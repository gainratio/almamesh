export declare const ASSET_MANIFEST_FILE: 'assets-manifest.json'
export declare const ASSET_MANIFEST_SCHEMA: 1
export declare const MAX_CARRIED_RELEASES: number
export declare const MAX_CARRIED_BYTES: number
export declare const DEFAULT_MAX_FILES: number
export declare const DEFAULT_MAX_FILE_BYTES: number

export interface AssetEntry {
  readonly path: string
  readonly bytes: number
  readonly sha256: string
}

export interface AssetRelease {
  readonly id: string
  readonly assets: readonly AssetEntry[]
}

export interface AssetManifest {
  readonly schema: 1
  readonly releases: readonly AssetRelease[]
}

export interface CarryLimits {
  readonly maxReleases?: number
  readonly maxCarriedBytes?: number
  readonly maxFiles?: number
  readonly maxFileBytes?: number
}

export interface CarryPlan {
  readonly carry: readonly AssetEntry[]
  readonly carriedBytes: number
  /** Paths a previous release had with other bytes than the new build (the new file wins). */
  readonly conflicts: readonly string[]
  /** Releases over the bound, not carried. */
  readonly dropped: readonly string[]
  readonly manifest: AssetManifest
}

export interface CarrySummary {
  readonly previousManifest: boolean
  readonly ownFiles: number
  readonly carriedFiles: number
  readonly carriedBytes: number
  readonly carriedReleases: readonly string[]
  readonly conflicts: readonly string[]
  readonly dropped: readonly string[]
}

export function parseAssetManifest(value: unknown, maxFileBytes?: number): AssetManifest

export function planCarryForward(input: {
  readonly own: AssetRelease
  readonly previous: AssetManifest | null
  readonly uploadFiles: number
  readonly limits?: CarryLimits
}): CarryPlan

export function missingAssetFallbackProblems(input: {
  readonly hasTopLevel404: boolean
  readonly redirects: string
}): string[]

export function readOwnRelease(distDir: string): AssetRelease

export function carryForwardAssets(input: {
  readonly distDir: string
  readonly previousOrigin: string | null
  readonly fetch?: (input: URL, init?: RequestInit) => Promise<Response>
  readonly limits?: CarryLimits
}): Promise<CarrySummary>
