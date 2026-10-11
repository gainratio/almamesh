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
#   - five original-release cold boots, followed by five candidate Day/place
#     journeys on separate production builds with exit hooks disabled
#   - e2e/time-travel.spec.ts (webkit: the full-tier and Dashboard journeys; iphone-webkit:
#     the iPhone journey, minimal tier; iphone-15-webkit: the @iphone15 Dashboard
#     time-travel journey, minimal tier)
#   - e2e/portable-invariants.spec.ts (export/import, incl. the Day-pin round trip)
#   - e2e/boot-retry.spec.ts (webkit: one automatic engine boot retry, bare and
#     Pyodide-wrapped wasm traps; needs this hooks build)
#
# Every run leaves its evidence in webkit-lane-artifacts/: each spec's
# Playwright output (traces, videos and screenshots of failed tests; every
# test's WebKit log and RSS samples, e2e/webkitDiagnostics.ts), the macOS crash
# reports and unified-log lines WebKit wrote during the run, and the machine's
# memory pressure every 10 s. The workflow uploads it only after
# scripts/artifactLeakScan.mjs has found no runner secret in it.
#
# Run from frontend/apps/web after `bun install` and `uv` are available.
set -euo pipefail

PORT="${WEBKIT_LANE_PORT:-4199}"
BASE_URL="http://127.0.0.1:${PORT}"
REFERENCE_PORT=$((PORT + 1))
REFERENCE_URL="http://127.0.0.1:${REFERENCE_PORT}"
MEMORY_PORT=$((PORT + 2))
MEMORY_URL="http://127.0.0.1:${MEMORY_PORT}"
REFERENCE_REF="8d10fbbb76336a8a5efe272912e392e260b3fef5"
MEASUREMENT_REF="$(git rev-parse HEAD)"
REPO_ROOT="$(git rev-parse --show-toplevel)"
MEMORY_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/almamesh-webkit-memory.XXXXXX")"
REFERENCE_ROOT="${MEMORY_ROOT}/reference"
REFERENCE_WEB="${REFERENCE_ROOT}/frontend/apps/web"
REFERENCE_DIST="${MEMORY_ROOT}/reference-dist"
MEMORY_DIST="${MEMORY_ROOT}/candidate-dist"
PREVIEW_PID=""
REFERENCE_PREVIEW_PID=""
MEMORY_PREVIEW_PID=""
MEMORY_PID=""
CRASH_EVIDENCE_COLLECTED=0
ARTIFACTS="${WEBKIT_LANE_ARTIFACTS:-webkit-lane-artifacts}"
rm -rf "${ARTIFACTS}"
mkdir -p "${ARTIFACTS}/crash-reports"
LANE_START="$(date '+%Y-%m-%d %H:%M:%S')"
touch "${ARTIFACTS}/.lane-start"
{ sw_vers; sysctl hw.memsize hw.ncpu hw.model; } > "${ARTIFACTS}/machine.txt" 2>&1 || true

cleanup_lane() {
  local lane_status=$?
  if [[ "${CRASH_EVIDENCE_COLLECTED}" == 0 ]] && command -v collect_crash_evidence >/dev/null; then
    collect_crash_evidence || true
  fi
  for pid in "${PREVIEW_PID}" "${REFERENCE_PREVIEW_PID}" "${MEMORY_PREVIEW_PID}" "${MEMORY_PID}"; do
    if [[ -n "${pid}" ]]; then kill "${pid}" 2>/dev/null || true; fi
  done
  rm -rf "${MEMORY_ROOT}"
  return "${lane_status}"
}
trap cleanup_lane EXIT

wait_for_preview() {
  local url="$1"
  for _ in $(seq 1 60); do
    if curl -fsS -o /dev/null "${url}/"; then return; fi
    sleep 1
  done
  curl -fsS -o /dev/null "${url}/"
}

bash scripts/setup-dev-assets.sh
bun x playwright install webkit
VITE_API_URL= VITE_EXIT_GATE_HOOKS=1 ./node_modules/.bin/vite build --outDir dist-webkit

