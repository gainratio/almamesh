import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

import { applyServiceWorkerUpdate } from '../swUpdate';

interface StubWorker {
  state: string;
  postMessage: ReturnType<typeof vi.fn>;
  addEventListener: (type: string, fn: () => void) => void;
  removeEventListener: (type: string, fn: () => void) => void;
  fireStateChange: (state: string) => void;
}

function stubWorker(state = 'installed'): StubWorker {
  const listeners = new Set<() => void>();
  return {
    state,
    postMessage: vi.fn(),
    addEventListener: (_t, fn) => listeners.add(fn),
    removeEventListener: (_t, fn) => listeners.delete(fn),
    fireStateChange(next: string) {
      this.state = next;
      listeners.forEach((fn) => fn());
    },
  };
}

/** A browser with a service worker registration in a given shape. */
function stubEnv(opts: {
  registration?: Record<string, unknown> | null;
  noServiceWorker?: boolean;
}) {
  const reload = vi.fn();
  const controllerChange = new Set<() => void>();
  const controller = { postMessage: vi.fn() };
  vi.stubGlobal(
    'navigator',
    opts.noServiceWorker
      ? {}
      : {
          serviceWorker: {
            controller,
            getRegistration: vi.fn().mockResolvedValue(opts.registration ?? null),
            addEventListener: (_t: string, fn: () => void) => controllerChange.add(fn),
            removeEventListener: (_t: string, fn: () => void) => controllerChange.delete(fn),
          },
        },
  );
  vi.stubGlobal('window', { location: { reload } });
  return {
    reload,
    controller,
    takeControl: () => controllerChange.forEach((fn) => fn()),
  };
}

// applyServiceWorkerUpdate arms a fallback reload timer. On the fake clock it
// is dropped with the clock; on the real one it would fire after the DOM
// environment is gone and touch the unstubbed `navigator`.
beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('applyServiceWorkerUpdate', () => {
  it('sends SKIP_WAITING to the WAITING worker, never to the active controller', async () => {
    const waiting = stubWorker();
    const env = stubEnv({ registration: { waiting, update: vi.fn() } });

    await applyServiceWorkerUpdate({ reload: env.reload });

    expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    // The old, active worker ignores SKIP_WAITING — messaging it is the defect.
    expect(env.controller.postMessage).not.toHaveBeenCalled();
  });

  it('re-checks sw.js when nothing is waiting yet — the version-poller case', async () => {
    // The poller notices a deploy before the browser has looked for a new
    // worker. Without registration.update() there is nothing to activate.
    const waiting = stubWorker();
    const registration: Record<string, unknown> = { waiting: null, update: vi.fn() };
    (registration.update as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      registration.waiting = waiting;
    });
    const env = stubEnv({ registration });

    await applyServiceWorkerUpdate({ reload: env.reload });

    expect(registration.update).toHaveBeenCalled();
    expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
  });

  it('waits for an installing worker to finish before messaging it', async () => {
    const installing = stubWorker('installing');
    const registration: Record<string, unknown> = {
      waiting: null,
      installing,
      update: vi.fn().mockResolvedValue(undefined),
    };
    const env = stubEnv({ registration });

    const done = applyServiceWorkerUpdate({ reload: env.reload });
    await Promise.resolve();
    registration.waiting = installing;
    installing.fireStateChange('installed');
    await done;

    expect(installing.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
  });

  it('reloads once the new worker takes control', async () => {
    const waiting = stubWorker();
    const env = stubEnv({ registration: { waiting, update: vi.fn() } });

    await applyServiceWorkerUpdate({ reload: env.reload });
    expect(env.reload).not.toHaveBeenCalled();

    env.takeControl();
    expect(env.reload).toHaveBeenCalledTimes(1);
  });

  it('reloads anyway when the worker never takes control — no dead button', async () => {
    vi.useFakeTimers();
    const waiting = stubWorker();
    const env = stubEnv({ registration: { waiting, update: vi.fn() } });

    await applyServiceWorkerUpdate({ reload: env.reload, timeoutMs: 5_000 });
    expect(env.reload).not.toHaveBeenCalled();

    vi.advanceTimersByTime(5_000);
    expect(env.reload).toHaveBeenCalledTimes(1);
  });

  it('reloads exactly once when control changes AND the timeout fires', async () => {
    vi.useFakeTimers();
    const waiting = stubWorker();
    const env = stubEnv({ registration: { waiting, update: vi.fn() } });

    await applyServiceWorkerUpdate({ reload: env.reload, timeoutMs: 5_000 });
    env.takeControl();
    vi.advanceTimersByTime(10_000);

    expect(env.reload).toHaveBeenCalledTimes(1);
  });

  it('falls back to a plain reload when there is nothing to activate', async () => {
    const env = stubEnv({ registration: { waiting: null, update: vi.fn() } });

    await applyServiceWorkerUpdate({ reload: env.reload });

    expect(env.reload).toHaveBeenCalledTimes(1);
  });

  it('falls back to a plain reload when the browser has no service worker', async () => {
    const env = stubEnv({ noServiceWorker: true });

    await applyServiceWorkerUpdate({ reload: env.reload });

    expect(env.reload).toHaveBeenCalledTimes(1);
  });

  it('falls back to a plain reload when the update check throws', async () => {
    const registration = {
      waiting: null,
      update: vi.fn().mockRejectedValue(new Error('offline')),
    };
    const env = stubEnv({ registration });

    await expect(applyServiceWorkerUpdate({ reload: env.reload })).resolves.toBeUndefined();
    expect(env.reload).toHaveBeenCalledTimes(1);
  });
});
