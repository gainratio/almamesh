import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { useEffect, useState } from 'react';

import {
  AlmaMeshRuntime,
  EngineOperationError,
  EngineStorageBlockedError,
  WorkerCrashError,
  type BootStage,
  type ChartEngine,
  type ChartEnginePort,
  type EnginePort,
  type OnStage,
  type RuntimeConfig,
} from '@almamesh/browser';
import { AlmaMeshRuntimeProvider } from '../AlmaMeshRuntimeProvider';
import { useChartEngine } from '../chartEngineContext';
import { clearRuntimeGenerator, clearRuntimeResolvePlace } from '../../lib/runtimeObservability';
import {
  isRollbackRefusal,
  lastEngineBootFailure,
  recordEngineBootFailure,
  teardownLiveEngine,
} from '../../lib/engineLifecycle';

const { recoverSeveredServiceWorkerChannel } = vi.hoisted(() => ({
  recoverSeveredServiceWorkerChannel: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../lib/swSelfHeal', () => ({ recoverSeveredServiceWorkerChannel }));

// The engine only boots once canonical SQLite is durable on OPFS. Every test
// here starts with storage ready; the gating tests drive it explicitly.
const storage = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state = { current: 'opfs' as 'pending' | 'opfs' | 'blocked' | 'unavailable' };
  return {
    state,
    listeners,
    set(next: typeof state.current) {
      state.current = next;
      for (const listener of listeners) listener();
    },
  };
});
const markBlockedByEngine = vi.hoisted(() => vi.fn());
vi.mock('@almamesh/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@almamesh/store')>()),
  markPortableStorageBlockedByEngine: markBlockedByEngine,
  portableStatePersistence: () => storage.state.current,
  subscribePortableStatePersistence: (listener: () => void) => {
    storage.listeners.add(listener);
    return () => storage.listeners.delete(listener);
  },
}));

// The provider gates its mount auto-boot off the marketing landing route
// (path "/" with no saved chart). These tests assert the auto-boot / recovery
// contract, so they must render on a NON-landing route — otherwise the gate
// (correctly) skips the mount boot. Pin a non-landing path for every test here.
beforeEach(() => {
  storage.state.current = 'opfs';
  storage.listeners.clear();
  window.history.pushState({}, '', '/onboarding');
  clearRuntimeGenerator();
});
afterEach(() => {
  clearRuntimeGenerator();
  clearRuntimeResolvePlace();
  window.history.pushState({}, '', '/');
});

/**
 * A minimal stand-in for `AlmaMeshRuntime` that lets a test drive bootstrap
 * outcomes deterministically: each `bootstrap()` call invokes the next queued
 * behavior. This is the same injection seam the real runtime exposes for its own
 * Workers — here we inject the whole runtime so the provider's retry orchestration
 * can be tested without Pyodide/OPFS.
 */
type Behavior = (onStage: OnStage) => Promise<ChartEngine>;

function makeFakeEngine(tag: string): ChartEngine {
  return {
    generateChart: vi.fn(),
    computePredictive: vi.fn(),
    computeMeshEdge: vi.fn(),
    meta: () => ({
      bundle_id: tag,
      version: '0',
      engine_version: '0',
      ephemeris_file: 'de421.bsp',
      ayanamsa: 'lahiri',
      constructs: [],
    }),
  } as unknown as ChartEngine;
}

interface FakeRuntime {
  bootstrap(config: RuntimeConfig, onStage?: OnStage): Promise<ChartEngine>;
  bootstrapCalls: number;
  dispose?: () => void;
}

function makeFakeRuntime(behaviors: Behavior[]): FakeRuntime {
  let i = 0;
  return {
    bootstrapCalls: 0,
    bootstrap(_config: RuntimeConfig, onStage: OnStage = () => {}) {
      this.bootstrapCalls += 1;
      const behavior = behaviors[Math.min(i, behaviors.length - 1)];
      i += 1;
      return behavior(onStage);
    },
  };
}

