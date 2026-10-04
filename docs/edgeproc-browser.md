# Standalone `@gainratio/browser` provenance

**TL;DR:** AlmaMesh consumes the generic signed-bundle browser engine from npm
as `@gainratio/browser`, at a caret range that tracks the newest release. This
repository keeps only a thin AlmaMesh adapter: a consumer-owned Worker entry,
the historical cache layout, and exit-gate observability.

## Source

| Field | Value |
|---|---|
| Package | [`@gainratio/browser`](https://www.npmjs.com/package/@gainratio/browser) |
| Range | `^0.2.0` (no upper cap; never a Git alias, never `"latest"`) |
| Source repository | `https://github.com/hseshadr/edgeproc-browser` |
| License | MIT |
| Consumer manifests | `frontend/packages/browser/package.json`, `frontend/packages/memory/package.json`, `frontend/packages/store/package.json` |
| Reproducible lock | `frontend/bun.lock` (a deploy builds exactly what CI tested) |

A Dependabot job (`.github/dependabot.yml`, group `gainratio`) checks
`@gainratio/*` daily and opens a bump PR right after each release.
`repositoryTruth.test.ts` fails if any `package.json` names the retired
`@edgeproc/` scope or a Git dependency on our own libraries.

## Boundary owned here

- `frontend/packages/browser/src/edgeproc.worker.ts` is the one-line,
  consumer-owned Vite Worker entry.
- `frontend/packages/browser/src/edgeprocClient.ts` adapts AlmaMesh's legacy
  four-argument sync port, preserves the `edgeproc-browser-cache` /
  `content-addressed-cache` / `:` IndexedDB layout, and maps the private
  exit-gate fallback hook to the shared typed storage option.
- `frontend/packages/browser/src/pyodide/` remains AlmaMesh product code: it
  loads the signed chart assets and boots the Pyodide chart Worker.

Generic signature verification, bounded fetch/decompression, content-addressed
sync, OPFS/IndexedDB persistence, locking, Worker protocol, and vector adapters
live only in the standalone package.

`frontend/packages/memory/src/vectorStore.ts` is a second thin domain adapter:
it maps chat chunks to flat SQLite metadata, applies the durable dataset
generation fence, and delegates all live similarity, scoped deletion, and OPFS
persistence to `@gainratio/browser/vector/sqlite`.

## Upgrade gate

1. Take the Dependabot `gainratio` PR (or bump the caret floor and run
   `bun install` in `frontend/`) so the Bun lock records the new release.
2. Run the complete frontend gate.
3. Build the real Vite app and confirm it emits one signed-bundle Worker asset
   and one SQLite-vector Worker asset.
4. Run the Chromium parity journey and both WebKit persistence journeys. They
   prove warm OPFS reuse, forced IndexedDB fallback using the historical layout,
   offline reload, trust-root refresh, and exactly one sync Worker asset.
5. Run the security audit and secret scan before merge.

The browser gate also writes, searches, disposes, reopens, and searches a real
OPFS SQLite vector index in Chromium. That is the consumer proof that the published
npm artifact contains runnable SQLite and sqlite-vector assets, not merely
passing mocked adapter tests. The WebKit leg capability-probes OPFS: Playwright
WebKit currently throws `UnknownError` while opening the root, so AlmaMesh must
return the stable `memory.opfs_unavailable` refusal without spawning a Worker or
falling back to a weaker index. Authoritative chat remains usable.
