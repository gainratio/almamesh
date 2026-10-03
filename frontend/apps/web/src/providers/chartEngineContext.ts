/**
 * The chart-engine React context — split from `AlmaMeshRuntimeProvider` so
 * CONSUMERS (pages, hooks, tests) can read the booted engine without pulling
 * the runtime/sync value graph (`AlmaMeshRuntime` → `@edgeproc/browser`) into
 * their module graph. All `@almamesh/browser` imports here are TYPE-ONLY and
 * erased at build time; only the provider module touches the runtime values.
 */

import { createContext, useContext } from 'react'
import type { BootStage, BundleMeta, ChartEngine } from '@almamesh/browser'

/**
 * Byte-level boot progress is published at most this often (<= 4 updates/s).
 * The Workers report hundreds of times a second during the bundle sync; a
 * re-render per report starved typing on the onboarding form (2026-10-02).
 */
export const PROGRESS_COALESCE_MS = 250

export interface ChartEngineContextValue {
  /** The ready engine, or null until bootstrap completes. */
  readonly engine: ChartEngine | null
  /**
   * COARSE bootstrap stage: changes when the bootstrap enters a new stage
   * (syncing -> synced -> reassembling -> booting-engine -> ready), never on a
   * byte-level progress report. Progress bars read `useEngineBootProgress()`
   * instead, so a consumer of this context is not re-rendered per report.
   */
  readonly stage: BootStage | null
  /**
   * When the bootstrap last reported progress (`Date.now()` ms): a stage
   * change, bundle bytes arriving, a file verified, Pyodide bytes arriving.
   * Readiness waits are IDLE budgets measured from this, not wall clocks, so a
   * slow link that keeps moving is never declared stuck. 0 before any report.
   */
  readonly lastProgressAt?: () => number
  /** Bootstrap failure, if any (the shell stays alive regardless). */
  readonly error: Error | null
  /** Synced bundle provenance (from `almamesh_meta.json`), for the report footer. */
  readonly meta: BundleMeta | null
  /**
   * Reset state to `{ engine: null, error: null }` and run a FRESH bootstrap
   * (re-sync the signed bundle + re-boot Pyodide). Resolves with the ready
   * engine or rejects with the new failure. The recovery path for a fail-closed
   * bootstrap (stale/inconsistent bundle chunk, signature/sha256 mismatch).
   */
  reboot: () => Promise<ChartEngine>
  /**
   * Resolve when the CURRENT in-flight bootstrap finishes (or reject with its
   * error). Multiple awaiters share the one boot — calling this NEVER starts a
   * second bootstrap. The cure for the warming race: a consumer awaits readiness
   * instead of throwing when the user clicks before boot completes.
   */
  whenReady: () => Promise<ChartEngine>
  /**
   * Idempotently START the engine bootstrap (bundle sync + Pyodide boot) at most
   * once. Safe to call repeatedly — only the first call kicks off a boot; later
   * calls are no-ops. This is what gates the 38 MB download off the landing page:
   * the provider does NOT auto-boot on the landing route, and instead this is
   * called on the first sign of intent (CTA hover/focus/click via
   * `usePrewarmEngineOnIntent`) and on entry to any engine-dependent route
   * (e.g. onboarding). Distinct from `reboot()`, which always re-runs a FRESH
   * bootstrap for recovery.
   */
  startBootstrap: () => void
}

export const ChartEngineContext = createContext<ChartEngineContextValue | null>(null)

export function useChartEngine(): ChartEngineContextValue {
  const ctx = useContext(ChartEngineContext)
  if (ctx === null) {
    throw new Error('useChartEngine must be used within <AlmaMeshRuntimeProvider>')
  }
  return ctx
}

/**
 * Non-throwing variant for components that merely DEGRADE without the engine
 * (e.g. the lazy predictive layer shows an "engine warming" note). Returns
 * `null` when rendered outside the provider instead of crashing.
 */
export function useOptionalChartEngine(): ChartEngineContextValue | null {
  return useContext(ChartEngineContext)
}

/**
 * The latest bootstrap report INCLUDING byte-level progress (bundle bytes,
 * files verified, Pyodide bytes), coalesced to one update per
 * `PROGRESS_COALESCE_MS`. Kept on its own context so only the components that
 * draw progress re-render for it; everything else reads the coarse `stage`.
 */
export const EngineBootProgressContext = createContext<BootStage | null>(null)

/** Null before the first report and outside the provider (prerender, tests). */
export function useEngineBootProgress(): BootStage | null {
  return useContext(EngineBootProgressContext)
}
