/**
 * Main-thread seams between the engine provider and the recovery surfaces.
 *
 * - The provider registers a teardown for the live runtime (sync + chart
 *   Workers), so an explicit user reset can release the sync Worker's Web Lock
 *   and OPFS/IndexedDB handles before it clears the signed-bundle cache.
 * - The provider records its latest boot failure, so a surface that does not
 *   receive the error directly (the global ErrorBoundary) can still tell a
 *   rollback refusal apart and guard its reset.
 *
 * Nothing here clears anything. Clearing stays an explicit user action.
 */

/** The @gainratio/browser Worker code for a refusal against the durable floor. */
export const ROLLBACK_CODE = 'rollback';

/**
 * The stable `EngineOperationError.code` carried by an error or anything in its
 * `cause` chain; null for other errors. Only the library's own error type is
 * trusted, never a message match.
 */
export function engineErrorCode(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (current.name === 'EngineOperationError' && typeof code === 'string') {
      return code;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

export function isRollbackRefusal(error: unknown): boolean {
  return engineErrorCode(error) === ROLLBACK_CODE;
}

let lastFailure: Error | null = null;

export function recordEngineBootFailure(error: Error | null): void {
  lastFailure = error;
}

export function lastEngineBootFailure(): Error | null {
  return lastFailure;
}

type Teardown = () => void | Promise<void>;
let teardown: Teardown | null = null;

/** Register the live runtime's teardown; returns an unregister function. */
export function registerEngineTeardown(fn: Teardown): () => void {
  teardown = fn;
  return () => {
    if (teardown === fn) teardown = null;
  };
}

/** Stop the live engine Workers (best-effort, never rejects). */
export async function teardownLiveEngine(): Promise<void> {
  try {
    await teardown?.();
  } catch {
    // Best-effort: a failed teardown must not stop an explicit reset.
  }
}
