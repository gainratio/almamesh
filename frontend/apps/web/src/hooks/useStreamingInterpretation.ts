/**
 * useStreamingInterpretation Hook — local-first, in-browser STRUCTURED narration.
 *
 * Drives the structured multi-section Vedic interpretation generator from
 * @almamesh/llm (`streamStructuredInterpretation`) and writes its progress +
 * result into the persisted `useInterpretationStore`, keyed by `chartId`. The
 * dashboard + astrologer cards read the finished `VedicInterpretation` straight
 * from that store; this hook is the bridge that fills it.
 *
 * No backend. This hook's only egress is the optional, PII-redacted LLM call,
 * and it is fail-closed: in `local_only` mode a non-local endpoint refuses to
 * send anything (PrivacyViolationError). When no model is reachable / configured
 * we surface a friendly notice instead of crashing.
 *
 * The JSON section calls fan out in parallel inside the generator; here we
 * translate its event stream into store mutations (startInterpretation /
 * markSectionComplete / setInterpretation / setError) and expose the derived
 * view-state the UI needs (status, per-section progress, error, isStreaming).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  applyInterpretationSettings,
  configProvenance,
  LlmRequestError,
  PrivacyViolationError,
  regenerateNatalSection,
  resolveProviderConfig,
  streamCurrentTimeline,
  streamNatalInterpretation,
  withheldNatalSections,
  type CurrentTimelineSectionKey,
  type InterpretationSectionKey,
  type LlmEnv,
  type NatalInterpretationSectionKey,
  type ProviderConfig,
  type RawEvidenceAnnotationPayload,
  type SectionProgressSnapshot,
} from '@almamesh/llm';
import {
  useAyanamsaStore,
  useChartLibraryStore,
  useInterpretationStore,
  useLanguageStore,
  usePredictiveStore,
  useProfilesStore,
  interpretationWriteRefusal,
  whenInterpretationHydrated,
  predictiveRequestKey,
  type CachedPredictiveContexts,
  type CurrentTimelineContent,
  type InterpretationErrorKind,
  type InterpretationInputProvenance,
  type InterpretationStatus,
} from '@almamesh/store';
import { safeError } from '@almamesh/shared-types';
import type { SiderealChart } from '@almamesh/browser/types';
import type { ProcessedBirthData, VedicInterpretation } from '@almamesh/shared-types';

import {
  aiErrorRegistry,
  aiErrorText,
  chatErrorMessage,
  classifyConnectionError,
  privacyBlockedMessage,
} from '../lib/errors';
import { createFrameBatcher, type FrameBatcher } from '../lib/frameBatcher';
import { whenDataLifecycleReady } from '../lib/profileDataLifecycle';
import { buildEnsurePredictiveInput, predictiveProfileKeyOf, predictiveReferenceInstant } from '../lib/predictive';
import {
  storedChartAnalysisInstant,
  storedChartReferenceInstant,
  viewerTimeZone,
} from '../lib/analysisInstant';
import {
  fetchEvidenceAnnotationsOutcome,
  trackEvidenceAnnotationFlight,
} from './evidenceAnnotations';
import { useSingleFlight } from './useSingleFlight';

/** The structured sections, in the order the generator announces them. */
export const INTERPRETATION_SECTIONS: readonly InterpretationSectionKey[] = [
  'core',
  'yoga',
  'guidance1',
  'guidance2',
  'remedial',
];

export const CURRENT_TIMELINE_SECTIONS: readonly CurrentTimelineSectionKey[] = [
  'upcoming_periods',
  'current_sky',
];

/** One section's completion/failure flags, for a progress checklist in the UI. */
export interface SectionProgress {
  readonly key: InterpretationSectionKey;
  readonly complete: boolean;
  /** True when the generator's per-section call failed (section degraded to empty). */
  readonly failed: boolean;
}

type StreamingInterpretationViewMode = 'layman' | 'expert';

export interface StreamInterpretationOptions {
  /** Paid provider calls are legal only after an explicit UI action. */
  readonly intent: 'user-request';
  view_mode?: StreamingInterpretationViewMode;
}

