/**
 * Which charts are being re-anchored to today right now.
 *
 * `useChartReanchor` recomputes a returning user's chart on the first render of
 * a new day. An answer streamed across that recompute is discarded by design
 * (the chart changed under it), so chat waits while the active chart is listed
 * here. Every attempt is settled whether it lands or fails, so chat can never
 * stay locked.
 */
import { create } from 'zustand';

interface ChartReanchorStatusState {
  readonly pendingChartIds: ReadonlySet<string>;
  readonly begin: (chartId: string) => void;
  readonly settle: (chartId: string) => void;
}

export const useChartReanchorStatus = create<ChartReanchorStatusState>((set) => ({
  pendingChartIds: new Set<string>(),
  begin: (chartId) =>
    set((s) => ({ pendingChartIds: new Set(s.pendingChartIds).add(chartId) })),
  settle: (chartId) =>
    set((s) => {
      const next = new Set(s.pendingChartIds);
      next.delete(chartId);
      return { pendingChartIds: next };
    }),
}));

/** True while this chart is being re-anchored to today. */
export function useChartReanchorPending(chartId: string | null): boolean {
  return useChartReanchorStatus((s) => chartId !== null && s.pendingChartIds.has(chartId));
}
