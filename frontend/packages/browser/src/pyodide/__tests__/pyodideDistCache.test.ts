import { describe, expect, it } from "vitest";

import {
  assertPackagesLoaded,
  bootCriticalUrls,
  ensureDistCached,
  openDistCache,
  PYODIDE_CACHE_NAME,
  PyodidePackageLoadError,
  type DistCache,
} from "../pyodideDistCache";

const INDEX = "https://almamesh.com/pyodide/v314.0.7/";

/** An in-memory stand-in for one CacheStorage cache, keyed by URL. */
function memoryCache(seed: readonly string[] = []): DistCache & { readonly urls: Set<string> } {
  const urls = new Set(seed);
  return {
    urls,
    match: async (url) => (urls.has(url) ? new Response("cached") : undefined),
    put: async (url, response) => {
      await response.arrayBuffer();
      urls.add(url);
    },
  };
}

function fetchFrom(status: number, log: string[] = []): typeof fetch {
  return async (input) => {
    log.push(String(input));
    return new Response("bytes", { status });
  };
}

describe("PYODIDE_CACHE_NAME", () => {
  it("is the cache the service worker serves /pyodide/** from (vite.config.ts runtimeCaching)", () => {
    expect(PYODIDE_CACHE_NAME).toBe("almamesh-pyodide-immutable");
  });
});

describe("assertPackagesLoaded", () => {
  const requested = ["micropip", "numpy", "python-dateutil"];
  const loaded = [{ name: "micropip" }, { name: "numpy" }, { name: "python_dateutil" }];

  it("accepts a load where every requested package arrived and nothing was reported", () => {
    expect(() => assertPackagesLoaded(requested, loaded, [])).not.toThrow();
  });

  it("throws a typed error naming the package Pyodide silently skipped (offline fetch failure)", () => {
    const offline = [{ name: "numpy" }, { name: "python-dateutil" }];
    const report = ["The following error occurred while loading micropip: Failed to fetch"];
    let caught: unknown;
    try {
      assertPackagesLoaded(requested, offline, report);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PyodidePackageLoadError);
    const failure = caught as PyodidePackageLoadError;
    expect(failure.missing).toEqual(["micropip"]);
    expect(failure.message).toContain("micropip");
    expect(failure.message).toContain("Failed to fetch");
  });

  it("throws when Pyodide reported an error even if every root is listed", () => {
    expect(() => assertPackagesLoaded(requested, loaded, ["checksum mismatch for numpy"])).toThrow(
      PyodidePackageLoadError,
    );
  });
});

describe("bootCriticalUrls", () => {
  it("adds the dynamically imported pyodide.asm.mjs, which never passes through fetch", () => {
    const fetched = [`${INDEX}pyodide-lock.json`, `${INDEX}micropip-0.11.1-py3-none-any.whl`];
    expect(bootCriticalUrls(INDEX, fetched)).toEqual([
      `${INDEX}pyodide-lock.json`,
      `${INDEX}micropip-0.11.1-py3-none-any.whl`,
      `${INDEX}pyodide.asm.mjs`,
    ]);
  });

  it("lists each URL once", () => {
    const fetched = [`${INDEX}pyodide.asm.mjs`, `${INDEX}pyodide.asm.mjs`];
    expect(bootCriticalUrls(INDEX, fetched)).toEqual([`${INDEX}pyodide.asm.mjs`]);
  });
});

describe("ensureDistCached", () => {
  const wheel = `${INDEX}micropip-0.11.1-py3-none-any.whl`;
  const asm = `${INDEX}pyodide.asm.mjs`;

  it("writes every boot-critical file the service worker did not cache (it lost the first-visit race)", async () => {
    const cache = memoryCache();
    const result = await ensureDistCached([wheel, asm], cache, fetchFrom(200));
    expect(cache.urls).toEqual(new Set([wheel, asm]));
    expect(result).toEqual({ repaired: [wheel, asm], failed: [] });
  });

  it("does not refetch a file already in the cache", async () => {
    const cache = memoryCache([wheel]);
    const log: string[] = [];
    const result = await ensureDistCached([wheel, asm], cache, fetchFrom(200, log));
    expect(log).toEqual([asm]);
    expect(result.repaired).toEqual([asm]);
  });

  it("reports, and never caches, a file the server refused", async () => {
    const cache = memoryCache();
    const result = await ensureDistCached([wheel], cache, fetchFrom(404));
    expect(cache.urls.size).toBe(0);
    expect(result).toEqual({ repaired: [], failed: [wheel] });
  });

  it("reports a file whose write failed (quota) instead of throwing", async () => {
    const cache: DistCache = {
      match: async () => undefined,
      put: async () => {
        throw new DOMException("quota", "QuotaExceededError");
      },
    };
    const result = await ensureDistCached([wheel], cache, fetchFrom(200));
    expect(result).toEqual({ repaired: [], failed: [wheel] });
  });
});

describe("openDistCache", () => {
  it("opens the SW's cache and matches ignoring Vary (a Worker cannot send the Origin the SW's request had)", async () => {
    const seen: { name?: string; options?: CacheQueryOptions } = {};
    const storage = {
      open: async (name: string) => {
        seen.name = name;
        return {
          match: async (_url: string, options?: CacheQueryOptions) => {
            seen.options = options;
            return undefined;
          },
          put: async () => {},
        };
      },
    } as unknown as CacheStorage;
    const cache = await openDistCache(storage);
    await cache.match(`${INDEX}pyodide.asm.mjs`);
    expect(seen.name).toBe("almamesh-pyodide-immutable");
    expect(seen.options).toEqual({ ignoreVary: true });
  });
});