export interface UseStreamingInterpretationResult {
  /**
   * Begin generation for a chart; resolves when done/aborted. A call while a
   * run for the same chart is starting or streaming attaches to that run.
   */
  streamInterpretation: (chartId: string, options: StreamInterpretationOptions) => Promise<void>;
  /** Explicitly refresh the date-sensitive timeline; never called on mount/day rollover. */
  streamCurrentTimeline: (chartId: string, options: StreamInterpretationOptions) => Promise<void>;
  /** The finished structured reading for the active chart, if complete. */
  interpretation: VedicInterpretation | undefined;
  /**
   * The model's RAW, UNVALIDATED evidence annotations for this chart.
   * Never render these directly — pass them to `buildEvidenceLedger`, which
   * rejects every citation to a factor the chart does not contain.
   */
  evidenceAnnotations: RawEvidenceAnnotationPayload | undefined;
  /** Canonical error code when the optional evidence-annotation request failed. */
  evidenceAnnotationError: string | undefined;
  /** Lifecycle of the active chart's interpretation. */
  status: InterpretationStatus;
  /** Per-section completion/failure flags (the 5 keys), for a progress checklist. */
  sections: readonly SectionProgress[];
  /** The keys of sections whose generation failed (degraded to empty). */
  failedSections: readonly InterpretationSectionKey[];
  /** Canonical error code (e.g. `ai.provider.rate_limited`) per failed natal section. */
  failedSectionCodes: Readonly<Partial<Record<InterpretationSectionKey, string>>>;
  /** The keys of sections containing an unfinished `READING_WITHHELD` placeholder. */
  withheldSections: readonly InterpretationSectionKey[];
  /** Regenerate only the given natal section(s), preserving completed sections and evidence annotations. */
  retrySections: (
    chartId: string,
    sections: readonly InterpretationSectionKey[],
    options: StreamInterpretationOptions,
  ) => Promise<void>;
  /** True while targeted single-section regeneration is in flight. */
  isRetryingSection: boolean;
  /** Non-destructive error message if a targeted single-section retry failed. */
  sectionRetryError: string | null;
  /** Re-run only the optional evidence-annotation call without regenerating Sections VI & VII. */
  refreshEvidenceAnnotations: (
    chartId: string,
    options: StreamInterpretationOptions,
  ) => Promise<void>;
  /** True while an evidence-annotation-only refresh is in flight. */
  isRefreshingAnnotations: boolean;
  /** Failure message; present once `status === 'error'`. */
  error: string | null;
  /**
   * The MACHINE-READABLE reason behind `error` — the typed companion to the
   * localized sentence above. The reading panel switches on this to tell an
   * optional-enhancement outage (out of credits, provider down) from a genuine
   * defect, so it can degrade calmly instead of shouting. `null` when nothing
   * has failed, or for an entry persisted before the kind was recorded.
   */
  errorKind: InterpretationErrorKind | null;
  /** True while a generation is in flight. */
  isStreaming: boolean;
  /** Independently persisted time-sensitive narration. */
  currentTimeline: CurrentTimelineContent | undefined;
  timelineStatus: InterpretationStatus;
  timelineSections: readonly SectionProgress[];
  failedTimelineSections: readonly CurrentTimelineSectionKey[];
  /** Canonical error code (e.g. `ai.provider.server_error`) per failed timeline section. */
  failedTimelineSectionCodes: Readonly<Partial<Record<CurrentTimelineSectionKey, string>>>;
  /**
   * Live, unvalidated prose per timeline section while it streams (words so
   * far + a bounded tail), updated at most once per animation frame. Empty
   * when no timeline run is in flight.
   */
  timelineProgress: TimelineProgress;
  timelineError: string | null;
  timelineErrorKind: InterpretationErrorKind | null;
  isTimelineStreaming: boolean;
  /** Drop the active chart's interpretation entry. */
  reset: () => void;
  /** Abort the in-flight generation. */
  cancel: () => void;
  cancelCurrentTimeline: () => void;
}

/**
 * Stable sentinel stored as the interpretation "error" when the configured
 * model is dead/retired/typo'd on the endpoint. The dashboard maps it to the
 * existing switch-model prompt (recommended-model button + AI settings door) —
 * the raw endpoint response body never reaches the screen.
 */
export const READING_MODEL_UNAVAILABLE = 'reading_model_unavailable';

/** Translate internal sentinels (`READING_MODEL_UNAVAILABLE`) for non-Dashboard surfaces. */
export function displayInterpretationError(error: string | null | undefined): string | null {
  if (!error) return null;
  return error === READING_MODEL_UNAVAILABLE ? aiErrorText('ai.model.unavailable') : error;
}

/** Shown instead of starting a paid run while unreadable saved readings are not held. */
const SAVED_READINGS_UNREADABLE =
  'Your saved readings could not be read, so new readings are paused to protect them. Reload the page to try again.';

/**
 * Resolve the LLM env for the INTERPRETATION path: build-time Vite env, with any
 * browser-local Settings overrides (canonical SQLite) taking precedence, and the
 * EXPLICIT interpretation model resolved via applyInterpretationSettings (the
 * frontier default, distinct from the chat tier). Centralized so the privacy
 * default (local_only) is explicit and the override layer is the single source
 * of truth.
 */
function readLlmEnv(): LlmEnv {
  const env = import.meta.env as unknown as Record<string, string | undefined>;
  return applyInterpretationSettings({
    VITE_LLM_API_BASE: env.VITE_LLM_API_BASE,
    VITE_LLM_API_KEY: env.VITE_LLM_API_KEY,
    VITE_LLM_MODEL: env.VITE_LLM_MODEL,
    VITE_LLM_PRIVACY_MODE: env.VITE_LLM_PRIVACY_MODE,
    VITE_LLM_ENGINE: env.VITE_LLM_ENGINE,
  });
}

/**
 * The resolved provider config the INTERPRETATION path would stream with right
 * now. Exported so settings and provenance captions resolve the exact same
 * provider identity as the request path.
 */
export function resolveInterpretationConfig(): ProviderConfig {
  return resolveProviderConfig(readLlmEnv());
}

interface NarrationInput {
  readonly chart: SiderealChart;
  readonly provenance: InterpretationInputProvenance;
}

interface CurrentPredictiveFacts {
  readonly rawContexts: CachedPredictiveContexts;
  readonly requestKey: string;
}

/** The requested chart owns its profile identity, independent of active-UI races. */
function predictiveProfileKey(chartId: string | null): string {
  const stored = chartId ? useChartLibraryStore.getState().getChart(chartId) : undefined;
  return predictiveProfileKeyOf(stored, useProfilesStore.getState().activeProfileId, chartId);
}

/**
 * The predictive identity for one stored chart, as of the chart's own analysis
 * day — the SAME day the Life Atlas computes for (`usePredictiveLayer`), so the
 * timeline is narrated from the facts on screen, with the prompt's `asOf`.
 */
