// A WebAssembly trap during the Pyodide boot (WebKit once raised
// `RuntimeError: Out of bounds memory access` on the very first Python
// statement of a cold compile) is a fault of that one wasm instance, not of
// the bundle or the network. These helpers keep the error's class intact
// across the Worker boundary so the runtime can tell such a fault apart and
// retry the boot once in a fresh Worker (see ./runtime.ts).
//
// Pyodide often wraps the trap before it reaches us: loadPackage reports it as
// text ("Out of bounds memory access (evaluating '__pyproxy_apply(...)')",
// which assertPackagesLoaded turns into a PyodidePackageLoadError), and a trap
// raised under Python surfaces in a traceback as "JsException: RuntimeError:
// ...". So the class, the message text and the `.cause` chain all count.

/** `WebAssembly.RuntimeError.prototype.name`; no other built-in error uses it. */
const WASM_TRAP_NAME = "RuntimeError";

/**
 * The engines' own trap wordings (JavaScriptCore, V8, SpiderMonkey). Each is
 * specific to a wasm trap: a fetch failure, "Network is unreachable" or a
 * Python RuntimeError never matches. V8's trap message is the single word
 * "unreachable", so that word counts only as a whole message segment: the
 * whole text, or right after "RuntimeError:" or loadPackage's "pytz:;".
 */
const WASM_TRAP_TEXT: readonly RegExp[] = [
  /out of bounds memory access/i,
  /memory access out of bounds/i,
  /\bindex out of bounds\b/i,
  /unreachable code should not be executed/i,
  /\bunreachable executed\b/i,
  /(?:^|[:;]\s*)unreachable(?:\s*$|\s*;|\s+\()/im,
];

/** How many errors of a `.cause` chain are inspected (the error itself included). */
const MAX_CAUSE_DEPTH = 8;

/** The error fields a Worker reply carries: the message and, when known, the class. */
export interface WorkerErrorFields {
  readonly error: string;
  readonly errorName?: string;
}

/**
 * Serialise a caught error for a Worker reply. Only the wasm-trap class is
 * passed through (an allowlist of one): no other class name crosses the
 * boundary, so nothing but a trap can ever look like one. A trap Pyodide
 * wrapped is sent under the trap class too, since its `.cause` chain cannot
 * cross the boundary.
 */
export function workerErrorFields(error: unknown): WorkerErrorFields {
  if (!(error instanceof Error)) return { error: String(error) };
  if (isWasmBootFault(error)) return { error: error.message, errorName: WASM_TRAP_NAME };
  return { error: error.message };
}

/** Rebuild a Worker-side error on the main thread, restoring its class name. */
export function errorFromWorker(message: string, errorName?: string): Error {
  const error = new Error(message);
  if (errorName !== undefined) error.name = errorName;
  return error;
}

function isTrapItself(error: Error): boolean {
  return error.name === WASM_TRAP_NAME || WASM_TRAP_TEXT.some((trap) => trap.test(error.message));
}

/**
 * True for a WebAssembly trap, raised locally, relayed from the Worker, or
 * wrapped by Pyodide (in the message or up to MAX_CAUSE_DEPTH errors deep).
 */
export function isWasmBootFault(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth += 1) {
    if (isTrapItself(current)) return true;
    current = current.cause;
  }
  return false;
}
