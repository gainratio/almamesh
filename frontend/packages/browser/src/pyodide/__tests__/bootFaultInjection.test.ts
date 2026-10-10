import { afterEach, describe, expect, it, vi } from "vitest";

import { isWasmBootFault } from "../bootFault";
import { BOOT_FAULT_ARM_KEY, raiseWasmTrap, takeArmedBootFault } from "../bootFaultInjection";

type Armable = typeof globalThis & { [BOOT_FAULT_ARM_KEY]?: boolean };

afterEach(() => {
  vi.unstubAllEnvs();
  delete (globalThis as Armable)[BOOT_FAULT_ARM_KEY];
});

describe("exit-gate boot fault switch", () => {
  it("names the page global the e2e arms", () => {
    expect(BOOT_FAULT_ARM_KEY).toBe("__almameshArmBootWasmFault");
  });

  it("fires once for an armed page in a hooks build, then disarms", () => {
    vi.stubEnv("VITE_EXIT_GATE_HOOKS", "1");
    (globalThis as Armable)[BOOT_FAULT_ARM_KEY] = true;

    expect(takeArmedBootFault()).toBe(true);
    expect(takeArmedBootFault()).toBe(false);
  });

  it("never fires in a build without the exit-gate hooks, even when armed", () => {
    vi.stubEnv("VITE_EXIT_GATE_HOOKS", "");
    (globalThis as Armable)[BOOT_FAULT_ARM_KEY] = true;

    expect(takeArmedBootFault()).toBe(false);
  });

  it("does not fire for a page that did not arm it", () => {
    vi.stubEnv("VITE_EXIT_GATE_HOOKS", "1");

    expect(takeArmedBootFault()).toBe(false);
  });

  it("raises a real WebAssembly RuntimeError, which the runtime retries", () => {
    let caught: unknown = null;
    try {
      raiseWasmTrap();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(WebAssembly.RuntimeError);
    expect(isWasmBootFault(caught)).toBe(true);
  });
});
