// Makes "engine ready" mean "engine can reboot offline".
//
// The Pyodide runtime (wasm, stdlib, lock, wheels) is cached by the service
// worker's CacheFirst rule for /pyodide/** — but only for fetches the SW
// actually sees. On a first visit to a slow phone the SW is still installing
// when the chart Worker starts, so the Worker is never controlled and its ~17 MB
// of fetches bypass the SW entirely. The engine boots, reports ready, and the
// next offline reload dies with "Failed to fetch dynamically imported module
// pyodide.asm.mjs" (or, with a half-filled cache, `No module named 'micropip'`).
//
// So the chart Worker checks the same cache after every boot and writes in any
// boot-critical file that is missing, before it reports ready. And because
// Pyodide's `loadPackage` only logs an offline fetch failure, a package that did
// not arrive is turned into a typed error here instead of a confusing
// ModuleNotFoundError several steps later.

/** The SW's CacheFirst cache for /pyodide/** (apps/web/vite.config.ts runtimeCaching). */
export const PYODIDE_CACHE_NAME = "almamesh-pyodide-immutable";

/** Loaded by `import()` inside loadPyodide, so it never passes through `fetch`. */
const DYNAMIC_IMPORT_ASSETS = ["pyodide.asm.mjs"] as const;

/** A package Pyodide was asked to load did not load (usually: fetch failed offline). */
export class PyodidePackageLoadError extends Error {
  public readonly missing: readonly string[];
  public readonly details: readonly string[];

  public constructor(missing: readonly string[], details: readonly string[]) {
    const what = missing.length > 0 ? missing.join(", ") : "one or more packages";
    const why = details.length > 0 ? `: ${details.join("; ")}` : "";
    super(`Pyodide could not load ${what}${why}`);
    this.name = "PyodidePackageLoadError";
    this.missing = missing;
    this.details = details;
  }
}

/** PEP 503 normalisation, so `python-dateutil` matches `python_dateutil`. */
function normalise(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

/** Throw unless every requested package loaded and Pyodide reported no error. */
export function assertPackagesLoaded(
  requested: readonly string[],
  loaded: readonly { readonly name: string }[],
  errors: readonly string[],
): void {
  const got = new Set(loaded.map((pkg) => normalise(pkg.name)));
  const missing = requested.filter((name) => !got.has(normalise(name)));
  if (missing.length > 0 || errors.length > 0) {
    throw new PyodidePackageLoadError(missing, errors);
  }
}

/** Every file a boot needs offline: what it fetched plus what it imported. */
export function bootCriticalUrls(indexUrl: string, fetched: Iterable<string>): string[] {
  const imported = DYNAMIC_IMPORT_ASSETS.map((file) => new URL(file, indexUrl).href);
  return [...new Set([...fetched, ...imported])];
}

/** The two CacheStorage calls this needs; a real `Cache` satisfies it. */
export interface DistCache {
  match(url: string): Promise<Response | undefined>;
  put(url: string, response: Response): Promise<void>;
}

/**
 * The SW's Pyodide cache, matched ignoring `Vary`. The SW stores each file under
 * the Worker's original request (which carried `Origin` for the module import);
 * a script cannot set `Origin`, so a `Vary: Origin` response would never match
 * here. The files are versioned and immutable, so Vary carries no meaning.
 */
export async function openDistCache(storage: CacheStorage): Promise<DistCache> {
  const cache = await storage.open(PYODIDE_CACHE_NAME);
  return {
    match: (url) => cache.match(url, { ignoreVary: true }),
    put: (url, response) => cache.put(url, response),
  };
}

export interface DistCacheResult {
  /** Files that were missing and are now cached. */
  readonly repaired: readonly string[];
  /** Files that are still not cached (server refused, or the write failed). */
  readonly failed: readonly string[];
}

/**
 * Write every missing URL into `cache`. Sequential on purpose: one response in
 * flight at a time keeps the repair inside the low-end memory budget.
 */
export async function ensureDistCached(
  urls: Iterable<string>,
  cache: DistCache,
  fetchFn: typeof fetch,
): Promise<DistCacheResult> {
  const repaired: string[] = [];
  const failed: string[] = [];
  for (const url of urls) {
    if ((await cache.match(url)) !== undefined) continue;
    try {
      const response = await fetchFn(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await cache.put(url, response);
      repaired.push(url);
    } catch {
      failed.push(url);
    }
  }
  return { repaired, failed };
}
