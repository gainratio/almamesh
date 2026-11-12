/**
 * Which engine boot failures are worth booting again for. The provider
 * retries these on its own; pages awaiting a boot follow that retry instead
 * of showing the failure (see resolveReadyEngine). Integrity, rollback and
 * storage refusals are never transient: they stay fail-closed.
 */
import { isWasmBootFault, WorkerCrashError, WorkerTimeoutError } from '@almamesh/browser';

// `stalled`: the sync transport's stall error (no bytes for 30 s) after its
// own bounded retries. A network condition, so it gets the same online retry.
const TRANSIENT_BOOT_FAILURE =
  /network unreachable|failed to fetch|load failed|networkerror|timed out after|stalled|importing a module script failed/i;
const TERMINAL_WORKER_FAILURE = /chart worker (?:failed|terminated)|engine boot superseded/i;

/** A Worker that crashed or went silent (e.g. an OPFS step that never settled). */
export function isTransientLocalWorkerFailure(error: Error): boolean {
  return error instanceof WorkerCrashError || error instanceof WorkerTimeoutError;
}

export function isTransientBootFailure(error: Error): boolean {
  return isTransientLocalWorkerFailure(error) || TRANSIENT_BOOT_FAILURE.test(error.message);
}

/** True when a post-ready or booting Worker died (iOS Low Power Mode jetsam, WASM trap) and a fresh reboot can recover. */
export function isRecoverableWorkerFailure(error: unknown): boolean {
  if (isWasmBootFault(error)) return true;
  if (!(error instanceof Error)) return false;
  return isTransientLocalWorkerFailure(error) || TERMINAL_WORKER_FAILURE.test(error.message);
}
