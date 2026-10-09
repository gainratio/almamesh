/**
 * usePredictiveLayer — the single seam between UI surfaces and the LAZY
 * predictive store (`usePredictiveStore`).
 *
 * Reads the active profile's primary chart + the booted engine, builds the
 * EXPLICIT `ensurePredictive` input (UTC-midnight reference instant, birth UTC
 * instant + coordinates) and exposes `compute()` plus the adapted contexts.
 * With `auto: true` it kicks the (idempotent) computation off shortly after the
 * engine is ready — the kickoff is DEFERRED (idle/short-timeout) and CANCELLED
 * on unmount, so the single serial Pyodide worker stays free if the user
 * navigates away immediately (e.g. to the rectification live preview) instead
 * of starving that interactive call behind the ~30s predictive job. Used by the
 * Life Atlas (dashboard) and the Sky & Timing (/life) panel, which both
 * auto-compute on chart-ready so the domain cards render without any manual
 * button.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  useChartLibraryStore,
  usePredictiveStore,
  useProfilesStore,
  predictiveRequestKey,
  type CachedPredictiveContexts,
  type PredictiveStatus,
} from '@almamesh/store';
import type {
  DomainsCtx,
  ProcessedBirthData,
  StrengthCtx,
  TransitCtx,
  VargaCtxFull,
} from '@almamesh/shared-types';
import type { VimshottariDasha } from '@almamesh/browser/types';
import { useOptionalChartEngine } from '../providers/chartEngineContext';
import {
  buildEnsurePredictiveInput,
  selectPrimaryStoredChart,
} from '../lib/predictive';
import { useRectificationGate } from '../lib/rectificationGate';
import { storedChartReferenceDay, viewerTimeZone } from '../lib/analysisInstant';
import { useDailyReferenceInstant } from './useDailyReferenceInstant';

/**
 * The deferred auto-kickoff delay (ms). It is a HARD floor, NOT an idle hint:
 * the predictive compute must not begin until the Life Atlas has stayed mounted
 * this long, so a user who lands on the dashboard and immediately navigates
 * elsewhere (e.g. to the rectification preview) unmounts it FIRST and the
 * pending kickoff is cancelled — keeping the single serial Pyodide worker free
 * for that interactive call. (Measured: the dashboard-visit-then-navigate
 * window in the rectification flow unmounts within ~0.6s of engine-ready, so
 * 2.5s gives a comfortable cancel margin.) A user who STAYS still sees the Life
 * Atlas populate within a few seconds — well inside its loading affordance.
 *
 * NOTE deliberately a plain `setTimeout`, NOT `requestIdleCallback`: rIC fires
 * the instant the MAIN thread goes idle (~250ms after engine-ready here), which
 * is far too eager — it would start the predictive compute before the user can
 * navigate away, exactly the starvation this defer exists to prevent. The
 * delay must be a real elapsed-time floor.
 */
const AUTO_KICKOFF_DELAY_MS = 2500;

/** An opaque handle for a scheduled kickoff so it can be cancelled exactly. */
interface ScheduledKickoff {
  readonly id: ReturnType<typeof setTimeout>;
}

/**
 * Defer `run` by a hard {@link AUTO_KICKOFF_DELAY_MS} floor. Returns a handle
 * for {@link cancelKickoff} so an unmount (or a re-schedule) before the floor
 * elapses cancels it exactly — no leak, no double-fire.
 */
function scheduleKickoff(run: () => void): ScheduledKickoff {
  return { id: setTimeout(run, AUTO_KICKOFF_DELAY_MS) };
}

function cancelKickoff(handle: ScheduledKickoff): void {
  clearTimeout(handle.id);
}

export interface PredictiveLayer {
  readonly status: PredictiveStatus;
  readonly error?: string;
  readonly transitCtx?: TransitCtx;
  readonly vargaCtxFull?: VargaCtxFull;
  readonly strengthCtx?: StrengthCtx;
  readonly domainsCtx?: DomainsCtx;
  /**
   * The raw calculation contexts (Spec 062 delta 1). A live Worker result also
   * carries Assay explanations plus Avow receipts/signer for current-boot
   * verification; a rehydrated cache keeps calculations but expires that proof.
   * Same cache-match gating as the adapted contexts above: undefined for a
   * stale or not-yet-computed cache.
   */
  readonly rawContexts?: CachedPredictiveContexts;
  /** The booted Pyodide engine is available. */
  readonly engineReady: boolean;
  /** The stored chart carries the birth fields the engine needs. */
  readonly hasBirthData: boolean;
  /** Engine ready AND birth data present — `compute()` will actually run. */
  readonly canCompute: boolean;
  /** Kick off (or retry) the idempotent lazy computation. */
  readonly compute: () => void;
  /**
   * The natal chart's engine-emitted Vimśottarī payload (verbatim from the
   * stored `sidereal_chart`) — available WITHOUT any predictive compute, so
   * the Periods surfaces render instantly. Absent on older stored charts.
   */
  readonly natalDashas?: VimshottariDasha;
  /** IANA zone of the birthplace (absent on a chart stored without one). */
  readonly birthTimeZone?: string;
}

