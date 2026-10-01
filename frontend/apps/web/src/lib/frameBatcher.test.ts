import { describe, expect, it, vi } from 'vitest';

import { createFrameBatcher } from './frameBatcher';

// Streamed sections emit a delta every few milliseconds. Re-rendering React per
// delta stalls low-end phones, so updates coalesce to at most one per frame.

function manualFrames() {
  const queue = new Map<number, FrameRequestCallback>();
  let next = 1;
  return {
    schedule: (cb: FrameRequestCallback) => {
      queue.set(next, cb);
      return next++;
    },
    cancel: (id: number) => queue.delete(id),
    pending: () => queue.size,
    run: () => {
      const callbacks = [...queue.values()];
      queue.clear();
      for (const cb of callbacks) cb(0);
    },
  };
}

describe('createFrameBatcher', () => {
  it('coalesces many pushes into one flush per frame with the latest value per key', () => {
    const frames = manualFrames();
    const flush = vi.fn();
    const batcher = createFrameBatcher<number>(flush, frames.schedule, frames.cancel);
    for (let i = 1; i <= 50; i += 1) batcher.push('a', i);
    batcher.push('b', 7);

    expect(flush).not.toHaveBeenCalled();
    expect(frames.pending()).toBe(1);
    frames.run();
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith({ a: 50, b: 7 });
  });

  it('schedules a new frame for pushes after a flush', () => {
    const frames = manualFrames();
    const flush = vi.fn();
    const batcher = createFrameBatcher<number>(flush, frames.schedule, frames.cancel);
    batcher.push('a', 1);
    frames.run();
    batcher.push('a', 2);
    frames.run();
    expect(flush).toHaveBeenNthCalledWith(2, { a: 2 });
  });

  it('cancel drops the pending frame so nothing flushes after unmount', () => {
    const frames = manualFrames();
    const flush = vi.fn();
    const batcher = createFrameBatcher<number>(flush, frames.schedule, frames.cancel);
    batcher.push('a', 1);
    batcher.cancel();
    frames.run();
    expect(flush).not.toHaveBeenCalled();
    batcher.push('a', 2);
    expect(frames.pending()).toBe(0);
  });
});
