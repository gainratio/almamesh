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

/**
 * List the chart as re-anchoring so chat waits. Returns the release; the wait
 * also ends on its own after `REANCHOR_WAIT_LIMIT_MS`.
 */
function beginWait(chartId: string): () => void {
  const status = useChartReanchorStatus.getState();
  status.begin(chartId);
  const limit = setTimeout(() => status.settle(chartId), REANCHOR_WAIT_LIMIT_MS);
  return () => {
    clearTimeout(limit);
    status.settle(chartId);
  };
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
  // Per attempt: the release of chat's wait, and whether the recompute ran.
  const waits = useRef(new Map<string, () => void>());
  const attempted = useRef(new Set<string>());
  useEffect(() => {
    const pending = waits.current;
    return () => {
      for (const release of pending.values()) release();
    };
  }, []);

  const chartId = chart?.chart_id;
  useEffect(() => {
    if (chartId === undefined || !behind) {
      return;
    }
    const attempt = `${chartId}|${today}`;
    // Chat waits from the moment a re-anchor is DUE, not from when the engine
    // is up to run it: a question sent while the engine boots would otherwise
    // be answered across the recompute and discarded.
    let release = waits.current.get(attempt);
    if (release === undefined) {
      release = beginWait(chartId);
      waits.current.set(attempt, release);
    }
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
      .finally(release);
  }, [engine, chartId, behind, today, queryClient]);
}
