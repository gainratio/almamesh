# Go-Live checklist — activate almamesh.com auto-deploy

**TL;DR.** The Cloudflare Pages pipeline auto-deploys every green push to `main`.
GitHub only checks out the exact tested SHA and invokes native Dagger `deploy`;
Dagger owns signing, key shredding, pinned Wrangler 4.103.0, source identity, and
live app/bundle verification. Configure all four secrets before merging because
missing credentials fail closed. There is no manual production-deploy bypass.

> Background / architecture: [`almamesh-com.md`](./almamesh-com.md). The CI workflow
> is `.github/workflows/deploy.yml`; the prod build script is
> `frontend/apps/web/scripts/build-prod.sh`.

## Quick proof (no production credentials)

```bash
dagger call deploy-dry-run --expected-sha="$(git rev-parse HEAD)" sync
```

This builds a production-shaped artifact with an ephemeral signing key, runs the
pinned Wrangler Pages server, and verifies its exact build and bundle identity.
It cannot upload. The owner-only one-time account setup follows.

---

## ✅ Status — the 2026-06-21 go-live run (first deploy is LIVE)

The first production deploy is **done**, driven manually from the owner's Mac
(`wrangler` already logged in). Recorded here so the checklist matches reality:

- ✅ **Prod signing key backed up** off-machine (1Password). It is now load-bearing
  (clients pin it) — never rotate casually.
- ✅ **Pages project `almamesh` exists** (prod branch `main`) — Step 2 already done.
- ✅ **First deploy shipped** — `build-prod.sh` (prod-signed `v0.3.0` bundle) →
  `wrangler pages deploy dist` → **live at `https://almamesh.pages.dev`**. Validated
  end-to-end in headless Chromium through the REAL onboarding journey (no exit-gate
  hooks): chart renders on `/dashboard`, **zero cross-origin on the chart path**
  (zero-egress confirmed), `/public.key` matches the prod pin, `/bundle/latest`
  signature valid, `/report` PDF downloads. No console errors.
- ✅ **Custom domains attached** to the project via API — `almamesh.com` +
  `www.almamesh.com` (the zone is active in this account).
- ✅ **All 4 CI secrets set** — `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
  `BUNDLE_PRIVATE_KEY_B64`, `BUNDLE_PUBLIC_KEY_B64` → **auto-deploy is ARMED**.

## ✅✅ GO-LIVE COMPLETE — `almamesh.com` is fully live (2026-06-22)

The two formerly-remaining manual dashboard steps are **done**:

1. ✅ **DNS** — the stale Render records were deleted (apex `A` → `216.24.57.8/9`,
   `www` `CNAME` → `almamesh-web.onrender.com`) and replaced with two **proxied**
   `CNAME` records → `almamesh.pages.dev` (name `@` + `www`). Both auto-validated and
   issued TLS. Verified live: apex + `www` resolve via the CF proxy, 200 + valid cert,
   serve the SPA, `/public.key` matches the prod pin, `/bundle/latest/meta.json` 200.
2. ✅ **`CLOUDFLARE_API_TOKEN`** — set (all four secrets present; the next merge to
   `main` auto-deploys).

**Re-validated end-to-end** by a Playwright agent driving REAL onboarding against the
live `https://almamesh.com` origin (fresh OPFS): the ~38 MB engine boots, a chart
renders on `/dashboard`, console is clean, and there are **zero cross-origin requests
on the chart path** (zero-egress holds). The retryable warming/recovery card works.

> ⚠️ Cold first-load remains slow (400–600 tiny bundle chunks; ~85 s cold vs ~2 s
> warm) — future P-fix (HTTP/2 multiplexing / fewer-larger objects). On 2026-07-13,
> the Web Analytics dashboard toggle was turned off, but the existing production
> response still contained Cloudflare's injected beacon while that state propagated.
> The next app shell therefore sends `Cache-Control: public, no-cache, no-transform`
> as the deterministic enforcement boundary. After every deploy, the release
> operator must verify the live origin has this header, contains no injected beacon,
> makes no third-party requests, and produces no unexpected console errors. Do not
> record zero-egress as proven until those live checks pass.

The rest of this file is the full reference for re-running or auditing the pipeline.

---

## What you're activating

```
push to main ──► "Dagger" calls `ci` ──► passes ──► deploy.yml (same SHA)
                                                       │
                                                       └─► Dagger `deploy`
                                                           ├─ sign + shred key
                                                           ├─ Wrangler Pages deploy
                                                           └─ source + live identity
```