VITE_API_URL= ./node_modules/.bin/vite preview --outDir dist-webkit --host 127.0.0.1 --port "${PORT}" --strictPort &
PREVIEW_PID=$!
( while true; do
    echo "$(date '+%H:%M:%S') $(memory_pressure -Q 2>/dev/null | tail -1) $(sysctl -n vm.swapusage 2>/dev/null)"
    sleep 10
  done ) > "${ARTIFACTS}/system-memory.log" 2>&1 &
MEMORY_PID=$!

# What WebKit and macOS recorded about a lost web process: the WebKit,
# Playwright and bun reports written since the lane started, plus JetsamEvent
# (macOS's memory-kill report), each labelled crash report or resource report
# (.diag). The kernel's GPU-restart reports, which the runner's paravirtual GPU
# writes every run, are left out. Also the unified-log lines about WebContent
# terminations, memory kills and jetsam. Each .ips headline goes to the job log
# (scripts/crashReportSummary.mjs).
collect_crash_evidence() {
  for dir in "${HOME}/Library/Logs/DiagnosticReports" /Library/Logs/DiagnosticReports; do
    find "${dir}" -newer "${ARTIFACTS}/.lane-start" -type f 2>/dev/null | while read -r report; do
      label="$(node scripts/crashReportSummary.mjs --lane-report "${report}")" || continue
      cp "${report}" "${ARTIFACTS}/crash-reports/" || true
      echo "${label}: ${report}"
      case "${report}" in *.ips) node scripts/crashReportSummary.mjs "${report}" || true ;; esac
    done
  done
  log show --style compact --start "${LANE_START}" --predicate \
    'eventMessage CONTAINS[c] "WebContent" OR eventMessage CONTAINS[c] "memorystatus" OR eventMessage CONTAINS[c] "jetsam" OR eventMessage CONTAINS[c] "didExceed" OR eventMessage CONTAINS[c] "processDidTerminate" OR eventMessage CONTAINS[c] "webProcessDidCrash"' \
    > "${ARTIFACTS}/unified-log.txt" 2>&1 || true
  echo "unified log: $(wc -l < "${ARTIFACTS}/unified-log.txt") lines about WebContent, memory kills and jetsam"
  grep -iE 'memorystatus.*kill|exceed|crash|terminat' "${ARTIFACTS}/unified-log.txt" | grep -v 'coalition roles' | head -40 || true
}
wait_for_preview "${BASE_URL}"

# Hosted memory acceptance pairs the ORIGINAL release with this candidate on
# this runner, using the same installed Playwright, sampler and five fresh
# profiles. Neither build exposes exit hooks. A local caller may reuse an
# explicitly supplied, already-measured baseline; hosted CI may not bypass
# the original-release measurements with an unproven scalar.
if [[ -n "${TT_WEBKIT_BASELINE_MIB:-}" ]]; then
  BASELINE_MIB="$(
    node scripts/webkit-memory-baseline.mjs --local-baseline "${TT_WEBKIT_BASELINE_MIB}" --measurement-commit "${MEASUREMENT_REF}" --provenance "${ARTIFACTS}/time-travel-memory-baseline-provenance.json"
  )"
