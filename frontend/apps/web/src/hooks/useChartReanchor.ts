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
    status.settle(chartId);
  };
  waits.set(attempt, release);
  status.begin(chartId);
  limit = setTimeout(release, REANCHOR_WAIT_LIMIT_MS);
}

/** End whatever wait is active for this attempt. */
function endWait(waits: Waits, attempt: string): void {
  waits.get(attempt)?.();
}

export function useChartReanchor(): void {
  const engine = useOptionalChartEngine()?.engine ?? null;
  const queryClient = useQueryClient();
  const activeProfileId = useProfilesStore((s) => s.activeProfileId);
  const charts = useChartLibraryStore((s) => s.charts);
  const chart = selectPrimaryStoredChart(charts, activeProfileId);
  const today = useDailyReferenceInstant(viewerTimeZone());
  // A chart that records no instant at all (the oldest backups) is behind too.
  const behind = chart !== undefined &&
    (!storedChartRecordsInstant(chart) || storedChartReferenceDay(chart, today) < today);
  // Per attempt (`chartId|day`): the active wait, and whether the recompute
  // started / finished. Refs survive StrictMode's simulated remount.
  const waits = useRef<Waits>(new Map());
  const attempted = useRef(new Set<string>());
  const finished = useRef(new Set<string>());
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
    const attempt = `${chartId}|${today}`;
    if (finished.current.has(attempt)) {
      return;
    }
    // Chat waits from the moment a re-anchor is DUE, not from when the engine
    // is up to run it, and again whenever the recompute starts (or a remount
    // happens) with no wait active: an answer streamed across the recompute
    // would be discarded.
    beginWait(waits.current, attempt, chartId);
    if (!engine || attempted.current.has(attempt)) {
      return;
    }
    attempted.current.add(attempt);
    const deps = {
      engine,
      library: useChartLibraryStore.getState(),
      referenceInstant: newChartReferenceInstant(),
    };
    reanchorChart(chartId, deps)
      .then((saved) => {
        if (saved) {
          void queryClient.invalidateQueries({ queryKey: ['primary-chart'] });
        }
      })
      .catch((reason: unknown) => safeWarn('chart.reanchor_failed', reason))
      .finally(() => {
        finished.current.add(attempt);
        endWait(waits.current, attempt);
      });
  }, [engine, chartId, behind, today, queryClient]);
}