function expectedPredictiveKey(chartId: string | null): string | null {
  const stored = chartId ? useChartLibraryStore.getState().getChart(chartId) : undefined;
  const todayDay = predictiveReferenceInstant(new Date(), viewerTimeZone());
  const ayanamsa = useAyanamsaStore.getState().ayanamsa;
  const input = buildEnsurePredictiveInput(
    predictiveProfileKey(chartId),
    stored?.birth_data as ProcessedBirthData | undefined,
    stored ? storedChartReferenceInstant(stored, todayDay) : todayDay,
    {},
    ayanamsa,
  );
  return input ? predictiveRequestKey(input) : null;
}

/**
 * Whether the separate current timeline has exact-day deterministic inputs.
 * Paid timeline narration never fails open to a natal-only chart: that would
 * spend the user's provider tokens on prose that cannot describe the current
 * sky honestly.
 */
export type CurrentTimelineInputState = 'pending' | 'ready' | 'error';

export function currentTimelineInputState(chartId: string | null): CurrentTimelineInputState {
  const expectedRequest = expectedPredictiveKey(chartId);
  const { profileKey, rawContexts, requestKey, status } = usePredictiveStore.getState();
  if (expectedRequest === null) {
    return 'error';
  }
  if (requestKey === expectedRequest && status === 'error') {
    return 'error';
  }
  return requestKey === expectedRequest &&
    profileKey === predictiveProfileKey(chartId) &&
    status === 'ready' &&
    rawContexts !== undefined
    ? 'ready'
    : 'pending';
}

/** Return predictive facts only when every identity and readiness guard agrees. */
function currentPredictiveFacts(chartId: string | null): CurrentPredictiveFacts | null {
  const { status, rawContexts, profileKey, requestKey } = usePredictiveStore.getState();
  if (
    status !== 'ready' ||
    rawContexts === undefined ||
    profileKey !== predictiveProfileKey(chartId) ||
    requestKey === undefined ||
    requestKey !== expectedPredictiveKey(chartId)
  ) {
    return null;
  }
  return { rawContexts, requestKey };
}

/** Compose only exact-key predictive facts and record what the LLM received. */
function narrationInput(chart: SiderealChart, chartId: string | null): NarrationInput {
  const predictive = currentPredictiveFacts(chartId);
  if (predictive === null) {
    return { chart, provenance: { predictiveRequestKey: null } };
  }
  return {
    chart: { ...chart, ...predictive.rawContexts },
    provenance: { predictiveRequestKey: predictive.requestKey },
  };
}

/** Stable natal prose no longer expires when the predictive day changes. */
export function isInterpretationInputCurrent(
  provenance: InterpretationInputProvenance | undefined,
  _chartId: string | null,
): boolean {
  return provenance?.predictiveRequestKey !== undefined;
}

/** Natal prose is always safe to display; timing now lives in its own artifact. */
export function isInterpretationInputSafeToDisplay(
  _provenance: InterpretationInputProvenance | undefined,
  _chartId: string | null,
): boolean {
  return true;
}

/** Read a complete interpretation only when its deterministic inputs are current. */
export function currentInterpretationForChart(
  chartId: string | null,
): VedicInterpretation | undefined {
  if (!chartId) {
    return undefined;
  }
  const entry = useInterpretationStore.getState().getEntry(chartId);
  if (entry?.status !== 'complete') {
    return undefined;
  }
  return entry.interpretation;
}

/** Read interpretation prose that remains honest to display while inputs deepen. */
export function displayInterpretationForChart(
  chartId: string | null,
): VedicInterpretation | undefined {
  if (!chartId) {
    return undefined;
  }
  const entry = useInterpretationStore.getState().getEntry(chartId);
  return entry?.interpretation;
}

/**
 * Compose the persisted RAW engine predictive contexts onto the natal chart
 * (Spec 062, LLM delta 1) so interpretation + chat prompts carry the engine's
 * transit/strength/varga/domain blocks — activating the sanitizer + facts
 * pipeline that already exists in `@almamesh/llm`.
 *
 * Strictly additive and FAIL-OPEN: contexts that are absent (pre-v2 persisted
 * blob), not `ready`, or belong to a different profile leave the chart
 * untouched — narration degrades gracefully to natal-only, NEVER an error.
 * Privacy is unchanged: the composed chart still flows through
 * `sanitizeChartForLlm`, which reduces every predictive date to month
 * precision before any prompt is built.
 *
 * Identity is enforced by `narrationInput` / `currentPredictiveFacts`: contexts
 * are composed only when the predictive store is `ready` for THIS chart's profile
 * AND its deterministic `predictiveRequestKey` matches the current birth/reference
 * identity — so a stale or cross-profile context can never reach another chart.
 *
 * Returns the (possibly-composed) chart. The caller derives `predictiveAware`
 * from the resulting input provenance (a non-null `predictiveRequestKey`) to stamp
 * whether the full predictive superset was present at generation time (Spec 065) —
 * the single source of truth for the enrich-when-ready upgrade guard.
 */
export function withRawPredictive(chart: SiderealChart, chartId: string | null): SiderealChart {
  return narrationInput(chart, chartId).chart;
}

/**
 * Map a thrown error to a friendly, user-facing message — the same
 * classification the chat path applies (see `describeChatStreamError` /
 * `lib/errors`). Raw failure text is NEVER passed through for untyped errors:
 * the all-sections-failed aggregate can embed the configured endpoint URL
 * (a build-time VITE_LLM_API_BASE value), so every non-privacy path resolves
 * to translated guidance or a stable sentinel the dashboard maps to actions.
 */
interface InterpretationFailure {
  /** The localized, user-facing sentence (or the model-unavailable sentinel). */
  readonly message: string;
  /** The typed verdict the UI switches on to choose its treatment. */
  readonly kind: InterpretationErrorKind;
}

