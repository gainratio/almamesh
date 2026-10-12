import {
  EngineClient,
  EngineStorageUnavailableError,
  type EngineSyncResult,
  type EngineWorkerLike,
  type SyncProgress,
} from "@gainratio/browser";
import EdgeProcWorker from "./edgeproc.worker?worker";

const CACHE_NAMESPACE = "edgeproc-browser";
// Where a 0.2.x cache kept its IndexedDB floor and chunks. 0.3.0 reads it once
// to migrate into SQLite and never writes IndexedDB again.
const LEGACY_INDEXED_DB_LAYOUT = Object.freeze({
  database: "edgeproc-browser-cache",
  store: "content-addressed-cache",
  separator: ":" as const,
});

/**
 * Exit-gate hook (hooks builds only): when the provider sets
 * `__EDGEPROC_REPORT_CACHE__`, publish which cache the library chose. This is a
 * diagnostic only: AlmaMesh runs the engine on "sqlite-opfs" alone (see
 * EngineCacheNotDurableError). There is no IndexedDB fallback to force.
 */
type ExitGateGlobals = typeof globalThis & {
  __EDGEPROC_REPORT_CACHE__?: boolean;
  __EDGEPROC_SELECTED_CACHE__?: string;
  __EDGEPROC_CACHE_STORAGE__?: EngineSyncResult["cacheStorage"];
};

/**
 * Defense in depth. Unless the app's data is itself in memory, every call
 * passes `cacheFallback: "none"`, so the library refuses its in-memory cache up front
 * (EngineStorageBlockedError, nothing downloaded) and should never report one.
 * If a memory cache is ever reported anyway, the engine still never boots on a
 * cache that dies with the Worker. Not transient: never auto-retried.
 */
export class EngineCacheNotDurableError extends Error {
  public override readonly name = "EngineCacheNotDurableError";

  public constructor(public readonly cacheBackend: EngineSyncResult["cacheBackend"]) {
    super(`The engine cache is not durable (${cacheBackend}); AlmaMesh runs only on SQLite in OPFS.`);
  }
}

/**
 * The engine's persistent SQLite cache could not open, so nothing was opened
 * in memory and nothing was downloaded (`cacheFallback: "none"`).
 * "opfs-unavailable": the browser refuses on-device storage (the block
 * screen). "pool-in-use": another AlmaMesh tab holds the engine cache.
 * AlmaMesh's own type, so callers never import the library's names.
 */
export class EngineStorageBlockedError extends Error {
  public override readonly name = "EngineStorageBlockedError";

  public constructor(
    public readonly reason: "opfs-unavailable" | "pool-in-use",
    options?: ErrorOptions,
  ) {
    super(
      reason === "pool-in-use"
        ? "The engine cache is open in another AlmaMesh tab."
        : "This browser refuses on-device storage, so the engine cache cannot open.",
      options,
    );
  }
}

/**
 * Where the engine cache may live. "none" (the default): SQLite on OPFS or a
 * typed refusal, never a RAM cache. "memory": only when the app's own data
 * already runs on SQLite in memory because OPFS is refused, and the UI says so.
 */
export interface AlmaSyncEngineOptions {
  readonly cacheFallback?: "none" | "memory";
}

/** Translate the library's storage refusal into AlmaMesh's typed error. */
function asStorageBlocked(error: unknown): unknown {
  if (!(error instanceof EngineStorageUnavailableError)) return error;
  const reason = error.reason === "pool-in-use" ? "pool-in-use" : "opfs-unavailable";
  return new EngineStorageBlockedError(reason, { cause: error });
}

async function translated<T>(operation: Promise<T>): Promise<T> {
  try {
    return await operation;
  } catch (error) {
    throw asStorageBlocked(error);
  }
}

