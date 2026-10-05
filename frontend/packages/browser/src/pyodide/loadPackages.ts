// The Pyodide-lock packages the chart Worker loads before installing the
// signed-bundle wheels. Resolved offline from the self-hosted Pyodide lock (no
// PyPI/CDN). dateutil, pytz, and certifi ship in Pyodide's own lock, so
// skyfield's pure-Python deps need no network. Only the pure-Python bundle
// wheels (jplephem/sgp4/skyfield, almamesh) travel in the signed bundle.
//
// NO `pynacl`. Strength receipts are signed in TypeScript by `@gainratio/avow`
// (see ./strengthReceipt.ts), so the Ed25519 WASM dylib — and its cffi ->
// pycparser chain — is off EVERY boot, including natal-only sessions that never
// compute a Life Atlas. It is also the one package that would not register under
// this app's Pyodide boot at all.
//
// apps/web/scripts/setup-dev-assets.sh ships exactly the lock closure of this
// list (pinned by __tests__/pyodideDist.test.ts).
export const LOAD_PACKAGES = [
  "micropip",
  "numpy",
  "pydantic",
  "pyyaml",
  "python-dateutil",
  "pytz",
  "certifi",
] as const;
