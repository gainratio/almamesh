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
ARTIFACTS="${WEBKIT_LANE_ARTIFACTS:-webkit-lane-artifacts}"
rm -rf "${ARTIFACTS}"
mkdir -p "${ARTIFACTS}/crash-reports"
LANE_START="$(date '+%Y-%m-%d %H:%M:%S')"
touch "${ARTIFACTS}/.lane-start"
{ sw_vers; sysctl hw.memsize hw.ncpu hw.model; } > "${ARTIFACTS}/machine.txt" 2>&1 || true

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
trap 'kill "${PREVIEW_PID}" "${MEMORY_PID}" 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do
  curl -fsS -o /dev/null "${BASE_URL}/" && break
  sleep 1
done
curl -fsS -o /dev/null "${BASE_URL}/"

# No retries: a WebKit page that crashes once is a red lane, never a pass on
# retry. Every spec always runs, so one red run reports them all. Each spec
# writes to its own output directory, so a later run does not wipe an earlier
# one's evidence.
status=0
TIME_TRAVEL_E2E_BASE_URL="${BASE_URL}" bun run test:e2e:time-travel --project=webkit --project=iphone-webkit --retries=0 --output="${ARTIFACTS}/time-travel" || status=1
PORTABLE_INVARIANTS_E2E_BASE_URL="${BASE_URL}" bun run test:e2e:portable-invariants --project=webkit --project=iphone-webkit --retries=0 --output="${ARTIFACTS}/portable-invariants" || status=1
BOOT_RETRY_E2E_BASE_URL="${BASE_URL}" bun run test:e2e:boot-retry --project=webkit --retries=0 --output="${ARTIFACTS}/boot-retry" || status=1
collect_crash_evidence
grep -rh "page crashed" "${ARTIFACTS}" --include='*-browser.log' || true
exit "${status}"
