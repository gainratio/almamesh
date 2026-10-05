// Where the self-hosted Pyodide dist lives, per runtime version.
//
// The dist is served immutable (CDN `max-age=1y, immutable`) and the service
// worker CacheFirst-caches every `/pyodide/**` response for a year. Under an
// unversioned path a runtime upgrade would mix releases on a returning visit:
// the worker bundles the NEW `pyodide.mjs` loader while the HTTP cache and the
// `almamesh-pyodide-immutable` SW cache keep handing back the OLD lock, wasm
// and wheels. Putting each release under `v<version>/` makes the URLs disjoint,
// so no cache entry can ever be served to a runtime it was not built for.
//
// `version` is the loader's own constant — the same one `loadPyodide` checks
// against the fetched `pyodide.asm.mjs` — so the path cannot drift from the
// bundled runtime.
import { version } from "pyodide";

/** The Pyodide release bundled into the chart Worker. */
export const PYODIDE_RUNTIME_VERSION: string = version;

/**
 * Resolve `baseUrl` (e.g. `/pyodide/`) to the absolute, version-scoped index URL
 * handed to `loadPyodide`: `<origin>/pyodide/v<version>/`.
 */
export function versionedPyodideIndexUrl(
  baseUrl: string,
  runtimeVersion: string = PYODIDE_RUNTIME_VERSION,
  origin: string = self.location.href,
): string {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(`v${runtimeVersion}/`, new URL(base, origin)).href;
}
