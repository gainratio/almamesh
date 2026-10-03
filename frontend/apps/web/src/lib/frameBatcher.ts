/**
 * Coalesce rapid keyed updates into at most one flush per animation frame.
 *
 * A streamed section reports progress on every token; setting React state on
 * each would re-render the dashboard dozens of times a second, which stalls
 * low-end phones. Only the latest value per key survives to the next frame.
 * After `cancel()` (unmount) nothing is scheduled or flushed again.
 */
export interface FrameBatcher<T> {
  push(key: string, value: T): void;
  cancel(): void;
}

export function createFrameBatcher<T>(
  flush: (latest: Readonly<Record<string, T>>) => void,
  schedule: (cb: FrameRequestCallback) => number = (cb) => requestAnimationFrame(cb),
  unschedule: (id: number) => void = (id) => cancelAnimationFrame(id),
): FrameBatcher<T> {
  let pending: Record<string, T> = {};
  let frame: number | null = null;
  let cancelled = false;

  return {
    push(key, value) {
      if (cancelled) return;
      pending[key] = value;
      if (frame !== null) return;
      frame = schedule(() => {
        frame = null;
        const latest = pending;
        pending = {};
        flush(latest);
      });
    },
    cancel() {
      cancelled = true;
      if (frame !== null) unschedule(frame);
      frame = null;
      pending = {};
    },
  };
}
