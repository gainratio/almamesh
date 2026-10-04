import { describe, it, expect, vi } from 'vitest';
import type { Embedder } from '@almamesh/memory';

import { createEmbedderStatusStore } from '../embedderStatus';

interface Deferred {
  readonly promise: Promise<Float32Array[]>;
  readonly resolve: (v: Float32Array[]) => void;
  readonly reject: (e: Error) => void;
}

function deferred(): Deferred {
  let resolve!: (v: Float32Array[]) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<Float32Array[]>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function controllableEmbedder(): { embedder: Embedder; calls: Deferred[] } {
  const calls: Deferred[] = [];
  return {
    calls,
    embedder: {
      embed: vi.fn(() => {
        const d = deferred();
        calls.push(d);
        return d.promise;
      }),
    },
  };
}

describe('embedder status store', () => {
  it('starts idle: nothing loads the model until someone embeds', () => {
    const store = createEmbedderStatusStore();
    const { embedder } = controllableEmbedder();
    store.track(embedder);
    expect(store.get()).toBe('idle');
    expect(embedder.embed).not.toHaveBeenCalled();
  });

  it('reports loading while the first embed is in flight, then ready', async () => {
    const store = createEmbedderStatusStore();
    const { embedder, calls } = controllableEmbedder();
    const tracked = store.track(embedder);
    const listener = vi.fn();
    store.subscribe(listener);

    const pending = tracked.embed(['hello']);
    expect(store.get()).toBe('loading');
    calls[0]?.resolve([new Float32Array([1])]);
    await pending;

    expect(store.get()).toBe('ready');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('does not flip back to loading once the model is ready', async () => {
    const store = createEmbedderStatusStore();
    const { embedder, calls } = controllableEmbedder();
    const tracked = store.track(embedder);
    const first = tracked.embed(['a']);
    calls[0]?.resolve([]);
    await first;

    void tracked.embed(['b']);
    expect(store.get()).toBe('ready');
  });

  it('reports failed when the model cannot load, and loading again on retry', async () => {
    const store = createEmbedderStatusStore();
    const { embedder, calls } = controllableEmbedder();
    const tracked = store.track(embedder);
    const first = tracked.embed(['a']);
    calls[0]?.reject(new Error('OOM'));
    await expect(first).rejects.toThrow('OOM');
    expect(store.get()).toBe('failed');

    void tracked.embed(['b']);
    expect(store.get()).toBe('loading');
  });

  it('ignores an empty batch (no model work, no status change)', async () => {
    const store = createEmbedderStatusStore();
    const { embedder } = controllableEmbedder();
    await expect(store.track(embedder).embed([])).resolves.toEqual([]);
    expect(store.get()).toBe('idle');
    expect(embedder.embed).not.toHaveBeenCalled();
  });

  it('reset returns a ready store to idle', async () => {
    const store = createEmbedderStatusStore();
    await store.track({ embed: async () => [] }).embed(['x']);
    store.reset();
    expect(store.get()).toBe('idle');
  });

  it('stops notifying after unsubscribe', () => {
    const store = createEmbedderStatusStore();
    const { embedder } = controllableEmbedder();
    const listener = vi.fn();
    const off = store.subscribe(listener);
    off();
    void store.track(embedder).embed(['x']);
    expect(listener).not.toHaveBeenCalled();
  });
});
