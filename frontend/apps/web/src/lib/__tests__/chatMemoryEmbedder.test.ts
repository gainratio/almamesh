/**
 * The chat embedder (MiniLM + ORT wasm, ~+80-95 MB resident) must load only
 * when someone first needs embeddings, report that load, and never be spawned
 * twice. A stub Worker answers embed requests so no model is loaded here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

interface EmbedRequest {
  readonly id: number;
  readonly texts: readonly string[];
}

const spawned: string[] = [];
let terminated = 0;
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1';
const DESKTOP = {
  userAgent: 'Mozilla/5.0 Chrome/153.0.0.0', platform: 'MacIntel',
  maxTouchPoints: 0, deviceMemory: 8, hardwareConcurrency: 8,
};

class StubEmbedderWorker extends EventTarget {
  constructor(url: URL | string) {
    super();
    spawned.push(String(url));
  }
  postMessage(request: EmbedRequest): void {
    queueMicrotask(() => {
      const vectors = request.texts.map(() => [1, 0, 0]);
      this.dispatchEvent(new MessageEvent('message', { data: { id: request.id, ok: true, vectors } }));
    });
  }
  terminate(): void {
    terminated += 1;
  }
}

const embedderSpawns = (): number => spawned.filter((u) => u.includes('embedder')).length;

describe('chatMemory embedder lifecycle', () => {
  beforeEach(() => {
    spawned.length = 0;
    terminated = 0;
    vi.resetModules();
    vi.stubGlobal('Worker', StubEmbedderWorker);
    vi.stubGlobal('navigator', DESKTOP);
    // The embedder arms an idle-release timer after each answer; fake it so
    // tests can step through it and nothing is left pending.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('does not spawn the embedder when the module loads', async () => {
    const { embedderStatus } = await import('../embedderStatus');
    await import('../chatMemory');
    expect(embedderSpawns()).toBe(0);
    expect(embedderStatus.get()).toBe('idle');
  });

  it('spawns it on the first search and reports loading, then ready', async () => {
    const { embedderStatus } = await import('../embedderStatus');
    const { searchMemory } = await import('../chatMemory');
    const seen: string[] = [];
    embedderStatus.subscribe(() => seen.push(embedderStatus.get()));

    await searchMemory('career', 'p1');

    expect(embedderSpawns()).toBe(1);
    expect(seen).toEqual(['loading', 'ready']);
  });

  it('keeps one embedder across a memory-runtime invalidation', async () => {
    const { searchMemory, invalidateMemoryRuntime } = await import('../chatMemory');
    await searchMemory('career', 'p1');
    invalidateMemoryRuntime();
    await searchMemory('health', 'p1');
    expect(embedderSpawns()).toBe(1);
  });

  it.each(['minimal', 'lite'])('%s devices never start an embedder for a chat send or search', async (tier) => {
    vi.stubGlobal('navigator', tier === 'minimal'
      ? { userAgent: IPHONE, platform: 'iPhone', maxTouchPoints: 5, hardwareConcurrency: 6 }
      : { ...DESKTOP, deviceMemory: 4 });
    const { embedderStatus } = await import('../embedderStatus');
    const { indexChatMessage, retrieveContext, searchMemory, rebuildMemory } = await import('../chatMemory');
    const message = { id: 'm', thread_id: 't', profile_id: 'p1', content: 'career' };
    await indexChatMessage(message);
    await retrieveContext('career', 'p1');
    await searchMemory('career', 'p1');
    await rebuildMemory([message]);
    expect(embedderStatus.get()).toBe('idle');
    vi.advanceTimersByTime(600_000);
    await searchMemory('health', 'p1');
    expect(embedderSpawns()).toBe(0);
    expect(terminated).toBe(0);
  });

  it('full devices release the embedder after ten idle minutes and reload it on demand', async () => {
    const { embedderStatus } = await import('../embedderStatus');
    const { searchMemory } = await import('../chatMemory');
    await searchMemory('career', 'p1');
    expect(embedderStatus.get()).toBe('ready');
    vi.advanceTimersByTime(599_999);
    expect(terminated).toBe(0);
    vi.advanceTimersByTime(1);
    expect(terminated).toBe(1);
    expect(embedderStatus.get()).toBe('idle');
    await searchMemory('health', 'p1');
    expect(embedderSpawns()).toBe(2);
  });
});