/**
 * The canonical error code for one failed section (e.g. `ai.provider.server_error`
 * for an upstream provider dropping the generation), shown beside the section
 * name so a partial failure is diagnosable instead of a bare "could not be
 * generated". Classified by the same registry as every other AI error.
 */
function sectionErrorCode(message: string, status: number | undefined): string {
  return aiErrorRegistry.classify(
    new LlmRequestError(message, status === undefined ? undefined : { status }),
  );
}

function describeError(err: unknown): InterpretationFailure {
  if (err instanceof PrivacyViolationError) {
    // The fail-closed privacy fence: localized copy naming the refused
    // endpoint (the error's own message is an English log line).
    return { message: privacyBlockedMessage(err), kind: 'privacy' };
  }
  // Record only an allowlisted diagnostic code. Provider errors can contain
  // endpoints or prompt-adjacent data and must never be serialized to console.
  safeError('interpretation.stream_failed', err);
  // The reading surfaces a dead/typo'd model as a STABLE sentinel the dashboard
  // maps to its switch-model prompt (recommended-model button + AI settings
  // door). Every other failure shares the chat path's coded copy — the same
  // classification, so 402 billing / 401 auth / 429 rate-limit / 5xx outage /
  // unreachable endpoint each get their specific, actionable message instead of
  // the old generic "check your model and endpoint" dead-end. This works now
  // that the aggregation preserves the representative HTTP status (see
  // structured-interpretation.ts), so 401/429/5xx classify structurally.
  const kind = classifyConnectionError(err);
  if (kind === 'model') {
    return { message: READING_MODEL_UNAVAILABLE, kind };
  }
  return { message: chatErrorMessage(err), kind };
}

export type TimelineProgress = Readonly<
  Partial<Record<CurrentTimelineSectionKey, SectionProgressSnapshot>>
>;

interface TimelineRun {
  readonly chartId: string;
  readonly runToken: number;
}

