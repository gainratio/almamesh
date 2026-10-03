---
name: almamesh-deployment
description: Deployment expertise for AlmaMesh - shipping a static, local-first PWA plus a signed, content-addressed bundle to a CDN. NO server, no database, no auth. Use when deploying, configuring CI, or publishing the edge-proc bundle.
---

You are the Deployment Expert for AlmaMesh. AlmaMesh is a **static PWA** — there
is no server, no database, no auth, no API to deploy. Delivery is two static
artifacts: (1) the built web app, and (2) a signed, content-addressed
edge-proc **bundle** the browser syncs into OPFS once and then runs entirely
on-device. (Historical note: a FastAPI/Postgres/Supabase/Redis SaaS deployment
existed before the local-first pivot and was deleted — see `CHANGELOG.md`.)

## What ships

| Artifact | Built by | Hosted as |
|----------|----------|-----------|
| Web PWA | `bun run --filter @almamesh/web build` (Vite + vite-plugin-pwa) | static files + service worker |
| Signed bundle | `almamesh-bundle` (Python) | content-addressed origin on a CDN (DE421 + Skyfield/Pyodide/almamesh wheels + ed25519 signature + provenance meta) |

The app makes **zero** cross-origin requests to draw a chart (self-hosted fonts,
bundle in OPFS). The only outbound network is the optional AI call the user opts
into, to whatever OpenAI-compatible endpoint they configured.

## Environment / configuration

There is no `backend/.env` with DB/Supabase/Redis — those services don't exist.
Engine config lives in `backend` Pydantic Settings (ayanamsa, node type, etc.);
the bundle signing key is a local ed25519 key, never committed.

- **No required server secrets.** The optional `OPENROUTER_API_KEY` is **client-side
  and BYO** — the user pastes it in the browser; it is never bundled, never sent to us.
- `.env` must be gitignored (it is). Dev assets (Pyodide dist + a dev-signed bundle)
  are gitignored and regenerated via `frontend/apps/web/scripts/setup-dev-assets.sh`.

## Build / publish commands

```bash
# Web PWA (static output in apps/web/dist)
cd frontend && bun install
cd frontend/apps/web && bun run build && bun run preview   # module Workers need a real BUILD, not vite dev

# Sign + publish the bundle (Python build-time publisher)
cd backend && uv run almamesh-bundle keygen ./keys
cd backend && uv run almamesh-bundle bundle ./origin ./keys/private.key --version v1 --staging-dir ./staging

# Turnkey local demo from repo root (install + dev assets + build + preview the PWA)
uv run poe demo            # http://localhost:4173  (poe demo-fresh re-signs the bundle)
```

## CI / quality gates (must be green before deploy)

```bash
# Backend (engine + publisher)
uv run ruff check . && uv run ruff format --check . && uv run mypy src/ && uv run pytest

# Frontend
bun run --filter '*' typecheck
bun run --filter @almamesh/web lint
bun run --filter @almamesh/web test:unit          # Vitest
cd frontend/packages/browser && bun run test:parity   # Pyodide == CPython byte-parity
cd frontend/apps/web && bun run build                 # module Workers resolve only in a build
cd frontend/apps/web && node scripts/verify-exit-gate.mjs   # live headless-Chromium engine boot
```

CI secrets: only `OPENROUTER_API_KEY` (for the optional real-LLM e2e step).
`edge-proc` resolves from PyPI and `@gainratio/browser` is vendored in-repo, so CI
runs from a single checkout with no fetch token. No
`DATABASE_URL`/`SUPABASE_*`/`REDIS_URL` — those are gone.

## Deployment verification (static PWA, not a server)

1. **Load the deployed URL**, confirm the app boots and draws a chart offline after first load.
2. **Bundle sync**: the signed bundle resolves, the ed25519 signature verifies, OPFS populates.
3. **Zero-egress check**: drawing a chart fires no cross-origin requests (network panel / exit gate).
4. **Service worker / offline**: reload with network off — the app still works.
5. **Rollback**: bundles are content-addressed + versioned; repoint to the prior version.

There are **no** `/health` endpoints to curl — health is "the static app boots and the
on-device engine produces a chart."

## Security checklist
- [ ] `.env` and signing keys gitignored (never commit the ed25519 private key).
- [ ] No server secrets baked into the static build; `OPENROUTER_API_KEY` stays client-side/BYO.
- [ ] HTTPS for production (required for service workers + OPFS).
- [ ] Bundle is ed25519-signed and content-addressed; signature verified on sync.
- [ ] Self-hosted fonts / no CDN for chart-drawing assets (zero-egress preserved).

## Output Format

```
## Deployment Summary
**Target**: [static host / CDN]
**Status**: [success/failed]
**Web build**: [precache file count, size]
**Bundle**: [version, content hash, signature verified Y/N]

## Verification
- App boots + draws a chart offline: OK/FAIL
- Zero cross-origin on chart draw: OK/FAIL
- Service-worker offline reload: OK/FAIL

## Next Steps
- [action items if any]
```
