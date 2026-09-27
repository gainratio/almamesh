#!/usr/bin/env bash
#
# build-prod.sh — produce the PRODUCTION deploy artifact for https://almamesh.com
# (Cloudflare Pages serves the chart product from frontend/apps/web/dist; the
# optional feedback function is the separately disclosed server touchpoint).
#
# What it does, in order:
#   1. Rebuilds the almamesh wheel from the current checkout.
#   2. Signs the offline bundle with the PRODUCTION keypair (backend/keys-prod
#      locally, or PRODUCTION_KEYS_DIR in CI) into
#      backend/origin-prod, labeled with the latest git tag by default.
#   3. Swaps the production bundle + production public.key into apps/web/public/
#      (replacing whatever dev-signed bundle setup-dev-assets.sh put there;
#      re-run setup-dev-assets.sh / `uv run poe demo-fresh` to get dev back).
#   4. Runs the REAL production build: NO exit-gate hooks
#      (VITE_EXIT_GATE_HOOKS empty) and VITE_API_URL empty (no chart-data API).
#
# Prereqs (fail-closed below):
#   - bun install done; setup-dev-assets.sh run once (public/pyodide + public/models)
#   - the production keypair exists in PRODUCTION_KEYS_DIR when set, otherwise
#     backend/keys-prod/private.key + public.key:
#       cd backend && uv run almamesh-bundle keygen ./keys-prod
#     (deliberately NOT auto-generated here: generating a fresh key would
#      silently rotate the pin and orphan every installed client)
#
# Usage:  bash apps/web/scripts/build-prod.sh
#         BUNDLE_VERSION=v9.9.9 bash apps/web/scripts/build-prod.sh   # override label
#         BUNDLE_SEQUENCE=123 bash apps/web/scripts/build-prod.sh     # recovery only;
#                                                                   must exceed live
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"             # frontend/apps/web
REPO_ROOT="$(cd "${WEB_DIR}/../../.." && pwd)"        # repo root (almamesh/)
BACKEND_DIR="${REPO_ROOT}/backend"
PUBLIC_DIR="${WEB_DIR}/public"
# CI supplies this from the runner's ephemeral temp directory so the private
# signing key is never materialized inside the checkout. Local builds retain
# the documented backend/keys-prod default.
KEYS_DIR="${PRODUCTION_KEYS_DIR:-${BACKEND_DIR}/keys-prod}"
ORIGIN_DIR="${BACKEND_DIR}/origin-prod"

# --- Fail-closed preflight ----------------------------------------------------
if [[ ! -f "${KEYS_DIR}/private.key" || ! -f "${KEYS_DIR}/public.key" ]]; then
  echo "!! Production keypair missing at ${KEYS_DIR}/" >&2
  if [[ -n "${PRODUCTION_KEYS_DIR:-}" ]]; then
    echo "!! CI must restore private.key + public.key into PRODUCTION_KEYS_DIR." >&2
  else
    echo "!! Generate ONCE and back it up (docs/deploy/almamesh-com.md):" >&2
    echo "!!   cd backend && uv run almamesh-bundle keygen ./keys-prod" >&2
  fi
  exit 1
fi
if [[ ! -f "${PUBLIC_DIR}/pyodide/pyodide.asm.wasm" ]]; then
  echo "!! Pyodide dist missing — run apps/web/scripts/setup-dev-assets.sh once first." >&2
  exit 1
fi
if [[ ! -d "${PUBLIC_DIR}/models" ]]; then
  echo "!! public/models missing — run apps/web/scripts/setup-dev-assets.sh once first." >&2
  exit 1
fi

BUNDLE_VERSION="${BUNDLE_VERSION:-$(git -C "${REPO_ROOT}" describe --tags --abbrev=0 2>/dev/null || echo "0.0.0+$(git -C "${REPO_ROOT}" rev-parse --short HEAD)")}"
BUNDLE_SEQUENCE="${BUNDLE_SEQUENCE:-$(git -C "${REPO_ROOT}" rev-list --count HEAD)}"
echo "==> Production build for almamesh.com — bundle version ${BUNDLE_VERSION}, sequence ${BUNDLE_SEQUENCE}"

# --- 1. Fresh wheel from this checkout -----------------------------------------
echo "==> Building almamesh wheel"
( cd "${BACKEND_DIR}" && uv build --wheel )
WHEEL="$(ls -t "${BACKEND_DIR}"/dist/almamesh-*-py3-none-any.whl | head -1)"
echo "    wheel: ${WHEEL}"

