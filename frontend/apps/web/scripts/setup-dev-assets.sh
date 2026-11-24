#!/usr/bin/env bash
#
# setup-dev-assets.sh — regenerate the large, git-ignored dev assets the
# in-browser engine needs at runtime. Run once after a fresh clone (or whenever
# the bundle/Pyodide inputs change). Everything it writes under
# apps/web/public/{pyodide,bundle,public.key} is .gitignored.
#
# What it produces:
#   apps/web/public/pyodide/v<ver>/ — self-hosted Pyodide dist (offline, 17 files)
#   apps/web/public/bundle/    — signed dev edge-proc bundle (origin layout)
#   apps/web/public/public.key — pinned ed25519 verify key for that bundle
#   apps/web/public/models/    — self-hosted RAG embedding model (MiniLM q8 ONNX)
#                                + onnxruntime-web wasm (offline, zero-egress)
#
# Usage:  bash apps/web/scripts/setup-dev-assets.sh
set -euo pipefail

# Resolve repo paths relative to this script (apps/web/scripts/).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"            # frontend/apps/web
REPO_ROOT="$(cd "${WEB_DIR}/../../.." && pwd)"        # repo root (almamesh/)
BACKEND_DIR="${REPO_ROOT}/backend"
PUBLIC_DIR="${WEB_DIR}/public"

# The self-hosted Pyodide dist: the core runtime + ONLY the package wheels our
# engine loads (numpy/pydantic/pyyaml + skyfield's pure-Python deps), pinned to
# the `pyodide` npm dep version. We fetch them once from Pyodide's official CDN
# (jsdelivr) so a fresh clone is fully reproducible; the RUNTIME stays offline
# (these are served same-origin from public/pyodide/). Core runtime files are
# copied from the pinned npm package when available (byte integrity without a
# second network hop); only the package wheels fall back to the CDN.
#
# To change the set: keep it in lockstep with loadPackages.ts LOAD_PACKAGES (+ the
# lock's transitive closure) and the `pyodide` dep version — both are pinned by
# packages/browser/src/pyodide/__tests__/pyodideDist.test.ts. Override with a
# local dir via PYODIDE_DIST=/path (skips the download).
#
# The dist lands in a VERSIONED directory, public/pyodide/v<version>/, which is
# where the chart Worker looks (pyodideDist.ts). /pyodide/* is served immutable
# and CacheFirst-cached by the service worker, so an unversioned path would let a
# returning visitor's cached 0.29 lock/wasm/wheels meet a newer bundled loader.
PYODIDE_VERSION="${PYODIDE_VERSION:-314.0.7}"
PYODIDE_CDN="https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full"
PYODIDE_NPM_DIR="${REPO_ROOT}/frontend/packages/browser/node_modules/pyodide"
PYODIDE_OUT="${PUBLIC_DIR}/pyodide/v${PYODIDE_VERSION}"
PYODIDE_FILES=(
  pyodide.asm.mjs pyodide.asm.wasm pyodide.mjs pyodide-lock.json python_stdlib.zip
  micropip-0.11.1-py3-none-any.whl
  numpy-2.4.6-cp314-cp314-pyemscripten_2026_0_wasm32.whl
  pydantic-2.12.5-py3-none-any.whl
  pydantic_core-2.41.5-cp314-cp314-pyemscripten_2026_0_wasm32.whl
  annotated_types-0.7.0-py3-none-any.whl
  typing_extensions-4.15.0-py3-none-any.whl
  typing_inspection-0.4.2-py3-none-any.whl
  certifi-2026.4.22-py3-none-any.whl
)

# Copy core files from node_modules ONLY when it holds this exact release; a
# PYODIDE_VERSION override must never mix an npm loader of another version in.
PYODIDE_NPM_VERSION="$(node -p "require('${PYODIDE_NPM_DIR}/package.json').version" 2>/dev/null || true)"
if [[ "${PYODIDE_NPM_VERSION}" != "${PYODIDE_VERSION}" ]]; then
  PYODIDE_NPM_DIR=""
fi
# Prune every other release (incl. the pre-versioned flat layout): Pages ships
# all of public/, so a stale dist would be deployed dead weight.
if [[ -d "${PUBLIC_DIR}/pyodide" ]]; then
  find "${PUBLIC_DIR}/pyodide" -mindepth 1 -maxdepth 1 ! -name "v${PYODIDE_VERSION}" -exec rm -rf {} +
