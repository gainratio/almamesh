// A WebAssembly trap during the Pyodide boot (WebKit once raised
// `RuntimeError: Out of bounds memory access` on the very first Python
// statement of a cold compile) is a fault of that one wasm instance, not of
// the bundle or the network. These helpers keep the error's class intact
// across the Worker boundary so the runtime can tell such a fault apart and
// retry the boot once in a fresh Worker (see ./runtime.ts).

/** `WebAssembly.RuntimeError.prototype.name`; no other built-in error uses it. */
const WASM_TRAP_NAME = "RuntimeError";

/** The error fields a Worker reply carries: the message and, when known, the class. */
export interface WorkerErrorFields {
  readonly error: string;
  readonly errorName?: string;
}

/**
 * Serialise a caught error for a Worker reply. Only the wasm-trap class is
 * passed through (an allowlist of one): no other class name crosses the
 * boundary, so nothing but a trap can ever look like one.
 */
export function workerErrorFields(error: unknown): WorkerErrorFields {
  if (!(error instanceof Error)) return { error: String(error) };
  if (error.name === WASM_TRAP_NAME) return { error: error.message, errorName: WASM_TRAP_NAME };
  return { error: error.message };
}

/** Rebuild a Worker-side error on the main thread, restoring its class name. */
export function errorFromWorker(message: string, errorName?: string): Error {
  const error = new Error(message);
  if (errorName !== undefined) error.name = errorName;
  return error;
}

/** True for a WebAssembly trap, raised locally or relayed from the Worker. */
export function isWasmBootFault(error: unknown): boolean {
  return error instanceof Error && error.name === WASM_TRAP_NAME;
}