/** Surfaces the context value onto the DOM + a captured ref for assertions. */
function Probe({ capture }: { capture: (v: ReturnType<typeof useChartEngine>) => void }) {
  const value = useChartEngine();
  useEffect(() => {
    capture(value);
  });
  return (
    <div>
      <span data-testid="engine">{value.engine ? 'engine-ready' : 'no-engine'}</span>
      <span data-testid="error">{value.error ? value.error.message : 'no-error'}</span>
      <span data-testid="reboot">{typeof value.reboot === 'function' ? 'has-reboot' : 'no-reboot'}</span>
      <span data-testid="whenReady">
        {typeof value.whenReady === 'function' ? 'has-whenReady' : 'no-whenReady'}
      </span>
    </div>
  );
}

describe('AlmaMeshRuntimeProvider — durable storage gate', () => {
  it('does not boot the engine while storage is blocked, and boots once it becomes OPFS', async () => {
    storage.state.current = 'blocked';
    const runtime = makeFakeRuntime([(onStage) => {
      onStage({ kind: 'ready' } as BootStage);
      return Promise.resolve(makeFakeEngine('gated'));
    }]);

    render(
      <AlmaMeshRuntimeProvider runtime={runtime}>
        <Probe capture={() => {}} />
      </AlmaMeshRuntimeProvider>,
    );

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(runtime.bootstrapCalls).toBe(0);
    expect(screen.getByTestId('engine').textContent).toBe('no-engine');

    act(() => storage.set('pending'));
    expect(runtime.bootstrapCalls).toBe(0);

    act(() => storage.set('opfs'));
    await waitFor(() => expect(screen.getByTestId('engine').textContent).toBe('engine-ready'));
    expect(runtime.bootstrapCalls).toBe(1);
  });

  it('never boots and surfaces an error when storage is unavailable', async () => {
    storage.state.current = 'blocked';
    const runtime = makeFakeRuntime([() => Promise.resolve(makeFakeEngine('never'))]);

    render(
      <AlmaMeshRuntimeProvider runtime={runtime}>
        <Probe capture={() => {}} />
      </AlmaMeshRuntimeProvider>,
    );
    act(() => storage.set('unavailable'));

    await waitFor(() =>
      expect(screen.getByTestId('error').textContent).toBe(
        'Durable storage is unavailable; the engine needs SQLite on OPFS.',
      ),
    );
    expect(runtime.bootstrapCalls).toBe(0);
  });

  it('does not boot a disposed runtime when storage becomes ready after unmount', async () => {
    storage.state.current = 'blocked';
    const runtime = makeFakeRuntime([() => Promise.resolve(makeFakeEngine('late'))]);
    const view = render(
      <AlmaMeshRuntimeProvider runtime={runtime}>
        <Probe capture={() => {}} />
      </AlmaMeshRuntimeProvider>,
    );
    view.unmount();
    act(() => storage.set('opfs'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(runtime.bootstrapCalls).toBe(0);
  });
});

// @gainratio/browser 0.3.1 refuses its RAM cache (cacheFallback "none") and
// the seam reports EngineStorageBlockedError. Never the generic engine error.
describe('AlmaMeshRuntimeProvider — engine cache refused', () => {
  beforeEach(() => markBlockedByEngine.mockReset().mockImplementation(() => storage.set('blocked')));

  it('opfs-unavailable: shows the storage block screen, then boots once storage is allowed', async () => {
    const runtime = makeFakeRuntime([
      () => Promise.reject(new EngineStorageBlockedError('opfs-unavailable')),
      (onStage) => {
        onStage({ kind: 'ready' } as BootStage);
        return Promise.resolve(makeFakeEngine('after-allow'));
      },
    ]);
    render(
      <AlmaMeshRuntimeProvider runtime={runtime}>
        <Probe capture={() => {}} />
      </AlmaMeshRuntimeProvider>,
    );
    await waitFor(() => expect(markBlockedByEngine).toHaveBeenCalledOnce());
    expect(storage.state.current).toBe('blocked');
    expect(runtime.bootstrapCalls).toBe(1);

    act(() => storage.set('opfs'));
    await waitFor(() => expect(screen.getByTestId('engine').textContent).toBe('engine-ready'));
    expect(runtime.bootstrapCalls).toBe(2);
  });

  it('pool-in-use: surfaces the other-tab error itself and does not loop retrying', async () => {
    const runtime = makeFakeRuntime([() => Promise.reject(new EngineStorageBlockedError('pool-in-use'))]);
    render(
      <AlmaMeshRuntimeProvider runtime={runtime}>
        <Probe capture={() => {}} />
      </AlmaMeshRuntimeProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId('error').textContent).toBe('The engine cache is open in another AlmaMesh tab.'),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(runtime.bootstrapCalls).toBe(1);
    expect(markBlockedByEngine).not.toHaveBeenCalled();
  });
});

describe('AlmaMeshRuntimeProvider — retryable bootstrap', () => {
  it('exposes reboot() and whenReady() on the context value', async () => {
    const runtime = makeFakeRuntime([(onStage) => {
      onStage({ kind: 'ready' } as BootStage);
      return Promise.resolve(makeFakeEngine('a'));
    }]);

    render(
      <AlmaMeshRuntimeProvider runtime={runtime}>
        <Probe capture={() => {}} />
      </AlmaMeshRuntimeProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('engine').textContent).toBe('engine-ready'));
    expect(screen.getByTestId('reboot').textContent).toBe('has-reboot');
    expect(screen.getByTestId('whenReady').textContent).toBe('has-whenReady');
  });

  it('auto-bootstraps exactly once on mount and publishes the ready engine', async () => {
    const runtime = makeFakeRuntime([(onStage) => {
      onStage({ kind: 'ready' } as BootStage);
      return Promise.resolve(makeFakeEngine('once'));
    }]);

    render(
      <AlmaMeshRuntimeProvider runtime={runtime}>
        <Probe capture={() => {}} />
      </AlmaMeshRuntimeProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('engine').textContent).toBe('engine-ready'));
    expect(runtime.bootstrapCalls).toBe(1);
  });

  it('publishes the ready engine generator and clears it before a failed reboot', async () => {
    const ready = makeFakeEngine('generator');
    const chart = { ayanamsa_value: 23.86 } as Awaited<ReturnType<ChartEngine['generateChart']>>;
    vi.mocked(ready.generateChart).mockResolvedValue(chart);
    const runtime = makeFakeRuntime([
      () => Promise.resolve(ready),
      () => Promise.reject(new Error('fresh boot failed')),
    ]);
    let captured: ReturnType<typeof useChartEngine> | null = null;

    render(
      <AlmaMeshRuntimeProvider runtime={runtime}>
        <Probe capture={(value) => {
          captured = value;
        }} />
      </AlmaMeshRuntimeProvider>,
    );

    await waitFor(() => expect(window.__almameshGenerate).toBeTypeOf('function'));
    const birth = {
      datetimeUtc: '1990-03-30T06:30:00Z',
      latitude: 12.97,
      longitude: 77.59,
      referenceDate: '2025-01-01T00:00:00+00:00',
    };
    await expect(window.__almameshGenerate?.(birth)).resolves.toBe(chart);
    expect(ready.generateChart).toHaveBeenCalledWith(birth);

    await act(async () => {
      await expect(captured!.reboot()).rejects.toThrow('fresh boot failed');
    });
    expect(window.__almameshGenerate).toBeUndefined();
  });

  it('clears the place-lookup hook as soon as a reboot starts (final review)', async () => {
    const runtime = makeFakeRuntime([
      () => Promise.resolve(makeFakeEngine('place-hook')),
      () => new Promise<ChartEngine>(() => {}),
    ]);
    let captured: ReturnType<typeof useChartEngine> | null = null;
    render(
      <AlmaMeshRuntimeProvider runtime={runtime}>
        <Probe capture={(value) => {
          captured = value;
        }} />
      </AlmaMeshRuntimeProvider>,
    );
    await waitFor(() => expect(window.__almameshResolvePlace).toBeTypeOf('function'));
    act(() => {
      void captured!.reboot().catch(() => undefined);
    });
    await waitFor(() => expect(runtime.bootstrapCalls).toBe(2));
    expect(window.__almameshResolvePlace).toBeUndefined();
  });

  it('a failed reboot leaves no place-lookup hook behind', async () => {
    const runtime = makeFakeRuntime([
      () => Promise.resolve(makeFakeEngine('place-hook-fail')),
      () => Promise.reject(new Error('fresh boot failed')),
    ]);
    let captured: ReturnType<typeof useChartEngine> | null = null;
    render(
      <AlmaMeshRuntimeProvider runtime={runtime}>
        <Probe capture={(value) => {
          captured = value;
        }} />
      </AlmaMeshRuntimeProvider>,
    );
    await waitFor(() => expect(window.__almameshResolvePlace).toBeTypeOf('function'));
    await act(async () => {
      await expect(captured!.reboot()).rejects.toThrow('fresh boot failed');
    });
    expect(window.__almameshResolvePlace).toBeUndefined();
  });

  it('whenReady() resolves with the in-flight bootstrap result (shared, no extra bootstrap)', async () => {
    let resolveBoot!: (e: ChartEngine) => void;
    const ready = makeFakeEngine('shared');
    const runtime = makeFakeRuntime([
      () => new Promise<ChartEngine>((res) => {
        resolveBoot = res;
      }),
    ]);

    let captured: ReturnType<typeof useChartEngine> | null = null;
    render(
      <AlmaMeshRuntimeProvider runtime={runtime}>
        <Probe capture={(v) => {
          captured = v;
        }} />
      </AlmaMeshRuntimeProvider>,
    );

    await waitFor(() => expect(captured).not.toBeNull());
    // Engine not ready yet (still warming).
    expect(screen.getByTestId('engine').textContent).toBe('no-engine');

    const whenReadyPromise = captured!.whenReady();
    // Let the in-flight bootstrap complete.
    await act(async () => {
      resolveBoot(ready);
      await whenReadyPromise;
    });

    await expect(whenReadyPromise).resolves.toBe(ready);
    // whenReady must NOT trigger a second bootstrap — it shares the in-flight one.
    expect(runtime.bootstrapCalls).toBe(1);
  });

  it('reboot() resets error to null, re-bootstraps fresh, and publishes the new engine', async () => {
    const recovered = makeFakeEngine('recovered');
    const runtime = makeFakeRuntime([
      // First mount bootstrap fails (stale/inconsistent bundle).
      () => Promise.reject(new Error('bundle chunk 404')),
      // reboot() re-runs a fresh bootstrap that succeeds.
      (onStage) => {
        onStage({ kind: 'ready' } as BootStage);
        return Promise.resolve(recovered);
      },
    ]);

    let captured: ReturnType<typeof useChartEngine> | null = null;
    render(
      <AlmaMeshRuntimeProvider runtime={runtime}>
        <Probe capture={(v) => {
          captured = v;
        }} />
      </AlmaMeshRuntimeProvider>,
    );

    // The first bootstrap fails -> error surfaced, no engine.
    await waitFor(() => expect(screen.getByTestId('error').textContent).toBe('bundle chunk 404'));
    expect(screen.getByTestId('engine').textContent).toBe('no-engine');

    // Reboot -> fresh bootstrap -> recovery.
    let result: ChartEngine | undefined;
    await act(async () => {
      result = await captured!.reboot();
    });

    expect(result).toBe(recovered);
    expect(runtime.bootstrapCalls).toBe(2);
    await waitFor(() => expect(screen.getByTestId('error').textContent).toBe('no-error'));
    await waitFor(() => expect(screen.getByTestId('engine').textContent).toBe('engine-ready'));
  });

  it('reboot() rejects (and re-surfaces the error) when the fresh bootstrap also fails', async () => {
    const runtime = makeFakeRuntime([
      () => Promise.reject(new Error('first fail')),
      () => Promise.reject(new Error('second fail')),
    ]);

    let captured: ReturnType<typeof useChartEngine> | null = null;
    render(
      <AlmaMeshRuntimeProvider runtime={runtime}>
        <Probe capture={(v) => {
          captured = v;
        }} />
      </AlmaMeshRuntimeProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('error').textContent).toBe('first fail'));

    await act(async () => {
      await expect(captured!.reboot()).rejects.toThrow('second fail');
    });

    await waitFor(() => expect(screen.getByTestId('error').textContent).toBe('second fail'));
  });

  it('retries one failed offline bootstrap when connectivity returns without duplicating boots', async () => {
    const online = vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
    const recovered = makeFakeEngine('online-recovery');
    const runtime = makeFakeRuntime([
      () => Promise.reject(new Error('network unreachable')),
      () => Promise.resolve(recovered),
    ]);
    let captured: ReturnType<typeof useChartEngine> | null = null;

    render(
      <AlmaMeshRuntimeProvider runtime={runtime}>
        <Probe capture={(value) => {
          captured = value;
        }} />
      </AlmaMeshRuntimeProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('error').textContent).toBe('network unreachable'));
    expect(runtime.bootstrapCalls).toBe(1);

    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });

    await waitFor(() => expect(screen.getByTestId('engine').textContent).toBe('engine-ready'));
    await expect(captured!.whenReady()).resolves.toBe(recovered);
    expect(screen.getByTestId('error').textContent).toBe('no-error');
    expect(runtime.bootstrapCalls).toBe(2);

    await act(async () => {
      window.dispatchEvent(new Event('online'));
      window.dispatchEvent(new Event('online'));
    });
    expect(runtime.bootstrapCalls).toBe(2);
    online.mockRestore();
  });

  it('retries a transient local worker crash while the browser remains offline', async () => {
    const online = vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
    const recovered = makeFakeEngine('offline-worker-recovery');
    const runtime = makeFakeRuntime([
      () => Promise.reject(new WorkerCrashError('engine worker crashed: undefined')),
      () => Promise.resolve(recovered),
    ]);

    try {
      render(
        <AlmaMeshRuntimeProvider runtime={runtime}>
          <Probe capture={() => {}} />
        </AlmaMeshRuntimeProvider>,
      );

      await waitFor(() => expect(screen.getByTestId('engine').textContent).toBe('engine-ready'), {
        timeout: 2_000,
      });
      expect(screen.getByTestId('error').textContent).toBe('no-error');
      expect(runtime.bootstrapCalls).toBe(2);
    } finally {
      online.mockRestore();
    }
  });

  it('does not overlap a scheduled worker retry with whenReady recovery', async () => {
    vi.useFakeTimers();
    let resolveRecovery!: (engine: ChartEngine) => void;
    const recovered = makeFakeEngine('single-flight-worker-recovery');
    const runtime = makeFakeRuntime([
      () => Promise.reject(new WorkerCrashError('engine worker crashed: undefined')),
      () => new Promise<ChartEngine>((resolve) => {
        resolveRecovery = resolve;
      }),
    ]);
    let captured: ReturnType<typeof useChartEngine> | null = null;

    try {
      render(
        <AlmaMeshRuntimeProvider runtime={runtime}>
          <Probe capture={(value) => {
            captured = value;
          }} />
        </AlmaMeshRuntimeProvider>,
      );
      await act(async () => Promise.resolve());
      expect(runtime.bootstrapCalls).toBe(1);

      const recovery = captured!.whenReady();
      expect(runtime.bootstrapCalls).toBe(2);
      await act(async () => vi.advanceTimersByTimeAsync(250));
      expect(runtime.bootstrapCalls).toBe(2);

      await act(async () => {
        resolveRecovery(recovered);
        await recovery;
      });
      expect(screen.getByTestId('engine').textContent).toBe('engine-ready');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not miss connectivity returning while the failing bootstrap is still in flight', async () => {
    const online = vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
    let rejectOffline!: (error: Error) => void;
    const recovered = makeFakeEngine('online-during-boot');
    const runtime = makeFakeRuntime([
      () => new Promise<ChartEngine>((_resolve, reject) => {
        rejectOffline = reject;
      }),
      () => Promise.resolve(recovered),
    ]);

    render(
      <AlmaMeshRuntimeProvider runtime={runtime}>
        <Probe capture={() => {}} />
      </AlmaMeshRuntimeProvider>,
    );
    await waitFor(() => expect(runtime.bootstrapCalls).toBe(1));

    await act(async () => {
      window.dispatchEvent(new Event('online'));
      window.dispatchEvent(new Event('online'));
      rejectOffline(new Error('network unreachable'));
    });

    await waitFor(() => expect(screen.getByTestId('engine').textContent).toBe('engine-ready'));
    expect(runtime.bootstrapCalls).toBe(2);
    online.mockRestore();
  });

  it('retries a transport failure once when the browser still reports online', async () => {
    const recovered = makeFakeEngine('partial-connectivity-recovery');
    const runtime = makeFakeRuntime([
      () => Promise.reject(new Error('failed to fetch public key')),
      () => Promise.resolve(recovered),
    ]);

    render(
      <AlmaMeshRuntimeProvider runtime={runtime}>
        <Probe capture={() => {}} />
      </AlmaMeshRuntimeProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('engine').textContent).toBe('engine-ready'), {
      timeout: 2_000,
    });
    expect(screen.getByTestId('error').textContent).toBe('no-error');
    expect(runtime.bootstrapCalls).toBe(2);
  });

  it('retries a chart-worker module import that WebKit failed mid-boot', async () => {
    // WebKit's wording when a worker's dynamic import() loses its network
    // process mid-load (Chromium says "Failed to fetch dynamically imported
    // module", which the transport pattern already covers).
    const runtime = makeFakeRuntime([
      () => Promise.reject(new TypeError('Importing a module script failed.')),
      () => Promise.resolve(makeFakeEngine('after-import-failure')),
    ]);

    render(
      <AlmaMeshRuntimeProvider runtime={runtime}>
        <Probe capture={() => {}} />
      </AlmaMeshRuntimeProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('engine').textContent).toBe('engine-ready'), {
      timeout: 2_000,
    });
    expect(runtime.bootstrapCalls).toBe(2);
  });

  it('recovers when transport returns later without an online event', async () => {
    vi.useFakeTimers();
    let transportAvailable = false;
    const runtime = makeFakeRuntime([
      () => Promise.reject(new Error('failed to fetch public key')),
      () => Promise.reject(new Error('network unreachable')),
      () => transportAvailable
        ? Promise.resolve(makeFakeEngine('later-recovery'))
        : Promise.reject(new Error('load failed')),
    ]);

    try {
      render(
        <AlmaMeshRuntimeProvider runtime={runtime}>
          <Probe capture={() => {}} />
        </AlmaMeshRuntimeProvider>,
      );
      await act(async () => Promise.resolve());
      await act(async () => vi.advanceTimersByTimeAsync(250));
      expect(runtime.bootstrapCalls).toBe(2);
      transportAvailable = true;
      await act(async () => vi.advanceTimersByTimeAsync(1_000));
      expect(screen.getByTestId('engine').textContent).toBe('engine-ready');
      expect(runtime.bootstrapCalls).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops the reported-online retry window after four attempts', async () => {
    vi.useFakeTimers();
    const runtime = makeFakeRuntime([
      () => Promise.reject(new Error('failed to fetch public key')),
    ]);

    try {
      render(
        <AlmaMeshRuntimeProvider runtime={runtime}>
          <Probe capture={() => {}} />
        </AlmaMeshRuntimeProvider>,
      );
      await act(async () => Promise.resolve());
      for (const delay of [250, 1_000, 5_000, 15_000]) {
        await act(async () => vi.advanceTimersByTimeAsync(delay));
      }
      await act(async () => vi.runOnlyPendingTimersAsync());
      expect(runtime.bootstrapCalls).toBe(5);
      expect(screen.getByTestId('engine').textContent).toBe('no-engine');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not auto-retry an integrity failure on an online event', async () => {
    const runtime = makeFakeRuntime([
      () => Promise.reject(new Error('signature verification failed')),
      () => Promise.resolve(makeFakeEngine('must-not-run')),
    ]);

    render(
      <AlmaMeshRuntimeProvider runtime={runtime}>
        <Probe capture={() => {}} />
      </AlmaMeshRuntimeProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId('error').textContent).toBe('signature verification failed'),
    );

    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });
    expect(runtime.bootstrapCalls).toBe(1);
  });

  it('does not let a stale failed bootstrap overwrite a newer successful reboot', async () => {
    let rejectStale!: (error: Error) => void;
    const recovered = makeFakeEngine('newer-reboot');
    const runtime = makeFakeRuntime([
      () => new Promise<ChartEngine>((_resolve, reject) => {
        rejectStale = reject;
      }),
      () => Promise.resolve(recovered),
    ]);
    let captured: ReturnType<typeof useChartEngine> | null = null;

    render(
      <AlmaMeshRuntimeProvider runtime={runtime}>
        <Probe capture={(value) => {
          captured = value;
        }} />
      </AlmaMeshRuntimeProvider>,
    );
    await waitFor(() => expect(runtime.bootstrapCalls).toBe(1));

    await act(async () => {
      await captured!.reboot();
    });
    await waitFor(() => expect(screen.getByTestId('engine').textContent).toBe('engine-ready'));

    await act(async () => {
      rejectStale(new Error('network unreachable'));
    });

    expect(screen.getByTestId('engine').textContent).toBe('engine-ready');
    expect(screen.getByTestId('error').textContent).toBe('no-error');
    await expect(captured!.whenReady()).resolves.toBe(recovered);
    expect(runtime.bootstrapCalls).toBe(2);
  });

  it('disposes the runtime and resets lifecycle refs on unmount', async () => {
    const runtime = makeFakeRuntime([(onStage) => {
      onStage({ kind: 'ready' } as BootStage);
      return Promise.resolve(makeFakeEngine('cleanup'));
    }]);
    runtime.dispose = vi.fn();

    const view = render(
      <AlmaMeshRuntimeProvider runtime={runtime}>
        <Probe capture={() => {}} />
      </AlmaMeshRuntimeProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('engine').textContent).toBe('engine-ready'));
    view.unmount();

    expect(runtime.dispose).toHaveBeenCalledOnce();
  });
});