/** AlmaMesh's small domain adapter over the generic signed-bundle client. */
export interface AlmaSyncEngine {
  sync(
    baseUrl: string,
    pubkeyUrl: string,
    expectedBundleId: string,
    expectedChannel: string,
    /** The library's sync progress (per phase, per network read, per retry). */
    onProgress?: (progress: SyncProgress) => void,
  ): Promise<EngineSyncResult>;
  readFile(path: string): Promise<Uint8Array>;
  /**
   * Clear the signed-bundle cache (the `edgeproc-browser-chunks` SQLite
   * database: chunks, manifests, active pointer and rollback floor, plus any
   * not-yet-migrated 0.2.x stores) via the library's own `EngineClient.clear()`,
   * under the same Web Lock as sync/read.
   */
  clearCache(): Promise<void>;
  terminate(): void;
}

export function createAlmaSyncEngine(
  worker: EngineWorkerLike,
  options: AlmaSyncEngineOptions = {},
): AlmaSyncEngine {
  const client = new EngineClient(worker);
  const fallback = { cacheFallback: options.cacheFallback ?? "none" } as const;
  const durableOnly = fallback.cacheFallback === "none";
  return {
    async sync(baseUrl, pubkeyUrl, expectedBundleId, expectedChannel, onProgress) {
      const hooks = globalThis as ExitGateGlobals;
      const result = await translated(
        client.sync(baseUrl, pubkeyUrl, {
          expectedBundleId,
          expectedChannel,
          cacheNamespace: CACHE_NAMESPACE,
          indexedDbLayout: LEGACY_INDEXED_DB_LAYOUT,
          ...fallback,
          ...(onProgress === undefined ? {} : { onProgress }),
        }),
      );
      if (hooks.__EDGEPROC_REPORT_CACHE__ === true) {
        hooks.__EDGEPROC_SELECTED_CACHE__ = result.cacheBackend;
        hooks.__EDGEPROC_CACHE_STORAGE__ = result.cacheStorage;
      }
      // Defense in depth: with cacheFallback "none" the library never reports
      // a memory cache, but if one ever appears the engine still never runs on it.
      if (durableOnly && result.cacheBackend !== "sqlite-opfs") {
        throw new EngineCacheNotDurableError(result.cacheBackend);
      }
      return result;
    },
    readFile: (path) => translated(client.readFile(path, fallback)),
    clearCache: () =>
      translated(
        client.clear({
          cacheNamespace: CACHE_NAMESPACE,
          indexedDbLayout: LEGACY_INDEXED_DB_LAYOUT,
          ...fallback,
        }),
      ),
    terminate: () => client.dispose(),
  };
}

/** Consumer-owned Worker construction keeps Vite in control of the asset URL. */
export function spawnAlmaSyncEngine(options: AlmaSyncEngineOptions = {}): AlmaSyncEngine {
  return createAlmaSyncEngine(new EdgeProcWorker(), options);
}

/**
 * Wipe the synced bundle cache with a dedicated, short-lived sync Worker.
 *
 * SECURITY: this discards the anti-rollback floor, returning this device to
 * first-install trust (the next pointer is verified against the pinned key
 * exactly as for a new user, with no floor). It is for an EXPLICIT user
 * "Reset" action only — never call it automatically in response to a
 * `RollbackError`, which would turn rollback protection into a no-op.
 */
interface ClearBundleCacheOptions {
  /** Worker factory (tests inject a fake). */
  readonly spawn?: () => AlmaSyncEngine;
  /** Reject (as a failure) if the locked clear has not finished by then. */
  readonly timeoutMs?: number;
}

export async function clearAlmaBundleCache(
  options: ClearBundleCacheOptions = {},
): Promise<void> {
  const engine = (options.spawn ?? spawnAlmaSyncEngine)();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const clearing = engine.clearCache();
    if (options.timeoutMs === undefined) {
      await clearing;
      return;
    }
    const timeoutMs = options.timeoutMs;
    await Promise.race([
      clearing,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`bundle cache clear timed out after ${timeoutMs} ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    // Terminating also drops a still-queued Web Lock request on timeout.
    engine.terminate();
  }
}
