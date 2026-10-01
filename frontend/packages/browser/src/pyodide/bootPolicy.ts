// Engine boot policy: may the Pyodide Worker warm up WHILE the bundle-sync
// Worker is still alive ("overlap"), or only after it has been terminated
// ("sequential")?
//
// Overlap saves roughly one Pyodide cold start (≈1 s on a desktop) but keeps
// two wasm heaps resident at once, and on few slow cores the two Workers only
// contend. Low-end hardware is the primary target, so the default is
// sequential and overlap is opt-in on positive evidence only: a Chromium
// `deviceMemory` reading (absent on WebKit/Firefox → sequential), enough cores,
// and a link fast enough that the sync is not network-bound anyway.
//
// Pure: no globals, no I/O. `readBootSignals` is the one adapter over navigator.

export type BootMode = "sequential" | "overlap";

export interface BootDecision {
  readonly mode: BootMode;
  readonly reason: string;
}

/** The signals the policy reads; everything but the UA may be unavailable. */
export interface BootSignals {
  readonly userAgent: string;
  readonly platform?: string;
  readonly maxTouchPoints?: number;
  /** navigator.deviceMemory (GB, Chromium only; bucketed 0.25…8). */
  readonly deviceMemory?: number;
  readonly hardwareConcurrency?: number;
  readonly saveData?: boolean;
  /** navigator.connection.effectiveType: "slow-2g" | "2g" | "3g" | "4g". */
  readonly effectiveType?: string;
}

/** The subset of `navigator` read by `readBootSignals` (structural, so tests can fake it). */
export interface NavigatorSignals {
  readonly userAgent: string;
  readonly platform?: string;
  readonly maxTouchPoints?: number;
  readonly deviceMemory?: number;
  readonly hardwareConcurrency?: number;
  readonly connection?: { readonly saveData?: boolean; readonly effectiveType?: string };
}

/** Below this, a second wasm heap during the sync is not worth the risk. */
export const MIN_OVERLAP_DEVICE_MEMORY_GB = 4;
/** Below this, the sync Worker and the Pyodide Worker would share cores. */
export const MIN_OVERLAP_CORES = 4;

export function readBootSignals(nav: NavigatorSignals): BootSignals {
  return {
    userAgent: nav.userAgent,
    platform: nav.platform,
    maxTouchPoints: nav.maxTouchPoints,
    deviceMemory: nav.deviceMemory,
    hardwareConcurrency: nav.hardwareConcurrency,
    saveData: nav.connection?.saveData,
    effectiveType: nav.connection?.effectiveType,
  };
}

/** iPhone/iPad/iPod UAs, plus iPadOS "desktop mode" (Macintosh UA with touch). */
export function isIosWebKit(signals: BootSignals): boolean {
  if (/\b(iPhone|iPad|iPod)\b/.test(signals.userAgent)) return true;
  return signals.platform === "MacIntel" && (signals.maxTouchPoints ?? 0) > 1;
}

const sequential = (reason: string): BootDecision => ({ mode: "sequential", reason });

export function decideBootPolicy(signals: BootSignals): BootDecision {
  const { deviceMemory, hardwareConcurrency, effectiveType } = signals;
  if (isIosWebKit(signals)) {
    return sequential("iOS/iPadOS WebKit: memory-bound tab, no deviceMemory signal");
  }
  if (signals.saveData === true) return sequential("Save-Data requested");
  if (effectiveType !== undefined && effectiveType !== "4g") {
    return sequential(`${effectiveType} network: the sync is network-bound, overlap only lengthens the memory peak`);
  }
  if (deviceMemory === undefined) return sequential("no deviceMemory signal (non-Chromium)");
  if (deviceMemory < MIN_OVERLAP_DEVICE_MEMORY_GB) {
    return sequential(`${deviceMemory} GB < ${MIN_OVERLAP_DEVICE_MEMORY_GB} GB`);
  }
  if (hardwareConcurrency === undefined) return sequential("unknown number of cores");
  if (hardwareConcurrency < MIN_OVERLAP_CORES) {
    return sequential(`${hardwareConcurrency} cores < ${MIN_OVERLAP_CORES}`);
  }
  return {
    mode: "overlap",
    reason: `${deviceMemory} GB, ${hardwareConcurrency} cores, ${effectiveType ?? "unknown"} link`,
  };
}
