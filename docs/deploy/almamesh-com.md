# Deploying https://almamesh.com (Cloudflare Pages)

**TL;DR** — almamesh.com is a static deploy of `frontend/apps/web/dist` to
Cloudflare Pages. There is no account or chart-data backend: the dist folder is
the chart product (PWA shell + Pyodide engine + signed chart bundle + self-hosted
models/fonts). The optional feedback form is the separately disclosed
same-origin function. Dagger is the sole release orchestrator:

```bash
# PR-safe production-artifact + Pages behavior proof (ephemeral signing key)
dagger call deploy-dry-run --expected-sha="$(git rev-parse HEAD)" sync

# production: merge a green PR; the same-SHA main workflow invokes Dagger deploy
gh run list --workflow="Deploy almamesh.com" --limit 3
```

Then attach the domain (once): Cloudflare dashboard → **Workers & Pages →
almamesh → Custom domains → Set up a custom domain → `almamesh.com`**. The
almamesh.com zone already lives on this Cloudflare account, so Cloudflare
creates the CNAME record itself. (No wrangler subcommand exists for this; the
API equivalent is `POST /accounts/{account_id}/pages/projects/almamesh/domains`.)
Add `www.almamesh.com` the same way if wanted.

---

## Key custody — the one rule that cannot be broken

The chart engine only runs bundles whose ed25519 signature verifies against the
same release's `dist/public.key`. The service worker keeps that key in a
content-hash-versioned offline cache and revalidates it online. Deploy the key,
signed pointer, manifest, and chunks as one release; a mismatched or unavailable
pair fails closed.

- **The local production private key is `backend/keys-prod/private.key`**
  (gitignored; the whole `backend/keys-prod/` + `backend/origin-prod/` dirs are
  ignored). Dagger restores the typed secrets only into an ephemeral temp mount
  outside the checkout and passes that directory to `build-prod.sh` through
  `PRODUCTION_KEYS_DIR`.
- **Losing it = you cannot sign a continuity-preserving bundle update.** A
  deliberate key rotation requires one deployment containing both the new
  public key and bundles signed by its matching private key. Treat it
  like a release-signing key.
- **Back it up OUTSIDE the repo and outside this machine** immediately after
  keygen — e.g. a password manager secure note / encrypted vault:

  ```bash
  base64 < backend/keys-prod/private.key   # store this string + the public.key one
  base64 < backend/keys-prod/public.key
  ```

- **Never commit it, never print it into CI logs.** `.gitignore` covers
  `backend/keys-prod/`, plus `private.key` by name everywhere; CI restores it
  from a secret, shreds the ephemeral file, and removes that temp directory
  after the build. Only the public key is copied into the shipped artifact.
- Generating a key is deliberately manual (`build-prod.sh` fails closed if the
  keypair is missing instead of minting one) — an accidental fresh key would
  silently rotate the pin and orphan every installed client.
- The **dev** keypair (`backend/keys/`, written by `setup-dev-assets.sh`) is
  throwaway and unrelated. Local dev keeps using it; `build-prod.sh` swaps the
  production bundle + production `public.key` into `public/` for the artifact
  (re-run `setup-dev-assets.sh` or `uv run poe demo-fresh` to restore the dev
  bundle afterwards). Consequence for anyone diffing: a local
  `public/public.key` is the dev key, so it will never match the live
  `https://almamesh.com/public.key` (the prod pin CI injects) — that mismatch
  is expected, not a compromise.

## Rebuild → re-sign → redeploy (local recovery proof)

```bash
# 0. prereqs (once per machine): bun install done, dev assets fetched
cd frontend && bun install
bash apps/web/scripts/setup-dev-assets.sh     # pyodide dist + models + skyfield data

# 1. build the artifact — signs the bundle with backend/keys-prod, labels it
#    with the latest git tag and a signed monotonic sequence derived from the
#    commit count. Before copying anything into `dist/`, the script verifies the
#    candidate pointer and (when `BUNDLE_LIVE_URL` is set in CI) compares its
#    signed sequence to the live `/bundle/latest` pointer. BUNDLE_VERSION may
#    override the label. BUNDLE_SEQUENCE is recovery-only and MUST be greater
#    than the live verified pointer.
#    The script then runs the real production build with exit-gate hooks off.
bash apps/web/scripts/build-prod.sh

# 2. sanity: the script already asserts _headers/_redirects/public.key/bundle/
#    pyodide are in dist and that dist/public.key == keys-prod/public.key.

# 3. Never upload this directory manually. Production upload is Dagger-only
#    after the exact commit passes the protected Dagger workflow on main.
```

