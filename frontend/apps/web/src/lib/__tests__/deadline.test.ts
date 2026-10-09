import { afterEach, describe, expect, it, vi } from 'vitest';

import { withDeadline } from '../deadline';

class LateError extends Error {}

const options = {
  timeoutMs: 1_000,
  onTimeout: () => new LateError('too slow'),
  failureMessage: 'the work failed',
};

const never = () => new Promise<never>(() => {});

afterEach(() => {
  vi.useRealTimers();
});

describe('withDeadline', () => {
  it('resolves with the work value before the deadline', async () => {
    await expect(withDeadline(Promise.resolve(7), new AbortController().signal, options)).resolves.toBe(7);
  });

  it('rejects with the onTimeout error once the deadline passes', async () => {
    vi.useFakeTimers();
    const pending = withDeadline(never(), new AbortController().signal, options);
    const outcome = expect(pending).rejects.toBeInstanceOf(LateError);
    await vi.advanceTimersByTimeAsync(999);
    let settled = false;
    void pending.catch(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await outcome;
  });

  it('rejects with the abort reason when the signal aborts', async () => {
    const controller = new AbortController();
    const pending = withDeadline(never(), controller.signal, options);
    controller.abort(new DOMException('cancelled', 'AbortError'));
    await expect(pending).rejects.toThrow('cancelled');
  });

  it('rejects at once when the signal is already aborted', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    controller.abort(new DOMException('cancelled', 'AbortError'));
    const pending = withDeadline(never(), controller.signal, options);
    const outcome = expect(pending).rejects.toThrow('cancelled');
    await vi.advanceTimersByTimeAsync(0);
    await outcome;
  });

  it('passes a work Error through and wraps a non-Error in failureMessage', async () => {
    const signal = new AbortController().signal;
    await expect(withDeadline(Promise.reject(new Error('engine down')), signal, options)).rejects.toThrow(
      'engine down',
    );
    await expect(withDeadline(Promise.reject('nope'), signal, options)).rejects.toThrow('the work failed');
  });

  it('clears its timer and abort listener once settled', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    await withDeadline(Promise.resolve(1), controller.signal, options);
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });
});
