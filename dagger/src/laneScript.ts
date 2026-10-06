/**
 * The bash script a browser lane runs: start a local server, wait for it, then
 * run each verification command in order, each under a hard time limit.
 *
 * Why the limit exists: on 2026-10-05 (run 37362447831) one lane command
 * awaited a service worker that was never registered, printed nothing, and
 * held the whole CI run for 74 minutes until it was cancelled. A command that
 * outlives its budget now FAILS, names itself, and the gate reports it.
 *
 * Pure bash, no coreutils `timeout`: each command runs in its own process
 * group (`set -m`), so the kill reaches the browsers a Playwright script
 * spawned; the watchdog has its own group too, so no stray `sleep` keeps the
 * exec's output pipe open after the lane ends.
 */

/** Per-command budget. The slowest lane command takes ~5 min on CI. */
export const LANE_COMMAND_TIMEOUT_SECONDS = 900

/** Grace between SIGTERM and SIGKILL for a timed-out command. */
const KILL_GRACE_SECONDS = 10

export interface LaneScriptOptions {
  readonly server: string
  readonly port: number
  readonly commands: readonly string[]
  readonly timeoutSeconds?: number
  /** Test seam: skip the curl readiness loop (no server to probe). */
  readonly waitForServer?: boolean
}

/** Single-quote a string for bash. */
function quote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`
}

const RUN_BOUNDED = `run_bounded() {
  local limit="$1" command="$2" marker status=0 child watchdog
  marker="$(mktemp)"
  set -m
  bash -c "$command" &
  child=$!
  ( sleep "$limit"; echo timeout > "$marker"; kill -TERM -- "-$child" 2>/dev/null; sleep ${KILL_GRACE_SECONDS}; kill -KILL -- "-$child" 2>/dev/null ) &
  watchdog=$!
  set +m
  wait "$child" || status=$?
  kill -KILL -- "-$watchdog" 2>/dev/null || true
  wait "$watchdog" 2>/dev/null || true
  if [ -s "$marker" ]; then
    rm -f "$marker"
    echo "lane command timed out after \${limit}s: $command" >&2
    return 124
  fi
  rm -f "$marker"
  return "$status"
}`

export function laneScript(options: LaneScriptOptions): string {
  const limit = options.timeoutSeconds ?? LANE_COMMAND_TIMEOUT_SECONDS
  const ready =
    options.waitForServer === false
      ? ""
      : `for _ in {1..60}; do curl -fsS -o /dev/null http://127.0.0.1:${options.port} && break; kill -0 "$pid"; sleep 1; done; curl -fsS -o /dev/null http://127.0.0.1:${options.port}\n`
  const commands = options.commands.map((command) => `run_bounded ${limit} ${quote(command)}`).join("\n")
  return `set -euo pipefail
${RUN_BOUNDED}
${options.server} &
pid=$!
trap 'kill "$pid" 2>/dev/null || true' EXIT
${ready}${commands}`
}
