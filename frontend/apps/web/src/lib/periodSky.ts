/**
 * Time travel (spec 2026-10-08, "Computing a period's sky"): engine runs for a
 * period other than today. They must NOT go through `usePredictiveStore`: it
 * holds ONE persisted result, and a period compute there would evict today's
 * Life Atlas (which then recomputes for ~30 s on next open).
 *
 * One serial period queue, joined while in flight. Recomputable results are
 * kept in the derived SQLite database, without boot proofs and outside exports.
 * The engine memo retains at most the device's period bound in JavaScript.
 */
import type { PredictiveCallOptions, PredictiveInput } from '@almamesh/browser/types';
import {
  predictiveRequestKey,
  usePredictiveStore,
  withoutBootProof,
  type CachedPredictiveContexts,
  type EnsurePredictiveInput,
  type PredictiveRuntime,
} from '@almamesh/store';

import { abortReason, withDeadline, type DeadlineOptions } from './deadline';
import { periodSkyRows, type PeriodSkyRows } from './periodSkyRows';

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

interface PredictiveStoreSnapshot {
  readonly status: string;
  readonly requestKey?: string;
  readonly rawContexts?: CachedPredictiveContexts;
}

export interface PeriodSkyCacheOptions {
  readonly readStore?: () => PredictiveStoreSnapshot;
  readonly timeoutMs?: number;
  /** Default: SQLite on OPFS. null keeps only the engine's bounded memory memo. */
  readonly rows?: PeriodSkyRows | null;
}

export interface PeriodSkyCache {
  load(input: EnsurePredictiveInput, runtime: PredictiveRuntime, signal: AbortSignal): Promise<CachedPredictiveContexts>;
}

const PERIOD_RETENTION: PredictiveCallOptions = { retention: 'period' };
let engineCalls = 0;
export function periodEngineCallCount(): number { return engineCalls; }

/** The engine's reference instant for a calendar day (the `predictiveReferenceInstant` shape). */
export function periodReferenceInstant(day: string): string {
  return `${day}T00:00:00Z`;
}

/**
 * Exactly the fields the predictive store sends, so the engine memo key matches
 * the store's. A 12-month Day input sends no window and no reading end, so the
 * memo key equals the store's.
 */
function engineInput(input: EnsurePredictiveInput): PredictiveInput {
  return {
    datetimeUtc: input.datetimeUtc,
    latitude: input.latitude,
    longitude: input.longitude,
    referenceInstant: input.referenceInstant,
    utcOffsetMinutes: input.utcOffsetMinutes,
    ...(input.windowMonths === undefined ? {} : { windowMonths: input.windowMonths }),
    ...(input.readingEnd === undefined ? {} : { readingEnd: input.readingEnd }),
  };
}

export function createPeriodSkyCache(options: PeriodSkyCacheOptions): PeriodSkyCache {
  const readStore = options.readStore ?? ((): PredictiveStoreSnapshot => usePredictiveStore.getState());
  const deadline = periodSkyDeadline(options.timeoutMs);
  const rows = options.rows === undefined ? periodSkyRows() : options.rows;
  const swept = new Map<string, Promise<void>>();
  interface Work {
    readonly promise: Promise<CachedPredictiveContexts>;
    readonly reject: (error: Error) => void;
    waiters: number;
    started: boolean;
    abandoned: boolean;
    cancelQueued?: () => void;
  }
  interface Job { readonly work: Work; begin(): void; }
  const inFlight = new Map<string, Work>();
  const queued: Job[] = [];
  let computing = false;
  const abandoned = () => new DOMException('The period is no longer needed.', 'AbortError');

  function drain(): void {
    if (!computing) queued.shift()?.begin();
  }

  function compute(work: Work, input: EnsurePredictiveInput, runtime: PredictiveRuntime): Promise<CachedPredictiveContexts> {
    if (work.abandoned) return Promise.reject(abandoned());
    return new Promise((resolve, reject) => {
      const job: Job = {
        work,
        begin() {
          work.cancelQueued = undefined;
          computing = true;
          // The microtask lets a synchronous abort release its waiter before
          // crossing the worker boundary. Once started, a compute can finish.
          void Promise.resolve().then(() => {
            if (work.abandoned) throw abandoned();
            work.started = true;
            engineCalls += 1;
            return runtime.computePredictive(engineInput(input), PERIOD_RETENTION);
          }).then(resolve, reject).finally(() => {
            computing = false;
            drain();
          });
        },
      };
      work.cancelQueued = () => {
        const index = queued.indexOf(job);
        if (index >= 0) queued.splice(index, 1);
        reject(abandoned());
      };
      queued.push(job);
      drain();
    });
  }

  const start = (key: string, input: EnsurePredictiveInput, runtime: PredictiveRuntime, engineHash?: string) => {
    let resolve!: (value: CachedPredictiveContexts) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<CachedPredictiveContexts>((yes, no) => { resolve = yes; reject = no; });
    const work: Work = { promise, reject, waiters: 0, started: false, abandoned: false };
    // Publish before any asynchronous SQLite read so every caller joins.
    inFlight.set(key, work);
    void Promise.resolve().then(async () => {
      if (work.abandoned) throw abandoned();
      if (!rows || !engineHash) return compute(work, input, runtime);
      await swept.get(engineHash);
      if (work.abandoned) throw abandoned();
      const sweep = !swept.has(engineHash);
      const lookup = rows.lookup(engineHash, predictiveRequestKey(input), sweep);
      if (sweep) {
        swept.set(engineHash, lookup.then((result) => {
          if (result.epoch === undefined) swept.delete(engineHash);
        }, () => { swept.delete(engineHash); }));
      }
      // The session is closed before this resolves. Keep no SQL owner while
      // the engine computes; writing reacquires a separately fenced session.
      const prepared = await lookup.catch(() => undefined);
      if (work.abandoned) throw abandoned();
      if (!prepared || prepared.epoch === undefined) return compute(work, input, runtime);
      const { epoch, hit } = prepared;
      if (hit) return hit;
      const fresh = await compute(work, input, runtime);
      const safe = withoutBootProof(fresh);
      if (safe) await rows.write(engineHash, predictiveRequestKey(input), input.profileKey, safe, epoch).catch(() => undefined);
      return fresh;
    }).then(resolve, reject);
    const settle = (): void => {
      if (inFlight.get(key) === work) inFlight.delete(key);
    };
    promise.then(settle, settle);
    return work;
  };

  return {
    load(input, runtime, signal) {
      if (signal.aborted) return Promise.reject(abortReason(signal));
      const key = predictiveRequestKey(input);
      const store = readStore();
      if (store.status === 'ready' && store.requestKey === key && store.rawContexts) {
        return Promise.resolve(store.rawContexts);
      }
      const engineHash = runtime.identity?.();
      const flightKey = JSON.stringify([engineHash ?? null, key]);
      const work = inFlight.get(flightKey) ?? start(flightKey, input, runtime, engineHash);
      work.waiters += 1;
      return withDeadline(work.promise, signal, deadline).finally(() => {
        work.waiters -= 1;
        if (work.waiters > 0 || work.started) return;
        work.abandoned = true;
        work.cancelQueued?.();
        work.reject(abandoned());
        if (inFlight.get(flightKey) === work) inFlight.delete(flightKey);
      });
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
