# AlmaMesh Tech Stack

**Last Updated**: 2026-08-12

**TL;DR — AlmaMesh is a static, local-first PWA. There is no server-side
database, no accounts.** The chart engine is the unchanged Python `almamesh`
package running in the browser under Pyodide (WebAssembly) in a Web Worker,
**byte-identical to CPython**. The network delivers the app and syncs a
**signed, content-addressed bundle** into the browser's private storage (OPFS,
with a persistent IndexedDB fallback and shared rollback floor); after the first
complete load, the app works fully offline. **AI is off by default** (the chart is pure calculation)
and strictly opt-in.

Why this shape: local-first is the anti-scam guarantee. If the compute never
leaves the device, there is nothing to harvest, nothing to paywall, and every
result can be reproduced bit-for-bit from the open engine.

## At a glance

| Layer | Tech | Notes |
|-------|------|-------|
| Engine | Python 3.13 `almamesh` package | Pydantic models, `uv` deps; deterministic — same inputs → byte-identical chart on CPython and Pyodide |
| Astronomy | Skyfield + DE421 ephemeris | Sidereal; Lahiri ayanamsa default (True-Chitra + True-node selectable); externally validated against astropy + JPL Horizons to sub-arcsecond (no Swiss Ephemeris) |
| Delivery | `almamesh-bundle` CLI (build-time) | ed25519-signed, content-addressed bundle: DE421 + Skyfield/Pyodide wheels + the `almamesh` wheel + provenance metadata; verification is fail-closed |
| In-browser engine | Pyodide (WASM) in a Web Worker | `@almamesh/browser` syncs the signed bundle into OPFS or its durable IndexedDB fallback, boots the unchanged wheel, computes off the UI thread |
| Frontend | React ^19 + Vite ^6 + TypeScript ~5.7 + Tailwind ^3.4 | Bun-workspace monorepo; installable PWA (vite-plugin-pwa + service worker), offline after first load |
| State | Zustand ^5 + SQLite 3.53.4 WASM | Persisted envelopes, predictive results, portable preferences (including the optional AI key), and the deletion ledger share one authoritative OPFS SQLite database through `@gainratio/browser/sqlite`. Legacy localStorage and user-state IndexedDB are verified one-time migration inputs and are then purged, never maintained as mirrors. The live database opens normally; only exported `.almamesh` transport files are password-encrypted. Pure adapters in `@almamesh/store` reshape only—**no astrology in TypeScript**. |
| AI (optional) | Client-side, BYO endpoint (`@almamesh/llm`) | **Default: none** — the chart is pure calculation. Opt-in **cloud/BYO**: a one-click OpenRouter preset (stronger) or any OpenAI-compatible endpoint (incl. a local Ollama). Saving runs a real connectivity test so a bad key/model is reported immediately. Prompts are PII-redacted; `local_only` fail-closes against cloud hosts. Never required to draw a chart |
| Chat memory | `@almamesh/memory` + `@gainratio/browser/vector/sqlite` | Zero-egress RAG: on-device MiniLM embeddings in one Worker; exact cosine search and metadata filtering in a SQLite + sqlite-vector Worker; derived vectors persist in OPFS. There is no weaker JavaScript/IndexedDB vector fallback. |
| i18n | react-i18next | en / es / pt, offline bundled catalogs (zero egress); AI narrates in-language; en authoritative, es/pt machine-translated |
| Tests | Vitest (unit) + Playwright (live-browser exit gate) | Plus the `test:parity` gate asserting Pyodide == CPython byte-identical charts |
| Deploy | Cloudflare Pages (static) | CI runs `wrangler pages deploy dist`; the origin is plain static files + the signed bundle — any static host would do |

## How a chart happens (one paragraph)

The browser app (`@almamesh/browser`) verifies and syncs the signed bundle into
OPFS and its persistent IndexedDB safety copy. IndexedDB supplies the fallback
when OPFS cannot open and keeps one rollback floor across storage changes. It
then boots the `almamesh` wheel under Pyodide in a Web Worker and calls the
same `calculate_sidereal_context()` entrypoint the offline CLI calls. TypeScript
then only *reshapes* the result (`SiderealChart → ChartData` plus kundli
geometry and the 3D force-field frame) — every piece of astrology math lives in
Python. The same worker lazily serves the predictive ("Sky & Timing"), mesh
(relationship), and rectification (birth-time) entrypoints. Full pipeline detail
lives in the root [`CLAUDE.md`](../CLAUDE.md) Data Contract section.

## Commands

```bash
# Engine + bundle publisher (Python)
cd backend
uv sync --extra dev
uv run almamesh-chart "1990-01-15T12:00:00+00:00" 40.7128 -74.0060   # offline chart, no browser
uv run ruff check . && uv run mypy src/ && uv run pytest -q          # quality gate

# Turnkey demo (from the repo root): install + dev assets + build + open the PWA
uv run poe demo                                           # http://localhost:4173

# Frontend (the product — local-first PWA)
cd frontend && bun install
cd frontend/apps/web && ./scripts/setup-dev-assets.sh     # one-time: Pyodide dist + signed dev bundle
cd frontend/apps/web && bun run build && bun run preview  # run end-to-end (NOT `vite dev` — module Workers need a real build)
cd frontend/packages/browser && bun run test:parity       # Pyodide == CPython byte-parity gate
cd frontend/apps/web && node scripts/verify-exit-gate.mjs # live headless-Chromium exit gate
```

> The `frontend/` monorepo packages are `@almamesh/{shared-types,constants,
> browser,store,llm,memory}` plus `apps/web` (the "Observatory" PWA).
> `@almamesh/browser` consumes the standalone, exact-SHA `@gainratio/browser`
> bundle-sync Lego. See
> [`../frontend/README.md`](../frontend/README.md).

## Not using

| Technology | Reason |
|------------|--------|
| Any backend server / DB / cache | Local-first: compute on-device; the network is delivery-only |
| Accounts / auth / login | No sign-in; profiles are named, password-less, and live on the device |
| GraphQL / REST API | There is no API to call |
| Font / asset CDNs | Fonts are self-hosted; a loaded app makes zero cross-origin requests to draw a chart |
| Swiss Ephemeris | License-encumbered; Skyfield + DE421 validated independently instead |
