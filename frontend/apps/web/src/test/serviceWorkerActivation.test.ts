import { describe, expect, it } from 'vitest';

import {
  waitForServiceWorkerActive,
  type ServiceWorkerReader,
  type ServiceWorkerSnapshot,
} from '../../e2e/serviceWorkerActivation';

const NONE: ServiceWorkerSnapshot = { registered: false, installing: null, waiting: null, active: null, controlled: false };
const INSTALLING: ServiceWorkerSnapshot = { ...NONE, registered: true, installing: 'installing' };
const ACTIVATED: ServiceWorkerSnapshot = { ...NONE, registered: true, active: 'activated', controlled: true };

/** A scripted worker: one snapshot per poll (the last repeats), and a fixed probe answer. */
function scriptedReader(snapshots: Array<ServiceWorkerSnapshot | Error>, probe: readonly string[] | null = null) {
  let polls = 0;
  let probes = 0;
  const reader: ServiceWorkerReader = {
    snapshot: async () => {
      const next = snapshots[Math.min(polls, snapshots.length - 1)];
      polls += 1;
      if (next instanceof Error) throw next;
      return next;
    },
    probeFetches: async () => {
      probes += 1;
      return probe;
    },
  };
  return { reader, polls: () => polls, probes: () => probes };
}

/** A fake clock the waiter advances through its own sleep, so no test waits in real time. */
function fakeClock() {
  let now = 0;
  return { now: () => now, sleep: async (ms: number) => { now += ms; } };
}

describe('waitForServiceWorkerActive', () => {
  it('returns as soon as the registration has an active worker, reporting each state change once', async () => {
    const { reader } = scriptedReader([NONE, INSTALLING, INSTALLING, ACTIVATED]);
    const states: ServiceWorkerSnapshot[] = [];
    const result = await waitForServiceWorkerActive(reader, {
      timeoutMs: 60_000, pollMs: 250, onState: (state) => states.push(state), ...fakeClock(),
    });
    expect(result).toEqual(ACTIVATED);
    expect(states).toEqual([NONE, INSTALLING, ACTIVATED]);
  });

  it('counts an activating worker as active, as navigator.serviceWorker.ready does', async () => {
    const activating: ServiceWorkerSnapshot = { ...NONE, registered: true, active: 'activating' };
    const { reader } = scriptedReader([INSTALLING, activating]);
    await expect(waitForServiceWorkerActive(reader, { timeoutMs: 60_000, pollMs: 250, ...fakeClock() })).resolves.toEqual(activating);
  });

  it('fails a worker stuck in installing with its own fetch record, not a bare timeout', async () => {
    const fetched = ['http://127.0.0.1:4199/sw-egress-probe.js', 'http://127.0.0.1:4199/assets/a.js', 'http://127.0.0.1:4199/assets/b.wasm'];
    const { reader, probes } = scriptedReader([NONE, INSTALLING], fetched);
    const clock = fakeClock();
    const failure = waitForServiceWorkerActive(reader, { timeoutMs: 60_000, pollMs: 250, ...clock });
    await expect(failure).rejects.toThrow(
      'the service worker did not activate within 60000 ms: registration {installing: installing, waiting: none, active: none, controlled: no}; '
      + 'the worker answered the egress probe with 3 fetched URLs, the last /assets/b.wasm',
    );
    expect(clock.now()).toBeGreaterThanOrEqual(60_000);
    expect(probes()).toBe(1);
  });

  it('says so when the stuck worker does not answer the probe at all', async () => {
    const { reader } = scriptedReader([INSTALLING], null);
    await expect(waitForServiceWorkerActive(reader, { timeoutMs: 1_000, pollMs: 250, ...fakeClock() })).rejects.toThrow(
      'the service worker did not activate within 1000 ms: registration {installing: installing, waiting: none, active: none, controlled: no}; '
      + 'no worker answered the egress probe (hung, terminated, or none to ask)',
    );
  });

  it('treats a probe that throws like one that never answers, and an empty record as zero fetches', async () => {
    const throwing: ServiceWorkerReader = { snapshot: async () => INSTALLING, probeFetches: () => Promise.reject(new Error('Target closed')) };
    await expect(waitForServiceWorkerActive(throwing, { timeoutMs: 500, pollMs: 250, ...fakeClock() })).rejects.toThrow(
      'no worker answered the egress probe (hung, terminated, or none to ask)',
    );
    const { reader } = scriptedReader([INSTALLING], []);
    await expect(waitForServiceWorkerActive(reader, { timeoutMs: 500, pollMs: 250, ...fakeClock() })).rejects.toThrow(
      'the worker answered the egress probe with 0 fetched URLs, the last none',
    );
  });

  it('waits on the real clock by default', async () => {
    const { reader } = scriptedReader([INSTALLING], null);
    const started = Date.now();
    await expect(waitForServiceWorkerActive(reader, { timeoutMs: 40, pollMs: 10 })).rejects.toThrow('did not activate within 40 ms');
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
  });

  it('names a missing registration: register() never ran, or a failed install cleared it', async () => {
    const { reader } = scriptedReader([NONE]);
    await expect(waitForServiceWorkerActive(reader, { timeoutMs: 1_000, pollMs: 250, ...fakeClock() })).rejects.toThrow(
      'the service worker did not activate within 1000 ms: no registration (register() never ran, or a failed install cleared it)',
    );
  });

  it('keeps polling through a read lost to a navigation, and reports the last such error on a stall', async () => {
    const lost = new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation');
    const recovered = scriptedReader([lost, INSTALLING, ACTIVATED]);
    await expect(waitForServiceWorkerActive(recovered.reader, { timeoutMs: 60_000, pollMs: 250, ...fakeClock() })).resolves.toEqual(ACTIVATED);
    expect(recovered.polls()).toBe(3);

    const neverRead = scriptedReader([lost]);
    await expect(waitForServiceWorkerActive(neverRead.reader, { timeoutMs: 1_000, pollMs: 250, ...fakeClock() })).rejects.toThrow(
      'the service worker did not activate within 1000 ms: the registration was never read (last error: page.evaluate: Execution context was destroyed',
    );
  });
});
