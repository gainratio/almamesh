import { describe, expect, it } from "vitest";

import { errorFromWorker, isWasmBootFault, workerErrorFields } from "../bootFault";
import { PyodidePackageLoadError } from "../pyodideDistCache";

/** A real WebAssembly trap, raised by running an `unreachable` instruction. */
function realWasmTrap(): Error {
  // (module (func (export "trap") unreachable))
  const bytes = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x04, 0x01, 0x60, 0x00, 0x00, 0x03,
    0x02, 0x01, 0x00, 0x07, 0x08, 0x01, 0x04, 0x74, 0x72, 0x61, 0x70, 0x00, 0x00, 0x0a, 0x05,
    0x01, 0x03, 0x00, 0x00, 0x0b,
  ]);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes));
  try {
    (instance.exports.trap as () => void)();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a wasm trap");
}

describe("isWasmBootFault", () => {
  it("recognises a real WebAssembly trap", () => {
    expect(isWasmBootFault(realWasmTrap())).toBe(true);
  });

  it("recognises a trap that crossed the Worker boundary by its error name", () => {
    expect(isWasmBootFault(errorFromWorker("Out of bounds memory access", "RuntimeError"))).toBe(true);
  });

  it("does not treat network, signature or Python failures as wasm faults", () => {
    expect(isWasmBootFault(new TypeError("Failed to fetch"))).toBe(false);
    expect(isWasmBootFault(new Error("bundle signature verification failed"))).toBe(false);
    // A Python RuntimeError arrives as a PythonError whose MESSAGE names it.
    expect(isWasmBootFault(errorFromWorker("Traceback ...\nRuntimeError: boom", "PythonError"))).toBe(false);
    expect(isWasmBootFault("RuntimeError")).toBe(false);
    expect(isWasmBootFault(null)).toBe(false);
  });
});

/** A PythonError as Pyodide raises it: class name kept, traceback as the message. */
function pythonError(traceback: string): Error {
  const error = new Error(traceback);
  error.name = "PythonError";
  return error;
}

/** `depth` errors, each the `.cause` of the one before; the innermost is `innermost`. */
function causeChain(depth: number, innermost: Error): Error {
  let error = innermost;
  for (let link = 1; link < depth; link += 1) error = new Error(`boot step ${link} failed`, { cause: error });
  return error;
}

// Recorded on the WebKit macOS lane (run 38024217611, PR #317): JavaScriptCore's
// trap message, as Pyodide's loadPackage hands it to the errorCallback.
const JSC_PACKAGE_TRAP = [
  "The following error occurred while loading pytz:",
  "Out of bounds memory access (evaluating '__pyproxy_apply(t,e,n,o,s)')",
];

describe("isWasmBootFault: a trap wrapped by Pyodide", () => {
  it("recognises a package load error whose details carry the trap", () => {
    const wrapped = new PyodidePackageLoadError(["pytz"], JSC_PACKAGE_TRAP);

    expect(wrapped.message).toBe(
      "Pyodide could not load pytz: The following error occurred while loading pytz:; " +
        "Out of bounds memory access (evaluating '__pyproxy_apply(t,e,n,o,s)')",
    );
    expect(isWasmBootFault(wrapped)).toBe(true);
  });

  it("recognises the V8 and SpiderMonkey wordings of the same traps", () => {
    // V8's `unreachable` trap message is the single word.
    for (const trap of ["memory access out of bounds", "unreachable", "unreachable executed", "index out of bounds"]) {
      const details = ["The following error occurred while loading pytz:", trap];
      expect(isWasmBootFault(new PyodidePackageLoadError(["pytz"], details)), trap).toBe(true);
    }
  });

  it("recognises a Python import error whose traceback ends in a wasm trap", () => {
    for (const trap of [
      "RuntimeError: Out of bounds memory access",
      "RuntimeError: Unreachable code should not be executed",
      "RuntimeError: unreachable",
      "RuntimeError: memory access out of bounds",
      "RuntimeError: index out of bounds",
    ]) {
      const traceback =
        "Traceback (most recent call last):\n" +
        '  File "<exec>", line 1, in <module>\n' +
        '  File "/lib/python3.13/site-packages/pytz/__init__.py", line 20, in <module>\n' +
        // A formatted traceback ends with a newline.
        `pyodide.ffi.JsException: ${trap}\n`;
      expect(isWasmBootFault(pythonError(traceback)), trap).toBe(true);
    }
  });

  it("recognises the trap after it crossed the Worker boundary as text", () => {
    const wrapped = new PyodidePackageLoadError(["pytz"], JSC_PACKAGE_TRAP);
    const fields = workerErrorFields(wrapped);

    expect(fields).toEqual({ error: wrapped.message, errorName: "RuntimeError" });
    expect(isWasmBootFault(errorFromWorker(fields.error, fields.errorName))).toBe(true);
    // An older Worker that sent no class name: the text alone still counts.
    expect(isWasmBootFault(errorFromWorker(wrapped.message))).toBe(true);
  });

  it("follows the cause chain to a real trap, up to 8 errors deep", () => {
    expect(isWasmBootFault(new Error("engine boot failed", { cause: realWasmTrap() }))).toBe(true);
    expect(isWasmBootFault(causeChain(8, realWasmTrap()))).toBe(true);
    expect(isWasmBootFault(causeChain(9, realWasmTrap()))).toBe(false);
  });

  it("stops on a cause cycle", () => {
    const looped = new Error("boot failed");
    (looped as { cause?: unknown }).cause = looped;

    expect(isWasmBootFault(looped)).toBe(false);
  });
});

