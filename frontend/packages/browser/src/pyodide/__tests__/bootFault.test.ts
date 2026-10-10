import { describe, expect, it } from "vitest";

import { errorFromWorker, isWasmBootFault, workerErrorFields } from "../bootFault";

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
