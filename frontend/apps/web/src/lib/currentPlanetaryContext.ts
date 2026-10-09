import type { SiderealChart } from '@almamesh/browser/types';
import type { ProcessedBirthData } from '@almamesh/shared-types';
import {
  predictiveRequestKey,
  usePredictiveStore,
  type PredictiveRuntime,
} from '@almamesh/store';

import { withDeadline } from './deadline';
import { buildEnsurePredictiveInput, predictiveReferenceInstant } from './predictive';

export interface EnsureCurrentPlanetaryContextInput {
  readonly chart: SiderealChart;
  readonly profileKey: string;
  readonly birth: ProcessedBirthData | undefined;
  readonly chartTimeZone: string;
  readonly now: Date;
  readonly runtime: PredictiveRuntime;
  readonly signal: AbortSignal;
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException('The operation was aborted', 'AbortError');
}

const CURRENT_CONTEXT_TIMEOUT_MS = 60_000;

/** Use the chart-local calendar day as the engine's stable daily reference key. */
export function planetaryReferenceInstantForZone(now: Date, timeZone: string): string {
  return predictiveReferenceInstant(now, timeZone);
}

function withCurrentContextDeadline<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return withDeadline(work, signal, {
    timeoutMs: CURRENT_CONTEXT_TIMEOUT_MS,
    onTimeout: () => new Error('Current planetary context calculation timed out.'),
    failureMessage: 'Current planetary context calculation failed.',
  });
}

/** Join an identical lazy calculation already started by another dashboard surface. */
function waitForCurrentCalculation(
  profileKey: string,
  requestKey: string,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe = () => {};
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      unsubscribe();
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => {
      const reason = signal.reason;
      finish(reason instanceof Error ? reason : new DOMException('The operation was aborted', 'AbortError'));
    };
    const inspect = () => {
      const state = usePredictiveStore.getState();
      if (state.profileKey !== profileKey || state.requestKey !== requestKey) {
        finish(new Error('Current planetary context was superseded by another chart.'));
      } else if (state.status === 'ready') {
        finish();
      } else if (state.status === 'error') {
        finish(new Error('Current planetary context could not be calculated safely.'));
      }
    };
    const timeout = setTimeout(
      () => finish(new Error('Current planetary context calculation timed out.')),
      CURRENT_CONTEXT_TIMEOUT_MS,
    );
    signal.addEventListener('abort', onAbort, { once: true });
    unsubscribe = usePredictiveStore.subscribe(inspect);
    inspect();
  });
}

/**
 * Resolve exact-day predictive facts through the existing on-device engine.
 * The predictive store supplies same-input deduplication and persistence; the
 * checks below prevent a superseded profile/day result from crossing charts.
 */
export async function ensureCurrentPlanetaryContext(
  options: EnsureCurrentPlanetaryContextInput,
): Promise<SiderealChart> {
  throwIfAborted(options.signal);
  const input = buildEnsurePredictiveInput(
    options.profileKey,
    options.birth,
    planetaryReferenceInstantForZone(options.now, options.chartTimeZone),
  );
  if (!input) {
    throw new Error('Current planetary context requires complete birth data.');
  }

  const expectedKey = predictiveRequestKey(input);
  await withCurrentContextDeadline(
    usePredictiveStore.getState().ensurePredictive(options.runtime, input),
    options.signal,
  );
  throwIfAborted(options.signal);

  const afterEnsure = usePredictiveStore.getState();
  if (
    afterEnsure.status === 'loading' &&
    afterEnsure.profileKey === options.profileKey &&
    afterEnsure.requestKey === expectedKey
  ) {
    await waitForCurrentCalculation(options.profileKey, expectedKey, options.signal);
  }

  const state = usePredictiveStore.getState();
  if (
    state.status !== 'ready' ||
    state.profileKey !== options.profileKey ||
    state.requestKey !== expectedKey ||
    state.rawContexts === undefined
  ) {
    throw new Error('Current planetary context could not be calculated safely.');
  }
  return { ...options.chart, ...state.rawContexts };
}