describe("isWasmBootFault: failures that are not a wasm trap stay unretried", () => {
  it("does not retry an ordinary Python import error", () => {
    const traceback =
      "Traceback (most recent call last):\n" +
      '  File "<exec>", line 1, in <module>\n' +
      "ModuleNotFoundError: No module named 'pytz'";
    expect(isWasmBootFault(pythonError(traceback))).toBe(false);
    expect(isWasmBootFault(pythonError("Traceback ...\nImportError: cannot import name 'utc' from 'pytz'"))).toBe(false);
  });

  it("does not retry an offline package fetch failure in any browser's wording", () => {
    for (const fetchFailure of ["Failed to fetch", "Load failed", "NetworkError when attempting to fetch resource."]) {
      const details = ["The following error occurred while loading pytz:", fetchFailure];
      expect(isWasmBootFault(new PyodidePackageLoadError(["pytz"], details)), fetchFailure).toBe(false);
    }
  });

  it("does not mistake a network 'unreachable' or a Python RuntimeError for a trap", () => {
    expect(isWasmBootFault(new TypeError("Failed to fetch", { cause: new Error("net::ERR_ADDRESS_UNREACHABLE") }))).toBe(false);
    expect(isWasmBootFault(new Error("Network is unreachable"))).toBe(false);
    expect(isWasmBootFault(pythonError("Traceback ...\nRuntimeError: unreachable state in the engine"))).toBe(false);
    expect(isWasmBootFault(pythonError("Traceback ...\nIndexError: index 5 is out of bounds for axis 0 with size 3"))).toBe(false);
  });

  // Real CPython 3.13 tracebacks, each raised by plain Python code. The last
  // line is a Python exception, never a JS error relayed through JsException.
  it.each([
    ["memoryview", "IndexError: index out of bounds on dimension 1"],
    ["a Python RuntimeError", "RuntimeError: unreachable"],
    ["a Python assertion", "AssertionError: unreachable"],
    ["an OS network error", "OSError: [Errno 101] Network is unreachable"],
  ])("does not retry a CPython traceback from %s", (_source, last) => {
    const traceback =
      "Traceback (most recent call last):\n" +
      '  File "<stdin>", line 3, in msg\n' +
      '  File "<stdin>", line 7, in <lambda>\n' +
      `${last}\n`;
    expect(isWasmBootFault(pythonError(traceback))).toBe(false);
  });

  it("does not retry the same trap words outside a Pyodide wrapper", () => {
    // SpiderMonkey's WebAssembly.Table.get range error, and a Rust panic.
    expect(isWasmBootFault(new RangeError("index out of bounds"))).toBe(false);
    expect(isWasmBootFault(new Error("panicked at src/lib.rs:1:1:\nindex out of bounds: the len is 3 but the index is 5"))).toBe(false);
    expect(isWasmBootFault(pythonError("Traceback ...\npyodide.ffi.JsException: RangeError: index out of bounds"))).toBe(false);
  });

  it("counts the ambiguous words only as a whole wrapped segment, never as the start of a sentence", () => {
    const details = ["The following error occurred while loading pytz:", "index out of bounds on dimension 1"];
    expect(isWasmBootFault(new PyodidePackageLoadError(["pytz"], details))).toBe(false);
    expect(isWasmBootFault(pythonError("Traceback ...\npyodide.ffi.JsException: RuntimeError: unreachable state\n"))).toBe(false);
  });

  it("rejects a plain JS Error('unreachable') (an assertNever guard): a real V8 trap carries the RuntimeError class", () => {
    expect(isWasmBootFault(new Error("unreachable"))).toBe(false);
    expect(isWasmBootFault(new Error("unreachable executed"))).toBe(false);
    expect(isWasmBootFault(new Error("index out of bounds"))).toBe(false);
  });

  it("keeps a non-trap error's class off the Worker wire", () => {
    const offline = new PyodidePackageLoadError(["pytz"], ["The following error occurred while loading pytz:", "Load failed"]);

    expect(workerErrorFields(offline)).toEqual({ error: offline.message });
  });
});

describe("worker error wire shape", () => {
  it("carries the error class across the Worker boundary", () => {
    const fields = workerErrorFields(realWasmTrap());

    expect(fields.errorName).toBe("RuntimeError");
    const rebuilt = errorFromWorker(fields.error, fields.errorName);
    expect(rebuilt).toBeInstanceOf(Error);
    expect(rebuilt.name).toBe("RuntimeError");
    expect(rebuilt.message).toBe(fields.error);
  });

  it("passes only the wasm-trap class through: any other class is omitted", () => {
    const python = new Error("Traceback ...\nRuntimeError: boom");
    python.name = "PythonError";

    expect(workerErrorFields(new TypeError("Failed to fetch"))).toEqual({ error: "Failed to fetch" });
    expect(workerErrorFields(python)).toEqual({ error: "Traceback ...\nRuntimeError: boom" });
    expect(workerErrorFields(new Error("plain"))).toEqual({ error: "plain" });
  });

  it("serialises a non-Error throw as its string with no class", () => {
    expect(workerErrorFields("boom")).toEqual({ error: "boom" });
    expect(errorFromWorker("boom").name).toBe("Error");
  });
});
