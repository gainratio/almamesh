// One device tier per tab, and what each tier may keep resident.
//
// WHY: three features used to decide "is this a weak device?" on their own (the
// Pyodide boot overlap, the force field's bloom, SQLite's page cache) and the
// heaviest optional feature (the chat embedder) did not ask at all. The tier now
// comes from ONE place: @gainratio/browser's `detectMemoryTier`, the same
// detector that sizes SQLite's page cache, so every feature agrees with SQLite.
// iOS is always "minimal"; unknown memory is "lite", never "full".
//
// This file is the only import site of the library's tier detector (the seam).

import {
  currentMemoryEnvironment,
  detectMemoryTier,
  type MemoryEnvironment,
  type MemoryTier,
} from "@gainratio/browser/sqlite";

export type DeviceTier = MemoryTier;
export type { MemoryEnvironment };

export interface DevicePolicy {
  readonly tier: DeviceTier;
  /** Terminate the chat embedder worker after this long with no embed in flight. */
  readonly embedderIdleReleaseMs: number;
  /** Force-field post-processing: full bloom + vignette, one soft bloom, or none. */
  readonly forceFieldEffects: "full" | "lite" | "none";
  /** Upper bound of the force-field canvas device-pixel ratio. */
  readonly forceFieldMaxDpr: number;
  /** May the Pyodide worker warm up while the bundle-sync worker is alive? */
  readonly bootOverlapAllowed: boolean;
}

export const DEVICE_POLICIES: Readonly<Record<DeviceTier, DevicePolicy>> = Object.freeze({
  minimal: Object.freeze({
    tier: "minimal",
    embedderIdleReleaseMs: 60_000,
    forceFieldEffects: "none",
    forceFieldMaxDpr: 1,
    bootOverlapAllowed: false,
  }),
  lite: Object.freeze({
    tier: "lite",
    embedderIdleReleaseMs: 120_000,
    forceFieldEffects: "lite",
    forceFieldMaxDpr: 1.5,
    bootOverlapAllowed: false,
  }),
  full: Object.freeze({
    tier: "full",
    embedderIdleReleaseMs: 600_000,
    forceFieldEffects: "full",
    forceFieldMaxDpr: 2,
    bootOverlapAllowed: true,
  }),
});

/** The tab's tier from the live navigator (or the given environment in tests). */
export function deviceTier(env: MemoryEnvironment = currentMemoryEnvironment()): DeviceTier {
  return detectMemoryTier(env);
}

/** What the given tier (default: this tab's) may keep resident. */
export function devicePolicy(tier: DeviceTier = deviceTier()): DevicePolicy {
  return DEVICE_POLICIES[tier];
}
