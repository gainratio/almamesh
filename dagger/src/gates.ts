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

/** Starts one gate now. The returned promise never rejects; it reports instead. */
export function startGate(name: string, run: Gate["run"]): Promise<GateOutcome> {
  const started = (async () => run())()
  return started.then(
    () => ({ gate: name, failed: false }),
    (error: unknown) => ({ gate: name, failed: true, error }),
  )
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