/** A tiny harness component proving the warming-race fix can drive readiness. */
function ConsumerThatWaits({ onResult }: { onResult: (s: string) => void }) {
  const { engine, error, whenReady, reboot } = useChartEngine();
  const [status, setStatus] = useState('idle');
  return (
    <button
      type="button"
      data-testid="go"
      onClick={async () => {
        try {
          const e = engine ?? (error ? await reboot() : await whenReady());
          onResult(e ? 'got-engine' : 'no-engine');
          setStatus('done');
        } catch {
          onResult('threw');
          setStatus('error');
        }
      }}
    >
      {status}
    </button>
  );
}

describe('AlmaMeshRuntimeProvider — consumer readiness contract', () => {
  it('a consumer can await whenReady() during the warming race and get the engine', async () => {
    let resolveBoot!: (e: ChartEngine) => void;
    const ready = makeFakeEngine('race');
    const runtime = makeFakeRuntime([
      () => new Promise<ChartEngine>((res) => {
        resolveBoot = res;
      }),
    ]);
    const results: string[] = [];

    render(
      <AlmaMeshRuntimeProvider runtime={runtime}>
        <ConsumerThatWaits onResult={(s) => results.push(s)} />
      </AlmaMeshRuntimeProvider>,
    );

    // Click Generate WHILE bootstrap is still in flight (the race).
    await act(async () => {
      screen.getByTestId('go').click();
      // Now let bootstrap finish.
      resolveBoot(ready);
    });

    await waitFor(() => expect(results).toContain('got-engine'));
  });
});

