/**
 * Keep the active chart's ONE analysis instant on the user's day.
 *
 * Every surface reads the chart's own instant (the provenance footer, the
 * dasha "running" legs, the PDF, every AI prompt) and the predictive layer is
 * pinned to its day (`storedChartReferenceDay`), so they cannot disagree. That
 * pin would freeze a returning visitor's dashboard on the day the chart was
 * calculated; this hook moves the instant forward instead. On the first render
 * of a new day, with the engine booted, it recomputes the chart
 * from its own stored birth as of now (`reanchorChart`), and every surface
 * follows together. No AI is involved, and nothing runs without an engine.
 *
 * At most one attempt per chart per day: a failed recompute leaves the chart as
 * it was (still self-consistent) and is retried tomorrow, never in a loop.
 *
 * From the moment a re-anchor is due (even while the engine still boots) until
 * it settles, the chart is listed in `useChartReanchorStatus` so chat waits
 * instead of streaming an answer the recompute would discard. The entry is
 * cleared whether the attempt lands or fails, and after
 * `REANCHOR_WAIT_LIMIT_MS` at most, so a hung or absent engine cannot lock chat.
 */
import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { safeWarn } from '@almamesh/shared-types';
import {
  newChartReferenceInstant,
  reanchorChart,
  useAyanamsaStore,
  useChartLibraryStore,
  useProfilesStore,
} from '@almamesh/store';

import {
  storedChartRecordsInstant,
  storedChartReferenceDay,
  viewerTimeZone,
} from '../lib/analysisInstant';
import { useChartReanchorStatus } from '../lib/chartReanchorStatus';
import { selectPrimaryStoredChart } from '../lib/predictive';
import { useOptionalChartEngine } from '../providers/chartEngineContext';
import { useDailyReferenceInstant } from './useDailyReferenceInstant';

/** The longest chat waits for a re-anchor before it is enabled anyway. */
export const REANCHOR_WAIT_LIMIT_MS = 30_000;

/** The active wait's release per attempt (`chartId|day`). */
type Waits = Map<string, () => void>;

/**
 * List the chart as re-anchoring so chat waits, unless a wait for this attempt
 * is already active. The wait ends when released or after
 * `REANCHOR_WAIT_LIMIT_MS`; either way its entry is removed, so a later call
 * (the recompute starting late, a StrictMode remount) waits again.
 */
function beginWait(waits: Waits, attempt: string, chartId: string): void {
  if (waits.has(attempt)) {
    return;
  }
  const status = useChartReanchorStatus.getState();
  let limit: ReturnType<typeof setTimeout> | undefined;
  const release = (): void => {
    clearTimeout(limit);
    if (waits.get(attempt) === release) {
      waits.delete(attempt);
    }
    status.settle(chartId, attempt);
  };
  waits.set(attempt, release);
  status.begin(chartId, attempt);
  limit = setTimeout(release, REANCHOR_WAIT_LIMIT_MS);
}

/** End whatever wait is active for this attempt. */
function endWait(waits: Waits, attempt: string): void {
  waits.get(attempt)?.();
}

