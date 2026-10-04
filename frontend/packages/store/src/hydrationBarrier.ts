interface HydrationApi {
  hasHydrated(): boolean;
  onFinishHydration(callback: () => void): () => void;
}

/**
 * How a persisted store's hydration ended. A failure is a value, not a hang:
 * zustand's persist never fires `onFinishHydration` when `getItem`, `JSON.parse`
 * or `migrate` throws, so a barrier that only listened for success waited
 * forever and the app's first render (which awaits it) never happened.
 */
export type HydrationOutcome =
  | { readonly status: 'hydrated' }
  | { readonly status: 'failed'; readonly error: unknown };

const HYDRATED: HydrationOutcome = { status: 'hydrated' };
const failures = new WeakMap<object, unknown>();
const failureListeners = new WeakMap<object, Set<(error: unknown) => void>>();

/** Record that `api`'s hydration threw; every pending and later wait settles as failed. */
export function reportHydrationFailure(api: object, error: unknown): void {
  failures.set(api, error);
  for (const listener of failureListeners.get(api) ?? []) listener(error);
}

function onHydrationFailure(api: object, listener: (error: unknown) => void): () => void {
  const listeners = failureListeners.get(api) ?? new Set();
  failureListeners.set(api, listeners);
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

function settledOutcome(api: HydrationApi): HydrationOutcome | undefined {
  if (api.hasHydrated()) return HYDRATED;
  return failures.has(api) ? { status: 'failed', error: failures.get(api) } : undefined;
}

/** Wait without missing hydration that finishes (or fails) between the check and subscription. */
export function whenHydrated(api: HydrationApi | undefined): Promise<HydrationOutcome> {
  if (api === undefined) return Promise.resolve(HYDRATED);
  const already = settledOutcome(api);
  if (already !== undefined) return Promise.resolve(already);
  return new Promise((resolve) => {
    let settled = false;
    const unsubscribers: (() => void)[] = [];
    const finish = (outcome: HydrationOutcome) => {
      if (settled) return;
      settled = true;
      for (const unsubscribe of unsubscribers) unsubscribe();
      resolve(outcome);
    };
    unsubscribers.push(api.onFinishHydration(() => finish(HYDRATED)));
    unsubscribers.push(onHydrationFailure(api, (error) => finish({ status: 'failed', error })));
    const raced = settledOutcome(api);
    if (raced !== undefined) finish(raced);
  });
}