describe('AlmaMeshRuntimeProvider — recovery seams', () => {
  afterEach(() => recordEngineBootFailure(null));

  it('records a rollback boot failure (never auto-retries or clears it) and forgets it on success', async () => {
    const rollback = new EngineOperationError({
      code: 'rollback',
      message: 'refusing rollback: sequence is not fresher',
    });
    const runtime = makeFakeRuntime([
      () => Promise.reject(rollback),
      () => Promise.resolve(makeFakeEngine('after-reset')),
    ]);
    let ctx: ReturnType<typeof useChartEngine> | null = null;
    render(
      <AlmaMeshRuntimeProvider runtime={runtime}>
        <Probe capture={(v) => (ctx = v)} />
      </AlmaMeshRuntimeProvider>,
    );
    await waitFor(() => expect(isRollbackRefusal(lastEngineBootFailure())).toBe(true));
    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });
    expect(runtime.bootstrapCalls).toBe(1);

    await act(async () => {
      await ctx!.reboot();
    });
    expect(lastEngineBootFailure()).toBeNull();
  });

  it('registers a teardown that disposes the live runtime Workers', async () => {
    const runtime = makeFakeRuntime([() => Promise.resolve(makeFakeEngine('live'))]);
    const dispose = vi.fn();
    runtime.dispose = dispose;
    render(
      <AlmaMeshRuntimeProvider runtime={runtime}>
        <Probe capture={() => {}} />
      </AlmaMeshRuntimeProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('engine').textContent).toBe('engine-ready'));
    await teardownLiveEngine();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});

