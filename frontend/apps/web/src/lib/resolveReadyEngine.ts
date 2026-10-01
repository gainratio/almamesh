/**
 * Resolve a READY in-browser chart engine before computing a chart — the single
 * decision that kills the onboarding "Connection Issue" race and recovers a
 * fail-closed bootstrap, instead of throwing the moment the user clicks Generate
 * faster than the 38 MB Pyodide + signed-bundle boot finishes.
 *
 * Three states map to three actions:
 *   - `engine` already ready          -> use it immediately.
 *   - `error` (bootstrap failed)      -> `reboot()` (a FRESH sync + boot) and use the result.
 *   - neither (still warming, in race)-> `whenReady()` (await the in-flight boot) and use it.
 *
 * A generous IDLE budget bounds the wait so a wedged boot still surfaces a
 * clear, retryable failure rather than hanging the Generate button forever.
 * It is an idle budget, not a wall clock: while the bootstrap keeps reporting
 * progress (bundle bytes arriving, files verified, Pyodide loading) the wait
 * continues. On slow 4G the cold sync alone takes about two minutes and the
 * old fixed 90 s wait rejected it every time, 30 s before the engine was ready.
 */

import type { ChartEngine } from '@almamesh/browser';

/** The slice of the chart-engine context this decision needs. */
export interface EngineReadiness {
  readonly engine: ChartEngine | null;
  readonly error: Error | null;
  /** Reset + run a FRESH bootstrap (new sync + boot); resolves with the ready engine. */
  reboot: () => Promise<ChartEngine>;
  /** Resolve when the CURRENT in-flight bootstrap finishes (shared, no extra boot). */
  whenReady: () => Promise<ChartEngine>;
  /**
   * When the bootstrap last reported progress (`Date.now()` ms). Each report
   * restarts the idle budget. Absent (no progress signal), the budget counts
   * from the call.
   */
  readonly lastProgressAt?: () => number;
}

/** Default readiness IDLE budget: how long the bootstrap may go without any progress. */
export const DEFAULT_READY_TIMEOUT_MS = 90_000;

class EngineNotReadyError extends Error {
  constructor() {
    super('The on-device engine did not become ready in time.');
    this.name = 'EngineNotReadyError';
  }
}

function withIdleBudget(
  work: Promise<ChartEngine>,
  idleMs: number,
  lastProgressAt: (() => number) | undefined,
): Promise<ChartEngine> {
  return new Promise<ChartEngine>((resolve, reject) => {
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Wake up when the budget WOULD expire; if progress moved it, sleep again.
    const check = (): void => {
      const latest = Math.max(started, lastProgressAt?.() ?? started);
      const remaining = idleMs - (Date.now() - latest);
      if (remaining <= 0) {
        reject(new EngineNotReadyError());
        return;
      }
      timer = setTimeout(check, remaining);
    };
    check();
    work.then(
      (engine) => {
        clearTimeout(timer);
        resolve(engine);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

export async function resolveReadyEngine(
  readiness: EngineReadiness,
  timeoutMs: number = DEFAULT_READY_TIMEOUT_MS,
): Promise<ChartEngine> {
  if (readiness.engine) {
    return readiness.engine;
  }
  const work = readiness.error ? readiness.reboot() : readiness.whenReady();
  return withIdleBudget(work, timeoutMs, readiness.lastProgressAt);
}