The deploy job signs the engine bundle **inside GitHub Actions** with your prod
private key. Dagger restores the typed Secret only into an ephemeral temp mount
outside the checkout, uses it through `PRODUCTION_KEYS_DIR`, shreds the private
file, removes the mount, and strips secret variables before Wrangler executes.

---

## ⛔ Step 0 — Prerequisites (have these ready)

- A **Cloudflare account** that owns (or will own) the `almamesh.com` zone.
  - The domain's DNS should be managed by Cloudflare (nameservers pointed at CF).
- Wrangler 4.103.0 for one-time account setup — `npx --yes wrangler@4.103.0 --version`.
- `gh` CLI authenticated against `hseshadr/almamesh` — `gh auth status`.
- The production signing keypair present locally (it already is):
  - `backend/keys-prod/private.key` (32 bytes, mode 600)
  - `backend/keys-prod/public.key` (32 bytes)
  - Both are **gitignored** — they must never be committed.

---

## 🔑 Step 1 — Back up the production signing key (DO THIS FIRST)

`backend/keys-prod/private.key` is the **one** ed25519 key that every installed
client pins. If you lose it you **cannot** publish a new bundle that existing
clients will trust — they'd all have to re-onboard. It currently exists **only on
this Mac** (gitignored). Back it up to durable, private storage (password manager
/ encrypted vault) **before** it goes anywhere else.

```bash
cd /path/to/almamesh

# Copy both keys somewhere safe and OFF this machine (e.g. 1Password "AlmaMesh prod
# bundle signing key"). Store the raw files AND their base64 (used for the secrets):
base64 < backend/keys-prod/private.key    # → save as BUNDLE_PRIVATE_KEY_B64
base64 < backend/keys-prod/public.key     # → save as BUNDLE_PUBLIC_KEY_B64

# Sanity: each key is exactly 32 bytes.
wc -c backend/keys-prod/private.key backend/keys-prod/public.key   # → 32 each
```

**Do not** run `almamesh-bundle keygen` again for prod — that mints a NEW key and
silently rotates the pin. `build-prod.sh` fails closed rather than minting one, on
purpose.

---

## ☁️ Step 2 — Create the Cloudflare Pages project + custom domain

One-time, done by a human with `wrangler`. Project name **must** be `almamesh`
(the workflow passes `--project-name=almamesh`) and the production branch **must**
be `main`.

```bash
# Authenticate wrangler against your Cloudflare account (opens a browser).
npx --yes wrangler@4.103.0 login

# Create the Pages project (production branch = main).
npx --yes wrangler@4.103.0 pages project create almamesh --production-branch=main

# Note your Account ID — you'll need it for the secret in Step 4:
npx --yes wrangler@4.103.0 whoami        # prints the account name + Account ID
```

**Attach the custom domain `almamesh.com`.** There is no `wrangler` subcommand for
this; use the Cloudflare dashboard (recommended):

> Cloudflare dashboard → **Workers & Pages** → **almamesh** → **Custom domains** →
> **Set up a custom domain** → enter `almamesh.com` (and optionally `www.almamesh.com`).
> Cloudflare provisions DNS (apex CNAME-flattening) + TLS automatically.

(API equivalent, if you prefer:
`POST https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/pages/projects/almamesh/domains`
with body `{"name":"almamesh.com"}` and a Pages:Edit token.)

---

## 🎟️ Step 3 — Create a scoped Cloudflare API token

Used by CI to deploy. Make it **least-privilege**.

> Cloudflare dashboard → **My Profile** → **API Tokens** → **Create Token** →
> **Create Custom Token**:
> - **Permissions:** `Account` → `Cloudflare Pages` → **Edit**
> - **Account Resources:** Include → *your account*
> - (Zone permissions are not required for `pages deploy`.)
> - Create, then **copy the token value** (shown once) → this is `CLOUDFLARE_API_TOKEN`.

---

## 🔐 Step 4 — Add the four GitHub repo secrets

The deploy workflow needs exactly these four. The `--body "$(...)"` form strips any
trailing newline (important — the workflow decodes with `base64 -d`).

```bash
cd /path/to/almamesh

gh secret set CLOUDFLARE_API_TOKEN    --body "<the token from Step 3>"
gh secret set CLOUDFLARE_ACCOUNT_ID   --body "<Account ID from wrangler whoami>"
gh secret set BUNDLE_PRIVATE_KEY_B64  --body "$(base64 < backend/keys-prod/private.key)"
gh secret set BUNDLE_PUBLIC_KEY_B64   --body "$(base64 < backend/keys-prod/public.key)"

# Verify all four exist (values are never shown):
gh secret list
```