# --- 2. Sign the offline bundle with the PRODUCTION key ------------------------
# A clean origin dir so the artifact contains exactly one signed bundle.
rm -rf "${ORIGIN_DIR}"
echo "==> Signing the production bundle into ${ORIGIN_DIR}"
( cd "${BACKEND_DIR}" && uv run almamesh-bundle bundle ./origin-prod "${KEYS_DIR}/private.key" \
    --version "${BUNDLE_VERSION}" --sequence "${BUNDLE_SEQUENCE}" --offline \
    --almamesh-wheel "${WHEEL}" )

# Authenticate the candidate pointer and, in CI, compare it with the durable
# release counter in the live signed /bundle/latest pointer. A true retry of
# the exact same pointer is idempotent; rollback and equal-sequence forks fail.
RELEASE_GUARD_ARGS=(
  --candidate "${ORIGIN_DIR}/latest"
  --public-key "${KEYS_DIR}/public.key"
)
if [[ -n "${BUNDLE_LIVE_URL:-}" ]]; then
  RELEASE_GUARD_ARGS+=(--live-url "${BUNDLE_LIVE_URL}")
fi
echo "==> Verifying signed bundle release preflight"
( cd "${BACKEND_DIR}" && uv run python -m almamesh.edge.release_guard "${RELEASE_GUARD_ARGS[@]}" )

# --- 3. Swap the production bundle + pinned public key into public/ ------------
echo "==> Publishing production bundle + public.key into ${PUBLIC_DIR}"
rm -rf "${PUBLIC_DIR}/bundle"
mkdir -p "${PUBLIC_DIR}/bundle"
cp -R "${ORIGIN_DIR}/." "${PUBLIC_DIR}/bundle/"
cp "${KEYS_DIR}/public.key" "${PUBLIC_DIR}/public.key"

# --- 4. The real production build (no hooks, no backend URL) -------------------
echo "==> Building the app (tsc -b && vite build) — hooks OFF, VITE_API_URL empty"
( cd "${WEB_DIR}" && VITE_API_URL= VITE_EXIT_GATE_HOOKS= bun run build )

# --- Artifact sanity ------------------------------------------------------------
DIST="${WEB_DIR}/dist"
for must in index.html sw.js manifest.webmanifest _headers _redirects public.key \
            bundle/latest pyodide/pyodide.asm.wasm .well-known/security.txt; do
  if [[ ! -f "${DIST}/${must}" ]]; then
    echo "!! dist is missing ${must}" >&2
    exit 1
  fi
done
# Production sourcemaps must never reach Pages: it serves every file in the
# output directory, so a `.map` here IS a published copy of the original
# TypeScript source (a `_headers` rule cannot un-serve it). vite.config.ts sets
# `build.sourcemap: false` and the almamesh-no-sourcemaps plugin fails the build
# on emission; this is the last check, against the bytes actually being deployed.
if maps="$(find "${DIST}" -name '*.map' -print -quit)" && [[ -n "${maps}" ]]; then
  echo "!! dist would publish sourcemaps (first: ${maps}) — build.sourcemap must be false" >&2
  exit 1
fi
# The deployed bundle must verify against the PRODUCTION key, not the dev key.
if ! cmp -s "${DIST}/public.key" "${KEYS_DIR}/public.key"; then
  echo "!! dist/public.key is not the production key" >&2
  exit 1
fi
# The activation warmer must be bound to the exact production trust root. A
# successful UI build without this check could still lose first-session offline
# recovery while keeping signature verification fail-closed.
TRUST_KEY_HASH="$(shasum -a 256 "${KEYS_DIR}/public.key" | awk '{print substr($1, 1, 16)}')"
TRUST_KEY_B64="$(base64 < "${KEYS_DIR}/public.key" | tr -d '\n')"
TRUST_KEY_CONFIG="engine-trust-config-${TRUST_KEY_HASH}.js"
if [[ ! -f "${DIST}/${TRUST_KEY_CONFIG}" ]] || \
   ! grep -Fq "__ALMAMESH_TRUST_KEY_B64__=\"${TRUST_KEY_B64}\"" "${DIST}/${TRUST_KEY_CONFIG}" || \
   ! grep -Fq "importScripts(\"${TRUST_KEY_CONFIG}\",\"engine-trust-install.js\")" "${DIST}/sw.js"; then
  echo "!! service worker trust fallback is not bound to the production public key" >&2
  exit 1
fi
echo "==> Done. Deploy artifact: ${DIST} ($(du -sh "${DIST}" | cut -f1), $(find "${DIST}" -type f | wc -l | tr -d ' ') files)"
echo "==> Largest files (Cloudflare Pages cap is 25 MiB/file):"
find "${DIST}" -type f -size +8M -exec ls -lh {} \; | awk '{print "    " $5 "  " $9}'
