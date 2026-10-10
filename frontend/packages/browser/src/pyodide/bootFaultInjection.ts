// EXIT-GATE HOOK ONLY. Lets an e2e prove the one automatic boot retry live:
// a page that sets `window.__almameshArmBootWasmFault = true` makes the FIRST
// boot's Pyodide Worker execute a wasm `unreachable` instruction, a real
// WebAssembly.RuntimeError, the same class WebKit's cold-compile trap raised.
// Setting it to "wrapped" throws that same real trap wrapped the way Pyodide's
// loadPackage reports it on WebKit (a PyodidePackageLoadError for pytz whose
// text carries the trap message), the form PR #317 recorded on the macOS lane.
//
// Every caller guards on `import.meta.env.VITE_EXIT_GATE_HOOKS === "1"` at
// the call site, so a production build folds the guard to `false` and drops
// this module. `scripts/verify-boot-fault-hook.mjs` proves the production
// bundle contains neither the arm key nor the Worker's `injectWasmTrap` field.

import { PyodidePackageLoadError } from "./pyodideDistCache";

declare global {
  // Vite replaces `import.meta.env.*` at build time; a production build sees
  // this empty. @almamesh/browser reads no other env value.
  interface ImportMetaEnv {
    readonly VITE_EXIT_GATE_HOOKS?: string;
  }
  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}

/** The page global an e2e sets (via an init script) to arm the fault. */
export const BOOT_FAULT_ARM_KEY = "__almameshArmBootWasmFault";

/** "trap": the bare WebAssembly.RuntimeError. "wrapped": that trap as Pyodide reports it. */
export type BootFaultKind = "trap" | "wrapped";

type Armable = typeof globalThis & { [BOOT_FAULT_ARM_KEY]?: unknown };

/** Main thread: the armed fault once for an armed page in a hooks build, then disarmed. */
export function takeArmedBootFault(): BootFaultKind | null {
  if (import.meta.env.VITE_EXIT_GATE_HOOKS !== "1") return null;
  const scope = globalThis as Armable;
  const armed = scope[BOOT_FAULT_ARM_KEY];
  const kind = armed === true ? "trap" : armed === "wrapped" ? "wrapped" : null;
  if (kind !== null) scope[BOOT_FAULT_ARM_KEY] = false;
  return kind;
}

/** Worker: raise the armed fault, built on a genuine WebAssembly.RuntimeError. */
export function raiseWasmTrap(kind: BootFaultKind): never {
  if (kind === "trap") executeTrap();
  try {
    executeTrap();
  } catch (trap) {
    // Pyodide's loadPackage reports a failed package as these two lines.
    const details = ["The following error occurred while loading pytz:", (trap as Error).message];
    throw new PyodidePackageLoadError(["pytz"], details);
  }
}

/** Trap inside real wasm, throwing a genuine WebAssembly.RuntimeError. */
function executeTrap(): never {
  // (module (func (export "trap") unreachable)). Kept inside the function so a
  // production build, which never calls it, drops the bytes with it.
  const trapModule = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x04, 0x01, 0x60, 0x00, 0x00, 0x03, 0x02,
    0x01, 0x00, 0x07, 0x08, 0x01, 0x04, 0x74, 0x72, 0x61, 0x70, 0x00, 0x00, 0x0a, 0x05, 0x01, 0x03,
    0x00, 0x00, 0x0b,
  ]);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(trapModule));
  (instance.exports["trap"] as () => void)();
  throw new Error("wasm trap module returned instead of trapping");
}