describe('AlmaMeshRuntimeProvider — severed service-worker channel', () => {
  beforeEach(() => recoverSeveredServiceWorkerChannel.mockClear());

  it('checks for a severed service-worker channel after a transport failure', async () => {
    const runtime = makeFakeRuntime([
      () => Promise.reject(new Error('fetch http://localhost/public.key failed: network unreachable')),
      () => Promise.resolve(makeFakeEngine('after-channel-check')),
    ]);

    render(
      <AlmaMeshRuntimeProvider runtime={runtime}>
        <Probe capture={() => {}} />
      </AlmaMeshRuntimeProvider>,
    );

    await waitFor(() => expect(recoverSeveredServiceWorkerChannel).toHaveBeenCalledTimes(1));
  });

  it('never treats an integrity failure as a severed channel', async () => {
    const runtime = makeFakeRuntime([
      () => Promise.reject(new Error('signature verification failed')),
    ]);

    render(
      <AlmaMeshRuntimeProvider runtime={runtime}>
        <Probe capture={() => {}} />
      </AlmaMeshRuntimeProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('error').textContent).toBe('signature verification failed'));
    expect(recoverSeveredServiceWorkerChannel).not.toHaveBeenCalled();
  });
});

describe('AlmaMeshRuntimeProvider — one-off wasm boot fault (real runtime, fake Workers)', () => {
  /** A Pyodide Worker whose boot traps like WebKit's cold wasm compile did. */
  function chartWorker(outcome: 'trap' | 'ok'): ChartEnginePort & { terminated: boolean } {
    return {
      terminated: false,
      async boot() {
        if (outcome === 'trap') {
          const fault = new Error('Out of bounds memory access');
          fault.name = 'RuntimeError';
          throw fault;
        }
      },
      generateChart: vi.fn(),
      computePredictive: vi.fn(),
      computeMoonWindow: vi.fn(),
      computeMeshEdge: vi.fn(),
      computeRectification: vi.fn(),
      terminate() {
        this.terminated = true;
      },
    };
  }

  function syncWorker(): EnginePort {
    return {
      sync: async () => ({ version: 'v', manifestHash: 'm', chunksFetched: 0, chunksReused: 1, bytesFetched: 0 }),
      readFile: async () => new Uint8Array([1]),
      terminate: () => {},
    };
  }

  function runtimeWith(workers: Array<ChartEnginePort & { terminated: boolean }>) {
    const spawned: Array<ChartEnginePort & { terminated: boolean }> = [];
    const runtime = new AlmaMeshRuntime({
      spawnSyncEngine: syncWorker,
      spawnChartEngine: () => {
        const next = workers.shift() ?? chartWorker('ok');
        spawned.push(next);
        return next;
      },
      decideBootMode: () => ({ mode: 'sequential', reason: 'test' }),
      log: () => {},
    });
    return { runtime, spawned };
  }

  it('recovers from one fault without user action: engine ready, no error shown', async () => {
    const { runtime, spawned } = runtimeWith([chartWorker('trap'), chartWorker('ok')]);

    render(
      <AlmaMeshRuntimeProvider runtime={runtime}>
        <Probe capture={() => {}} />
      </AlmaMeshRuntimeProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('engine').textContent).toBe('engine-ready'));
    expect(screen.getByTestId('error').textContent).toBe('no-error');
    expect(spawned).toHaveLength(2);
    expect(spawned[0].terminated).toBe(true);
  });

  it('two faults in a row surface the error that drives the recovery card', async () => {
    const { runtime, spawned } = runtimeWith([chartWorker('trap'), chartWorker('trap')]);

    render(
      <AlmaMeshRuntimeProvider runtime={runtime}>
        <Probe capture={() => {}} />
      </AlmaMeshRuntimeProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('error').textContent).toBe('Out of bounds memory access'));
    expect(screen.getByTestId('engine').textContent).toBe('no-engine');
    expect(spawned).toHaveLength(2);
    expect(spawned.every((worker) => worker.terminated)).toBe(true);
  });
});