Bundle updates for already-installed clients flow through `/bundle/latest`
(no-cache) → new manifest hash → content-addressed chunk sync into OPFS,
verified against the release key. App-shell updates flow through `sw.js`
(no-cache) → the in-app "update available" prompt.

The signed sequence is the rollback/fork fence. Never deploy an older Pages
artifact directly: that would restore an older `/bundle/latest`, which existing
clients reject while fresh clients could accept. To roll back behavior, rebuild
the prior source/content as a **new** release with a sequence greater than the
live pointer, verify it, and deploy that newly signed artifact.

The live signed pointer is the durable release counter. CI authenticates both
the candidate and live pointers with the production public key before upload;
lower sequences and equal-sequence different manifests fail closed. An exact
same-pointer retry is allowed, so a transient Pages failure can be retried
without minting a new counter. A local build omits `BUNDLE_LIVE_URL` and still
verifies the candidate's signature; production CI always sets it.

### Production CI (auto-deploy after protected main CI)

`.github/workflows/deploy.yml` is pinned ingress only. It triggers automatically
after the "Dagger" workflow passes a push to this repository's `main`, checks out
that exact SHA, and passes four environment-backed typed Secrets to native Dagger
`deploy`. There is no manual dispatch path. Missing secrets fail closed.

| Secret | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | API token with Pages:Edit on the account |
| `CLOUDFLARE_ACCOUNT_ID` | the account that owns the project + zone |
| `BUNDLE_PRIVATE_KEY_B64` | `base64 < backend/keys-prod/private.key` |
| `BUNDLE_PUBLIC_KEY_B64` | `base64 < backend/keys-prod/public.key` |

**Activation order (important):** do the one-time human setup FIRST — pinned
`wrangler@4.103.0 login`, `wrangler@4.103.0 pages project create almamesh
--production-branch=main`, attach
the `almamesh.com` custom domain, back up `backend/keys-prod/private.key`
off-machine, then add the four secrets above. Once the secrets exist, the next
green CI run on `main` auto-deploys. Configure all four before merging; a partial
configuration produces a deliberate red deployment rather than a silent skip.

## What `dist/` must contain (and why)

| Path | Caching (see `public/_headers`) | Role |
|---|---|---|
| `index.html`, `/` + SPA routes | `no-cache` | app shell (SW precaches it) |
| `assets/*` (hashed) | immutable, 1y | JS/CSS chunks |
| `sw.js`, `manifest.webmanifest`, `version.json`, `build.json` | `no-cache` | update and exact-build identity signals |
| `workbox-*.js` (hashed) | immutable, 1y | SW runtime |
| `public.key` | `no-cache` | release ed25519 verify key; SW keeps a hash-versioned offline fallback |
| `bundle/latest` | `no-cache` | MUTABLE bundle pointer |
| `bundle/chunk(s)/*`, `bundle/manifest(s)/*` | immutable, 1y | content-addressed (sha256 names) |
| `pyodide/*` | immutable, 1y | version-pinned WASM runtime |
| `models/*` | immutable, 1y | self-hosted MiniLM + ort wasm |
| `fonts/*`, `planets/*` | 1y / 1d | self-hosted assets |
| `_headers`, `_redirects` | n/a (parsed by Pages, not served) | this config |

`build.json` is generated from the full `BUILD_COMMIT` SHA supplied by the
deployment workflow. The deploy job polls the live file and fails closed unless
Cloudflare serves the exact commit that passed CI; local builds intentionally
use the explicit `local` marker.

The same deploy job polls `/bundle/latest` after upload and fails closed unless
the live signed pointer's `manifest_hash:sequence` exactly matches the artifact
that was built. This closes the CDN propagation window between the build and
the Pages upload; both checks use cache-busting query parameters.

Size: ~153 MB / ~1,377 files (**no sourcemaps** — `build.sourcemap: false`;
Pages serves every file in the output directory, so an emitted `.map` is a
published copy of the original TypeScript source and no `_headers` rule can
un-serve it. Enforced by the `almamesh-no-sourcemaps` build plugin and a
`find -name '*.map'` check in `build-prod.sh`), largest file ~23 MB
(`models/Xenova/.../model_quantized.onnx`) — under the Pages **25 MiB/file**
cap; file count is far below the 20,000-file cap.

