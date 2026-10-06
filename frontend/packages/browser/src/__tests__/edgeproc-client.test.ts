import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  EngineRequest,
  EngineResponse,
  EngineWorkerLike,
} from "@gainratio/browser";
import {
  type AlmaSyncEngine,
  clearAlmaBundleCache,
  createAlmaSyncEngine,
  EngineCacheNotDurableError,
  EngineStorageBlockedError,
} from "../edgeprocClient";

class FakeWorker implements EngineWorkerLike {
  public readonly sent: EngineRequest[] = [];
  public terminated = false;
  readonly #messages: Array<(event: MessageEvent<EngineResponse>) => void> = [];

  public postMessage(message: EngineRequest): void {
    this.sent.push(message);
  }

  public addEventListener(
    type: "message" | "error" | "messageerror",
    listener:
      | ((event: MessageEvent<EngineResponse>) => void)
      | ((event: { message: string }) => void)
      | (() => void),
  ): void {
    if (type === "message") {
      this.#messages.push(listener as (event: MessageEvent<EngineResponse>) => void);
    }
  }

  public terminate(): void {
    this.terminated = true;
  }

  public reply(response: EngineResponse): void {
    for (const listener of this.#messages) {
      listener({ data: response } as MessageEvent<EngineResponse>);
    }
  }
}

const globals = globalThis as typeof globalThis & {
  __EDGEPROC_FORCE_INDEXEDDB_CACHE__?: boolean;
  __EDGEPROC_REPORT_CACHE__?: boolean;
  __EDGEPROC_SELECTED_CACHE__?: string;
  __EDGEPROC_CACHE_STORAGE__?: unknown;
};

afterEach(() => {
  delete globals.__EDGEPROC_FORCE_INDEXEDDB_CACHE__;
  delete globals.__EDGEPROC_REPORT_CACHE__;
  delete globals.__EDGEPROC_SELECTED_CACHE__;
  delete globals.__EDGEPROC_CACHE_STORAGE__;
});

describe("SQLite on OPFS or nothing: the engine never opens a memory cache", () => {
  // @gainratio/browser 0.3.1 can refuse its in-memory cache up front
  // (cacheFallback: "none"): nothing is opened in RAM and nothing downloaded.
  it("asks for no cache fallback on sync, readFile and clear", async () => {
    const worker = new FakeWorker();
    const engine = createAlmaSyncEngine(worker);
    void engine.sync("/bundle", "/public.key", "almamesh", "stable").catch(() => undefined);
    void engine.readFile("almamesh.whl").catch(() => undefined);
    void engine.clearCache().catch(() => undefined);
    expect(worker.sent.map((request) => [request.kind, (request as { cacheFallback?: string }).cacheFallback])).toEqual([
      ["sync", "none"],
      ["readFile", "none"],
      ["clear", "none"],
    ]);
    engine.terminate();
  });

  for (const reason of ["opfs-unavailable", "pool-in-use"] as const) {
    it(`turns the library's refusal (${reason}) into AlmaMesh's EngineStorageBlockedError`, async () => {
      const worker = new FakeWorker();
      const pending = createAlmaSyncEngine(worker).sync("/bundle", "/public.key", "almamesh", "stable");
      worker.reply({
        ok: false,
        id: worker.sent[0]?.id ?? 0,
        error: { code: "storage", message: `engine cache refused (${reason})`, reason },
      } as never);
      await expect(pending).rejects.toBeInstanceOf(EngineStorageBlockedError);
      await expect(pending).rejects.toMatchObject({ reason });
    });
  }

  it("passes any other engine failure through unchanged", async () => {
    const worker = new FakeWorker();
    const pending = createAlmaSyncEngine(worker).sync("/bundle", "/public.key", "almamesh", "stable");
    worker.reply({ ok: false, id: worker.sent[0]?.id ?? 0, error: { code: "network", message: "network unreachable" } } as never);
    await expect(pending).rejects.not.toBeInstanceOf(EngineStorageBlockedError);
    await expect(pending).rejects.toThrow("network unreachable");
  });
});

