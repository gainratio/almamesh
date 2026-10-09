/**
 * Which charts are being re-anchored to today right now.
 *
 * `useChartReanchor` recomputes a returning user's chart on the first render of
 * a new day. An answer streamed across that recompute is discarded by design
 * (the chart changed under it), so chat waits while the active chart has any
 * attempt listed here. Every attempt is settled whether it lands or fails, so
 * chat can never stay locked.
 *
 * Waits are keyed by attempt (`chartId|day`), not by chart: at a midnight
 * rollover yesterday's attempt can settle while today's still runs, and its
 * release must not clear today's wait.
 */
import { create } from 'zustand';

/** Pending attempt tokens per chart id. */
type PendingAttempts = ReadonlyMap<string, ReadonlySet<string>>;

interface ChartReanchorStatusState {
  readonly pendingAttempts: PendingAttempts;
  readonly begin: (chartId: string, attempt: string) => void;
  readonly settle: (chartId: string, attempt: string) => void;
}

function withAttempt(pending: PendingAttempts, chartId: string, attempt: string): PendingAttempts {
  const next = new Map(pending);
  next.set(chartId, new Set(pending.get(chartId)).add(attempt));
  return next;
}

function withoutAttempt(pending: PendingAttempts, chartId: string, attempt: string): PendingAttempts {
  const attempts = new Set(pending.get(chartId));
  attempts.delete(attempt);
  const next = new Map(pending);
  if (attempts.size === 0) next.delete(chartId);
  else next.set(chartId, attempts);
  return next;
}

export const useChartReanchorStatus = create<ChartReanchorStatusState>((set) => ({
  pendingAttempts: new Map(),
  begin: (chartId, attempt) =>
    set((s) => ({ pendingAttempts: withAttempt(s.pendingAttempts, chartId, attempt) })),
  settle: (chartId, attempt) =>
    set((s) => ({ pendingAttempts: withoutAttempt(s.pendingAttempts, chartId, attempt) })),
}));

/** True while any attempt to re-anchor this chart to today is in flight. */
export function useChartReanchorPending(chartId: string | null): boolean {
  return useChartReanchorStatus((s) => chartId !== null && s.pendingAttempts.has(chartId));
}