else
  git cat-file -e "${REFERENCE_REF}^{commit}"
  mkdir -p "${REFERENCE_ROOT}"
  # git archive follows the invocation directory; archive from the repository
  # root so the reference includes its backend and frontend workspace.
  git -C "${REPO_ROOT}" archive "${REFERENCE_REF}" | tar -x -C "${REFERENCE_ROOT}"
  mkdir -p "${REFERENCE_WEB}/public"
  # Reuse only downloaded third-party runtime assets. The reference script
  # builds its own Python wheel and signs it from the archived original tree;
  # no candidate bundle, wheel, key or application build is copied across.
  if [[ -d public/pyodide ]]; then cp -R public/pyodide "${REFERENCE_WEB}/public/"; fi
  if [[ -d public/models ]]; then cp -R public/models "${REFERENCE_WEB}/public/"; fi
  ( cd "${REFERENCE_ROOT}/frontend" && HUSKY=0 bun install --frozen-lockfile )
  REFERENCE_SEQUENCE="$(git rev-list --count "${REFERENCE_REF}")"
  ( cd "${REFERENCE_WEB}" && DEV_BUNDLE_SEQUENCE="${REFERENCE_SEQUENCE}" bash scripts/setup-dev-assets.sh )
  ( cd "${REFERENCE_WEB}" && BUILD_COMMIT="${REFERENCE_REF}" VITE_API_URL= VITE_EXIT_GATE_HOOKS= ./node_modules/.bin/vite build --outDir "${REFERENCE_DIST}" )
  ( cd "${REFERENCE_WEB}" && VITE_API_URL= exec ./node_modules/.bin/vite preview --outDir "${REFERENCE_DIST}" --host 127.0.0.1 --port "${REFERENCE_PORT}" --strictPort ) &
  REFERENCE_PREVIEW_PID=$!
  wait_for_preview "${REFERENCE_URL}"
  TT_MEMORY_BASELINE_REF="${REFERENCE_REF}" TT_MEMORY_MEASUREMENT_REF="${MEASUREMENT_REF}" TIME_TRAVEL_E2E_BASE_URL="${REFERENCE_URL}" bun x playwright test --config=playwright.time-travel.config.ts e2e/time-travel-memory.webkit.spec.ts --project=iphone-15-webkit --grep 'boot baseline' --repeat-each=5 --retries=0 --reporter=json --output="${ARTIFACTS}/time-travel-memory-baseline" > "${ARTIFACTS}/time-travel-memory-baseline-report.json"
  BASELINE_MIB="$(
    node scripts/webkit-memory-baseline.mjs --report "${ARTIFACTS}/time-travel-memory-baseline-report.json" --measurement-commit "${MEASUREMENT_REF}" --provenance "${ARTIFACTS}/time-travel-memory-baseline-provenance.json"
  )"
  kill "${REFERENCE_PREVIEW_PID}"
  wait "${REFERENCE_PREVIEW_PID}" 2>/dev/null || true
  REFERENCE_PREVIEW_PID=""
fi

# Serve the candidate's no-hooks build separately from seeded functional
# journeys. Its signed engine was built by the candidate setup script above.
BUILD_COMMIT="${MEASUREMENT_REF}" VITE_API_URL= VITE_EXIT_GATE_HOOKS= ./node_modules/.bin/vite build --outDir "${MEMORY_DIST}"
VITE_API_URL= ./node_modules/.bin/vite preview --outDir "${MEMORY_DIST}" --host 127.0.0.1 --port "${MEMORY_PORT}" --strictPort &
MEMORY_PREVIEW_PID=$!
wait_for_preview "${MEMORY_URL}"

# No retries: a WebKit page that crashes once is a red lane, never a pass on
# retry. After baseline validation, every spec runs even if one fails. Each spec
# writes to its own output directory, so a later run does not wipe an earlier
# one's evidence.
status=0
TT_MEMORY_PHASE=final TT_MEMORY_GRANULARITY=day TT_MEMORY_REPORT_ONLY=0 TT_WEBKIT_BASELINE_MIB="${BASELINE_MIB}" TIME_TRAVEL_E2E_BASE_URL="${MEMORY_URL}" bun run test:e2e:time-travel e2e/time-travel-memory.webkit.spec.ts --project=iphone-15-webkit --grep 'WebContent RSS budget' --repeat-each=5 --retries=0 --output="${ARTIFACTS}/time-travel-memory" || status=1
TIME_TRAVEL_E2E_BASE_URL="${BASE_URL}" bun run test:e2e:time-travel e2e/time-travel.spec.ts --project=webkit --project=iphone-webkit --project=iphone-15-webkit --retries=0 --output="${ARTIFACTS}/time-travel" || status=1
PORTABLE_INVARIANTS_E2E_BASE_URL="${BASE_URL}" bun run test:e2e:portable-invariants --project=webkit --project=iphone-webkit --retries=0 --output="${ARTIFACTS}/portable-invariants" || status=1
BOOT_RETRY_E2E_BASE_URL="${BASE_URL}" bun run test:e2e:boot-retry --project=webkit --retries=0 --output="${ARTIFACTS}/boot-retry" || status=1
collect_crash_evidence
CRASH_EVIDENCE_COLLECTED=1
grep -rh "page crashed" "${ARTIFACTS}" --include='*-browser.log' || true
exit "${status}"