The next green push to `main` can now deploy. Missing or partial credentials fail
closed rather than silently skipping.

---

## 🚀 Step 5 — First deploy (protected main, watched)

Merge a green human PR. Production deploy has no manual trigger.

```bash
# Watch the protected Dagger gate, then its same-SHA workflow_run deployment:
gh run list --workflow=Dagger --branch=main --limit 1
gh run list --workflow='Deploy almamesh.com' --branch=main --limit 1
```

If two commits land close together, both deploys run. The older one exits green
with `SKIP <sha>: superseded by <newer> on main` and builds nothing; the newer one
deploys. An older commit is never deployed over a newer one.

What native Dagger `deploy` does (see `dagger/src/index.ts` + `build-prod.sh`):
installs deps, fetches the Pyodide dist, restores the prod keypair from typed
Secrets, **signs** the bundle into
`backend/origin-prod/`, bakes it into `dist/bundle/` + `dist/public.key`, builds the
PWA, deploys `dist/` to Cloudflare Pages, then **shreds** the restored private key.

---

## ✅ Step 6 — Verify the live site (static PWA, not a server)

There is no `/health` endpoint — health is "the app boots and draws a chart
offline". Check, in a browser, at https://almamesh.com :

- [ ] App shell loads over HTTPS; no console errors.
- [ ] **Onboard for real** (name + birth date/time + city) → **Generate** → wait for
      the ~38 MB engine bootstrap → a chart renders on `/dashboard`.
- [ ] **Zero cross-origin on chart draw** — open DevTools → Network, draw a chart:
      the only requests are same-origin (`/bundle/*`, `/pyodide/*`, app assets). The
      only allowed outbound is an AI call *you* opt into.
- [ ] **Offline reload** — turn off network, reload: the app still works (SW + OPFS).
- [ ] The signed bundle resolves: `/bundle/latest` is served and the ed25519
      signature verifies against `/public.key` (no signature error in console).
- [ ] **Download PDF** from `/report` produces the beautiful report (correct dates).

---

## 🔁 Step 7 — Confirm auto-deploy

After Steps 1–5, normal flow takes over: **merge a PR to `main` → "Dagger" `ci` passes →
`deploy.yml` auto-runs and ships almamesh.com.** Confirm once:

```bash
# After your next merge to main, a Deploy run should appear automatically:
gh run list --workflow="Deploy almamesh.com" --limit 3
```

---

## 🩹 Rollback

Bundles are content-addressed, signed, and protected by a monotonic sequence.
Cloudflare Pages keeps every deployment, but an old artifact must not be
restored directly because its older pointer is intentionally rejected:

- **App or bundle rollback:** check out the prior source/content, then rebuild
  and sign it as a **new release** whose `BUNDLE_SEQUENCE` is greater than the
  current verified live pointer. Deploy and verify that new artifact.
- **Never repoint `latest` or use Pages' one-click rollback by itself.** That
  creates a split: cached clients reject the lower sequence while fresh clients
  may accept the old artifact.

---

## Key custody rules (don't skip)

- The prod **private key is irreplaceable** — back it up off-machine (Step 1) and
  never commit it. `.gitignore` already excludes `backend/keys-prod/`,
  `backend/origin-prod/`, `frontend/apps/web/public/bundle/`, and
  `public/public.key`.
- Treat `BUNDLE_PRIVATE_KEY_B64` like the key itself — rotating it orphans clients.
- `OPENROUTER_API_KEY` is **client-side / BYO** — never bake it into the build or a
  Cloudflare env var. The static site ships zero server secrets.
- Use HTTPS only (required for service workers + OPFS) — Cloudflare provides it.

---

## Quick reference — the four secrets

| GitHub secret | Value | Source |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | Pages:Edit-scoped token | Step 3 |
| `CLOUDFLARE_ACCOUNT_ID` | account that owns the project + zone | `npx --yes wrangler@4.103.0 whoami` |
| `BUNDLE_PRIVATE_KEY_B64` | `base64 < backend/keys-prod/private.key` | Step 1 |
| `BUNDLE_PUBLIC_KEY_B64` | `base64 < backend/keys-prod/public.key` | Step 1 |
