# AlmaMesh frontend

**The whole product lives here.** This is a Bun-workspace monorepo whose app
(`apps/web`) is an installable PWA that computes Vedic charts **entirely in the
browser** — the deterministic engine is the unchanged Python `almamesh` package
run under Pyodide (WebAssembly) in a Web Worker. No backend, no accounts, offline
after the first load.

TL;DR for a cold start:

```bash
cd frontend && bun install
cd apps/web && ./scripts/setup-dev-assets.sh   # one-time: Pyodide dist + signed dev bundle (gitignored)
bun run build && bun run preview               # open the printed URL, generate a chart offline
```

> **Why build+preview, not `dev`?** The engine's module Workers (and the
> `pyodide` import in worker scope) only resolve in a real Rollup build. `vite
> dev` is fine for editing UI, but the *engine* only runs under `vite build` +
> `vite preview`. The live exit-gate test drives exactly that build.

## Layout

```
frontend/
├── package.json                Bun workspace root (workspaces: packages/*, apps/web)
├── tsconfig.base.json
├── scripts/generate-cities.mjs builds the offline geocoder city dataset
├── packages/
│   ├── shared-types/           UI-facing TS contract: ChartData, DashaData, etc.
│   ├── constants/              SINGLE design-token source (colors/typography/astrology) + Tailwind preset
│   ├── browser/                THE in-browser engine (see below)
│   ├── store/                  Zustand stores + the pure SiderealChart adapters
│   │                            (chart, chartGeometry, energy) + profiles store
│   └── llm/                    optional AI, off by default: cloud/BYO OpenAI-compatible endpoint (OpenRouter preset or local Ollama)
└── apps/web/                   the React + Vite + Tailwind PWA ("Observatory" UI)
    ├── scripts/setup-dev-assets.sh   regenerates the gitignored dev assets
    ├── scripts/verify-exit-gate.mjs  live headless-Chromium exit gate
    ├── src/data/cities.min.json      bundled offline geocoder dataset
    ├── src/components/ui/             design-system primitives (Button, Card, Tabs, …)
    ├── src/components/features/layout/  AppLayout shell + Header (profile switcher)
    ├── src/components/chart/          N/S Indian SVG kundli + ChartStyleToggle
    └── src/components/forcefield/     the 3D planetary force-field hero (three.js)
```

### Packages

| Package | Role |
|---------|------|
| `@almamesh/shared-types` | The UI contract (`ChartData` and friends). UI code depends on this, not on the engine's raw shapes. |
| `@almamesh/constants` | The **single design-token source** (colors, typography, astrology constants); also exports a Tailwind preset (`@almamesh/constants/tailwind.preset`). |
| `@almamesh/browser` | The in-browser engine. Bundle sync + Pyodide chart Worker + `AlmaMeshRuntime`. |
| `@gainratio/browser` | Standalone browser sync Lego from npm, tracking its latest release (`^0.2.0`): signed-bundle sync into OPFS/IndexedDB with ed25519 + sha256 fail-closed. See `../docs/edgeproc-browser.md`. |
| `@almamesh/store` | Zustand stores + **pure** adapters, all reshape-only with **no astrology math**: `chart.ts` (`SiderealChart → ChartData`), `chartGeometry.ts` (`buildChartGeometry` → N/S kundli geometry), `energy.ts` (`buildEnergyFrame(chart, t)` → 3D force-field frame), plus the `profiles` store (named, password-less people; each owns its charts). |
| `@almamesh/llm` | Optional narration + multi-turn chat — **no AI by default** (the chart is pure calculation). Opt-in **cloud/BYO** only: any OpenAI-compatible endpoint (`engine:'openai-http'`) — a one-click OpenRouter preset (stronger) or a local Ollama. Saving runs a real connectivity probe (`testProviderConnection`); PII-redacted, fail-closed `local_only`. Never required to draw a chart. |
| `@almamesh/memory` | Zero-egress semantic chat memory: self-hosted MiniLM embeddings plus the shared `@gainratio/browser/vector/sqlite` Worker. Exact cosine search and profile/generation filtering run in SQLite; derived vectors persist in OPFS. |
| `apps/web` | The React/Vite "Observatory" PWA: UI primitives (`src/components/ui/`), `AppLayout` shell, N/S charts, and the `forcefield/` 3D hero. Self-hosted fonts (`@fontsource-variable/*`) — no font CDN. |

(`@almamesh/api-client` and `@almamesh/hooks` were deleted with the SaaS runtime.)

## How `@almamesh/browser` works

Two Workers, off the UI thread, driven by `AlmaMeshRuntime.bootstrap()`:

1. **Sync tier** — the injected-worker `EngineClient` from the standalone
   `@gainratio/browser` package pulls the **signed,
   content-addressed bundle** from a static origin, verifies it **ed25519 +
   sha256 fail-closed**, and materializes the DE421 ephemeris + the
   Skyfield/Pyodide/`almamesh` wheels into **OPFS**.
