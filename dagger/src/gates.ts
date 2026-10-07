/**
 * Concurrent gate runner for the `ci` function.
 *
 * Gates are independent Dagger containers, so they can run at the same time.
 * The one rule that must never bend: a red gate fails the whole run, and its
 * name and output reach the log. So every gate is allowed to finish (one red
 * gate must not hide another), and then any failure is thrown.
 */
export interface Gate {
  name: string
  run: () => PromiseLike<unknown>
}

export interface GateOutcome {
  gate: string
  failed: boolean
  error?: unknown
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Budget for one gate. The longest (browser) takes ~20 min on a loaded
 * runner. A gate past it reports a named failure instead of holding the run:
 * on 2026-10-05 one lane waited 74 minutes on a service worker that was never
 * registered (run 37362447831). The Dagger session ends with the run, which
 * tears down the stuck exec.
 */
export const GATE_TIMEOUT_MS = 45 * 60_000

class GateTimeoutError extends Error {
  public override readonly name = "GateTimeoutError"
}

/** Starts one gate now. The returned promise never rejects; it reports instead. */
export function startGate(name: string, run: Gate["run"], timeoutMs = GATE_TIMEOUT_MS): Promise<GateOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new GateTimeoutError(`gate timed out after ${timeoutMs} ms`)), timeoutMs)
  })
  const started = Promise.race([(async () => run())(), deadline])
  return started.then(
    () => ({ gate: name, failed: false }),
    (error: unknown) => ({ gate: name, failed: true, error }),
  ).finally(() => clearTimeout(timer))
}

/** Throws one error naming every failed gate with its output; no-op if all passed. */
export function assertAllPassed(outcomes: readonly GateOutcome[]): void {
  const failed = outcomes.filter((outcome) => outcome.failed)
  if (failed.length === 0) return
  const lines = failed.map((outcome) => `- ${outcome.gate}: ${describeError(outcome.error)}`)
  const summary = `${failed.length} of ${outcomes.length} gates failed:\n${lines.join("\n")}`
  throw new Error(summary, { cause: failed.map((outcome) => outcome.error) })
}

export async function runConcurrently(gates: readonly Gate[]): Promise<void> {
  const outcomes = await Promise.all(gates.map((gate) => startGate(gate.name, gate.run)))
  assertAllPassed(outcomes)
}

/**
 * Runs gates through `limit` lanes, starting them in the order given. Independent does not
 * mean free: on a 4 vCPU runner, too many heavy gates at once turn CPU contention into
 * timeouts. Like startGate it never rejects; every gate finishes and reports an outcome.
 */
export async function runPool(gates: readonly Gate[], limit: number): Promise<GateOutcome[]> {
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`gate pool limit must be >= 1, got ${limit}`)
  const outcomes: GateOutcome[] = new Array(gates.length)
  let next = 0
  const lane = async (): Promise<void> => {
    while (next < gates.length) {
      const index = next++
      outcomes[index] = await startGate(gates[index].name, gates[index].run)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, gates.length) }, lane))
  return outcomes
}

/**
 * The product gates, longest first (the order `ci` starts them in). The old
 * single `browser` gate ran ~28 minutes of serial commands, so it is split into
 * five shards that each serve the same hooked build; in one engine (`ci`) Dagger
 * builds it once, and on GitHub each shard runs on its own runner.
 */
export const PRODUCT_GATES = [
  "browserChromium",
  "browserJourneys",
  "browserSuites",
  "browserWizards",
  "browserWebkitReal",
  "browserMatrix",
  "frontend",
  "backend",
  "pdf",
  "privacy",
] as const

export type ProductGate = (typeof PRODUCT_GATES)[number]

/** Every gate `ci` runs; GitHub runs each as its own job (`gate --name=...`). */
export const CI_GATES = ["secretScan", "contracts", ...PRODUCT_GATES] as const

export type CiGate = (typeof CI_GATES)[number]

export function isProductGate(name: string): name is ProductGate {
  return (PRODUCT_GATES as readonly string[]).includes(name)
}

/**
 * The required `Dagger` check's verdict over the per-gate GitHub jobs, given
 * `join(needs.*.result, ',')`. Green only when there is one result per gate and
 * every one is `success`: a failed, cancelled, or skipped gate is red, and so is
 * a gate job someone dropped from the aggregate's `needs`.
 */
export function gateVerdict(results: string): string {
  const outcomes = results.split(",").map((result) => result.trim()).filter((result) => result !== "")
  if (outcomes.length !== CI_GATES.length) {
    throw new Error(`expected ${CI_GATES.length} gate job results, got ${outcomes.length}: ${results}`)
  }
  const red = outcomes.filter((result) => result !== "success")
  if (red.length > 0) {
    throw new Error(`${red.length} of ${outcomes.length} gate jobs did not succeed: ${red.join(", ")}`)
  }
  return `All ${outcomes.length} gate jobs passed.`
}
