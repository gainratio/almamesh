import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { natalOnlyNoted, PREDICTIVE_WAIT_MS, waitForPredictiveFacts, type PredictiveWaitInput } from '../predictiveWait';

type State = ReturnType<PredictiveWaitInput['state']>;

/** A predictive store stand-in: a state the test flips, and the listeners a flip notifies. */
function harness(initial: State) {
  let state = initial;
  const listeners = new Set<() => void>();
  const onWaiting = vi.fn();
  const controller = new AbortController();
  const input: PredictiveWaitInput = {
    state: () => state,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    signal: controller.signal,
    onWaiting,
  };
  const flip = (next: State) => { state = next; for (const listener of [...listeners]) listener(); };
  return { input, flip, onWaiting, listeners, controller };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('waitForPredictiveFacts: a today chat waits for the predictive layer (2026-10-14)', () => {
  it('pins the wait to 60 seconds', () => {
    expect(PREDICTIVE_WAIT_MS).toBe(60_000);
  });

  it('sends at once, with no waiting status, when the facts are ready', async () => {
    const { input, onWaiting, listeners } = harness('ready');
    await expect(waitForPredictiveFacts(input)).resolves.toBe('ready');
    expect(onWaiting).not.toHaveBeenCalled();
    expect(listeners.size).toBe(0);
  });

  it('shows the waiting status once, then sends when the facts become ready', async () => {
    const { input, flip, onWaiting, listeners } = harness('pending');
    const waiting = waitForPredictiveFacts(input);
    expect(onWaiting).toHaveBeenCalledTimes(1);
    flip('pending');
    expect(onWaiting).toHaveBeenCalledTimes(1);
    flip('ready');
    await expect(waiting).resolves.toBe('ready');
    expect(listeners.size).toBe(0);
  });

  it('answers natal-only when the predictive layer fails', async () => {
    const { input, flip } = harness('pending');
    const waiting = waitForPredictiveFacts(input);
    flip('error');
    await expect(waiting).resolves.toBe('natal_only');
  });

  it('answers natal-only, without waiting, when the facts already failed', async () => {
    const { input, onWaiting } = harness('error');
    await expect(waitForPredictiveFacts(input)).resolves.toBe('natal_only');
    expect(onWaiting).not.toHaveBeenCalled();
  });

  it('answers natal-only after the timeout, and stops listening', async () => {
    const { input, listeners } = harness('pending');
    const waiting = waitForPredictiveFacts({ ...input, timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(999);
    expect(listeners.size).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(waiting).resolves.toBe('natal_only');
    expect(listeners.size).toBe(0);
  });

  it('defaults to PREDICTIVE_WAIT_MS', async () => {
    const { input } = harness('pending');
    const settled = vi.fn();
    void waitForPredictiveFacts(input).then(settled);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toHaveBeenCalledWith('natal_only');
  });

  it('a cancelled turn stops waiting and rejects with the abort', async () => {
    const { input, controller, listeners } = harness('pending');
    const waiting = waitForPredictiveFacts(input);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    expect(listeners.size).toBe(0);
  });

  it('an already cancelled turn never shows the waiting status', async () => {
    const { input, controller, onWaiting } = harness('pending');
    controller.abort();
    await expect(waitForPredictiveFacts(input)).rejects.toMatchObject({ name: 'AbortError' });
    expect(onWaiting).not.toHaveBeenCalled();
  });
});

describe('natalOnlyNoted: the one short line a natal-only answer carries', () => {
  it('puts the note, in italics, above the answer', () => {
    expect(natalOnlyNoted('Today’s sky wasn’t ready, so this answer reads your birth chart only.', 'Venus is strong.'))
      .toBe('_Today’s sky wasn’t ready, so this answer reads your birth chart only._\n\nVenus is strong.');
  });
});
