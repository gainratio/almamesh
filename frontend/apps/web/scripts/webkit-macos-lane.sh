#!/usr/bin/env bash
# The macOS WebKit lane (.github/workflows/webkit-macos.yml).
#
# Why it is not a Dagger gate: Dagger runs in Linux containers, and Linux
# Playwright WebKit cannot open SQLite's nested-Worker OPFS (see
# scripts/verify-webkit-engine.mjs), so the engine never boots there and every
# journey that needs it would fail or have to be skipped. macOS WebKit can.
#
# Builds the hooked preview once (VITE_EXIT_GATE_HOOKS=1, as the Dagger browser
# shards do), serves it, and runs the journeys on desktop Safari and an iPhone
# profile:
#   - e2e/time-travel.spec.ts (webkit: the six full-tier journeys; iphone-webkit:
#     the iPhone journey, minimal tier)
#   - e2e/portable-invariants.spec.ts (export/import, incl. the Day-pin round trip)
#
# Run from frontend/apps/web after `bun install` and `uv` are available.
set -euo pipefail

PORT="${WEBKIT_LANE_PORT:-4199}"
BASE_URL="http://127.0.0.1:${PORT}"

bash scripts/setup-dev-assets.sh
bun x playwright install webkit
VITE_API_URL= VITE_EXIT_GATE_HOOKS=1 ./node_modules/.bin/vite build --outDir dist-webkit

VITE_API_URL= ./node_modules/.bin/vite preview --outDir dist-webkit --host 127.0.0.1 --port "${PORT}" --strictPort &
PREVIEW_PID=$!
trap 'kill "${PREVIEW_PID}" 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do
  curl -fsS -o /dev/null "${BASE_URL}/" && break
  sleep 1
done
curl -fsS -o /dev/null "${BASE_URL}/"

# No retries: a WebKit page that crashes once is a red lane, never a pass on
# retry. Both specs always run, so one red run reports both.
status=0
TIME_TRAVEL_E2E_BASE_URL="${BASE_URL}" bun run test:e2e:time-travel --project=webkit --project=iphone-webkit --retries=0 || status=1
PORTABLE_INVARIANTS_E2E_BASE_URL="${BASE_URL}" bun run test:e2e:portable-invariants --project=webkit --project=iphone-webkit --retries=0 || status=1
exit "${status}"
