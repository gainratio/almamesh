// EXIT-GATE HOOK ONLY. Lets an e2e prove the one automatic boot retry live:
// a page that sets `window.__almameshArmBootWasmFault = true` makes the FIRST
// boot's Pyodide Worker execute a wasm `unreachable` instruction, a real
// WebAssembly.RuntimeError, the same class WebKit's cold-compile trap raised.
//
// Every caller guards on `import.meta.env.VITE_EXIT_GATE_HOOKS === "1"` at
// the call site, so a production build folds the guard to `false` and drops
// this module. `scripts/verify-boot-fault-hook.mjs` proves the production
// bundle contains neither the arm key nor the Worker's `injectWasmTrap` field.

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

type Armable = typeof globalThis & { [BOOT_FAULT_ARM_KEY]?: boolean };

/** Main thread: true once for an armed page in a hooks build, then disarmed. */
export function takeArmedBootFault(): boolean {
  if (import.meta.env.VITE_EXIT_GATE_HOOKS !== "1") return false;
  const scope = globalThis as Armable;
  if (scope[BOOT_FAULT_ARM_KEY] !== true) return false;
  scope[BOOT_FAULT_ARM_KEY] = false;
  return true;
}

/** Worker: trap inside real wasm, throwing a genuine WebAssembly.RuntimeError. */
export function raiseWasmTrap(): never {
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
