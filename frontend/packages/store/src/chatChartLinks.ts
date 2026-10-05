/**
 * A chat thread remembers the chart it was started on (`chart_id`). That link is
 * a pointer, not ownership: the thread belongs to its person (`profile_id`).
 * When a chart is replaced (a birth-detail edit or rename regenerates it under
 * a new id) the link can outlive the chart. Dropping just that link keeps every
 * message and summary, and is the one repair shared by the chat store, the boot
 * reconciliation, and the SQLite export/import boundary.
 */

export interface ChartLinkRepair<Thread> {
  readonly threads: Readonly<Record<string, Thread>>;
  /** Thread ids whose `chart_id` named a chart that no longer exists, sorted. */
  readonly unlinkedThreadIds: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Remove `chart_id` from every thread whose chart is not in `liveChartIds`.
 * Only string links are touched: anything malformed is left for the portable
 * validator to refuse. Returns the input object itself when nothing changed.
 */
export function unlinkMissingChartLinks<Thread>(
  threads: Readonly<Record<string, Thread>>,
  liveChartIds: ReadonlySet<string>,
): ChartLinkRepair<Thread> {
  const unlinkedThreadIds: string[] = [];
  const next: Record<string, Thread> = {};
  for (const [threadId, thread] of Object.entries(threads)) {
    if (isRecord(thread) && typeof thread.chart_id === 'string' && !liveChartIds.has(thread.chart_id)) {
      const { chart_id: _dangling, ...kept } = thread;
      next[threadId] = kept as Thread;
      unlinkedThreadIds.push(threadId);
    } else {
      next[threadId] = thread;
    }
  }
  if (unlinkedThreadIds.length === 0) return { threads, unlinkedThreadIds };
  return { threads: next, unlinkedThreadIds: unlinkedThreadIds.sort() };
}
