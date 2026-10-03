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
  __EDGEPROC_SELECTED_CACHE__?: string;
};

afterEach(() => {
  delete globals.__EDGEPROC_FORCE_INDEXEDDB_CACHE__;
  delete globals.__EDGEPROC_SELECTED_CACHE__;
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
        cacheBackend: "opfs+indexeddb",
      },
    });
    await expect(pending).resolves.toMatchObject({ cacheBackend: "opfs+indexeddb" });
  });

  it("maps the exit-gate fallback to IndexedDB and reports the selected backend", async () => {
    globals.__EDGEPROC_FORCE_INDEXEDDB_CACHE__ = true;
    const worker = new FakeWorker();
    const engine = createAlmaSyncEngine(worker);
    const pending = engine.sync("/bundle", "/public.key", "almamesh", "stable");

    expect(worker.sent[0]).toMatchObject({
      kind: "sync",
      storageBackend: "indexeddb",
    });
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
        cacheBackend: "indexeddb",
      },
    });

    await pending;
    expect(globals.__EDGEPROC_SELECTED_CACHE__).toBe("indexeddb");
    engine.terminate();
    expect(worker.terminated).toBe(true);
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
