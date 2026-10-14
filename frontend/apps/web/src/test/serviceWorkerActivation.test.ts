import { describe, expect, it } from 'vitest';

import {
  waitForServiceWorkerActive,
  type ProbeRecord,
  type ServiceWorkerReader,
  type ServiceWorkerSnapshot,
} from '../../e2e/serviceWorkerActivation';

const NONE: ServiceWorkerSnapshot = { registered: false, installing: null, waiting: null, active: null, controlled: false };
const INSTALLING: ServiceWorkerSnapshot = { ...NONE, registered: true, installing: 'installing' };
const ACTIVATED: ServiceWorkerSnapshot = { ...NONE, registered: true, active: 'activated', controlled: true };

/** A scripted worker: one snapshot per poll (the last repeats), and a fixed probe record. */
function scriptedReader(snapshots: Array<ServiceWorkerSnapshot | Error>, record: ProbeRecord | null = null) {
  let polls = 0;
  let reads = 0;
  const reader: ServiceWorkerReader = {
    snapshot: async () => {
      const next = snapshots[Math.min(polls, snapshots.length - 1)];
      polls += 1;
      if (next instanceof Error) throw next;
      return next;
    },
    probeRecord: async () => {
      reads += 1;
      return record;
    },
  };
  return { reader, polls: () => polls, reads: () => reads };
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

  it('fails a worker stuck in installing with the probe record it left in Cache Storage, not a bare timeout', async () => {
    const record: ProbeRecord = {
      fetched: ['http://127.0.0.1:4199/sw-egress-probe.js', 'http://127.0.0.1:4199/assets/a.js', 'http://127.0.0.1:4199/assets/b.wasm'],
      events: ['script-start', 'install'],
    };
    const { reader, reads } = scriptedReader([NONE, INSTALLING], record);
    const clock = fakeClock();
    const failure = waitForServiceWorkerActive(reader, { timeoutMs: 60_000, pollMs: 250, ...clock });
    await expect(failure).rejects.toThrow(
      'the service worker did not activate within 60000 ms: registration {installing: installing, waiting: none, active: none, controlled: no}; '
      + 'probe record: 3 fetched URLs, the last /assets/b.wasm; worker events: script-start | install',
    );
    expect(clock.now()).toBeGreaterThanOrEqual(60_000);
    expect(reads()).toBe(1);
  });

  it('names a registration that has no worker in any slot, and the reason the worker left behind', async () => {
    const empty: ServiceWorkerSnapshot = { ...NONE, registered: true };
    const record: ProbeRecord = { fetched: [], events: ['script-start', 'install', 'install rejected: QuotaExceededError: The quota has been exceeded.'] };
    const { reader } = scriptedReader([empty], record);
    await expect(waitForServiceWorkerActive(reader, { timeoutMs: 1_000, pollMs: 250, ...fakeClock() })).rejects.toThrow(
      'the service worker did not activate within 1000 ms: a registration with no worker in any slot (controlled: no); '
      + 'probe record: 0 fetched URLs, the last none; worker events: script-start | install | install rejected: QuotaExceededError: The quota has been exceeded.',
    );
  });

  it('says when the worker left no probe record: its script never ran', async () => {
    const { reader } = scriptedReader([INSTALLING], null);
    await expect(waitForServiceWorkerActive(reader, { timeoutMs: 1_000, pollMs: 250, ...fakeClock() })).rejects.toThrow(
      'the service worker did not activate within 1000 ms: registration {installing: installing, waiting: none, active: none, controlled: no}; '
      + 'no probe record (sw.js never ran its first statement)',
    );
  });

  it('keeps only the last 12 worker events, and survives a record read that throws', async () => {
    const events = Array.from({ length: 15 }, (_, index) => `event ${index}`);
    const { reader } = scriptedReader([INSTALLING], { fetched: [], events });
    await expect(waitForServiceWorkerActive(reader, { timeoutMs: 500, pollMs: 250, ...fakeClock() })).rejects.toThrow(
      `worker events (last 12 of 15): ${events.slice(3).join(' | ')}`,
    );
    const throwing: ServiceWorkerReader = { snapshot: async () => INSTALLING, probeRecord: () => Promise.reject(new Error('Target closed')) };
    await expect(waitForServiceWorkerActive(throwing, { timeoutMs: 500, pollMs: 250, ...fakeClock() })).rejects.toThrow(
      'the probe record could not be read (Target closed)',
    );
  });

  it('bounds a snapshot read that never settles by the remaining budget', async () => {
    const hung: ServiceWorkerReader = { snapshot: () => new Promise<ServiceWorkerSnapshot>(() => undefined), probeRecord: async () => null };
    await expect(waitForServiceWorkerActive(hung, { timeoutMs: 40, pollMs: 10 })).rejects.toThrow(
      'the service worker did not activate within 40 ms: the registration was never read (last error: the registration read did not settle in 40 ms)',
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
