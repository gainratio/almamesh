import { useCallback, useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type {
  BirthChartGenerationResponse,
  AstronomicalCalculations,
  SiderealPlanet,
  ProcessedBirthData,
} from "@almamesh/shared-types";
import { readLocalPrimaryChart } from "../lib/localChartRead";
import {
  applyChatSettings,
  buildChatMessages,
  describeLlmStatus,
  resolveProviderConfig,
  sanitizeChartForLlm,
  streamAgentChat,
  serializeInterpretationForChat,
  readLlmSettings,
  writeLlmSettings,
  openRouterPreset,
  RECOMMENDED_CLOUD_MODEL,
  type ChatTurn,
  type AgentStatusEvent,
  type LlmEnv,
} from "@almamesh/llm";
import {
  useChartLibraryStore,
  useInterpretationStore,
  useLanguageStore,
  usePredictiveStore,
  useProfilesStore,
  useRectificationRecordsStore,
} from "@almamesh/store";
import { safeError } from "@almamesh/shared-types";

import { Card, Spinner } from "../components/ui";
import { ContentModeToggle } from "../components/ui/ContentModeToggle";
import { MarkdownContent } from "../components/ui/MarkdownContent";
import { FloatingChatPanel } from "../components/features/chat/FloatingChatPanel";
import { FeedbackWidget } from "../components/features/feedback/FeedbackWidget";
import { ProvenanceFooter } from "../components/ProvenanceFooter";
import {
  ChartVisualization,
  DashboardCurrentTimeline,
  DashboardInterpretation,
  IdentityStrip,
  LifeAtlas,
  ReadingGrounding,
} from "../components/features/dashboard";
import { NarrationUnavailable } from "../components/features/dashboard/NarrationUnavailable";
import {
  ChartReadFailed,
  NoChartYet,
} from "../components/features/dashboard/ChartlessState";
import { getUserFriendlyError, isModelUnavailableMessage } from "../lib/errors";
import { narrationOutage } from "../lib/narrationOutage";
import { isMappedChatStreamError } from "../hooks/useChatThread";
import { type SSEMetaData } from "../lib/streaming";
import { useContentModeStore } from "../stores/contentMode";
import type { ViewMode } from "../lib/types";
import {
  READING_MODEL_UNAVAILABLE,
  currentInterpretationForChart,
  currentTimelineInputState,
  useStreamingInterpretation,
  withRawPredictive,
} from "../hooks/useStreamingInterpretation";
import { useElapsedSeconds, formatElapsed } from "../hooks/useElapsedSeconds";
import { useLlmStatus } from "../hooks/useLlmStatus";
import { useReportPdfExport } from "../hooks/useReportPdfExport";
import { isPlaceholderContent } from "./exportGate";
import { personaText, resolveReportAudience } from "../lib/reportSelectors";
import { rectificationDelta } from "../lib/rectification";
import {
  createChatAgentTools,
  requiresCurrentPlanetaryContext,
} from "../lib/chatAgentTools";
import { ensureCurrentPlanetaryContext } from "../lib/currentPlanetaryContext";
import { useOptionalChartEngine } from "../providers/chartEngineContext";

// Resolve the LLM env: build-time Vite env with any browser-local Settings
// overrides taking precedence — mirrors useStreamingInterpretation so the
// privacy default (local_only) is the single source of truth for chat too.
// Chat resolves the EXPLICIT chat model (settings.chatModel, default the fast
// CHAT_CLOUD_MODEL) via applyChatSettings — a visible, configurable per-tier
// choice that replaces the old silent applyChatModelPreference swap. The longer
// structured interpretation path uses applyInterpretationSettings (the frontier
// default), so the two tiers stay independent.
function readChatLlmEnv(): LlmEnv {
  const env = import.meta.env as unknown as Record<string, string | undefined>;
  return applyChatSettings({
    VITE_LLM_API_BASE: env.VITE_LLM_API_BASE,
    VITE_LLM_API_KEY: env.VITE_LLM_API_KEY,
    VITE_LLM_MODEL: env.VITE_LLM_MODEL,
    VITE_LLM_PRIVACY_MODE: env.VITE_LLM_PRIVACY_MODE,
    VITE_LLM_ENGINE: env.VITE_LLM_ENGINE,
  });
}

export default function DashboardPage() {
  const { t, i18n } = useTranslation(["dashboard", "life", "predictive"]);
  const chartEngineContext = useOptionalChartEngine();

  // Auth state is handled by RequiresChartRoute guard
  const [chartData, setChartData] = useState<BirthChartGenerationResponse | null>(null);
  const [personName, setPersonName] = useState<string>("");
  const [chartDetails, setChartDetails] = useState<AstronomicalCalculations | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Connect to the global content mode store
  // Maps 'layman' | 'technical' to ViewMode 'layman' | 'astrologer'
  const { contentMode } = useContentModeStore();
  const viewMode: ViewMode = contentMode === 'technical' ? 'astrologer' : 'layman';
  // Canonical audience for the dual-voice reading selectors (`personaText`).
  // Toggling `contentMode` re-derives this at render time, so the summary
  // switches voice instantly — no LLM call (the store subscription re-renders).
  const audience = resolveReportAudience(contentMode);

  // Arriving via a "discuss in chat" link (e.g. from /life/:domain) opens the
  // chat panel immediately instead of leaving the user hunting for the bubble.
  const [searchParams] = useSearchParams();
  const chatInitiallyOpen = searchParams.get('chat') === 'open';

  // Local-first read: the primary chart comes from the on-device chart library
  // (IndexedDB), not the backend. We wrap the persisted ChartData in the
  // BirthChartGenerationResponse shape the dashboard already consumes.
  const { data: queryData, error: queryError } = useQuery<BirthChartGenerationResponse>({
    queryKey: ['primary-chart'],
    queryFn: () => readLocalPrimaryChart(),
    retry: false,
  });

  useEffect(() => {
    if (queryData?.success) {
      setChartData(queryData);
      setPersonName(queryData.person_name);
      if (queryData.chart_data?.astronomical_calculations) {
        setChartDetails(queryData.chart_data.astronomical_calculations);
      }
      setIsLoading(false);
    } else if (queryError) {
      safeError('dashboard.chart_fetch_failed', queryError);
      setIsLoading(false);
    } else if (queryData) {
      // Resolved but success:false — a genuinely chart-less device (the
      // hydration race now resolves with the chart). Stop loading so the
      // chart-less UI / guard redirect shows instead of an infinite spinner.
      setIsLoading(false);
    }
  }, [queryData, queryError]);

  // NOTE: Fallback redirect removed - RequiresChartRoute guard handles this.
  // `chartData === null` after loading is NOT a failure: charts are computed
  // on-device (no chart API exists to fail), so a miss means the ACTIVE person
  // has no chart yet. `hasLocalChart()` routes device-wide, so a newly added
  // second person lands here the moment they are created. A rejected read is
  // the only genuine failure, and react-query surfaces that as `queryError`.

  const chartId = (chartData as unknown as { chart_id?: string | null })?.chart_id ?? null;

  // The active profile scopes the persisted chat thread + RAG memory (mirrors
  // how charts are scoped per profile). Read it via the store HOOK so the chat
  // re-binds when the person switches.
  const activeProfileId = useProfilesStore((s) => s.activeProfileId);
  // Whose chart is missing — named on the empty state so the screen is about a
  // person, not an abstraction. Selected as a primitive so the hook is stable.
  const activeProfileName = useProfilesStore((s) =>
    s.activeProfileId ? (s.profiles[s.activeProfileId]?.name ?? null) : null,
  );

  // The richest feed for the chart visualization is the engine's raw
  // SiderealChart, persisted on-device in the chart library. Thread it to
  // ChartVisualization (which reshapes it once via buildChartGeometry).
  // Read it via the store HOOK (not getState()) so the component re-renders
  // once the library rehydrates from IndexedDB on a cold load.
  const siderealChart = useChartLibraryStore((s) =>
    chartId ? (s.charts[chartId]?.sidereal_chart ?? null) : null,
  );

  // Structured in-browser interpretation: drives @almamesh/llm's 5-section
  // generator and writes its progress + result into useInterpretationStore,
  // keyed by chartId. The reading below consumes the finished interpretation.
  const {
    streamInterpretation,
    interpretation,
    sections: interpretationSections,
    failedSections: failedInterpretationSections,
    isStreaming: isStreamingInterpretation,
    status: interpretationStatus,
    error: streamingError,
    errorKind: streamingErrorKind,
    cancel: cancelStreaming,
    streamCurrentTimeline,
    currentTimeline,
    timelineSections,
    failedTimelineSections,
    isTimelineStreaming,
    timelineStatus,
    timelineError,
    cancelCurrentTimeline,
  } = useStreamingInterpretation(chartId);
  const predictiveRequestIdentity = usePredictiveStore((s) => s.requestKey);
  const predictiveStatus = usePredictiveStore((s) => s.status);
  // The full persisted entry for the active chart: carries the reading's
  // provenance (which model wrote it) and updatedAt for the quiet caption
  // under the reading. Subscribed (not getState) so a fresh generation
  // re-renders the caption the moment the new reading lands.
  const interpretationEntry = useInterpretationStore((s) =>
    chartId ? s.byChart[chartId] : undefined,
  );

  // Whether an AI endpoint is configured (local or cloud) — gates
  // explicit generation and decides between the progress panel and the CTA. LIVE
  // (useLlmStatus): turning AI off updates every gate on this page immediately,
  // no reload.
  const aiConfigured = useLlmStatus().configured;

  // Whether the reading can be (re)generated: any configured AI can produce the
  // structured reading. Gates the Regenerate button (with an explanatory
  // caption) so a click is never a silent no-op when no AI is configured.
  const canRegenerateReading = aiConfigured;

  // A failed regeneration with a kept reading surfaces an inline error strip
  // in the reading section (keep-old-until-success keeps the reading itself).
  // Dismissed locally; a new generation attempt re-arms it.
  const [regenErrorDismissed, setRegenErrorDismissed] = useState(false);
  // A manual timeline refresh requested while today's predictive facts are
  // still computing is queued. Natal generation never waits on these facts.
  const [timelineRegenerationQueued, setTimelineRegenerationQueued] = useState(false);

  // Dead/retired/typo'd model → the switch-model prompt. The hook stores the
  // stable sentinel for this case; the raw-message sniff keeps recognizing
  // entries persisted before the sentinel existed.
  const isModelUnavailableNotice =
    streamingErrorKind === 'model' ||
    (streamingError !== null &&
      (streamingError === READING_MODEL_UNAVAILABLE || isModelUnavailableMessage(streamingError)));

  // HOW to present a missing narration. The chart is deterministic and complete
  // without any AI, so a provider problem is an OPTIONAL EXTRA being
  // unavailable, not a broken product: everything except `fault` degrades into
  // the calm, secondary NarrationUnavailable notice with mode-specific copy.
  // Only a genuine defect keeps the louder error treatment.
  const readingOutage = isModelUnavailableNotice
    ? ('model' as const)
    : narrationOutage(streamingErrorKind);
  const readingDegradesGracefully = readingOutage !== 'fault';

  // Honest, live "time so far" for the generation panel (replaces a fixed,
  // usually-wrong "about 30 seconds" estimate).
  const interpElapsed = useElapsedSeconds(isStreamingInterpretation);
  const timelineElapsed = useElapsedSeconds(isTimelineStreaming);

  // P5 local-first chat Q&A: the floating chat panel asks a grounded question
  // about the chart. We answer ENTIRELY in-browser via @almamesh/llm — the chart
  // is sanitized (identifier-free, dates relativized) before the prompt is built
  // and streamed to the configured (default local) OpenAI-compatible endpoint.
  // There is no backend; egress is the optional, PII-redacted LLM call only.
  const askLocalLlm = async function* (
    question: string,
    questionViewMode: ViewMode | undefined,
    signal: AbortSignal,
    history: readonly ChatTurn[] = [],
    retrievedContext: readonly string[] = [],
    onAgentStatus?: (label: string | null) => void,
  ) {
    const storedChart = chartId ? useChartLibraryStore.getState().getChart(chartId) : undefined;
    const chart = storedChart?.sidereal_chart;
    if (!chart) {
      throw new Error(t('errors:needs_regeneration'));
    }
    // SECURITY backstop: never send when AI is off. `resolveProviderConfig` is
    // fail-open (it falls back to the localhost Ollama default), and the chat UI
    // gate is the primary guard — but read the LIVE status here too so a send can
    // never reach an endpoint the user has disconnected. (Read at send time, not
    // a render snapshot.)
    if (!describeLlmStatus().configured) {
      throw new Error(t('dashboard:chat.not_configured_notice'));
    }
    const effectiveViewMode = questionViewMode || viewMode;
    const chatMode = effectiveViewMode === 'astrologer' ? 'expert' : 'layman';
    const config = resolveProviderConfig(readChatLlmEnv());
    // Reuse the already-generated natal reading (when complete) so a fast/small
    // chat model can lean on the frontier reading instead of re-deriving from raw
    // facts. Absent/incomplete → chat behaves exactly as before (facts only).
    const interp = currentInterpretationForChart(chartId);
    const interpretationText = interp
      ? serializeInterpretationForChat(interp, chatMode)
      : undefined;
    // Chat grounded in the CONFIRMED rectification record (Spec 062 delta 3):
    // only the PII-safe slice crosses — band + entered/working signs + fit
    // mode. Times, dates, and margins stay on-device by construction.
    const rectificationRecord = activeProfileId
      ? useRectificationRecordsStore.getState().getRecord(activeProfileId)
      : null;
    const language = useLanguageStore.getState().language;
    const now = new Date();
    let chartWithPredictive = withRawPredictive(chart, chartId);
    const rectification = rectificationRecord
      ? {
          band: rectificationRecord.band,
          originalSign: rectificationRecord.originalSign,
          rectifiedSign: rectificationRecord.rectifiedSign,
          mode: rectificationRecord.mode,
        }
      : undefined;

    const chartTimeZone = storedChart?.birth_data?.birth_location_details.timezone ?? 'UTC';
    const loadCurrentChart = async (context: { now: Date; signal: AbortSignal }) => {
      if (!chartEngineContext) {
        throw new Error('The on-device chart engine is unavailable.');
      }
      chartEngineContext.startBootstrap();
      const runtime = chartEngineContext.engine ?? await chartEngineContext.whenReady();
      chartWithPredictive = await ensureCurrentPlanetaryContext({
        chart,
        profileKey: storedChart?.profile_id ?? chartId ?? 'primary',
        birth: storedChart?.birth_data as ProcessedBirthData | undefined,
        chartTimeZone,
        now: context.now,
        runtime,
        signal: context.signal,
      });
      return chartWithPredictive;
    };
    const tools = createChatAgentTools({
      chart: chartWithPredictive,
      chartTimeZone,
      loadCurrentChart,
    });

    // A small deterministic router guarantees that explicit relative-time
    // questions receive exact-day engine facts. This does not ask a cheap model
    // to decide whether "today" needs today's sky; the same allowlisted tool the
    // model can call is run locally first, and the resulting chart is then the
    // one serialized into the agent context. Same-day repeats hit the store cache.
    let currentContextUnavailable = false;
    if (requiresCurrentPlanetaryContext(question)) {
      const currentTimingTool = tools.find((tool) => tool.name === 'get_current_timing');
      if (!currentTimingTool) throw new Error('Current timing tool is unavailable.');
      onAgentStatus?.(currentTimingTool.statusLabel ?? 'Calculating current planetary context');
      try {
        await currentTimingTool.execute(
          { section: 'transits' },
          { now: new Date(now.getTime()), signal },
        );
      } catch (error) {
        if (signal.aborted) throw error;
        currentContextUnavailable = true;
      }
    }

    let messages = buildChatMessages(
      sanitizeChartForLlm(chartWithPredictive, now),
      question,
      chatMode,
      history,
      retrievedContext,
      interpretationText,
      language,
      undefined,
      rectification,
    );
    if (currentContextUnavailable) {
      const [system, ...rest] = messages;
      messages = [
        {
          ...system,
          content:
            `${system.content ?? ''}\n\n` +
            'CURRENT-CONTEXT SAFETY: This question requires exact-day planetary facts, but the on-device calculation was unavailable. Say that plainly and do not infer current transits or timing from natal facts.',
        },
        ...rest,
      ];
    }

    let activeToolLabel: string | null = null;
    yield* streamAgentChat({
      config,
      messages,
      tools,
      now,
      signal,
      onStatus: (event) => {
        if (event.phase === 'using_tool') {
          activeToolLabel = event.label;
        } else if (event.phase === 'deciding' && event.round > 1 && activeToolLabel !== null) {
          // Keep the concrete local activity visible while the provider reads
          // its result; replacing it immediately with a generic second-round
          // label makes a synchronous tool call imperceptible to people.
          return;
        } else if (event.phase === 'answering' || event.phase === 'complete') {
          activeToolLabel = null;
        }
        onAgentStatus?.(agentStatusLabel(event));
      },
    });
  };

  const handleAskQuestionStream = async (
    question: string,
    onToken: (token: string) => void,
    _onMeta: (meta: SSEMetaData) => void,
    questionViewMode?: ViewMode,
    history: readonly ChatTurn[] = [],
    retrievedContext: readonly string[] = [],
    onAgentStatus?: (label: string | null) => void,
  ) => {
    const controller = new AbortController();
    let answer = '';
    try {
      for await (const delta of askLocalLlm(
        question,
        questionViewMode,
        controller.signal,
        history,
        retrievedContext,
        onAgentStatus,
      )) {
        answer += delta;
        onToken(delta);
      }
    } catch (err) {
      // Typed @almamesh/llm causes (on-device, privacy fence, request/endpoint
      // failures) must reach useChatThread intact so `describeChatStreamError`
      // can give the user an actionable message instead of the generic QA_001.
      if (isMappedChatStreamError(err)) throw err;
      throw new Error(getUserFriendlyError('QA_001', err instanceof Error ? err.message : undefined, t('dashboard:chat.not_configured_notice')), { cause: err });
    }
    return {
      answer,
      timing_guidance: null as string | null,
      remedies: null as string[] | null,
    };
  };

  function agentStatusLabel(event: AgentStatusEvent): string {
    switch (event.phase) {
      case 'deciding':
        return t('chat:agent.deciding');
      case 'using_tool':
        return event.label;
      case 'answering':
        return t('chat:agent.answering');
      case 'complete':
        return t('chat:agent.complete');
    }
  }

  const handleGenerateSeparatedInterpretation = useCallback(async () => {
    if (!chartId) return;
    // A fresh attempt re-arms the regeneration-failure strip (it was for the
    // PREVIOUS failure; a new one must be visible again).
    setRegenErrorDismissed(false);
    // Abort any in-flight run WITHOUT deleting the stored entry: the store
    // keeps a previously completed reading through a regeneration
    // (keep-old-until-success), so a failed run never leaves the user with
    // nothing. Only a successful new reading replaces the old one.
    cancelStreaming();

    const sepViewMode = viewMode === "astrologer" ? "expert" : "layman";

    // Local-first: narration runs entirely in-browser. The hook sanitizes the
    // on-device chart, fans out the 5 structured section calls, and writes the
    // merged VedicInterpretation into useInterpretationStore — there is no
    // backend version to fetch afterward.
    try {
      await streamInterpretation(chartId, {
        intent: 'user-request',
        view_mode: sepViewMode,
      });
    } catch (err) {
      safeError('dashboard.interpretation_failed', err);
    }
  }, [cancelStreaming, chartId, streamInterpretation, viewMode]);

  // Recover from a dead/typo'd cloud model after the user asks: re-point settings at the recommended
  // OpenRouter model (keeping the user's saved key), then re-run generation.
  const handleSwitchToRecommendedModel = () => {
    const current = readLlmSettings();
    writeLlmSettings(openRouterPreset(current.apiKey ?? '', RECOMMENDED_CLOUD_MODEL));
    handleGenerateSeparatedInterpretation();
  };

  // Manual natal regeneration keeps the current reading on screen until — and unless
  // — the explicitly requested replacement lands (keep-old-until-success).
  const handleRegenerateReading = () => {
    handleGenerateSeparatedInterpretation();
  };

  const handleRegenerateTimeline = useCallback(async () => {
    if (!chartId) return;
    if (currentTimelineInputState(chartId) === 'pending') {
      setTimelineRegenerationQueued(true);
      return;
    }
    setTimelineRegenerationQueued(false);
    cancelCurrentTimeline();
    try {
      await streamCurrentTimeline(chartId, {
        intent: 'user-request',
        view_mode: viewMode === 'astrologer' ? 'expert' : 'layman',
      });
    } catch (err) {
      safeError('dashboard.interpretation_failed', err);
    }
  }, [cancelCurrentTimeline, chartId, streamCurrentTimeline, viewMode]);
  const astronomicalData = chartDetails || chartData?.chart_data?.astronomical_calculations;

  // Check if interpretation has actual content (not just placeholders).
  // Requires at least ONE insight field (career, health, etc.) to have real content.
  // `isPlaceholderContent` is imported from ./exportGate (single source of truth
  // for the placeholder rules, also used by the Export PDF gate).
  const hasValidInterpretation = (() => {
    if (!interpretation) return false;
    // Check insight fields for valid content (summary alone is not enough)
    const careerContent = interpretation.career_guidance?.layman || interpretation.career_guidance?.technical;
    const healthContent = interpretation.health_guidance?.layman || interpretation.health_guidance?.technical;
    const relationshipContent = interpretation.relationship_guidance?.layman || interpretation.relationship_guidance?.technical;
    const spiritualContent = interpretation.spiritual_guidance?.layman || interpretation.spiritual_guidance?.technical;

    // At least one insight field must have real (non-placeholder) content
    const hasValidCareer = careerContent && !isPlaceholderContent(careerContent);
    const hasValidHealth = healthContent && !isPlaceholderContent(healthContent);
    const hasValidRelationship = relationshipContent && !isPlaceholderContent(relationshipContent);
    const hasValidSpiritual = spiritualContent && !isPlaceholderContent(spiritualContent);

    return Boolean(hasValidCareer || hasValidHealth || hasValidRelationship || hasValidSpiritual);
  })();

  // ONE-CLICK EXPORT. Everything the report prints is already persisted on this
  // device, so Export PDF renders and downloads right here — it does not
  // navigate to /report and ask for a second click, and it never prompts.
  //
  // The ONLY precondition is a stored chart (`canExport`). It is deliberately
  // NOT gated on a finished AI reading: that old gate meant a user without an
  // AI key could never export a document that is complete without any AI — the
  // chart, planets, houses, dasha, yogas and assumptions are all deterministic.
  // A missing interpretation just omits one optional section, and the PDF says
  // so in its own words. The assembly is shared with /report
  // (`useReportPdfExport`), so the two entry points cannot drift apart.
  const { exportPdf, pdfError, canExport } = useReportPdfExport(
    resolveReportAudience(viewMode === 'astrologer' ? 'astrologer' : 'you'),
  );

  // A click made while current predictive facts are loading remains explicit
  // user intent. Resume that one queued request only after the facts settle.
  // Mounts, reloads, service-worker activations, deploys, config changes, and
  // predictive-day changes never enter this effect because they cannot set the
  // queue; only `handleRegenerateTimeline` called by its button can.
  useEffect(() => {
    if (
      !timelineRegenerationQueued ||
      !chartId ||
      isLoading ||
      !aiConfigured ||
      isTimelineStreaming ||
      currentTimelineInputState(chartId) === 'pending'
    ) {
      return;
    }
    handleRegenerateTimeline();
  }, [
    aiConfigured,
    chartId,
    handleRegenerateTimeline,
    isLoading,
    isTimelineStreaming,
    predictiveRequestIdentity,
    predictiveStatus,
    timelineRegenerationQueued,
  ]);

  // Extract sidereal context data for the identity strip + chart panels.
  const siderealCtx = astronomicalData?.sidereal_ctx;

  // Extract lagna data with defensive typing
  const rawLagna = siderealCtx?.lagna as Record<string, unknown> | null;
  const lagna = rawLagna ? {
    sign: rawLagna.sign as string | undefined,
    longitude: rawLagna.longitude as number | undefined,
    nakshatra: rawLagna.nakshatra as string | undefined,
    nakshatraPada: rawLagna.nakshatra_pada as number | undefined,
    // The engine's cusp-proximity block (authoritative when present): drives the
    // Birth-time sensitivity callout off the engine's own near-cusp verdict.
    cuspDistanceDeg: rawLagna.lagna_cusp_distance_deg as number | undefined,
    adjacentSign: rawLagna.lagna_adjacent_sign as string | null | undefined,
    isNearCusp: rawLagna.is_near_cusp as boolean | undefined,
  } : null;

  // The Moon's placement for the identity strip (engine keys planets by name;
  // match case-insensitively so the strip never depends on serializer casing).
  const moonPlanet: SiderealPlanet | null = siderealCtx
    ? Object.values(siderealCtx.planets).find((p) => p.name.toLowerCase() === 'moon') ?? null
    : null;
  const moon = moonPlanet
    ? {
        sign: moonPlanet.sign,
        nakshatra: moonPlanet.nakshatra,
        nakshatraPada: moonPlanet.nakshatra_pada,
      }
    : null;

  // Manual birth-time rectification (if any) in effect for this chart: a pure,
  // display-only comparison of the entered vs. effective clock the engine path
  // already produced. Null when no rectification was applied — then the strip
  // renders no rectification line.
  const birthData = chartData?.chart_data?.birth_data ?? null;
  const rectification = birthData ? rectificationDelta(birthData) : null;

  // The headline reading in the selected voice (jargon-free for "you",
  // placement-naming for "astrologer"). Re-derived on every contentMode change.
  const summaryText = personaText(interpretation?.summary, audience);
  const summaryReady = Boolean(summaryText && !isPlaceholderContent(summaryText));

  // Quiet provenance caption under the reading: which model wrote it, when —
  // it makes an explicitly requested Regenerate self-explanatory. Legacy
  // pre-provenance readings degrade to the
  // date alone; with neither stored, the caption is omitted entirely.
  const readingDate = interpretationEntry?.updatedAt
    ? new Date(interpretationEntry.updatedAt).toLocaleDateString(i18n.language, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })
    : null;
  const readingModel = interpretationEntry?.provenance?.model ?? null;
  const readingCaption = readingDate
    ? readingModel
      ? t('dashboard:reading.generated_by', { model: readingModel, date: readingDate })
      : t('dashboard:reading.generated_at', { date: readingDate })
    : null;
  const timelineDate = interpretationEntry?.timeline?.updatedAt
    ? new Date(interpretationEntry.timeline.updatedAt).toLocaleDateString(i18n.language, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })
    : null;
  const timelineModel = interpretationEntry?.timeline?.provenance?.model ?? null;
  const timelineCaption = timelineDate
    ? timelineModel
      ? t('dashboard:timeline.generated_by', { model: timelineModel, date: timelineDate })
      : t('dashboard:timeline.generated_at', { date: timelineDate })
    : null;

  // Show loading state while fetching chart data
  if (isLoading) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center p-8">
        <div className="text-center">
          <Spinner size="lg" className="mx-auto mb-6" />
          <h2 className="text-xl font-bold text-text-primary mb-2">{t('dashboard:loading.title')}</h2>
          <p className="text-text-secondary">{t('dashboard:loading.subtitle')}</p>
        </div>
      </div>
    );
  }

  if (!chartData) {
    // Two genuinely different states, told apart by whether the read REJECTED.
    // Reloading a missing chart only ever reproduces this screen; creating the
    // chart is the action that changes the outcome.
    return queryError ? (
      <ChartReadFailed t={t} />
    ) : (
      <NoChartYet t={t} personName={activeProfileName} />
    );
  }

  // The recovery affordances for a failed REGENERATION, shared by the calm
  // notice and the louder fault strip so both offer the identical way out.
  const regenRecoveryActions = (
    <>
      {isModelUnavailableNotice && Boolean(readLlmSettings().apiKey) && (
        <button
          onClick={handleSwitchToRecommendedModel}
          className="rounded-md border border-ui-border px-3 py-1.5 text-text-secondary transition-colors hover:border-accent-gold/40 hover:text-text-primary"
          data-testid="reading-regen-switch-recommended"
        >
          {t('dashboard:actions.switch_recommended')}
        </button>
      )}
      <button
        onClick={handleRegenerateReading}
        className="underline hover:no-underline"
        data-testid="reading-regen-retry"
      >
        {t('dashboard:actions.retry')}
      </button>
      <Link
        to="/settings/ai"
        className="underline hover:no-underline"
        data-testid="reading-regen-ai-settings"
      >
        {t('dashboard:actions.ai_settings')}
      </Link>
      <button
        onClick={() => setRegenErrorDismissed(true)}
        className="underline hover:no-underline"
        data-testid="reading-regen-dismiss"
      >
        {t('dashboard:actions.dismiss')}
      </button>
    </>
  );

  return (
    <>
      <div className="space-y-10">
        {/* 1 — Identity: who this chart is, and the facts an astrologer reads
               first. The AppLayout header above carries the ONE brand wordmark;
               this page adds no second header. */}
        <IdentityStrip
          name={personName}
          lagna={lagna}
          moon={moon}
          dasha={astronomicalData?.dasha_ctx}
          rectification={rectification}
          timeConfidence={birthData?.birth_time_confidence}
          actions={
            <>
              <ContentModeToggle />
              <button
                type="button"
                onClick={exportPdf}
                disabled={!canExport}
                data-testid="print-chart-button"
                title={canExport ? t('dashboard:actions.export_pdf_title') : t('dashboard:actions.export_pdf_disabled_title')}
                className="inline-flex items-center gap-1.5 rounded-md border border-ui-border px-3 py-1.5 text-sm text-text-secondary transition-colors hover:border-accent-gold/40 hover:text-text-primary disabled:cursor-not-allowed disabled:border-ui-border/60 disabled:text-text-tertiary disabled:hover:border-ui-border/60"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3M4 6h16M4 6a2 2 0 00-2 2v8a2 2 0 002 2h16a2 2 0 002-2V8a2 2 0 00-2-2" />
                </svg>
                {t('dashboard:actions.export_pdf')}
              </button>
              {/* Generate the stable natal reading with the configured AI. Lives
                  in the top actions row (reachable on mobile, unlike the old
                  header slot) and stays present before the first interpretation
                  as well as after an empty result, so recovery has no dead-end.
                  It never waits for or includes time-sensitive predictive facts. */}
              <button
                type="button"
                onClick={handleRegenerateReading}
                disabled={
                  isStreamingInterpretation || isTimelineStreaming || !canRegenerateReading
                }
                data-testid={interpretation ? 'regenerate-reading' : 'generate-reading'}
                title={
                  !canRegenerateReading
                    ? t('dashboard:reading.regen_no_ai')
                    : interpretation
                      ? t('dashboard:actions.regenerate')
                      : t('dashboard:actions.generate')
                }
                className="inline-flex min-h-11 min-w-11 items-center gap-1.5 whitespace-nowrap rounded-md border border-ui-border px-3 py-1.5 text-sm text-text-secondary transition-colors hover:border-accent-gold/40 hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-gold disabled:cursor-not-allowed disabled:border-ui-border/60 disabled:text-text-tertiary disabled:hover:border-ui-border/60"
              >
                {isStreamingInterpretation ? (
                  <Spinner size="sm" />
                ) : (
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                )}
                {interpretation
                  ? t('dashboard:actions.regenerate')
                  : t('dashboard:actions.generate')}
              </button>
              <button
                type="button"
                onClick={handleRegenerateTimeline}
                disabled={
                  isStreamingInterpretation ||
                  isTimelineStreaming ||
                  timelineRegenerationQueued ||
                  !canRegenerateReading
                }
                data-testid={currentTimeline ? 'regenerate-timeline' : 'generate-timeline'}
                title={t('dashboard:actions.refresh_timeline')}
                className="inline-flex min-h-11 min-w-11 items-center gap-1.5 whitespace-nowrap rounded-md border border-ui-border px-3 py-1.5 text-sm text-text-secondary transition-colors hover:border-accent-gold/40 hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-gold disabled:cursor-not-allowed disabled:border-ui-border/60 disabled:text-text-tertiary disabled:hover:border-ui-border/60"
              >
                {isTimelineStreaming || timelineRegenerationQueued ? (
                  <Spinner size="sm" />
                ) : (
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 2m6-2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                )}
                {currentTimeline
                  ? t('dashboard:actions.refresh_timeline')
                  : t('dashboard:actions.generate_timeline')}
              </button>
              <FeedbackWidget page="dashboard" />
              <Link
                to="/settings"
                className="text-text-muted transition-colors hover:text-text-primary"
                data-testid="settings-link"
                title={t('dashboard:actions.settings_title')}
                aria-label={t('dashboard:actions.settings')}
              >
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              </Link>
            </>
          }
        />

        {/* The PDF render failed. Calm, visible, on-screen ONLY (`no-print`) —
            never a silent unhandled rejection, and never printed into a
            document. Mirrors the notice on /report. */}
        {pdfError && (
          <div
            className="no-print flex items-start gap-3 rounded-lg border border-ui-border bg-background-secondary px-4 py-3 text-sm text-text-secondary"
            role="alert"
            data-testid="dashboard-pdf-error"
          >
            <p>{pdfError}</p>
          </div>
        )}

        {/* 2 — Reading status. No AI provider connected: SETUP, not failure —
               the chart on this page is already complete, so the notice leads
               with that and offers the connect door as the next step. */}
        {!aiConfigured && chartId && !hasValidInterpretation && (
          <NarrationUnavailable
            outage="no_key"
            context="fresh"
            testId="interpretation-cta"
            actions={
              <Link
                to="/settings/ai"
                className="inline-flex items-center gap-2 rounded-md border border-ui-border px-3 py-1.5 text-text-secondary transition-colors hover:border-accent-gold/40 hover:text-text-primary"
                data-testid="connect-ai-link"
              >
                {t('dashboard:actions.connect_ai')}
              </Link>
            }
          />
        )}

        {/* The written interpretation is UNAVAILABLE, and no reading exists yet.
            The chart above is still complete — this is one optional extra
            missing, so it renders as a calm, informational aside with the
            mode's own next step, never a red "it failed" block. */}
        {aiConfigured && chartId && !hasValidInterpretation &&
          !isStreamingInterpretation && interpretationStatus === 'error' &&
          streamingError && readingDegradesGracefully && (
          <NarrationUnavailable
            outage={readingOutage}
            context="fresh"
            testId="interpretation-unavailable"
            actions={
              <>
                {isModelUnavailableNotice && Boolean(readLlmSettings().apiKey) && (
                  <button
                    onClick={handleSwitchToRecommendedModel}
                    className="rounded-md border border-ui-border px-3 py-1.5 text-text-secondary transition-colors hover:border-accent-gold/40 hover:text-text-primary"
                    data-testid="switch-recommended-model"
                  >
                    {t('dashboard:actions.switch_recommended')}
                  </button>
                )}
                <button
                  onClick={handleGenerateSeparatedInterpretation}
                  className="underline hover:no-underline"
                  data-testid="interpretation-unavailable-retry"
                >
                  {t('dashboard:actions.retry')}
                </button>
                <Link
                  to="/settings/ai"
                  className="underline hover:no-underline"
                  data-testid="interpretation-unavailable-ai-settings"
                >
                  {t('dashboard:actions.ai_settings')}
                </Link>
              </>
            }
          />
        )}

        {/* Generating (or a GENUINE fault): the 5-section progress checklist
            while streaming, and the louder failure treatment reserved for a
            real defect — a privacy refusal, an app-state error, an
            unclassifiable failure. */}
        {aiConfigured && chartId &&
          (isStreamingInterpretation ||
            (!hasValidInterpretation &&
              interpretationStatus === 'error' &&
              !readingDegradesGracefully)) && (
          <Card
            title={
              isStreamingInterpretation
                ? t('dashboard:generation.title_generating_natal')
                : t('dashboard:generation.title_failed')
            }
            actions={isStreamingInterpretation ? <Spinner size="sm" /> : undefined}
            data-testid="interpretation-progress"
          >
            <p className="text-sm text-text-secondary" data-testid="interpretation-elapsed">
              {isStreamingInterpretation
                ? t('dashboard:generation.elapsed', { elapsed: formatElapsed(interpElapsed) })
                : null}
            </p>

            {!isStreamingInterpretation && streamingError && (
              <div
                className="mt-2 text-sm text-status-error"
                data-testid="interpretation-error"
              >
                <p>{streamingError}</p>
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <button
                    onClick={handleGenerateSeparatedInterpretation}
                    className="underline hover:no-underline"
                  >
                    {t('dashboard:actions.retry')}
                  </button>
                  <Link to="/settings/ai" className="underline hover:no-underline">
                    {t('dashboard:actions.ai_settings')}
                  </Link>
                </div>
              </div>
            )}

            {isStreamingInterpretation && (
              <ul className="mt-4 max-w-sm space-y-1 text-sm text-text-secondary">
                {interpretationSections.map((s) => (
                  <li key={s.key} className="flex items-center justify-between">
                    <span>{t(`dashboard:sections.${s.key}`)}</span>
                    <span
                      className={
                        s.failed
                          ? 'text-status-error'
                          : s.complete
                            ? 'text-status-success'
                            : 'text-text-tertiary'
                      }
                    >
                      {s.failed ? '✗' : s.complete ? '✓' : '…'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}

        {aiConfigured && chartId &&
          (isTimelineStreaming || timelineStatus === 'error') && (
          <Card
            title={
              isTimelineStreaming
                ? t('dashboard:generation.title_generating_timeline')
                : t('dashboard:generation.title_timeline_failed')
            }
            actions={isTimelineStreaming ? <Spinner size="sm" /> : undefined}
            data-testid="timeline-progress"
          >
            {isTimelineStreaming ? (
              <>
                <p className="text-sm text-text-secondary" data-testid="timeline-elapsed">
                  {t('dashboard:generation.timeline_elapsed', {
                    elapsed: formatElapsed(timelineElapsed),
                  })}
                </p>
                <ul className="mt-4 max-w-sm space-y-1 text-sm text-text-secondary">
                  {timelineSections.map((section) => (
                    <li key={section.key} className="flex items-center justify-between">
                      <span>{t(`dashboard:sections.${section.key}`)}</span>
                      <span
                        className={
                          section.failed
                            ? 'text-status-error'
                            : section.complete
                              ? 'text-status-success'
                              : 'text-text-tertiary'
                        }
                      >
                        {section.failed ? '✗' : section.complete ? '✓' : '…'}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <div className="space-y-3 text-sm text-text-secondary" role="alert">
                <p>{timelineError}</p>
                <button
                  type="button"
                  onClick={handleRegenerateTimeline}
                  className="underline hover:no-underline"
                  data-testid="timeline-retry"
                >
                  {t('dashboard:actions.retry')}
                </button>
              </div>
            )}
          </Card>
        )}

        {/* 3 — The reading: the AI summary as open editorial prose (no
               accordion), with the timely "this period" note and the door to
               the full interpretation. */}
        {summaryReady && interpretation && (
          <section className="space-y-5" data-testid="reading-section">
            <header>
              <h2 className="font-display text-xl text-text-primary">
                {t('life:reading.heading')}
              </h2>
            </header>
            {/* WHY Regenerate is unavailable: no AI configured — with the door
                to AI settings. */}
            {!canRegenerateReading && (
              <p
                className="text-xs leading-relaxed text-text-tertiary"
                data-testid="regenerate-unavailable"
              >
                {t('dashboard:reading.regen_no_ai')}{' '}
                <Link to="/settings/ai" className="underline hover:no-underline">
                  {t('dashboard:actions.ai_settings')}
                </Link>
              </p>
            )}
            {/* A FAILED regeneration must be VISIBLE: keep-old-until-success
                keeps the reading below, and this dismissible strip carries the
                why + the recovery actions (Retry / switch model / AI settings).
                A provider-side outage degrades into the calm notice — the
                reading on screen is untouched, so nothing here is broken. */}
            {interpretationStatus === 'error' && streamingError && !regenErrorDismissed &&
              readingDegradesGracefully && (
              <NarrationUnavailable
                outage={readingOutage}
                context="kept"
                testId="reading-regen-error"
                actions={regenRecoveryActions}
              />
            )}
            {interpretationStatus === 'error' && streamingError && !regenErrorDismissed &&
              !readingDegradesGracefully && (
              <div
                className="flex items-start gap-3 rounded-lg border border-status-error/40 bg-status-error/10 px-4 py-3 text-sm"
                role="alert"
                data-testid="reading-regen-error"
              >
                <div className="space-y-2">
                  <p className="text-status-error">
                    {t('dashboard:generation.regen_failed', { error: streamingError })}
                  </p>
                  <div className="flex flex-wrap items-center gap-3">{regenRecoveryActions}</div>
                </div>
              </div>
            )}
            {/* Honest partial-failure notice: per-section LLM failures degrade
                those sections to empty — say which ones and offer a regenerate
                instead of silently rendering blank sections. */}
            {failedInterpretationSections.length > 0 && (
              <div
                className="text-sm text-text-secondary"
                role="status"
                data-testid="interpretation-partial-failure"
              >
                <p>
                  {t('dashboard:generation.partial_failure', {
                    sections: failedInterpretationSections
                      .map((key) => t(`dashboard:sections.${key}`))
                      .join(', '),
                  })}
                </p>
                <button
                  onClick={handleGenerateSeparatedInterpretation}
                  className="mt-1 underline hover:no-underline"
                  data-testid="interpretation-partial-retry"
                >
                  {t('dashboard:actions.retry')}
                </button>
              </div>
            )}
            <MarkdownContent content={summaryText} />
            {/* The full reading: core narrative (always visible) + collapsible
                depth (yogas, life-area guidance, remedies, the road ahead).
                Voice-driven by `audience`; empty sections drop themselves. */}
            <DashboardInterpretation
              interpretation={interpretation}
              audience={audience}
            />
            {/* Quiet provenance line: which model wrote this reading, when. */}
            {readingCaption && (
              <p
                className="text-[11px] uppercase tracking-[0.18em] text-text-tertiary"
                data-testid="reading-provenance"
              >
                {readingCaption}
              </p>
            )}
            {/* Trust, not hype: a quiet, closed-by-default explainer of WHY this
                reading is grounded (deterministic on-device astronomy,
                externally-validated positions, engine-grounded narration,
                privacy). Static i18n copy — no astrology, no LLM call. */}
            <ReadingGrounding />
          </section>
        )}

        {currentTimeline && (
          <div className="space-y-3">
            {failedTimelineSections.length > 0 ? (
              <p className="text-sm text-text-secondary" data-testid="timeline-partial-failure">
                {t('dashboard:generation.timeline_partial_failure', {
                  sections: failedTimelineSections
                    .map((key) => t(`dashboard:sections.${key}`))
                    .join(', '),
                })}
              </p>
            ) : null}
            <DashboardCurrentTimeline
              currentSky={currentTimeline.current_sky ?? []}
              upcomingPeriods={currentTimeline.upcoming_periods ?? []}
              audience={audience}
              caption={timelineCaption}
            />
          </div>
        )}

        {/* 4 — Life Atlas: the seven-domain centerpiece (engine forecasts,
               lazy compute behind one explicit affordance). */}
        <LifeAtlas />

        {/* 5 — The observatory: 3D force field, kundli and planetary table,
               rendered for both modes (depth lives inside, not in the layout). */}
        <ChartVisualization siderealChart={siderealChart} size={300} />

        {/* 6 — Continue: the deliberate exit to the full timing panel. (Export PDF
               + Feedback now live in the top identity-strip actions row.) */}
        <Card title={t('predictive:page.title')}>
          <div className="flex flex-col gap-4">
            <p className="text-sm leading-relaxed text-text-secondary">
              {t('life:continue.timing_body')}
            </p>
            <Link
              to="/predictive"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-accent-gold transition-colors hover:text-accent-gold-bright"
              data-testid="predictive-link"
            >
              {t('life:continue.open')}
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </Link>
          </div>
        </Card>

        {/* Trust-through-transparency: how this chart was produced (on-device). */}
        <ProvenanceFooter />
      </div>

      {/* Grounded chart Q&A — available in both modes (one surface). */}
      <FloatingChatPanel
        personName={personName}
        profileId={activeProfileId}
        chartId={chartId}
        viewMode={viewMode}
        onAskQuestionStream={handleAskQuestionStream}
        initialOpen={chatInitiallyOpen}
      />
    </>
  );
}
