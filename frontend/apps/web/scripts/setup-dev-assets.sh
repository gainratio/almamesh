#!/usr/bin/env bash
#
# setup-dev-assets.sh — regenerate the large, git-ignored dev assets the
# in-browser engine needs at runtime. Run once after a fresh clone (or whenever
# the bundle/Pyodide inputs change). Everything it writes under
# apps/web/public/{pyodide,bundle,public.key} is .gitignored.
#
# What it produces:
#   apps/web/public/pyodide/   — self-hosted Pyodide dist (offline, 20 files)
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
# To change the set: keep it in lockstep with chartWorker.ts LOAD_PACKAGES (+ the
# lock's transitive closure) and the `pyodide` dep version. Override with a local
# dir via PYODIDE_DIST=/path (skips the download).
PYODIDE_VERSION="${PYODIDE_VERSION:-0.29.4}"
PYODIDE_CDN="https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full"
PYODIDE_NPM_DIR="${REPO_ROOT}/frontend/packages/browser/node_modules/pyodide"
PYODIDE_FILES=(
  pyodide.asm.js pyodide.asm.wasm pyodide.mjs pyodide-lock.json python_stdlib.zip
  micropip-0.11.1-py3-none-any.whl
  numpy-2.2.5-cp313-cp313-pyemscripten_2025_0_wasm32.whl
  pydantic-2.12.5-py3-none-any.whl
  pydantic_core-2.41.5-cp313-cp313-pyemscripten_2025_0_wasm32.whl
  pyyaml-6.0.2-cp313-cp313-pyemscripten_2025_0_wasm32.whl
  annotated_types-0.7.0-py3-none-any.whl
  typing_extensions-4.15.0-py3-none-any.whl
  typing_inspection-0.4.2-py3-none-any.whl
  python_dateutil-2.9.0.post0-py2.py3-none-any.whl
  pytz-2025.2-py2.py3-none-any.whl
  certifi-2026.1.4-py3-none-any.whl
  six-1.17.0-py2.py3-none-any.whl
)

mkdir -p "${PUBLIC_DIR}/pyodide"
if [[ -n "${PYODIDE_DIST:-}" ]]; then
  echo "==> Pyodide dist (local override): ${PYODIDE_DIST} -> ${PUBLIC_DIR}/pyodide/"
  cp -R "${PYODIDE_DIST}/." "${PUBLIC_DIR}/pyodide/"
else
  echo "==> Fetching Pyodide ${PYODIDE_VERSION} dist (${#PYODIDE_FILES[@]} files) from ${PYODIDE_CDN}"
  for f in "${PYODIDE_FILES[@]}"; do
    dest="${PUBLIC_DIR}/pyodide/${f}"
    if [[ ! -s "${dest}" ]]; then
      # CDN connections can reset while a large wasm file is streaming. Retry
      # all transient curl failures so one edge blip cannot invalidate an
      # otherwise deterministic exit-gate run. Download to a process-unique
      # part file and publish atomically so a failed/terminated transfer can
      # never masquerade as a complete asset on the next run.
      part="${dest}.part.$$"
      rm -f "${part}"
      if [[ -f "${PYODIDE_NPM_DIR}/${f}" ]]; then
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
fi

# Ephemeris + IERS earth-orientation data the publisher bundles into ~/.skyfield-data
# (the publisher's --offline default). VENDORED-FIRST / OFFLINE: seed the Loader's data
# home from the tracked backend/de421.bsp + backend/finals2000A.all (same dir convention
# and same bytes the golden fixtures use) so a clean machine / CI deploy runner performs
# ZERO network fetches. Without this, Skyfield downloads de421.bsp (NASA) and
# finals2000A.all (iers.org) on demand — and the iers.org fetch TIMES OUT on GitHub
# Actions runners, which is what broke the Cloudflare deploy. (de421.bsp ~16MB,
# finals2000A.all ~3.5MB; both are git-tracked under backend/, like the vendored DE421.)
SKYFIELD_DATA_DIR="${HOME}/.skyfield-data"
echo "==> Seeding ${SKYFIELD_DATA_DIR} from vendored backend assets (offline, zero-download)"
mkdir -p "${SKYFIELD_DATA_DIR}"
for asset in de421.bsp finals2000A.all; do
  if [[ ! -f "${SKYFIELD_DATA_DIR}/${asset}" ]]; then
    echo "    - ${asset} (from vendored backend/${asset})"
    cp "${BACKEND_DIR}/${asset}" "${SKYFIELD_DATA_DIR}/${asset}"
  fi
done
# Safety net only: with both files now seeded this is a pure no-op and makes NO network
# request; it would fetch solely if a vendored copy were somehow missing.
( cd "${BACKEND_DIR}" && uv run python -c "
from pathlib import Path
from skyfield.api import Loader
L = Loader(str(Path.home() / '.skyfield-data'))
L('de421.bsp')
L.timescale(builtin=False)  # no-op when finals2000A.all is already seeded
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

echo "==> Generating a dev signing keypair (./backend/keys)"
( cd "${BACKEND_DIR}" && uv run almamesh-bundle keygen ./keys --force )

# The dev key is regenerated (--force) and the bundle re-signed on every run. A
# browser that already synced a dev bundle keeps its signed sequence as a durable
# anti-rollback floor in OPFS, so a fixed sequence (the CLI default is 1) would be
# refused as a rollback. Epoch seconds strictly increase across re-runs. Dev only:
# production sequences come from build-prod.sh (git commit count) + release_guard.
DEV_BUNDLE_SEQUENCE="${DEV_BUNDLE_SEQUENCE:-$(date +%s)}"
echo "==> Signing the offline dev bundle (./backend/origin), sequence ${DEV_BUNDLE_SEQUENCE}"
( cd "${BACKEND_DIR}" && uv run almamesh-bundle bundle ./origin ./keys/private.key --version dev --sequence "${DEV_BUNDLE_SEQUENCE}" --offline )

echo "==> Publishing bundle + pubkey into ${PUBLIC_DIR}"
mkdir -p "${PUBLIC_DIR}/bundle"
cp -R "${BACKEND_DIR}/origin/." "${PUBLIC_DIR}/bundle/"
cp "${BACKEND_DIR}/keys/public.key" "${PUBLIC_DIR}/public.key"

echo "==> Done. Dev assets are in ${PUBLIC_DIR} (pyodide/, bundle/, public.key, models/)."
