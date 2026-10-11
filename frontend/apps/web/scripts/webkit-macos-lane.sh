#!/usr/bin/env bash
# Native macOS WebKit acceptance. Hosted CI runs independent memory and
# functional jobs, each bounded to 45 minutes. Local callers may run all.
# memory: five original-release boots then five candidate Day/place journeys,
# on this same runner with the same sampler and production builds without hooks.
# functional: all desktop/iPhone time-travel, portable restore and boot recovery
# cases, against one hooks-enabled preview, with zero test retries.
# Evidence is uploaded only from a finalized snapshot after its content scan.
set -euo pipefail

FINALIZE=0
if [[ "${1:-}" == --finalize-evidence ]]; then FINALIZE=1; shift; fi
MODE="${1:-all}"
case "${MODE}" in memory|functional|all) ;; *) echo "Unknown WebKit lane mode: ${MODE}" >&2; exit 64 ;; esac
if (( $# > 1 )); then echo "Unexpected WebKit lane arguments" >&2; exit 64; fi
ARTIFACTS="${WEBKIT_LANE_ARTIFACTS:-webkit-lane-artifacts}"
if [[ "${MODE}" != all && -z "${WEBKIT_LANE_ARTIFACTS:-}" ]]; then ARTIFACTS="webkit-lane-artifacts-${MODE}"; fi
EVIDENCE_ROOT="webkit-lane-evidence-${MODE}"

finalize_evidence() {
  # The source remains diagnostic-only. The scanner and upload both use this
  # private copy after cp succeeds. No test or browser receives its path.
  # Detached source writers can outlive shell cleanup; interrupted evidence
  # may be incomplete. A failed copy is fatal and never reaches scan/upload.
  [[ -d "${ARTIFACTS}" && ! -L "${ARTIFACTS}" ]]
  [[ -f "${ARTIFACTS}/.lane-cleanup-finished" && ! -L "${ARTIFACTS}/.lane-cleanup-finished" ]]
  [[ ! -e "${EVIDENCE_ROOT}" && ! -L "${EVIDENCE_ROOT}" ]]
  cp -R "${ARTIFACTS}" "${EVIDENCE_ROOT}"
}
if [[ "${FINALIZE}" == 1 ]]; then finalize_evidence; exit; fi

# Direct-owned shell jobs get best-effort cleanup on signals. Playwright may
# start detached browsers/ffmpeg; this does not prove their quiescence. Never
# kill historical process groups or retain command PIDs after wait completes.
set -m
PRODUCER_PIDS=""
register_producer() { PRODUCER_PIDS="${PRODUCER_PIDS} $1"; }
forget_producer() {
  local remaining="" pid
  for pid in ${PRODUCER_PIDS}; do
    if [[ "${pid}" != "$1" ]]; then remaining="${remaining} ${pid}"; fi
  done
  PRODUCER_PIDS="${remaining}"
}
stop_producers() {
  local pid running
  # jobs -pr limits signals to this shell's currently running direct jobs.
  # Descendants and detached processes are deliberately not inferred by PID.
  for pid in "$@"; do
    for running in $(jobs -pr); do
      if [[ "${running}" == "${pid}" ]]; then kill -TERM "${pid}" 2>/dev/null || true; fi
    done
  done
  # Give live direct jobs a bounded grace period, with no delay for a command
  # that has already completed and been forgotten by run_lane_command.
  for _ in $(seq 1 20); do
    local live=0
    for pid in "$@"; do
      for running in $(jobs -pr); do
        if [[ "${running}" == "${pid}" ]]; then live=1; fi
      done
    done
    if [[ "${live}" == 0 ]]; then break; fi
    sleep 0.1
  done
  for pid in "$@"; do
    for running in $(jobs -pr); do
      if [[ "${running}" == "${pid}" ]]; then kill -KILL "${pid}" 2>/dev/null || true; fi
    done
    wait "${pid}" 2>/dev/null || true
  done
}
run_lane_command() {
  local command_pid command_status=0
  "$@" &
  command_pid=$!
  register_producer "${command_pid}"
  if wait "${command_pid}"; then command_status=0; else command_status=$?; fi
  forget_producer "${command_pid}"
  return "${command_status}"
}

PORT="${WEBKIT_LANE_PORT:-4199}"
BASE_URL="http://127.0.0.1:${PORT}"
REFERENCE_PORT=$((PORT + 1))
REFERENCE_URL="http://127.0.0.1:${REFERENCE_PORT}"
MEMORY_PORT=$((PORT + 2))
MEMORY_URL="http://127.0.0.1:${MEMORY_PORT}"
MEMORY_ROOT=""
CRASH_EVIDENCE_COLLECTED=0
rm -rf "${ARTIFACTS}"
mkdir -p "${ARTIFACTS}/crash-reports"
LANE_START="$(date '+%Y-%m-%d %H:%M:%S')"
touch "${ARTIFACTS}/.lane-start"
{ sw_vers; sysctl hw.memsize hw.ncpu hw.model; } > "${ARTIFACTS}/machine.txt" 2>&1 || true

cleanup_lane() {
  local lane_status=$?
  trap '' INT TERM
  stop_producers ${PRODUCER_PIDS}
  if [[ "${CRASH_EVIDENCE_COLLECTED}" == 0 ]] && command -v collect_crash_evidence >/dev/null; then
    collect_crash_evidence || true
  fi
  if [[ -n "${MEMORY_ROOT}" ]]; then rm -rf "${MEMORY_ROOT}"; fi
  # This marks shell cleanup only, not detached-process quiescence.
  # Source evidence may still change; only the later private copy is scanned.
  touch "${ARTIFACTS}/.lane-cleanup-finished"
  return "${lane_status}"
}
trap cleanup_lane EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

wait_for_preview() {
  local url="$1"
  for _ in $(seq 1 60); do
    if curl -fsS -o /dev/null "${url}/"; then return; fi
    sleep 1
  done
  curl -fsS -o /dev/null "${url}/"
}

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

bash scripts/setup-dev-assets.sh
bun x playwright install webkit
( while true; do
    echo "$(date '+%H:%M:%S') $(memory_pressure -Q 2>/dev/null | tail -1) $(sysctl -n vm.swapusage 2>/dev/null)"
    sleep 10
  done ) > "${ARTIFACTS}/system-memory.log" 2>&1 &
register_producer "$!"

status=0
run_memory_lane() {
REFERENCE_REF="8d10fbbb76336a8a5efe272912e392e260b3fef5"
MEASUREMENT_REF="$(git rev-parse HEAD)"
REPO_ROOT="$(git rev-parse --show-toplevel)"
MEMORY_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/almamesh-webkit-memory.XXXXXX")"
REFERENCE_ROOT="${MEMORY_ROOT}/reference"
REFERENCE_WEB="${REFERENCE_ROOT}/frontend/apps/web"
REFERENCE_DIST="${MEMORY_ROOT}/reference-dist"
MEMORY_DIST="${MEMORY_ROOT}/candidate-dist"
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
  register_producer "${REFERENCE_PREVIEW_PID}"
  wait_for_preview "${REFERENCE_URL}"
  TT_MEMORY_BASELINE_REF="${REFERENCE_REF}" TT_MEMORY_MEASUREMENT_REF="${MEASUREMENT_REF}" TIME_TRAVEL_E2E_BASE_URL="${REFERENCE_URL}" run_lane_command bun x playwright test --config=playwright.time-travel.config.ts e2e/time-travel-memory.webkit.spec.ts --project=iphone-15-webkit --grep 'boot baseline' --repeat-each=5 --retries=0 --reporter=json --output="${ARTIFACTS}/time-travel-memory-baseline" > "${ARTIFACTS}/time-travel-memory-baseline-report.json"
  BASELINE_MIB="$(
    node scripts/webkit-memory-baseline.mjs --report "${ARTIFACTS}/time-travel-memory-baseline-report.json" --measurement-commit "${MEASUREMENT_REF}" --provenance "${ARTIFACTS}/time-travel-memory-baseline-provenance.json"
  )"
  stop_producers "${REFERENCE_PREVIEW_PID}"
  forget_producer "${REFERENCE_PREVIEW_PID}"
  REFERENCE_PREVIEW_PID=""
fi

# Serve the candidate's no-hooks build separately from seeded functional
# journeys. Its signed engine was built by the candidate setup script above.
BUILD_COMMIT="${MEASUREMENT_REF}" VITE_API_URL= VITE_EXIT_GATE_HOOKS= ./node_modules/.bin/vite build --outDir "${MEMORY_DIST}"
VITE_API_URL= ./node_modules/.bin/vite preview --outDir "${MEMORY_DIST}" --host 127.0.0.1 --port "${MEMORY_PORT}" --strictPort &
MEMORY_PREVIEW_PID=$!
register_producer "${MEMORY_PREVIEW_PID}"
wait_for_preview "${MEMORY_URL}"

TT_MEMORY_PHASE=final TT_MEMORY_GRANULARITY=day TT_MEMORY_REPORT_ONLY=0 TT_WEBKIT_BASELINE_MIB="${BASELINE_MIB}" TIME_TRAVEL_E2E_BASE_URL="${MEMORY_URL}" run_lane_command bun run test:e2e:time-travel e2e/time-travel-memory.webkit.spec.ts --project=iphone-15-webkit --grep 'WebContent RSS budget' --repeat-each=5 --retries=0 --output="${ARTIFACTS}/time-travel-memory" || status=1
}

run_functional_lane() {
VITE_API_URL= VITE_EXIT_GATE_HOOKS=1 ./node_modules/.bin/vite build --outDir dist-webkit
VITE_API_URL= ./node_modules/.bin/vite preview --outDir dist-webkit --host 127.0.0.1 --port "${PORT}" --strictPort &
register_producer "$!"
wait_for_preview "${BASE_URL}"
# Zero retries, and run each independent suite even if a preceding one fails.
TIME_TRAVEL_E2E_BASE_URL="${BASE_URL}" run_lane_command bun run test:e2e:time-travel e2e/time-travel.spec.ts --project=webkit --project=iphone-webkit --project=iphone-15-webkit --retries=0 --output="${ARTIFACTS}/time-travel" || status=1
PORTABLE_INVARIANTS_E2E_BASE_URL="${BASE_URL}" run_lane_command bun run test:e2e:portable-invariants --project=webkit --project=iphone-webkit --retries=0 --output="${ARTIFACTS}/portable-invariants" || status=1
BOOT_RETRY_E2E_BASE_URL="${BASE_URL}" run_lane_command bun run test:e2e:boot-retry --project=webkit --retries=0 --output="${ARTIFACTS}/boot-retry" || status=1
}

if [[ "${MODE}" == memory || "${MODE}" == all ]]; then run_memory_lane; fi
if [[ "${MODE}" == functional || "${MODE}" == all ]]; then run_functional_lane; fi
collect_crash_evidence
CRASH_EVIDENCE_COLLECTED=1
grep -rh "page crashed" "${ARTIFACTS}" --include='*-browser.log' || true
exit "${status}"
