import {
  EngineClient,
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
 * `__EDGEPROC_REPORT_CACHE__`, publish which cache the library chose
 * ("sqlite-opfs", or "sqlite-memory" when OPFS is refused). There is no
 * IndexedDB fallback to force: since @gainratio/browser 0.3.0 the cache is
 * SQLite on OPFS, else SQLite in memory for the Worker's life.
 */
type ExitGateGlobals = typeof globalThis & {
  __EDGEPROC_REPORT_CACHE__?: boolean;
  __EDGEPROC_SELECTED_CACHE__?: string;
  __EDGEPROC_CACHE_STORAGE__?: EngineSyncResult["cacheStorage"];
};

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

export function createAlmaSyncEngine(worker: EngineWorkerLike): AlmaSyncEngine {
  const client = new EngineClient(worker);
  return {
    async sync(baseUrl, pubkeyUrl, expectedBundleId, expectedChannel, onProgress) {
      const hooks = globalThis as ExitGateGlobals;
      const result = await client.sync(baseUrl, pubkeyUrl, {
        expectedBundleId,
        expectedChannel,
        cacheNamespace: CACHE_NAMESPACE,
        indexedDbLayout: LEGACY_INDEXED_DB_LAYOUT,
        ...(onProgress === undefined ? {} : { onProgress }),
      });
      if (hooks.__EDGEPROC_REPORT_CACHE__ === true) {
        hooks.__EDGEPROC_SELECTED_CACHE__ = result.cacheBackend;
        hooks.__EDGEPROC_CACHE_STORAGE__ = result.cacheStorage;
      }
      return result;
    },
    readFile: (path) => client.readFile(path),
    clearCache: () =>
      client.clear({
        cacheNamespace: CACHE_NAMESPACE,
        indexedDbLayout: LEGACY_INDEXED_DB_LAYOUT,
      }),
    terminate: () => client.dispose(),
  };
}

/** Consumer-owned Worker construction keeps Vite in control of the asset URL. */
export function spawnAlmaSyncEngine(): AlmaSyncEngine {
  return createAlmaSyncEngine(new EdgeProcWorker());
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
