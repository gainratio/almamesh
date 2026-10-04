import { describe, expect, it } from 'vitest';
import { reportHydrationFailure, whenHydrated } from './hydrationBarrier';

/** A persist API whose hydration never finishes on its own (the boot-hang shape). */
function pendingApi() {
  const listeners = new Set<() => void>();
  return {
    hydrated: false,
    hasHydrated() {
      return this.hydrated;
    },
    onFinishHydration(callback: () => void) {
      listeners.add(callback);
      return () => void listeners.delete(callback);
    },
    finish() {
      this.hydrated = true;
      for (const listener of listeners) listener();
    },
  };
}

const NEVER = Symbol('never settled');
const settledWithin = <T>(promise: Promise<T>, ms = 50) =>
  Promise.race([promise, new Promise<typeof NEVER>((resolve) => setTimeout(() => resolve(NEVER), ms))]);

describe('whenHydrated', () => {
  it('resolves as hydrated when hydration finishes', async () => {
    const api = pendingApi();
    const waiting = whenHydrated(api);
    api.finish();
    await expect(waiting).resolves.toEqual({ status: 'hydrated' });
  });

  it('resolves immediately when there is no persist API', async () => {
    await expect(whenHydrated(undefined)).resolves.toEqual({ status: 'hydrated' });
  });

  it('settles with a typed failure when hydration errors instead of hanging', async () => {
    const api = pendingApi();
    const error = new SyntaxError('Unexpected token r in JSON');
    const waiting = whenHydrated(api);
    reportHydrationFailure(api, error);
    await expect(settledWithin(waiting)).resolves.toEqual({ status: 'failed', error });
  });

  it('settles a wait that starts after the failure was already reported', async () => {
    const api = pendingApi();
    const error = new Error('migrate threw');
    reportHydrationFailure(api, error);
    await expect(settledWithin(whenHydrated(api))).resolves.toEqual({ status: 'failed', error });
  });

  it('reports hydrated again once a later rehydrate succeeds', async () => {
    const api = pendingApi();
    reportHydrationFailure(api, new Error('first attempt'));
    api.finish();
    await expect(whenHydrated(api)).resolves.toEqual({ status: 'hydrated' });
  });
});