export function useStreamingInterpretation(chartId?: string | null): UseStreamingInterpretationResult {
  // Subscribe to the store so the component re-renders as events land.
  const entry = useInterpretationStore((s) => (chartId ? s.byChart[chartId] : undefined));
  // Context identity changes must immediately re-evaluate persisted prose even
  // when the interpretation entry itself did not mutate.
  usePredictiveStore((s) => s.requestKey);
  usePredictiveStore((s) => s.status);
  const startInterpretation = useInterpretationStore((s) => s.startInterpretation);
  const markSectionComplete = useInterpretationStore((s) => s.markSectionComplete);
  const markSectionFailed = useInterpretationStore((s) => s.markSectionFailed);
  const setInterpretation = useInterpretationStore((s) => s.setInterpretation);
  const patchInterpretationSection = useInterpretationStore((s) => s.patchInterpretationSection);
  const setEvidenceAnnotations = useInterpretationStore((s) => s.setEvidenceAnnotations);
  const setEvidenceAnnotationError = useInterpretationStore((s) => s.setEvidenceAnnotationError);
  const setError = useInterpretationStore((s) => s.setError);
  const startCurrentTimeline = useInterpretationStore((s) => s.startCurrentTimeline);
  const markCurrentTimelineSectionComplete = useInterpretationStore(
    (s) => s.markCurrentTimelineSectionComplete,
  );
  const markCurrentTimelineSectionFailed = useInterpretationStore(
    (s) => s.markCurrentTimelineSectionFailed,
  );
  const setCurrentTimeline = useInterpretationStore((s) => s.setCurrentTimeline);
  const setCurrentTimelineError = useInterpretationStore((s) => s.setCurrentTimelineError);
  const resetEntry = useInterpretationStore((s) => s.reset);
  const abandonInterpretation = useInterpretationStore((s) => s.abandonInterpretation);
  const abandonCurrentTimeline = useInterpretationStore((s) => s.abandonCurrentTimeline);

  // The persisted UI language threads into the prompt so the reading is narrated
  // in the user's chosen language; the engine math is untouched. Read as a hook
  // (this IS a React hook) so the latest choice is used on the next generation.
  const language = useLanguageStore((s) => s.language);

  const abortControllerRef = useRef<AbortController | null>(null);
  const natalRunRef = useRef<TimelineRun | null>(null);
  const sectionRetryAbortRef = useRef<AbortController | null>(null);
  const annotationRefreshAbortRef = useRef<AbortController | null>(null);
  const timelineAbortControllerRef = useRef<AbortController | null>(null);
  const timelineRunRef = useRef<TimelineRun | null>(null);
  const progressBatcherRef = useRef<FrameBatcher<SectionProgressSnapshot> | null>(null);
  const [timelineProgress, setTimelineProgress] = useState<TimelineProgress>({});
  const [sectionRetryError, setSectionRetryError] = useState<string | null>(null);

  // Leaving the page cancels background streams: nobody is watching them, and a
  // slow model would otherwise keep a connection (and tokens) running for
  // minutes. The store natal + timeline runs are closed so neither reads as 'generating' again.
  useEffect(
    () => () => {
      progressBatcherRef.current?.cancel();
      const natalRun = natalRunRef.current;
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
      natalRunRef.current = null;
      if (natalRun) abandonInterpretation(natalRun.chartId, natalRun.runToken);
      sectionRetryAbortRef.current?.abort();
      sectionRetryAbortRef.current = null;
      annotationRefreshAbortRef.current?.abort();
      annotationRefreshAbortRef.current = null;
      const run = timelineRunRef.current;
      timelineAbortControllerRef.current?.abort();
      timelineAbortControllerRef.current = null;
      timelineRunRef.current = null;
      if (run) abandonCurrentTimeline(run.chartId, run.runToken);
    },
    [abandonCurrentTimeline, abandonInterpretation],
  );
  // `setInterpretation` publishes to the zustand store synchronously but its
  // Promise resolves only after the SQLite snapshot commits. Keep that new
  // reading behind a local durability gate so a user-visible completion can
  // never be followed immediately by a hard reload that loses the prose.
  const [durabilityPendingRun, setDurabilityPendingRun] = useState<number | null>(null);
  const [timelineDurabilityPendingRun, setTimelineDurabilityPendingRun] = useState<number | null>(null);

  const reset = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    sectionRetryAbortRef.current?.abort();
    sectionRetryAbortRef.current = null;
    annotationRefreshAbortRef.current?.abort();
    annotationRefreshAbortRef.current = null;
    setSectionRetryError(null);
    if (timelineAbortControllerRef.current) {
      timelineAbortControllerRef.current.abort();
      timelineAbortControllerRef.current = null;
    }
    if (chartId) {
      resetEntry(chartId);
    }
  }, [chartId, resetEntry]);

  const cancel = useCallback(() => {
    const natalRun = natalRunRef.current;
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    natalRunRef.current = null;
    if (natalRun) abandonInterpretation(natalRun.chartId, natalRun.runToken);
    sectionRetryAbortRef.current?.abort();
    sectionRetryAbortRef.current = null;
    annotationRefreshAbortRef.current?.abort();
    annotationRefreshAbortRef.current = null;
  }, [abandonInterpretation]);

  const cancelCurrentTimeline = useCallback(() => {
    const run = timelineRunRef.current;
    if (timelineAbortControllerRef.current) {
      timelineAbortControllerRef.current.abort();
      timelineAbortControllerRef.current = null;
    }
    timelineRunRef.current = null;
    if (run) abandonCurrentTimeline(run.chartId, run.runToken);
  }, [abandonCurrentTimeline]);

  // One paid run per chart per kind: a repeat click while a run is starting
  // or streaming attaches to it (see useSingleFlight).
  const natalFlight = useSingleFlight();
  const timelineFlight = useSingleFlight();
  const sectionRetryFlight = useSingleFlight();
  const annotationRefreshFlight = useSingleFlight();

  const runNatal = useCallback(
    async (id: string, options: StreamInterpretationOptions, release: () => void) => {
      let runToken: number | undefined;
      let readingCompleted = false;
      let stored: ReturnType<ReturnType<typeof useChartLibraryStore.getState>['getChart']>;
      let chart: SiderealChart | undefined;
      let config: ProviderConfig | undefined;
      const controller = new AbortController();
      abortControllerRef.current = controller;
      try {
        // Startup may reconcile a newer portable dataset after Zustand's first
        // hydration. Both phases can replace the live map, so paid work must wait
        // for the whole lifecycle boundary before reading or mutating the store.
        await whenDataLifecycleReady();
        await whenInterpretationHydrated();
        if (controller.signal.aborted) return;
        if (interpretationWriteRefusal() !== undefined) {
          // Saved readings could not be read or held: a new run would overwrite them.
          startInterpretation(id);
          setError(id, SAVED_READINGS_UNREADABLE, 'unknown');
          return;
        }
        stored = useChartLibraryStore.getState().getChart(id);
        chart = stored?.sidereal_chart;
        if (!stored || !chart) {
          // No raw engine output to interpret (e.g. a pre-structured persisted chart).
          startInterpretation(id);
          setError(
            id,
            'This chart needs to be regenerated before it can be interpreted.',
            'needs_regeneration',
          );
          return;
        }

        config = resolveInterpretationConfig();
        sectionRetryAbortRef.current?.abort();
        sectionRetryAbortRef.current = null;
        annotationRefreshAbortRef.current?.abort();
        annotationRefreshAbortRef.current = null;
        setSectionRetryError(null);

        runToken = startInterpretation(id, stored.profile_id);
        natalRunRef.current = { chartId: id, runToken };

        for await (const event of streamNatalInterpretation({
          chart,
          asOf: storedChartAnalysisInstant(stored),
          config,
          mode: options.view_mode === 'expert' ? 'expert' : 'layman',
          language,
          signal: controller.signal,
        })) {
          if (controller.signal.aborted) {
            abandonInterpretation(id, runToken);
            return;
          }
          if (event.type === 'section_complete') {
            markSectionComplete(id, event.section, runToken);
          } else if (event.type === 'error' && event.section != null) {
            // A per-section failure degrades that section while the run still
            // completes — record both the section and its typed error code so
            // the UI can name the exact OpenRouter cause and offer a retry.
            markSectionFailed(
              id,
              event.section,
              runToken,
              sectionErrorCode(event.message, event.status),
            );
          } else if (event.type === 'complete') {
            setDurabilityPendingRun(runToken);
            await setInterpretation(
              id,
              event.interpretation,
              new Date().toISOString(),
              { ...configProvenance(config), predictiveAware: false },
              { predictiveRequestKey: null },
              runToken,
            );
            setDurabilityPendingRun((pending) => (pending === runToken ? null : pending));
            readingCompleted = true;
          }
          // `section_start` is informational.
        }
      } catch (err) {
        if (runToken !== undefined) {
          setDurabilityPendingRun((pending) => (pending === runToken ? null : pending));
        }
        if ((err instanceof Error && err.name === 'AbortError') || controller?.signal.aborted) {
          if (runToken !== undefined) abandonInterpretation(id, runToken);
          return;
        }
        const failure = describeError(err);
        if (runToken === undefined) {
          runToken = startInterpretation(id, stored?.profile_id);
        }
        setError(id, failure.message, failure.kind, runToken);
        return;
      } finally {
        if (natalRunRef.current?.runToken === runToken) {
          natalRunRef.current = null;
        }
        // The reading phase ends here: annotations below are background work
        // and must not swallow a deliberate new request.
        release();
      }

      if (!readingCompleted || !stored || !chart || !config || runToken === undefined || controller.signal.aborted) {
        return;
      }
      const completedToken = runToken;
      const completedChart = chart;
      const completedStored = stored;
      const completedConfig = config;
      const completedController = controller;
      await trackEvidenceAnnotationFlight(
        id,
        (async () => {
          const outcome = await fetchEvidenceAnnotationsOutcome({
            chart: completedChart,
            asOf: storedChartAnalysisInstant(completedStored),
            config: completedConfig,
            language,
            signal: completedController.signal,
            timeZone: viewerTimeZone(),
          });
          if (completedController.signal.aborted) return;
          if (outcome.kind === 'ok') {
            await setEvidenceAnnotations(id, outcome.payload, completedToken);
          } else if (outcome.kind === 'failed') {
            await setEvidenceAnnotationError(id, outcome.errorCode, completedToken);
          }
        })(),
      );
    },
    [
      abandonInterpretation,
      language,
      markSectionComplete,
      markSectionFailed,
      setError,
      setEvidenceAnnotationError,
      setEvidenceAnnotations,
      setInterpretation,
      startInterpretation,
    ]
  );

  const runNatalFlight = natalFlight.run;
  const streamInterpretation = useCallback(
    (id: string, options: StreamInterpretationOptions): Promise<void> => {
      if (options.intent !== 'user-request') return Promise.resolve();
      return runNatalFlight(id, (release) => runNatal(id, options, release), cancel);
    },
    [cancel, runNatal, runNatalFlight],
  );

  const runTimeline = useCallback(
    async (id: string, options: StreamInterpretationOptions) => {
      let runToken: number | undefined;
      const controller = new AbortController();
      timelineAbortControllerRef.current = controller;
      let progress: FrameBatcher<SectionProgressSnapshot> | undefined;
      let stored: ReturnType<ReturnType<typeof useChartLibraryStore.getState>['getChart']>;
      try {
        await whenDataLifecycleReady();
        await whenInterpretationHydrated();
        if (controller.signal.aborted) return;
        stored = useChartLibraryStore.getState().getChart(id);
        if (interpretationWriteRefusal() !== undefined) {
          startCurrentTimeline(id, stored?.profile_id);
          setCurrentTimelineError(id, SAVED_READINGS_UNREADABLE, 'unknown');
          return;
        }
        const chart = stored?.sidereal_chart;
        if (!stored || !chart) {
          startCurrentTimeline(id, stored?.profile_id);
          setCurrentTimelineError(
            id,
            'This chart needs to be regenerated before its current timeline can be interpreted.',
            'needs_regeneration',
          );
          return;
        }

        const predictive = currentPredictiveFacts(id);
        if (predictive === null) {
          startCurrentTimeline(id, stored.profile_id);
          setCurrentTimelineError(
            id,
            'Current timing facts are not ready. Retry after Sky & Timing finishes.',
            'unknown',
          );
          return;
        }
        const input: NarrationInput = {
          chart: { ...chart, ...predictive.rawContexts },
          provenance: { predictiveRequestKey: predictive.requestKey },
        };
        const config = resolveInterpretationConfig();
        runToken = startCurrentTimeline(id, stored.profile_id);
        timelineRunRef.current = { chartId: id, runToken };
        progressBatcherRef.current?.cancel();
        const activeProgress = createFrameBatcher<SectionProgressSnapshot>((latest) =>
          setTimelineProgress((previous) => ({ ...previous, ...latest })),
        );
        progress = activeProgress;
        progressBatcherRef.current = activeProgress;
        setTimelineProgress({});

        for await (const event of streamCurrentTimeline({
          chart: input.chart,
          asOf: storedChartAnalysisInstant(stored),
          config,
          mode: options.view_mode === 'expert' ? 'expert' : 'layman',
          language,
          signal: controller.signal,
          onSectionProgress: (section, snapshot) => activeProgress.push(section, snapshot),
        })) {
          if (controller.signal.aborted) {
            abandonCurrentTimeline(id, runToken);
            return;
          }
          if (event.type === 'section_complete') {
            markCurrentTimelineSectionComplete(id, event.section, runToken);
          } else if (event.type === 'error') {
            markCurrentTimelineSectionFailed(
              id,
              event.section,
              runToken,
              sectionErrorCode(event.message, event.status),
            );
          } else if (event.type === 'complete') {
            setTimelineDurabilityPendingRun(runToken);
            await setCurrentTimeline(
              id,
              event.timeline,
              new Date().toISOString(),
              { ...configProvenance(config), predictiveAware: true },
              input.provenance,
              runToken,
            );
            setTimelineDurabilityPendingRun((pending) =>
              pending === runToken ? null : pending,
            );
          }
        }
      } catch (err) {
        if (runToken !== undefined) {
          setTimelineDurabilityPendingRun((pending) => (pending === runToken ? null : pending));
        }
        if ((err instanceof Error && err.name === 'AbortError') || controller?.signal.aborted) {
          if (runToken !== undefined) abandonCurrentTimeline(id, runToken);
          return;
        }
        const failure = describeError(err);
        if (runToken === undefined) {
          runToken = startCurrentTimeline(id, stored?.profile_id);
        }
        setCurrentTimelineError(id, failure.message, failure.kind, runToken);
      } finally {
        progress?.cancel();
        if (progress && progressBatcherRef.current === progress) {
          progressBatcherRef.current = null;
          setTimelineProgress({});
        }
        if (timelineRunRef.current?.runToken === runToken) timelineRunRef.current = null;
      }
    },
    [
      abandonCurrentTimeline,
      language,
      markCurrentTimelineSectionComplete,
      markCurrentTimelineSectionFailed,
      setCurrentTimeline,
      setCurrentTimelineError,
      startCurrentTimeline,
    ],
  );

  const runTimelineFlight = timelineFlight.run;
  const streamTimeline = useCallback(
    (id: string, options: StreamInterpretationOptions): Promise<void> => {
      if (options.intent !== 'user-request') return Promise.resolve();
      return runTimelineFlight(id, () => runTimeline(id, options), cancelCurrentTimeline);
    },
    [cancelCurrentTimeline, runTimeline, runTimelineFlight],
  );

  const runSectionRetry = useCallback(
    async (
      id: string,
      targetSections: readonly InterpretationSectionKey[],
      options: StreamInterpretationOptions,
    ) => {
      const validTargets = targetSections.filter((s): s is NatalInterpretationSectionKey =>
        (INTERPRETATION_SECTIONS as readonly string[]).includes(s),
      );
      if (validTargets.length === 0) return;
      setSectionRetryError(null);
      let controller: AbortController | undefined;
      try {
        await whenDataLifecycleReady();
        await whenInterpretationHydrated();
        if (interpretationWriteRefusal() !== undefined) {
          setSectionRetryError(SAVED_READINGS_UNREADABLE);
          return;
        }
        const stored = useChartLibraryStore.getState().getChart(id);
        const chart = stored?.sidereal_chart;
        if (!stored || !chart) {
          setSectionRetryError('This chart needs to be regenerated before it can be interpreted.');
          return;
        }
        const storeState = useInterpretationStore.getState();
        const currentEntry = storeState.getEntry(id);
        if (!currentEntry?.interpretation || currentEntry.status === 'generating') {
          return;
        }

        const tokenSnapshot = storeState.getActiveRunToken(id);
        const config = resolveInterpretationConfig();
        sectionRetryAbortRef.current?.abort();
        controller = new AbortController();
        sectionRetryAbortRef.current = controller;
        for (const section of validTargets) {
          if (controller.signal.aborted) return;
          const latestState = useInterpretationStore.getState();
          if (latestState.getActiveRunToken(id) !== tokenSnapshot) return;
          const latestEntry = latestState.getEntry(id);
          if (!latestEntry?.interpretation || latestEntry.status === 'generating') return;
          const isFailed = Boolean(latestEntry.failedSections?.[section]);
          const patch = await regenerateNatalSection(section, {
            chart,
            asOf: storedChartAnalysisInstant(stored),
            config,
            mode: options.view_mode === 'expert' ? 'expert' : 'layman',
            language,
            signal: controller.signal,
            ...(isFailed ? {} : { existing: latestEntry.interpretation }),
          });
          if (controller.signal.aborted) return;
          const prePatchEntry = useInterpretationStore.getState().getEntry(id);
          await patchInterpretationSection(
            id,
            section,
            patch,
            new Date().toISOString(),
            {
              ...configProvenance(config),
              predictiveAware: prePatchEntry?.provenance?.predictiveAware ?? false,
            },
            tokenSnapshot,
          );
        }
        const afterEntry = useInterpretationStore.getState().getEntry(id);
        const stillWithheld = withheldNatalSections(afterEntry?.interpretation).filter((s) =>
          validTargets.includes(s),
        );
        if (stillWithheld.length > 0) {
          setSectionRetryError(
            'The model still returned non-reflective phrasing for that section. Try again, or pick another model in AI settings.',
          );
        }
      } catch (err) {
        if ((err instanceof Error && err.name === 'AbortError') || controller?.signal.aborted) {
          return;
        }
        const failure = describeError(err);
        setSectionRetryError(
          failure.message === READING_MODEL_UNAVAILABLE ? chatErrorMessage(err) : failure.message,
        );
      } finally {
        if (controller && sectionRetryAbortRef.current === controller) {
          sectionRetryAbortRef.current = null;
        }
      }
    },
    [language, patchInterpretationSection],
  );

  const cancelSectionRetry = useCallback(() => {
    sectionRetryAbortRef.current?.abort();
    sectionRetryAbortRef.current = null;
  }, []);

  const runSectionRetryFlight = sectionRetryFlight.run;
  const retrySections = useCallback(
    (
      id: string,
      targetSections: readonly InterpretationSectionKey[],
      options: StreamInterpretationOptions,
    ): Promise<void> => {
      if (options.intent !== 'user-request') return Promise.resolve();
      return runSectionRetryFlight(
        id,
        () => runSectionRetry(id, targetSections, options),
        cancelSectionRetry,
      );
    },
    [cancelSectionRetry, runSectionRetry, runSectionRetryFlight],
  );

  const runAnnotationRefresh = useCallback(
    async (id: string) => {
      let controller: AbortController | undefined;
      let tokenSnapshot: number | null = null;
      try {
        await whenDataLifecycleReady();
        await whenInterpretationHydrated();
        if (interpretationWriteRefusal() !== undefined) return;
        const stored = useChartLibraryStore.getState().getChart(id);
        const chart = stored?.sidereal_chart;
        const storeState = useInterpretationStore.getState();
        if (!stored || !chart || storeState.getEntry(id)?.status === 'generating') return;
        tokenSnapshot = storeState.getActiveRunToken(id);
        const config = resolveInterpretationConfig();
        annotationRefreshAbortRef.current?.abort();
        const activeController = new AbortController();
        controller = activeController;
        annotationRefreshAbortRef.current = activeController;
        await trackEvidenceAnnotationFlight(
          id,
          (async () => {
            const outcome = await fetchEvidenceAnnotationsOutcome({
              chart,
              asOf: storedChartAnalysisInstant(stored),
              config,
              language,
              signal: activeController.signal,
              timeZone: viewerTimeZone(),
            });
            if (activeController.signal.aborted) return;
            if (outcome.kind === 'ok') {
              await setEvidenceAnnotations(id, outcome.payload, tokenSnapshot);
            } else if (outcome.kind === 'failed') {
              await setEvidenceAnnotationError(id, outcome.errorCode, tokenSnapshot);
            }
          })(),
        );
      } catch (err) {
        if ((err instanceof Error && err.name === 'AbortError') || controller?.signal.aborted) {
          return;
        }
        await setEvidenceAnnotationError(id, aiErrorRegistry.classify(err), tokenSnapshot);
      } finally {
        if (controller && annotationRefreshAbortRef.current === controller) {
          annotationRefreshAbortRef.current = null;
        }
      }
    },
    [language, setEvidenceAnnotationError, setEvidenceAnnotations],
  );

  const cancelAnnotationRefresh = useCallback(() => {
    annotationRefreshAbortRef.current?.abort();
    annotationRefreshAbortRef.current = null;
  }, []);

  const runAnnotationRefreshFlight = annotationRefreshFlight.run;
  const refreshEvidenceAnnotations = useCallback(
    (id: string, options: StreamInterpretationOptions): Promise<void> => {
      if (options.intent !== 'user-request') return Promise.resolve();
      return runAnnotationRefreshFlight(
        id,
        () => runAnnotationRefresh(id),
        cancelAnnotationRefresh,
      );
    },
    [cancelAnnotationRefresh, runAnnotationRefresh, runAnnotationRefreshFlight],
  );

  const storedStatus: InterpretationStatus = entry?.status ?? 'idle';
  const waitingForDurability = durabilityPendingRun !== null;
  const natalInFlight = chartId != null && natalFlight.activeKey === chartId;
  const status: InterpretationStatus = waitingForDurability || natalInFlight
    ? 'generating'
    : storedStatus;
  const completed = entry?.sections ?? {};
  const failed = entry?.failedSections ?? {};
  const sections: readonly SectionProgress[] = INTERPRETATION_SECTIONS.map((key) => ({
    key,
    complete: Boolean(completed[key]),
    failed: Boolean(failed[key]),
  }));
  const storedTimelineStatus: InterpretationStatus = entry?.timeline?.status ?? 'idle';
  const waitingForTimelineDurability = timelineDurabilityPendingRun !== null;
  const timelineInFlight = chartId != null && timelineFlight.activeKey === chartId;
  const timelineStatus: InterpretationStatus = waitingForTimelineDurability || timelineInFlight
    ? 'generating'
    : storedTimelineStatus;
  const timelineCompleted = entry?.timeline?.sections ?? {};
  const timelineFailed = entry?.timeline?.failedSections ?? {};
  const timelineSections: readonly SectionProgress[] = CURRENT_TIMELINE_SECTIONS.map((key) => ({
    key,
    complete: Boolean(timelineCompleted[key]),
    failed: Boolean(timelineFailed[key]),
  }));

  return {
    streamInterpretation,
    streamCurrentTimeline: streamTimeline,
    interpretation: !waitingForDurability ? entry?.interpretation : undefined,
    // UNVALIDATED model output, handed on deliberately raw. `buildEvidenceLedger`
    // is the single place it is ever checked against the computed chart, so
    // passing it through here cannot create a second, laxer validation site.
    evidenceAnnotations: !waitingForDurability ? entry?.evidenceAnnotations : undefined,
    evidenceAnnotationError: !waitingForDurability ? entry?.evidenceAnnotationError : undefined,
    status,
    sections,
    failedSections: sections.filter((s) => s.failed).map((s) => s.key),
    failedSectionCodes: entry?.failedSectionCodes ?? {},
    withheldSections: !waitingForDurability ? withheldNatalSections(entry?.interpretation) : [],
    retrySections,
    isRetryingSection: chartId != null && sectionRetryFlight.activeKey === chartId,
    sectionRetryError,
    refreshEvidenceAnnotations,
    isRefreshingAnnotations: chartId != null && annotationRefreshFlight.activeKey === chartId,
    error: entry?.error ?? null,
    errorKind: entry?.errorKind ?? null,
    isStreaming: status === 'generating',
    currentTimeline: !waitingForTimelineDurability ? entry?.timeline?.content : undefined,
    timelineStatus,
    timelineSections,
    failedTimelineSections: timelineSections
      .filter((section) => section.failed)
      .map((section) => section.key as CurrentTimelineSectionKey),
    failedTimelineSectionCodes: entry?.timeline?.failedSectionCodes ?? {},
    timelineProgress,
    timelineError: entry?.timeline?.error ?? null,
    timelineErrorKind: entry?.timeline?.errorKind ?? null,
    isTimelineStreaming: timelineStatus === 'generating',
    reset,
    cancel,
    cancelCurrentTimeline,
  };
}

export default useStreamingInterpretation;
