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
//
// The same instance fault can end the runtime without a trap: CPython exits
// during start-up ("Fatal Python error: Failed to import encodings module",
// WebKit CI run 38295121396) and `loadPyodide` rejects with Emscripten's
// `ExitStatus`, which is not an Error. Unrecognised, it crossed the Worker as
// "[object Object]", was neither retried nor transient, and the Life Atlas
// waited on a dead engine. It is a fault of that instance too.

/** `WebAssembly.RuntimeError.prototype.name`; no other built-in error uses it. */
const WASM_TRAP_NAME = "RuntimeError";

/**
 * The engines' own trap wordings that nothing else uses (JavaScriptCore, V8),
 * so they count anywhere in the text.
 */
const DISTINCT_TRAP_TEXT: readonly RegExp[] = [
  /out of bounds memory access/i,
  /memory access out of bounds/i,
  /unreachable code should not be executed/i,
  // Pyodide's own wording for any use of a runtime that already died.
  /Pyodide already fatally failed/,
];

/** Emscripten's `ExitStatus` class name (`loadPyodide` rejects with it). */
const EMSCRIPTEN_EXIT_NAME = "ExitStatus";
const EMSCRIPTEN_EXIT_TEXT = /^Program terminated with exit\(-?\d+\)$/;

/**
 * Emscripten's `ExitStatus` is a plain object, not an Error: recognise it by
 * its own class name AND its exact message, so an arbitrary object cannot.
 */
function emscriptenExit(error: unknown): string | null {
  if (typeof error !== "object" || error === null || error instanceof Error) return null;
  const { name, message } = error as { readonly name?: unknown; readonly message?: unknown };
  if (name !== EMSCRIPTEN_EXIT_NAME || typeof message !== "string") return null;
  return EMSCRIPTEN_EXIT_TEXT.test(message) ? message : null;
}

/**
 * V8's "unreachable" and SpiderMonkey's "unreachable executed" / "index out of
 * bounds" are also ordinary words: a Python `RuntimeError: unreachable`, a
 * memoryview `IndexError: index out of bounds on dimension 1`, an assertNever
 * `Error("unreachable")`. So they count only where Pyodide wrapped a JS trap:
 * right after "JsException: RuntimeError: ", or as a whole "; "-joined
 * loadPackage segment. A bare trap is caught by its RuntimeError class instead.
 */
const WRAPPED_AMBIGUOUS_TRAP =
  /(?:JsException: RuntimeError: |; )(?:unreachable(?: executed)?|index out of bounds)(?=;|\n|$)/;

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
  const exited = emscriptenExit(error);
  if (exited !== null) return { error: exited, errorName: WASM_TRAP_NAME };
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
  if (error.name === WASM_TRAP_NAME) return true;
  return DISTINCT_TRAP_TEXT.some((trap) => trap.test(error.message)) || WRAPPED_AMBIGUOUS_TRAP.test(error.message);
}

/**
 * True for a WebAssembly trap, raised locally, relayed from the Worker, or
 * wrapped by Pyodide (in the message or up to MAX_CAUSE_DEPTH errors deep).
 */
export function isWasmBootFault(error: unknown): boolean {
  if (emscriptenExit(error) !== null) return true;
  let current = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth += 1) {
    if (isTrapItself(current)) return true;
    current = current.cause;
  }
  return false;
}
