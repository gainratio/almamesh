/**
 * Writes the dataset fence refused on behalf of another realm (a live Replace
 * or repair elsewhere, or a newer generation this realm has not loaded). The
 * in-memory store kept the change, SQLite did not: the UI must say so instead
 * of letting a reload silently lose it.
 */

export type DroppedWriteReason = 'dataset-busy' | 'stale-generation';

export interface DroppedWrite {
  readonly key: string;
  readonly reason: DroppedWriteReason;
  readonly at: number;
}

const MAX_RECORDED = 50;
let droppedWrites: readonly DroppedWrite[] = [];
const listeners = new Set<() => void>();

export function reportDroppedWrite(key: string, reason: DroppedWriteReason): void {
  droppedWrites = [...droppedWrites, { key, reason, at: Date.now() }].slice(-MAX_RECORDED);
  for (const listener of listeners) listener();
}

/** Stable snapshot (same array until the next report), safe for useSyncExternalStore. */
export function readDroppedWrites(): readonly DroppedWrite[] {
  return droppedWrites;
}

export function subscribeDroppedWrites(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam: forget every reported write (a new page load). */
export function resetDroppedWritesForTests(): void {
  droppedWrites = [];
  for (const listener of listeners) listener();
}
