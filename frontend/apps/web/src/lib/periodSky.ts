/**
 * Time travel (spec 2026-10-08, "Computing a period's sky"): engine runs for a
 * period other than today. They must NOT go through `usePredictiveStore`: it
 * holds ONE persisted result, and a period compute there would evict today's
 * Life Atlas (which then recomputes for ~30 s on next open).
 *
 * What this module owns: store reuse, the one-at-a-time period queue with
 * join-while-in-flight, and the waiter's deadline. What it deliberately does
 * NOT own: retaining results. The engine memo (`@almamesh/browser`
 * engineMemo.ts) already keeps settled predictive payloads; calls made with
 * `{ retention: 'period' }` count against its device-tier bound
 * (`devicePolicy().periodSkyCacheSize`: 5 / 3 / 1), so that bound is the only
 * cap on retained period payloads. Memory only, never persisted or exported.
 */
import type { PredictiveCallOptions, PredictiveInput } from '@almamesh/browser/types';
import {
  predictiveRequestKey,
  usePredictiveStore,
  type CachedPredictiveContexts,
  type EnsurePredictiveInput,
  type PredictiveRuntime,
} from '@almamesh/store';

import { abortReason, withDeadline, type DeadlineOptions } from './deadline';

/**
 * One queued Life Atlas compute (~30 s) plus this one (~30 s+). Kept under the
 * agent's 150 s tool cap so the waiter times out first and the tool can say so.
 */
export const PERIOD_SKY_TIMEOUT_MS = 140_000;

export class PeriodSkyTimeoutError extends Error {
  constructor() {
    super('The period sky calculation timed out.');
    this.name = 'PeriodSkyTimeoutError';
  }
}

/** The period waiter's deadline: a timeout reads as `PeriodSkyTimeoutError`. */
export function periodSkyDeadline(timeoutMs: number = PERIOD_SKY_TIMEOUT_MS): DeadlineOptions {
  return {
    timeoutMs,
    onTimeout: () => new PeriodSkyTimeoutError(),
    failureMessage: 'The period sky calculation failed.',
  };
}

export interface PredictiveStoreSnapshot {
  readonly status: string;
  readonly requestKey?: string;
  readonly rawContexts?: CachedPredictiveContexts;
}

export interface PeriodSkyCacheOptions {
  readonly readStore?: () => PredictiveStoreSnapshot;
  readonly timeoutMs?: number;
}

export interface PeriodSkyCache {
  load(input: EnsurePredictiveInput, runtime: PredictiveRuntime, signal: AbortSignal): Promise<CachedPredictiveContexts>;
}

const PERIOD_RETENTION: PredictiveCallOptions = { retention: 'period' };

/** The engine's reference instant for a calendar day (the `predictiveReferenceInstant` shape). */
export function periodReferenceInstant(day: string): string {
  return `${day}T00:00:00Z`;
}

/** Exactly the fields the predictive store sends, so the engine memo key matches the store's. */
function engineInput(input: EnsurePredictiveInput): PredictiveInput {
  return {
    datetimeUtc: input.datetimeUtc,
    latitude: input.latitude,
    longitude: input.longitude,
    referenceInstant: input.referenceInstant,
    utcOffsetMinutes: input.utcOffsetMinutes,
  };
}

export function createPeriodSkyCache(options: PeriodSkyCacheOptions): PeriodSkyCache {
  const readStore = options.readStore ?? ((): PredictiveStoreSnapshot => usePredictiveStore.getState());
  const deadline = periodSkyDeadline(options.timeoutMs);
  const inFlight = new Map<string, Promise<CachedPredictiveContexts>>();
  let queue: Promise<unknown> = Promise.resolve();

  const start = (key: string, input: EnsurePredictiveInput, runtime: PredictiveRuntime) => {
    // One period compute at a time: the Pyodide worker is serial anyway.
    const run = queue.then(() => runtime.computePredictive(engineInput(input), PERIOD_RETENTION));
    queue = run.catch(() => undefined);
    inFlight.set(key, run);
    const settle = (): void => {
      if (inFlight.get(key) === run) inFlight.delete(key);
    };
    run.then(settle, settle);
    return run;
  };

  return {
    load(input, runtime, signal) {
      if (signal.aborted) return Promise.reject(abortReason(signal));
      const key = predictiveRequestKey(input);
      const store = readStore();
      if (store.status === 'ready' && store.requestKey === key && store.rawContexts) {
        return Promise.resolve(store.rawContexts);
      }
      return withDeadline(inFlight.get(key) ?? start(key, input, runtime), signal, deadline);
    },
  };
}

let shared: PeriodSkyCache | undefined;

/** This tab's period-sky queue. */
export function periodSkyCache(): PeriodSkyCache {
  shared ??= createPeriodSkyCache({});
  return shared;
}

export function __resetPeriodSkyCacheForTest(): void {
  shared = undefined;
}