export function useChartReanchor(): void {
  const engineCtx = useOptionalChartEngine();
  const engine = engineCtx?.engine ?? null;
  const engineError = engineCtx?.error ?? null;
  const startBootstrap = engineCtx?.startBootstrap;
  const queryClient = useQueryClient();
  const activeProfileId = useProfilesStore((s) => s.activeProfileId);
  const ayanamsa = useAyanamsaStore((s) => s.ayanamsa);
  const charts = useChartLibraryStore((s) => s.charts);
  const chart = selectPrimaryStoredChart(charts, activeProfileId);
  const today = useDailyReferenceInstant(viewerTimeZone());
  const storedAyanamsa = (chart?.sidereal_chart?.snapshot?.ayanamsa ?? 'LAHIRI').toUpperCase();
  const ayanamsaChanged = chart !== undefined && storedAyanamsa !== ayanamsa;
  const storedYogas = chart?.sidereal_chart?.yogas ?? [];
  const missingYogaActivation =
    chart !== undefined &&
    chart.sidereal_chart?.snapshot != null &&
    storedYogas.length > 0 &&
    storedYogas.some((yoga) => yoga.dasha_activation == null);
  // A chart that records no instant at all (the oldest backups), uses a
  // different ayanamsa than the active preference, or predates deterministic
  // yoga-dasha activation is behind too.
  const behind =
    chart !== undefined &&
    (!storedChartRecordsInstant(chart) ||
      storedChartReferenceDay(chart, today) < today ||
      ayanamsaChanged ||
      missingYogaActivation);
  // Secondary/family charts whose stored snapshot ayanamsa lags behind the active
  // preference (or whose yogas predate deterministic dasha_activation) also need
  // re-anchoring so Mesh/Match PDF plates never mix ayanamsas or omit activation.
  const staleSecondaryIds = Object.values(charts)
    .filter((c) => {
      if (c.chart_id === chart?.chart_id) return false;
      const secAyanamsa = (c.sidereal_chart?.snapshot?.ayanamsa ?? 'LAHIRI').toUpperCase();
      const secYogas = c.sidereal_chart?.yogas ?? [];
      const secMissingAct =
        c.sidereal_chart?.snapshot != null &&
        secYogas.length > 0 &&
        secYogas.some((yoga) => yoga.dasha_activation == null);
      return secAyanamsa !== ayanamsa || secMissingAct;
    })
    .map((c) => c.chart_id);
  const staleSecondaryKey = staleSecondaryIds.join(',');
  // Per attempt (`chartId|day|ayanamsa`): active wait, in-flight attempts, and
  // FAILED attempts (never record successes so toggling LAHIRI->KP->LAHIRI works).
  const waits = useRef<Waits>(new Map());
  const attempted = useRef(new Set<string>());
  const failed = useRef(new Set<string>());
  useEffect(() => {
    const active = waits.current;
    return () => {
      for (const release of [...active.values()]) release();
    };
  }, []);

  const chartId = chart?.chart_id;
  useEffect(() => {
    if (chartId === undefined || !behind) {
      return;
    }
    const attempt = `${chartId}|${today}|${ayanamsa}${missingYogaActivation ? '|yoga-act' : ''}`;
    if (failed.current.has(attempt)) {
      return;
    }
    // Chat waits from the moment a re-anchor is DUE, not from when the engine
    // is up to run it, and again whenever the recompute starts (or a remount
    // happens) with no wait active: an answer streamed across the recompute
    // would be discarded.
    beginWait(waits.current, attempt, chartId);
    if (!engine) {
      if (!engineError) startBootstrap?.();
      return;
    }
    if (attempted.current.has(attempt)) {
      return;
    }
    attempted.current.add(attempt);
    const deps = {
      engine,
      library: useChartLibraryStore.getState(),
      referenceInstant: newChartReferenceInstant(),
      ayanamsaType: ayanamsa,
    };
    reanchorChart(chartId, deps)
      .then((saved) => {
        if (saved) {
          void queryClient.invalidateQueries({ queryKey: ['primary-chart'] });
        }
      })
      .catch((reason: unknown) => {
        failed.current.add(attempt);
        safeWarn('chart.reanchor_failed', reason);
      })
      .finally(() => {
        attempted.current.delete(attempt);
        endWait(waits.current, attempt);
      });
  }, [
    engine,
    engineError,
    startBootstrap,
    chartId,
    behind,
    missingYogaActivation,
    today,
    ayanamsa,
    queryClient,
  ]);

  // Re-anchor any secondary/family charts whose stored ayanamsa differs.
  useEffect(() => {
    if (!engine || !staleSecondaryKey) return;
    const ids = staleSecondaryKey.split(',').filter(Boolean);
    for (const id of ids) {
      const attempt = `${id}|${today}|${ayanamsa}`;
      if (attempted.current.has(attempt) || failed.current.has(attempt)) continue;
      attempted.current.add(attempt);
      reanchorChart(id, {
        engine,
        library: useChartLibraryStore.getState(),
        referenceInstant: newChartReferenceInstant(),
        ayanamsaType: ayanamsa,
      })
        .catch((reason: unknown) => {
          failed.current.add(attempt);
          safeWarn('chart.reanchor_failed', reason);
        })
        .finally(() => {
          attempted.current.delete(attempt);
        });
    }
  }, [engine, staleSecondaryKey, today, ayanamsa]);
}
