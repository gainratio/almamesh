#!/usr/bin/env bash
# Native macOS WebKit lane. It reports and never blocks a deploy (.github/workflows/
# webkit-macos.yml files crash signatures as issues). Hosted CI runs independent
# memory, travel and portable/boot jobs, each bounded to 45 minutes. Local callers may run all.
# memory: five original-release boots then five candidate Day/place journeys,
# on this same runner with the same sampler and production builds without hooks.
# travel: all desktop/iPhone time-travel cases; portable: all portable restore
# and boot recovery cases. Each uses its own hooks-enabled preview and no retries.
# Local functional runs both suites; local all also runs the memory comparison.
# Evidence is uploaded only from a finalized snapshot after its content scan.
set -euo pipefail

FINALIZE=0
COLLECT=0
case "${1:-}" in
  --finalize-evidence) FINALIZE=1; shift ;;
  --collect-native-evidence) COLLECT=1; shift ;;
esac
MODE="${1:-all}"
case "${MODE}" in memory|travel|portable|functional|all) ;; *) echo "Unknown WebKit lane mode: ${MODE}" >&2; exit 64 ;; esac
if (( $# > 1 )); then echo "Unexpected WebKit lane arguments" >&2; exit 64; fi
ARTIFACTS="${WEBKIT_LANE_ARTIFACTS:-webkit-lane-artifacts}"
if [[ "${MODE}" != all && -z "${WEBKIT_LANE_ARTIFACTS:-}" ]]; then ARTIFACTS="webkit-lane-artifacts-${MODE}"; fi
EVIDENCE_ROOT="webkit-lane-evidence-${MODE}"

collect_crash_evidence() {
  # Diagnostic availability is not a product gate. Persist each attempt and its
  # outcome, including missing roots and failed/timed-out commands. Only failure
  # to write the required manifest is fatal. CI also invokes this independently
  # after the lane, so an interrupted shell trap is not our only collection path.
  node --input-type=module - "${ARTIFACTS}" "${BASH_SOURCE[0]:-$0}" "${HOME}" <<'NATIVE_EVIDENCE'
import { appendFileSync, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const directory = resolve(process.argv[2]);
const { isLaneCrashReport } = await import(pathToFileURL(join(dirname(resolve(process.argv[3])), 'crashReportSummary.mjs')));
if (!lstatSync(directory).isDirectory()) throw new Error('Native evidence source must be a directory');
const manifestPath = join(directory, 'native-collection-status.json');
const limits = { maxReports: 32, maxReportBytes: 16 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024 };
const copyTotals = { consideredCount: 0, readAttempts: 0, reservedBytes: 0, copiedCount: 0, copiedBytes: 0 };
const manifest = { state: 'collecting', startedAt: new Date().toISOString(), laneStartedAt: null, limits, copyTotals, roots: [], reports: [], unifiedLog: { status: 'not-attempted' } };
const save = () => writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
save();
const marker = join(directory, '.lane-start');
let started;
try { started = statSync(marker).mtime; manifest.laneStartedAt = started.toISOString(); }
catch (error) { manifest.startError = error.code ?? String(error); }
if (started) {
  try { mkdirSync(join(directory, 'crash-reports'), { recursive: true }); }
  catch (error) { manifest.reportsDirectoryError = error.code ?? String(error); }
  for (const [name, root] of [['user', join(process.argv[4], 'Library/Logs/DiagnosticReports')], ['system', '/Library/Logs/DiagnosticReports']]) {
    const entry = { name, status: 'searching', matchedCount: 0, copiedCount: 0 };
    manifest.roots.push(entry);
    save();
    try {
      if (!lstatSync(root).isDirectory()) { entry.status = 'not-directory'; save(); continue; }
    } catch (error) {
      entry.status = error.code === 'ENOENT' ? 'missing' : 'error';
      entry.error = error.code ?? String(error);
      save(); continue;
    }
    const found = spawnSync('find', [root, '-newer', marker, '-type', 'f', '-print0'], { encoding: 'utf8', timeout: 5_000, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL' });
    entry.status = found.error?.code === 'ETIMEDOUT' ? 'timeout' : found.status === 0 ? 'searched' : 'error';
    entry.exitCode = found.status;
    if (found.error) entry.error = found.error.code ?? String(found.error);
    if (found.stderr) entry.stderr = found.stderr;
    for (const report of (found.stdout ?? '').split('\0').filter(Boolean)) {
      if (!isLaneCrashReport(report)) continue;
      const record = { name: basename(report), status: 'copying' };
      entry.matchedCount += 1;
      manifest.reports.push(record);
      if (copyTotals.consideredCount >= limits.maxReports) { record.status = 'skipped-count-limit'; save(); continue; }
      copyTotals.consideredCount += 1;
      try {
        const details = lstatSync(report);
        if (!details.isFile()) throw new Error('Report is not a regular file');
        if (details.mtime <= started) { record.status = 'stale'; continue; }
        record.bytes = details.size;
        if (details.size > limits.maxReportBytes) { record.status = 'skipped-size-limit'; save(); continue; }
        if (copyTotals.reservedBytes + details.size > limits.maxTotalBytes) { record.status = 'skipped-total-size-limit'; save(); continue; }
        // Reserve the read budget even if the copy fails. Read a fixed amount;
        // a growing native report cannot bypass either byte ceiling.
        copyTotals.readAttempts += 1; copyTotals.reservedBytes += details.size; save();
        const contents = Buffer.allocUnsafe(details.size);
        const descriptor = openSync(report, 'r');
        try {
          let offset = 0;
          while (offset < contents.length) {
            const count = readSync(descriptor, contents, offset, contents.length - offset, offset);
            if (count === 0) throw new Error('Report changed while reading');
            offset += count;
          }
          const after = fstatSync(descriptor);
          if (after.size !== details.size || after.mtimeMs !== details.mtimeMs) throw new Error('Report changed while reading');
        } finally { closeSync(descriptor); }
        writeFileSync(join(directory, 'crash-reports', record.name), contents);
        record.status = 'copied'; entry.copiedCount += 1;
        copyTotals.copiedCount += 1; copyTotals.copiedBytes += details.size;
      } catch (error) { record.status = 'copy-error'; record.error = error.code ?? String(error); }
      save();
    }
    save();
  }
  const pad = (value) => String(value).padStart(2, '0');
  const start = `${started.getFullYear()}-${pad(started.getMonth() + 1)}-${pad(started.getDate())} ${pad(started.getHours())}:${pad(started.getMinutes())}:${pad(started.getSeconds())}`;
  const predicate = 'eventMessage CONTAINS[c] "WebContent" OR eventMessage CONTAINS[c] "memorystatus" OR eventMessage CONTAINS[c] "jetsam" OR eventMessage CONTAINS[c] "didExceed" OR eventMessage CONTAINS[c] "processDidTerminate" OR eventMessage CONTAINS[c] "webProcessDidCrash"';
  manifest.unifiedLog = { status: 'collecting' }; save();
  const result = spawnSync('log', ['show', '--style', 'compact', '--start', start, '--predicate', predicate], { encoding: 'utf8', timeout: 15_000, maxBuffer: 8 * 1024 * 1024, killSignal: 'SIGKILL' });
  const timedOut = result.error?.code === 'ETIMEDOUT';
  manifest.unifiedLog = { status: timedOut ? 'timeout' : result.status === 0 ? 'collected' : 'error', exitCode: result.status, timedOut, signal: result.signal };
  if (result.error) manifest.unifiedLog.error = result.error.code ?? String(result.error);
  // The independent CI attempt must not erase a successful shell-trap capture.
  try { appendFileSync(join(directory, 'unified-log.txt'), `\n== native collection ${manifest.startedAt}: ${manifest.unifiedLog.status} ==\n${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? `\ncollector error: ${result.error.code ?? String(result.error)}\n` : ''}`); }
  catch (error) { manifest.unifiedLog.status = 'write-error'; manifest.unifiedLog.writeError = error.code ?? String(error); }
}
manifest.state = 'complete'; manifest.completedAt = new Date().toISOString(); save();
console.log(`native evidence: ${manifest.reports.filter((report) => report.status === 'copied').length} reports copied; unified log ${manifest.unifiedLog.status}; details in native-collection-status.json`);
NATIVE_EVIDENCE
}
if [[ "${COLLECT}" == 1 ]]; then collect_crash_evidence; exit; fi

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

start_functional_preview() {
VITE_API_URL= VITE_EXIT_GATE_HOOKS=1 ./node_modules/.bin/vite build --outDir dist-webkit
VITE_API_URL= ./node_modules/.bin/vite preview --outDir dist-webkit --host 127.0.0.1 --port "${PORT}" --strictPort &
register_producer "$!"
wait_for_preview "${BASE_URL}"
}

# Run one functional suite with zero Playwright retries.
#   run_suite <package script> <output dir> <args...>
run_suite() {
  local script="$1" output="$2"
  shift 2
  local reporter="list"
  if [[ -n "${CI:-}" ]]; then reporter="github,list"; fi
  run_lane_command bun run "${script}" "$@" --retries=0 --reporter="${reporter}" --output="${output}"
}

run_travel_lane() {
# Run each independent suite even if a preceding one fails.
TIME_TRAVEL_E2E_BASE_URL="${BASE_URL}" run_suite test:e2e:time-travel "${ARTIFACTS}/time-travel" e2e/time-travel.spec.ts --project=webkit --project=iphone-webkit --project=iphone-15-webkit || status=1
}

run_portable_lane() {
PORTABLE_INVARIANTS_E2E_BASE_URL="${BASE_URL}" run_suite test:e2e:portable-invariants "${ARTIFACTS}/portable-invariants" --project=webkit --project=iphone-webkit || status=1
BOOT_RETRY_E2E_BASE_URL="${BASE_URL}" run_suite test:e2e:boot-retry "${ARTIFACTS}/boot-retry" --project=webkit || status=1
}

if [[ "${MODE}" == memory || "${MODE}" == all ]]; then run_memory_lane; fi
if [[ "${MODE}" == travel || "${MODE}" == portable || "${MODE}" == functional || "${MODE}" == all ]]; then start_functional_preview; fi
if [[ "${MODE}" == travel || "${MODE}" == functional || "${MODE}" == all ]]; then run_travel_lane; fi
if [[ "${MODE}" == portable || "${MODE}" == functional || "${MODE}" == all ]]; then run_portable_lane; fi
collect_crash_evidence
CRASH_EVIDENCE_COLLECTED=1
grep -rh "page crashed" "${ARTIFACTS}" --include='*-browser.log' || true
exit "${status}"
