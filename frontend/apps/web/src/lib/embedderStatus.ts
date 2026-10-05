/**
 * Load state of the on-device chat embedder (MiniLM + onnxruntime wasm, about
 * +80-95 MB resident once loaded). The model is never loaded at boot: the first
 * semantic search or chat send starts it. This store lets the UI say so while
 * that first load runs, instead of looking frozen.
 *
 * idle    -> nothing has asked for embeddings yet (the model is not in memory)
 * loading -> the first embed is in flight (worker + model starting)
 * ready   -> an embed succeeded; the model is resident
 * failed  -> the last load failed; the next embed retries (back to loading)
 */

import type { Embedder } from '@almamesh/memory';

export type EmbedderStatus = 'idle' | 'loading' | 'ready' | 'failed';

export interface EmbedderStatusStore {
  get(): EmbedderStatus;
  subscribe(listener: () => void): () => void;
  /** Wrap an embedder so its calls drive this store. */
  track(embedder: Embedder): Embedder;
  /** Back to idle (the model runtime was dropped, or a test starts fresh). */
  reset(): void;
}

export function createEmbedderStatusStore(): EmbedderStatusStore {
  let status: EmbedderStatus = 'idle';
  const listeners = new Set<() => void>();

  function set(next: EmbedderStatus): void {
    if (next === status) {
      return;
    }
    status = next;
    for (const listener of listeners) {
      listener();
    }
  }

  async function settle(work: Promise<Float32Array[]>): Promise<Float32Array[]> {
    try {
      const vectors = await work;
      set('ready');
      return vectors;
    } catch (error) {
      if (status === 'loading') {
        set('failed');
      }
      throw error;
    }
  }

  return {
    get: () => status,
    reset: () => set('idle'),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    track(embedder) {
      return {
        embed(texts) {
          if (texts.length === 0) {
            return Promise.resolve([]);
          }
          if (status !== 'ready') {
            set('loading');
          }
          return settle(embedder.embed(texts));
        },
      };
    },
  };
}

/** The app-wide store, shared by chatMemory (writer) and the chat UI (readers). */
export const embedderStatus: EmbedderStatusStore = createEmbedderStatusStore();

/** TEST SEAM: return the shared store to idle between tests. */
export function __resetEmbedderStatusForTest(): void {
  embedderStatus.reset();
}