2. **Pyodide Worker** — `ChartEngineClient` boots Pyodide from the self-hosted
   dist, installs the wheels from OPFS, and calls the *same* Python entrypoint
   the CLI uses: `calculate_sidereal_context(dt, lat, lon, reference_date=...)`.
   `reference_date` pins the "current" Vimshottari dasha, and it is **required**
   at this boundary — the worker glue raises rather than falling back to the wall
   clock, so a chart is a pure function of its four recorded inputs and is
   reproducible byte-for-byte against CPython. Callers mint it once with
   `newChartReferenceInstant()` (`@almamesh/store`) and pass that same value to
   both `toBirthInput` and `siderealChartToChartData`, which is what makes the
   stored `calculation_timestamp` the key that regenerates the chart.

The Worker emits a `SiderealChart` (a TS mirror of the Python `SiderealContext`).
`@almamesh/store`'s adapter reshapes it into `ChartData` for the UI. After the
first bootstrap everything needed lives in OPFS, so reloads are offline.

> **No sibling checkout required:** `@almamesh/browser` resolves the public
> `@gainratio/browser` package from npm at the version recorded in the frozen
> Bun lock. AlmaMesh owns a one-line Worker entry plus a thin cache
> compatibility/exit-gate adapter; generic sync, crypto, storage, and vector
> code remain upstream. A fresh clone typechecks and builds with `bun install`
> alone.

## How `@almamesh/llm` works

The chart is computed without any AI — **the default is no AI at all**, stated
in the app as a feature. When the user opts in, `@almamesh/llm` speaks to a
single engine, any OpenAI-compatible endpoint they bring:

- **Cloud / BYO endpoint.** The one-click **OpenRouter** preset (stronger
  models), or point `VITE_LLM_API_BASE`/`VITE_LLM_API_KEY` (or Settings → AI) at
  any OpenAI-compatible server — e.g. a local **Ollama** at
  `http://localhost:11434/v1`. Saving runs a real 1-token connectivity probe
  (`testProviderConnection`), so a bad key / bad model / out-of-credits /
  unreachable endpoint is reported immediately in the UI (and logged to the
  console) instead of a silent no-op.

Cloud-bound prompts run the chart through `sanitizeChartForLlm` (PII-redacted)
first, and `ensurePrivacy` is **fail-closed**: a `local_only` request that would
leave the device throws rather than sending. Chat is multi-turn, with history
trimmed to a token budget (`trimHistoryToBudget`). (The former on-device WebLLM
tier and its `@mlc-ai/web-llm` dependency were removed.)

## Dev assets (`apps/web/scripts/setup-dev-assets.sh`)

The large runtime inputs are **gitignored** and regenerated by this script. Run
it once after a fresh clone (or whenever the bundle/Pyodide inputs change):

```bash
cd apps/web && ./scripts/setup-dev-assets.sh
```

It writes:

- `apps/web/public/pyodide/` — a self-hosted, offline Pyodide dist
- `apps/web/public/bundle/`  — a signed dev edge-proc bundle (origin layout)
- `apps/web/public/public.key` — the release-matched ed25519 verify key for that bundle

It copies a Pyodide dist (override the source with `PYODIDE_DIST=/path/...`),
builds the `almamesh` wheel (`uv build --wheel`), and uses `almamesh-bundle`
(keygen + bundle) from `../../backend` to produce and sign the dev bundle.

## Commands

```bash
# Install (workspace root)
bun install

# Typecheck / lint everything
bun run --filter '*' typecheck
bun run --filter '*' lint

# Run the app end-to-end (engine needs a real build)
cd apps/web && bun run build && bun run preview

# Unit tests (Vitest)
cd apps/web && bun run test:unit
cd packages/store && bun run test
cd packages/llm && bun run test

# Live-browser exit gate: boots the real engine in headless Chromium, asserts
# no backend, no login, offline-capable, same-origin-only traffic.
# See the script header for the exact build+preview it expects, e.g.:
cd apps/web
VITE_API_URL= VITE_EXIT_GATE_HOOKS=1 ./node_modules/.bin/vite build --outDir dist-verify
VITE_API_URL= ./node_modules/.bin/vite preview --outDir dist-verify --port 4199 --strictPort &
node scripts/verify-exit-gate.mjs http://localhost:4199

# Byte-parity gate: the REAL browser Worker == the committed CPython golden.
# This is the gate the README badge points at, and it runs in CI. Reuses the
# same build + preview as the exit gate above. The reference date is an
# argument, never a constant in the script — see the script header for why.
node scripts/verify-browser-parity.mjs http://localhost:4199 \
  --reference-date=2025-01-01T00:00:00+00:00

# Optional local helper (NOT the gate, and not run by CI): the same golden
# compared against Pyodide hosted in *node*. It needs a hand-provisioned
# ~38 MB spike dir and proves nothing about a browser, so treat it as a
# debugging aid only. See packages/browser/integration/README.md.
cd packages/browser && bun run test:parity
# (one-time browser install: bunx playwright install chromium)

# Regenerate the offline geocoder dataset
bun run --filter @almamesh/web data:cities
```

## License

MIT — see [`../LICENSE`](../LICENSE).
