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
 * While an attempt runs, the chart is listed in `useChartReanchorStatus` so chat
 * waits instead of streaming an answer the recompute would discard. The entry
 * is cleared whether the attempt lands or fails.
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
  const attempted = useRef(new Set<string>());

  const chartId = chart?.chart_id;
  useEffect(() => {
    if (!engine || chartId === undefined || !behind) {
      return;
    }
    const attempt = `${chartId}|${today}`;
    if (attempted.current.has(attempt)) {
      return;
    }
    attempted.current.add(attempt);
    const status = useChartReanchorStatus.getState();
    status.begin(chartId);
    reanchorChart(chartId, {
      engine,
      library: useChartLibraryStore.getState(),
      referenceInstant: newChartReferenceInstant(),
    })
      .then((saved) => {
        if (saved) {
          void queryClient.invalidateQueries({ queryKey: ['primary-chart'] });
        }
      })
      .catch((reason: unknown) => safeWarn('chart.reanchor_failed', reason))
      .finally(() => status.settle(chartId));
  }, [engine, chartId, behind, today, queryClient]);
}