## Pages behaviors we verified (don't re-litigate, re-test)

Verified empirically against `wrangler pages dev` (same asset-serving code as
production) — re-run the probe if Cloudflare semantics are ever in doubt:

1. **`/* /index.html 200` in `_redirects` does NOT shadow real assets** —
   `/assets/*.js`, `/bundle/latest` (extensionless), `/pyodide/*` are still
   served as themselves; only unmatched paths fall back to the shell. (The docs'
   "redirects are always followed" caveat applies to true 3xx redirects.)
   Without `_redirects`, Pages' implicit SPA rendering does the same; the file
   makes it explicit and survives a future `404.html`.
2. **`_headers` rules MERGE same-name headers across matching rules** —
   `/*` + `/assets/*` both setting `Cache-Control` yields
   `no-cache, public, max-age=…, immutable` (browsers then treat it as
   no-cache). Every specific rule therefore detaches first (`! Cache-Control`)
   before setting its own. Do not remove the `!` lines.
3. **COOP `same-origin` + COEP `require-corp` are required together.** The
   shared OPFS Web-Locks SQLite VFS depends on `SharedArrayBuffer`, which is only
   exposed in a cross-origin-isolated document. Keep both headers on the app
   shell, service worker, and worker responses. `require-corp` is intentional:
   it works in the WebKit lane where `credentialless` does not. OpenRouter and
   Open-Meteo opt in through CORS, while Cloudflare Turnstile supplies a
   cross-origin resource policy. The browser probe's optional external-egress
   mode exercises all three before a release without making normal CI depend on
   upstream availability.
4. Content types: Pages serves `.wasm` as `application/wasm`, `.js` as
   `application/javascript`; extensionless bundle files (`latest`, sha256
   chunks) come back as octet-stream and are consumed via `fetch()` — fine.
5. **The app shell owns zero-egress at the origin.** The catch-all response uses
   `Cache-Control: public, no-cache, no-transform`, which keeps revalidation while
   preventing Cloudflare Web Analytics from injecting a third-party beacon into
   valid HTML. Keep the dashboard automatic setup disabled too, but do not rely on
   dashboard state as the enforcement boundary. The public-file test locks the
   origin header rule. After deployment, the release operator must verify the
   effective live header and run the live no-third-party-request/clean-console
   acceptance checks before declaring the release complete.
6. **A `503` on an app route in a browser trace is a refused prefetch, not an
   outage.** The zone has Cloudflare Speed Brain on (the Free-plan default). It
   adds `speculation-rules: "/cdn-cgi/speculation"` to every HTML response, so a
   supporting browser prefetches a same-origin link on pointer-down. Cloudflare
   only answers a prefetch from its cache; our HTML is never cached, so the edge
   replies `503` with `cf-speculation-refused: prefetch refused: not eligible`
   and no body. The real navigation is unaffected. Measured live 2026-10-02:

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' https://almamesh.com/onboarding                         # 200
   curl -s -o /dev/null -w '%{http_code}\n' -H 'Sec-Purpose: prefetch' https://almamesh.com/onboarding  # 503
   ```

   Nothing in this repo sets that header. To stop the refused prefetches, turn
   Speed Brain off for the zone (dashboard: Speed > Settings > Content
   Optimization, or `PATCH zones/$ZONE_ID/settings/speed_brain {"value":"off"}`).
   It is still on as of this note; `curl -sI https://almamesh.com/ | grep -i
   speculation-rules` printing nothing is the proof it is off.

## Verifying an artifact before deploy

```bash
# closest-to-production local serve (honors _headers/_redirects):
cd frontend/apps/web && bunx wrangler pages dev dist --port 8788
# then drive the real engine against http://127.0.0.1:8788 with the project's
# Playwright Chromium: onboard a chart → dashboard → /predictive → /mesh,
# console clean. NOTE: scripts/verify-exit-gate.mjs CANNOT run against this
# artifact — it needs a VITE_EXIT_GATE_HOOKS=1 build (CI's exit-gate job covers
# that on every push); the production artifact deliberately ships without hooks.
```