export interface UsePredictiveLayerOptions {
  /** Start computing as soon as the engine + chart are available. */
  readonly auto?: boolean;
}

export function usePredictiveLayer({ auto = false }: UsePredictiveLayerOptions = {}): PredictiveLayer {
  const engineCtx = useOptionalChartEngine();
  const engine = engineCtx?.engine ?? null;

  const status = usePredictiveStore((s) => s.status);
  const error = usePredictiveStore((s) => s.error);
  const transitCtx = usePredictiveStore((s) => s.transitCtx);
  const vargaCtxFull = usePredictiveStore((s) => s.vargaCtxFull);
  const strengthCtx = usePredictiveStore((s) => s.strengthCtx);
  const domainsCtx = usePredictiveStore((s) => s.domainsCtx);
  const rawContexts = usePredictiveStore((s) => s.rawContexts);
  const loadedProfileKey = usePredictiveStore((s) => s.profileKey);
  const loadedRequestKey = usePredictiveStore((s) => s.requestKey);
  const ensurePredictive = usePredictiveStore((s) => s.ensurePredictive);

  const activeProfileId = useProfilesStore((s) => s.activeProfileId);
  const charts = useChartLibraryStore((s) => s.charts);
  const storedChart = selectPrimaryStoredChart(charts, activeProfileId);
  const birth = storedChart?.birth_data as ProcessedBirthData | undefined;
  const profileKey = activeProfileId ?? storedChart?.chart_id ?? 'primary';

  // ONE analysis instant (#274): the predictive layer is computed for the
  // chart's own analysis day, never the wall clock, so the Life Atlas and Sky
  // & Timing cannot name a day the chart's running daśā was not computed for.
  // The chart is re-anchored to today by `useChartReanchor`; only a chart that
  // records no instant at all falls back to the viewer's daily wall-clock day.
  const todayDay = useDailyReferenceInstant(viewerTimeZone());
  const referenceInstant = storedChart ? storedChartReferenceDay(storedChart, todayDay) : todayDay;
  const input = useMemo(
    () => buildEnsurePredictiveInput(profileKey, birth, referenceInstant),
    [profileKey, birth, referenceInstant],
  );
  const expectedRequestKey = input ? predictiveRequestKey(input) : undefined;
  const cacheMatchesInput =
    expectedRequestKey !== undefined && loadedRequestKey === expectedRequestKey;
  // Never pair one natal chart with another chart's predictive superset. A
  // stale ready/error payload is presented as absent until this exact birth
  // input + reference instant has been computed.
  const visibleStatus: PredictiveStatus = cacheMatchesInput ? status : 'idle';

  const compute = useCallback(() => {
    if (engine && input) {
      void ensurePredictive(engine, input);
    }
  }, [engine, input, ensurePredictive]);

  // Auto mode: start once the engine + chart are there — but DEFER the kickoff
  // (idle/short-timeout) and CANCEL it on cleanup. Deferring keeps the single
  // serial Pyodide worker free on dashboard mount so an interactive engine call
  // (e.g. the rectification live preview) is not queued behind the ~30s
  // predictive job; cancelling on unmount means navigating away before the
  // timer elapses frees the engine entirely. Never auto-retries an error (that
  // stays a human decision); recomputes when the profile changed under an
  // already-ready store (ensurePredictive is idempotent per key).
  // Suppress auto-start while the rectification wizard is mounted so the single
  // serial Pyodide worker stays free for the interactive rectification call.
  const rectGateActive = useRectificationGate((s) => s.active);

  const pendingKickoff = useRef<ScheduledKickoff | null>(null);
  useEffect(() => {
    if (!auto || !engine || !input || rectGateActive) {
      return;
    }
    const staleInput = loadedProfileKey !== profileKey || !cacheMatchesInput;
    if (status !== 'idle' && !staleInput) {
      return;
    }
    // Clear any prior pending handle before re-scheduling so we never stack
    // (or double-fire) kickoffs across re-renders.
    if (pendingKickoff.current) {
      cancelKickoff(pendingKickoff.current);
    }
    pendingKickoff.current = scheduleKickoff(() => {
      pendingKickoff.current = null;
      compute();
    });
    return () => {
      if (pendingKickoff.current) {
        cancelKickoff(pendingKickoff.current);
        pendingKickoff.current = null;
      }
    };
  }, [
    auto,
    engine,
    input,
    rectGateActive,
    status,
    loadedProfileKey,
    profileKey,
    cacheMatchesInput,
    compute,
  ]);

  return {
    status: visibleStatus,
    error: cacheMatchesInput ? error : undefined,
    transitCtx: cacheMatchesInput ? transitCtx : undefined,
    vargaCtxFull: cacheMatchesInput ? vargaCtxFull : undefined,
    strengthCtx: cacheMatchesInput ? strengthCtx : undefined,
    domainsCtx: cacheMatchesInput ? domainsCtx : undefined,
    rawContexts: cacheMatchesInput ? rawContexts : undefined,
    engineReady: engine !== null,
    hasBirthData: input !== null,
    canCompute: engine !== null && input !== null,
    compute,
    natalDashas: storedChart?.sidereal_chart?.dashas,
    birthTimeZone: birth?.birth_location_details?.timezone || undefined,
  };
}