describe("AlmaMesh edgeproc adapter", () => {
  it("pins the legacy cache layout while keeping automatic OPFS selection", async () => {
    const worker = new FakeWorker();
    const engine = createAlmaSyncEngine(worker);
    const pending = engine.sync("/bundle", "/public.key", "almamesh", "stable");

    expect(worker.sent[0]).toMatchObject({
      kind: "sync",
      baseUrl: "/bundle",
      pubkeyUrl: "/public.key",
      expectedBundleId: "almamesh",
      expectedChannel: "stable",
      cacheNamespace: "edgeproc-browser",
      indexedDbLayout: {
        database: "edgeproc-browser-cache",
        store: "content-addressed-cache",
        separator: ":",
      },
    });
    expect(worker.sent[0]).not.toHaveProperty("storageBackend");

    worker.reply({
      ok: true,
      id: worker.sent[0]?.id ?? 0,
      kind: "sync",
      result: {
        version: "v1",
        manifestHash: "a".repeat(64),
        chunksFetched: 0,
        chunksReused: 2,
        bytesFetched: 0,
        cacheBackend: "sqlite-opfs",
        cacheStorage: { persistence: "opfs", pool: "edgeproc-browser-chunks", file: "/edgeproc-browser-chunks" },
      },
    });
    await expect(pending).resolves.toMatchObject({ cacheBackend: "sqlite-opfs" });
  });

  // REVERSED CONTRACT (2026-10-05, @gainratio/browser 0.3.0): this test used to
  // require that the exit-gate hook forced an IndexedDB engine cache. AlmaMesh
  // never falls back to IndexedDB: with OPFS refused the cache is in-memory
  // SQLite and the UI says it will not persist. The old hook must do nothing.
  it("never asks for an IndexedDB cache, even with the retired force-IndexedDB hook set", () => {
    globals.__EDGEPROC_FORCE_INDEXEDDB_CACHE__ = true;
    const worker = new FakeWorker();
    void createAlmaSyncEngine(worker).sync("/bundle", "/public.key", "almamesh", "stable");

    expect(worker.sent[0]).not.toHaveProperty("storageBackend");
  });

  // CONTRACT REVERSED (2026-10-05, product rule "SQLite on OPFS or no dice"):
  // this test used to require that a sync on the in-memory SQLite cache
  // resolved (and was merely reported). @gainratio/browser 0.3.0 cannot be told
  // to refuse its memory cache, so the adapter fails closed after the fact:
  // the engine never runs on a cache that vanishes with the Worker. The exit
  // gate still sees which cache was chosen, as a diagnostic.
  it("fails closed on the in-memory SQLite cache, still reporting it to the exit gate", async () => {
    globals.__EDGEPROC_REPORT_CACHE__ = true;
    const worker = new FakeWorker();
    const engine = createAlmaSyncEngine(worker);
    const pending = engine.sync("/bundle", "/public.key", "almamesh", "stable");
    worker.reply({
      ok: true,
      id: worker.sent[0]?.id ?? 0,
      kind: "sync",
      result: {
        version: "v1",
        manifestHash: "a".repeat(64),
        chunksFetched: 2,
        chunksReused: 0,
        bytesFetched: 1024,
        cacheBackend: "sqlite-memory",
        cacheStorage: { persistence: "memory", reason: "opfs-unavailable", detail: "UnknownError" },
      },
    });

    await expect(pending).rejects.toBeInstanceOf(EngineCacheNotDurableError);
    await expect(pending).rejects.toThrow(
      "The engine cache is not durable (sqlite-memory); AlmaMesh runs only on SQLite in OPFS.",
    );
    expect(globals.__EDGEPROC_SELECTED_CACHE__).toBe("sqlite-memory");
    expect(globals.__EDGEPROC_CACHE_STORAGE__).toEqual({
      persistence: "memory",
      reason: "opfs-unavailable",
      detail: "UnknownError",
    });
    engine.terminate();
    expect(worker.terminated).toBe(true);
  });

  it("fails closed on the in-memory cache even when the exit gate did not ask", async () => {
    const worker = new FakeWorker();
    const pending = createAlmaSyncEngine(worker).sync("/bundle", "/public.key", "almamesh", "stable");
    worker.reply({
      ok: true,
      id: worker.sent[0]?.id ?? 0,
      kind: "sync",
      result: {
        version: "v1",
        manifestHash: "a".repeat(64),
        chunksFetched: 2,
        chunksReused: 0,
        bytesFetched: 1024,
        cacheBackend: "sqlite-memory",
        cacheStorage: { persistence: "memory", reason: "opfs-unavailable", detail: "UnknownError" },
      },
    });
    await expect(pending).rejects.toBeInstanceOf(EngineCacheNotDurableError);
  });

  it("publishes nothing when the exit gate did not ask", async () => {
    const worker = new FakeWorker();
    const pending = createAlmaSyncEngine(worker).sync("/bundle", "/public.key", "almamesh", "stable");
    worker.reply({
      ok: true,
      id: worker.sent[0]?.id ?? 0,
      kind: "sync",
      result: {
        version: "v1",
        manifestHash: "a".repeat(64),
        chunksFetched: 0,
        chunksReused: 2,
        bytesFetched: 0,
        cacheBackend: "sqlite-opfs",
        cacheStorage: { persistence: "opfs", pool: "p", file: "/f" },
      },
    });
    await pending;
    expect(globals.__EDGEPROC_SELECTED_CACHE__).toBeUndefined();
    expect(globals.__EDGEPROC_CACHE_STORAGE__).toBeUndefined();
  });

  it("clears the durable bundle cache (OPFS + IndexedDB floor) through the library, same namespace + layout", async () => {
    const worker = new FakeWorker();
    const engine = createAlmaSyncEngine(worker);
    const pending = engine.clearCache();

    expect(worker.sent[0]).toMatchObject({
      kind: "clear",
      cacheNamespace: "edgeproc-browser",
      indexedDbLayout: {
        database: "edgeproc-browser-cache",
        store: "content-addressed-cache",
        separator: ":",
      },
    });
    worker.reply({ ok: true, id: worker.sent[0]?.id ?? 0, kind: "clear" });
    await expect(pending).resolves.toBeUndefined();
  });

  it("clearAlmaBundleCache spawns a dedicated worker, clears, and always terminates it", async () => {
    const calls: string[] = [];
    const fake = (clearCache: () => Promise<void>): AlmaSyncEngine => ({
      sync: () => Promise.reject(new Error("unused")),
      readFile: () => Promise.reject(new Error("unused")),
      clearCache: async () => {
        calls.push("clear");
        await clearCache();
      },
      terminate: () => calls.push("terminate"),
    });

    await clearAlmaBundleCache({ spawn: () => fake(() => Promise.resolve()) });
    expect(calls).toEqual(["clear", "terminate"]);

    calls.length = 0;
    await expect(
      clearAlmaBundleCache({ spawn: () => fake(() => Promise.reject(new Error("lock"))) }),
    ).rejects.toThrow("lock");
    expect(calls).toEqual(["clear", "terminate"]);
  });

  it("a hung clear times out as a FAILURE and still terminates its worker (releasing the lock request)", async () => {
    vi.useFakeTimers();
    try {
      let terminated = false;
      const pending = clearAlmaBundleCache({
        timeoutMs: 1_000,
        spawn: () => ({
          sync: () => Promise.reject(new Error("unused")),
          readFile: () => Promise.reject(new Error("unused")),
          clearCache: () => new Promise<void>(() => {}),
          terminate: () => {
            terminated = true;
          },
        }),
      });
      const assertion = expect(pending).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;
      expect(terminated).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
