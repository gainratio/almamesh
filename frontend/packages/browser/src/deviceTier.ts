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
  /** May chat load MiniLM and keep a semantic-vector SQLite Worker resident? */
  readonly semanticMemoryAllowed: boolean;
  /** Force-field post-processing: full bloom + vignette, one soft bloom, or none. */
  readonly forceFieldEffects: "full" | "lite" | "none";
  /** Upper bound of the force-field canvas device-pixel ratio. */
  readonly forceFieldMaxDpr: number;
  /** May the Pyodide worker warm up while the bundle-sync worker is alive? */
  readonly bootOverlapAllowed: boolean;
  /**
   * How many time-travel period computes stay in memory (apps/web periodSky.ts).
   * Other periods live in SQLite and are queried when revisited.
   */
  readonly periodSkyCacheSize: number;
  /**
   * May a dated question run the deterministic engine for that period's sky?
   * Day/place journeys are measured on minimal devices; SQLite keeps revisits
   * from retaining an in-memory cache of every computed period.
   */
  readonly periodSkyComputeAllowed: boolean;
}

export const DEVICE_POLICIES: Readonly<Record<DeviceTier, DevicePolicy>> = Object.freeze({
  minimal: Object.freeze({
    tier: "minimal",
    embedderIdleReleaseMs: 60_000,
    semanticMemoryAllowed: false,
    forceFieldEffects: "none",
    forceFieldMaxDpr: 1,
    bootOverlapAllowed: false,
    periodSkyCacheSize: 1,
    periodSkyComputeAllowed: true,
  }),
  lite: Object.freeze({
    tier: "lite",
    embedderIdleReleaseMs: 120_000,
    semanticMemoryAllowed: false,
    forceFieldEffects: "lite",
    forceFieldMaxDpr: 1.5,
    bootOverlapAllowed: false,
    periodSkyCacheSize: 1,
    periodSkyComputeAllowed: true,
  }),
  full: Object.freeze({
    tier: "full",
    embedderIdleReleaseMs: 600_000,
    semanticMemoryAllowed: true,
    forceFieldEffects: "full",
    forceFieldMaxDpr: 2,
    bootOverlapAllowed: true,
    periodSkyCacheSize: 1,
    periodSkyComputeAllowed: true,
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
