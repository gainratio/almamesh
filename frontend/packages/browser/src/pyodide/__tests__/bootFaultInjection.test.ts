import { afterEach, describe, expect, it, vi } from "vitest";

import { isWasmBootFault, workerErrorFields } from "../bootFault";
import { BOOT_FAULT_ARM_KEY, raiseWasmTrap, takeArmedBootFault } from "../bootFaultInjection";
import { PyodidePackageLoadError } from "../pyodideDistCache";

type Armable = typeof globalThis & { [BOOT_FAULT_ARM_KEY]?: unknown };

afterEach(() => {
  vi.unstubAllEnvs();
  delete (globalThis as Armable)[BOOT_FAULT_ARM_KEY];
});

function thrownBy(raise: () => never): unknown {
  try {
    raise();
  } catch (error) {
    return error;
  }
  return null;
}

describe("exit-gate boot fault switch", () => {
  it("names the page global the e2e arms", () => {
    expect(BOOT_FAULT_ARM_KEY).toBe("__almameshArmBootWasmFault");
  });

  it("fires once for an armed page in a hooks build, then disarms", () => {
    vi.stubEnv("VITE_EXIT_GATE_HOOKS", "1");
    (globalThis as Armable)[BOOT_FAULT_ARM_KEY] = true;

    expect(takeArmedBootFault()).toBe("trap");
    expect(takeArmedBootFault()).toBeNull();
  });

  it("arms a Pyodide-wrapped trap when the page sets 'wrapped'", () => {
    vi.stubEnv("VITE_EXIT_GATE_HOOKS", "1");
    (globalThis as Armable)[BOOT_FAULT_ARM_KEY] = "wrapped";

    expect(takeArmedBootFault()).toBe("wrapped");
    expect(takeArmedBootFault()).toBeNull();
  });

  it("ignores any other armed value", () => {
    vi.stubEnv("VITE_EXIT_GATE_HOOKS", "1");
    (globalThis as Armable)[BOOT_FAULT_ARM_KEY] = "yes";

    expect(takeArmedBootFault()).toBeNull();
  });

  it("never fires in a build without the exit-gate hooks, even when armed", () => {
    vi.stubEnv("VITE_EXIT_GATE_HOOKS", "");
    (globalThis as Armable)[BOOT_FAULT_ARM_KEY] = true;

    expect(takeArmedBootFault()).toBeNull();
  });

  it("does not fire for a page that did not arm it", () => {
    vi.stubEnv("VITE_EXIT_GATE_HOOKS", "1");

    expect(takeArmedBootFault()).toBeNull();
  });

  it("raises a real WebAssembly RuntimeError, which the runtime retries", () => {
    const caught = thrownBy(() => raiseWasmTrap("trap"));

    expect(caught).toBeInstanceOf(WebAssembly.RuntimeError);
    expect(isWasmBootFault(caught)).toBe(true);
  });

  it("wraps the real trap the way Pyodide's loadPackage reports it; the runtime still retries", () => {
    const caught = thrownBy(() => raiseWasmTrap("wrapped"));

    expect(caught).toBeInstanceOf(PyodidePackageLoadError);
    expect((caught as Error).message).toMatch(
      /^Pyodide could not load pytz: The following error occurred while loading pytz:; \S/,
    );
    expect(isWasmBootFault(caught)).toBe(true);
    expect(workerErrorFields(caught).errorName).toBe("RuntimeError");
  });
});