fi
mkdir -p "${PYODIDE_OUT}"
if [[ -n "${PYODIDE_DIST:-}" ]]; then
  echo "==> Pyodide dist (local override): ${PYODIDE_DIST} -> ${PYODIDE_OUT}/"
  cp -R "${PYODIDE_DIST}/." "${PYODIDE_OUT}/"
else
  echo "==> Fetching Pyodide ${PYODIDE_VERSION} dist (${#PYODIDE_FILES[@]} files) from ${PYODIDE_CDN}"
  for f in "${PYODIDE_FILES[@]}"; do
    dest="${PYODIDE_OUT}/${f}"
    if [[ ! -s "${dest}" ]]; then
      # CDN connections can reset while a large wasm file is streaming. Retry
      # all transient curl failures so one edge blip cannot invalidate an
      # otherwise deterministic exit-gate run. Download to a process-unique
      # part file and publish atomically so a failed/terminated transfer can
      # never masquerade as a complete asset on the next run.
      part="${dest}.part.$$"
      rm -f "${part}"
      if [[ -n "${PYODIDE_NPM_DIR}" && -f "${PYODIDE_NPM_DIR}/${f}" ]]; then
        echo "    - ${f} (pinned npm package)"
        cp "${PYODIDE_NPM_DIR}/${f}" "${part}"
      elif curl -fsSL --retry 5 --retry-delay 4 --retry-all-errors \
             --retry-max-time 900 --connect-timeout 30 --max-time 600 \
             "${PYODIDE_CDN}/${f}" -o "${part}"; then
        :
      else
        rm -f "${part}"
        exit 1
      fi
      if [[ -s "${part}" ]]; then
        mv "${part}" "${dest}"
      else
        rm -f "${part}"
        exit 1
      fi
    fi
  done
  # Prune any stale wheels left behind when LOAD_PACKAGES shrinks (Pages ships all of public/).
  for existing in "${PYODIDE_OUT}"/*.whl; do
    [[ -e "${existing}" ]] || continue
    base="$(basename "${existing}")"
    keep=0
    for wanted in "${PYODIDE_FILES[@]}"; do
      if [[ "${wanted}" == "${base}" ]]; then keep=1; break; fi
    done
    if [[ "${keep}" -eq 0 ]]; then rm -f "${existing}"; fi
  done
fi

# Ephemeris data the publisher bundles into ~/.skyfield-data (the publisher's
# --offline default). Skyfield 1.55 uses built-in timescale tables inside the
# skyfield wheel (`loader.timescale(builtin=True)`), so only `de421.bsp` (~16 MB)
# is seeded from the vendored backend/de421.bsp (zero network fetches).
SKYFIELD_DATA_DIR="${HOME}/.skyfield-data"
echo "==> Seeding ${SKYFIELD_DATA_DIR} from vendored backend assets (offline, zero-download)"
mkdir -p "${SKYFIELD_DATA_DIR}"
for asset in de421.bsp; do
  if [[ ! -f "${SKYFIELD_DATA_DIR}/${asset}" ]]; then
    echo "    - ${asset} (from vendored backend/${asset})"
    cp "${BACKEND_DIR}/${asset}" "${SKYFIELD_DATA_DIR}/${asset}"
  fi
done
# Safety net only: with de421.bsp seeded this is a pure no-op and makes NO network request.
( cd "${BACKEND_DIR}" && uv run python -c "
from pathlib import Path
from skyfield.api import Loader
L = Loader(str(Path.home() / '.skyfield-data'))
L('de421.bsp')
L.timescale(builtin=True)
" )

# The self-hosted RAG embedding model: Transformers.js loads it same-origin from
# public/models/ with `env.allowRemoteModels = false`, so the bytes NEVER touch
# the HuggingFace CDN at runtime (offline + no usage leak, same discipline as the
# Pyodide dist and the self-hosted fonts). We fetch the q8 quantized MiniLM ONNX
# + its config/tokenizer once from the HF Hub, and copy the onnxruntime-web wasm
# from the version-matched npm package (no version skew with @huggingface/transformers).
# Idempotent: each file is skipped if it already exists.
MINILM_REPO="Xenova/all-MiniLM-L6-v2"
MINILM_BASE="https://huggingface.co/${MINILM_REPO}/resolve/main"
MINILM_DIR="${PUBLIC_DIR}/models/${MINILM_REPO}"
MINILM_FILES=(
  config.json
  tokenizer.json
  tokenizer_config.json
  onnx/model_quantized.onnx
)
echo "==> Fetching self-hosted RAG model (${MINILM_REPO}, q8) into ${MINILM_DIR}"
mkdir -p "${MINILM_DIR}/onnx"
# NON-FATAL + retried on purpose: the HF Hub rate-limits anonymous fetches (HTTP
# 429), and the chart engine / exit-gate does NOT need this model (it's lazy-loaded
# only for the optional in-browser chat search). So retry transient errors, and if
# the Hub is still unreachable, warn and continue rather than failing the whole
# build — RAG/search simply won't work in that build, everything else does.
for f in "${MINILM_FILES[@]}"; do
  if [[ ! -f "${MINILM_DIR}/${f}" ]]; then
    echo "    - ${f}"
    if ! curl -fsSL --retry 5 --retry-delay 4 --retry-all-errors \
         "${MINILM_BASE}/${f}?download=true" -o "${MINILM_DIR}/${f}"; then
      rm -f "${MINILM_DIR}/${f}"
      echo "    !! Could not fetch ${f} from the HF Hub (rate-limited / offline)." >&2
      echo "    !! Skipping the RAG model: chart engine + chat still work; in-browser search is disabled in this build." >&2
      break
    fi
  fi
done

# onnxruntime-web wasm: copy from the installed package so the binaries match the
# @huggingface/transformers runtime exactly (the worker pins wasmPaths=/models/ort/).
ORT_DEST="${PUBLIC_DIR}/models/ort"
ORT_DIST="$(find "${WEB_DIR}/.." "${REPO_ROOT}/frontend" -type d -path '*onnxruntime-web/dist' 2>/dev/null | head -1)"
echo "==> Publishing onnxruntime-web wasm into ${ORT_DEST}"
mkdir -p "${ORT_DEST}"
if [[ -n "${ORT_DIST:-}" && -d "${ORT_DIST}" ]]; then
  # Only the plain CPU build: vite.config.ts's ortWasmOnlyPlugin points ORT at its
  # wasm-only export, which loads exactly these two files. The jsep (28.35 MB)
  # and asyncify (26.86 MB) builds are over Cloudflare Pages' 25 MiB per-file
  # limit, so they must never land in public/. Always overwrite: a stale copy
  # from an older onnxruntime-web would not match the bundled ORT JS.
  rm -f "${ORT_DEST}"/ort-wasm-simd-threaded.{jsep,asyncify,jspi}.{wasm,mjs}
  for f in ort-wasm-simd-threaded.wasm ort-wasm-simd-threaded.mjs; do
    cp "${ORT_DIST}/${f}" "${ORT_DEST}/${f}"
  done
else
  echo "    !! onnxruntime-web not found in node_modules — run 'bun install' first."
fi

echo "==> Building almamesh wheel"
( cd "${BACKEND_DIR}" && uv build --wheel )

if [[ ! -f "${BACKEND_DIR}/keys/private.key" || ! -f "${BACKEND_DIR}/keys/public.key" ]]; then
  echo "==> Generating a dev signing keypair (./backend/keys)"
  ( cd "${BACKEND_DIR}" && uv run almamesh-bundle keygen ./keys --force )
else
  echo "==> Reusing existing dev signing keypair (./backend/keys)"
fi

# The bundle is re-signed on every run with an increasing epoch-second sequence. A
# browser that already synced a dev bundle keeps its signed sequence as a durable
# anti-rollback floor in OPFS, so epoch seconds strictly increase across re-runs
# while keeping the same dev signing key. Dev only:
# production sequences come from build-prod.sh (git commit count) + release_guard.
DEV_BUNDLE_SEQUENCE="${DEV_BUNDLE_SEQUENCE:-$(date +%s)}"
echo "==> Signing the offline dev bundle (./backend/origin), sequence ${DEV_BUNDLE_SEQUENCE}"
( cd "${BACKEND_DIR}" && uv run almamesh-bundle bundle ./origin ./keys/private.key --version dev --sequence "${DEV_BUNDLE_SEQUENCE}" --offline )

echo "==> Publishing bundle + pubkey into ${PUBLIC_DIR}"
mkdir -p "${PUBLIC_DIR}/bundle"
cp -R "${BACKEND_DIR}/origin/." "${PUBLIC_DIR}/bundle/"
cp "${BACKEND_DIR}/keys/public.key" "${PUBLIC_DIR}/public.key"

echo "==> Done. Dev assets are in ${PUBLIC_DIR} (pyodide/, bundle/, public.key, models/)."
