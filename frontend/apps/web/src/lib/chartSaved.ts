/**
 * The one wait a page runs before it leaves, or says "saved", after a chart
 * write. It turns the store's strict barrier into a typed, bounded outcome.
 *
 * - A failed SQLite/OPFS write rejects with `ChartSaveError('failed')`.
 * - A write that never settles (another tab holds the dataset lease) rejects
 *   with `ChartSaveError('timed_out')` after `CHART_SAVE_TIMEOUT_MS`, so the
 *   page shows its Retry instead of "saving" forever.
 *
 * Either way it logs a fixed console code and never the cause, which could
 * carry birth data.
 */
import { safeWarn } from '@almamesh/shared-types';
import { whenChartLibraryCommitted } from '@almamesh/store';

/**
 * A chart-library commit is one SQLite row and normally lands in milliseconds;
 * the dataset lease is rechecked every second. 30 s is ~30 lease rechecks and
 * the same order as the engine's 60 s request timeout, while still giving a
 * stuck user a Retry inside half a minute.
 */
export const CHART_SAVE_TIMEOUT_MS = 30_000;

export type ChartSaveFailure = 'failed' | 'timed_out';

export class ChartSaveError extends Error {
  readonly reason: ChartSaveFailure;

  constructor(reason: ChartSaveFailure) {
    super(reason === 'failed' ? 'The chart could not be saved.' : 'Saving the chart timed out.');
    this.name = 'ChartSaveError';
    this.reason = reason;
  }
}

interface CancellableTimeout {
  readonly promise: Promise<never>;
  readonly cancel: () => void;
}

function timeoutAfter(ms: number): CancellableTimeout {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ChartSaveError('timed_out')), ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

/** Resolve once the chart library is on disk; reject (and log a code) otherwise. */
export async function waitForChartSaved(): Promise<void> {
  const timeout = timeoutAfter(CHART_SAVE_TIMEOUT_MS);
  try {
    await Promise.race([whenChartLibraryCommitted(), timeout.promise]);
  } catch (error) {
    const failure = error instanceof ChartSaveError ? error : new ChartSaveError('failed');
    safeWarn(failure.reason === 'timed_out' ? 'chart.save_timed_out' : 'chart.save_failed');
    throw failure;
  } finally {
    timeout.cancel();
  }
}
