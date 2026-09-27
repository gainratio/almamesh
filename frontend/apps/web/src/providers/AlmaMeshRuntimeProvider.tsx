/**
 * Owns the single in-browser AlmaMesh engine for the whole app.
 *
 * On mount it bootstraps one `AlmaMeshRuntime` (sync the signed bundle into
 * OPFS, boot Pyodide, expose a chart engine) and publishes `{ engine, stage,
 * error, meta }` through context. Bootstrap is idempotent; failures are surfaced
 * as `error` rather than crashing the app shell, so the rest of the UI still
 * renders while the engine warms up (or while a retry is offered).
 *
 * Bootstrap is RETRYABLE. The underlying `AlmaMeshRuntime.bootstrap()` already
 * nulls its cached promise on failure so it can re-run a fresh sync + boot; this
 * provider exposes that as:
 *   - `whenReady()` — await the CURRENT in-flight bootstrap (shared; no extra boot).
 *     Cures the "Connection Issue" warming race: a consumer awaits readiness
 *     instead of throwing when the user clicks Generate before boot completes.
 *   - `reboot()`    — reset state + run a FRESH bootstrap. Recovers a fail-closed
 *     boot (stale/inconsistent bundle chunk, signature/sha256 mismatch) in-app,
 *     with no manual reload.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AlmaMeshRuntime, WorkerCrashError, WorkerTimeoutError } from '@almamesh/browser'
import type { BootStage, BundleMeta, ChartEngine, OnStage, RuntimeConfig } from '@almamesh/browser'
import { ChartEngineContext } from './chartEngineContext'
import { hasLocalChart } from '../lib/localChart'
import { recordEngineBootFailure, registerEngineTeardown } from '../lib/engineLifecycle'
import { recoverSeveredServiceWorkerChannel } from '../lib/swSelfHeal'
import {
  clearRuntimeError,
  clearRuntimeGenerator,
  publishRuntimeError,
  publishRuntimeGenerator,
  publishRuntimeStage,
} from '../lib/runtimeObservability'

// The context + hooks live in `./chartEngineContext` (type-only imports) so
// consumers never pull the runtime/sync graph; re-exported here so existing
// `import { useChartEngine } from './AlmaMeshRuntimeProvider'` sites keep working.
export {
  useChartEngine,
  useOptionalChartEngine,
  type ChartEngineContextValue,
} from './chartEngineContext'

// Canonical bundle layout emitted by the `almamesh-bundle` publisher. Order is
// install order: leaf wheels first, the almamesh wheel last.
const WHEEL_PATHS = [
  'wheels/jplephem-2.23-py3-none-any.whl',
  'wheels/sgp4-2.25-py3-none-any.whl',
  'wheels/skyfield-1.53-py3-none-any.whl',
  // NO avow / rfc8785 wheels. Strength receipts are signed in TypeScript by
  // `@edgeproc/avow` (see packages/browser/src/pyodide/strengthReceipt.ts), so
  // the Python engine is crypto-free and the signed bundle no longer carries
  // that wheel chain. This list must stay byte-identical to the publisher's
  // vendored-wheel set (backend/tests/test_edge_offline_bundle.py) — a path
  // here that the manifest does not contain fails the whole boot with
  // "file <path> not in manifest", which surfaces as CHART_GEN_001.
  'wheels/almamesh-0.1.0-py3-none-any.whl',
] as const

const SKYFIELD_DATA_PATHS = [
  'skyfield-data/de421.bsp',
  'skyfield-data/finals2000A.all',
] as const

/** Build the RuntimeConfig from Vite env, with same-origin dev defaults. */
export function readRuntimeConfig(): RuntimeConfig {
  return {
    bundleBaseUrl: import.meta.env.VITE_BUNDLE_BASE_URL ?? '/bundle',
    expectedBundleId: 'almamesh-constructs',
    expectedChannel: 'stable',
    // ROOT-absolute on purpose, matching '/bundle' + '/pyodide/' and the SW
    // NetworkFirst rule (`url.pathname === '/public.key'`). Resolving against
    // document.baseURI broke deep links: a hard load of /rectify/<id> requested
    // /rectify/public.key, the SPA fallback answered with index.html, and
    // ed25519 signature verification failed closed on every nested route.
    pubkeyUrl: new URL('/public.key', globalThis.location.origin).toString(),
    pyodideIndexUrl: '/pyodide/',
    wheelPaths: [...WHEEL_PATHS],
    skyfieldDataPaths: [...SKYFIELD_DATA_PATHS],
  }
}

/**
 * Drop the MUTABLE runtime caches that can fail-close a boot: the verify key
 * (`almamesh-pubkey`) and the update pointer (`almamesh-signals`). A stale key
 * here — e.g. a dev-signed key pinned by the old CacheFirst strategy — makes the
 * current prod-signed bundle fail ed25519 verification ("signature verification
 * failed"). Clearing it forces the next boot to re-fetch the CURRENT server key.
 * Immutable, content-addressed caches (pyodide/bundle chunks) are intentionally
 * left intact to avoid a needless ~38 MB re-download. Best-effort + guarded so
 * recovery never hard-fails (CacheStorage is absent in some test/SSR contexts).
 */
export async function clearStaleEngineCaches(): Promise<void> {
  try {
    if (typeof caches === 'undefined') return
    const names = await caches.keys()
    await Promise.all(names
      .filter((name) => name === 'almamesh-signals' || name.startsWith('almamesh-pubkey'))
      .map((name) => caches.delete(name)))
  } catch {
    // ignore — recovery must never fail on cache cleanup
  }
}

// Observability/test hooks are installed only in dev, or in a build explicitly
// opted in via VITE_EXIT_GATE_HOOKS=1 (the P3 exit-gate verification build).
// They are NEVER present in a normal production build.
const EXIT_GATE_HOOKS =
  import.meta.env.DEV || import.meta.env.VITE_EXIT_GATE_HOOKS === '1'

if (typeof window !== 'undefined' && EXIT_GATE_HOOKS) {
  const forceIndexedDb = new URL(window.location.href).searchParams.has(
    'force-indexeddb-engine-cache',
  )
  ;(
    globalThis as typeof globalThis & {
      __EDGEPROC_FORCE_INDEXEDDB_CACHE__?: boolean
    }
  ).__EDGEPROC_FORCE_INDEXEDDB_CACHE__ = forceIndexedDb
  window.__almameshVerifySqliteMemory = async () =>
    (await import('../lib/chatMemory')).verifySqliteMemoryPersistence()
}

/**
 * The minimal runtime surface the provider drives. `AlmaMeshRuntime` satisfies
 * it; tests inject a fake so the retry orchestration can be exercised without
 * Pyodide/OPFS Workers.
 */
export interface BootstrapRuntime {
  bootstrap(config: RuntimeConfig, onStage?: OnStage): Promise<ChartEngine>
  dispose?(): Promise<void> | void
}

const TRANSIENT_BOOT_FAILURE = /network unreachable|failed to fetch|load failed|networkerror|timed out after|importing a module script failed/i
const REPORTED_ONLINE_RETRY_DELAYS_MS = [250, 1_000, 5_000, 15_000] as const

function isTransientBootFailure(error: Error): boolean {
  return isTransientLocalWorkerFailure(error) || TRANSIENT_BOOT_FAILURE.test(error.message)
}

function isTransientLocalWorkerFailure(error: Error): boolean {
  return error instanceof WorkerCrashError || error instanceof WorkerTimeoutError
}

interface ProviderProps {
  children: ReactNode
  /** Injectable for tests; defaults to a real `AlmaMeshRuntime`. */
  runtime?: BootstrapRuntime
}

export function AlmaMeshRuntimeProvider({ children, runtime }: ProviderProps) {
  // One runtime instance for the provider's lifetime. `AlmaMeshRuntime.bootstrap`
  // re-runs a fresh sync + boot after a failure, so we can reuse this instance
  // for reboot()s rather than building a new one each time.
  const runtimeRef = useRef<BootstrapRuntime | null>(runtime ?? null)
  if (runtimeRef.current === null) {
    runtimeRef.current = new AlmaMeshRuntime()
  }

  const [engine, setEngine] = useState<ChartEngine | null>(null)
  const [stage, setStage] = useState<BootStage | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [meta, setMeta] = useState<BundleMeta | null>(null)
  const [onlineEpoch, setOnlineEpoch] = useState(0)

  // The CURRENT in-flight (or last) bootstrap promise, shared by every awaiter
  // of whenReady(). A ref (not state) so stable callbacks always see the latest.
  const inFlightRef = useRef<Promise<ChartEngine> | null>(null)
  const startedRef = useRef(false)
  const bootstrapFailedRef = useRef(false)
  const retryableFailureRef = useRef(false)
  const retryWithoutConnectivityRef = useRef(false)
  const consumedOnlineEpochRef = useRef(0)
  const reportedOnlineRetryCountRef = useRef(0)

  const onStage = useCallback<OnStage>((next) => {
    setStage(next)
    // Dev-only observability hook: expose the latest boot stage on window so a
    // Playwright harness can poll readiness without UI scraping.
    if (EXIT_GATE_HOOKS) {
      publishRuntimeStage(next.kind)
    }
  }, [])

  // Run (or re-run) the bootstrap, wiring engine/meta/error and sharing the
  // promise via the ref. Returns the promise so callers can await readiness.
  const runBootstrap = useCallback((): Promise<ChartEngine> => {
    const runtimeInstance = runtimeRef.current
    if (runtimeInstance === null) {
      return Promise.reject(new Error('AlmaMesh runtime unavailable'))
    }
    if (EXIT_GATE_HOOKS) {
      clearRuntimeGenerator()
    }
    bootstrapFailedRef.current = false
    retryableFailureRef.current = false
    retryWithoutConnectivityRef.current = false
    let promise: Promise<ChartEngine>
    promise = runtimeInstance
      .bootstrap(readRuntimeConfig(), onStage)
      .then((ready) => {
        if (inFlightRef.current !== promise) {
          return ready
        }
        bootstrapFailedRef.current = false
        retryableFailureRef.current = false
        retryWithoutConnectivityRef.current = false
        reportedOnlineRetryCountRef.current = 0
        setEngine(ready)
        setMeta(ready.meta())
        setError(null)
        recordEngineBootFailure(null)
        // Dev-only test hook: drive the booted engine directly, bypassing the
        // geocode-dependent onboarding UI. Returns the raw SiderealChart.
        if (EXIT_GATE_HOOKS) {
          clearRuntimeError()
          publishRuntimeGenerator((birth) => ready.generateChart(birth))
        }
        return ready
      })
      .catch((err: unknown) => {
        const e = err instanceof Error ? err : new Error(String(err))
        // Release only THIS failed attempt. The runtime already discarded its
        // failed workers and bootstrap promise; keeping the provider's rejected
        // promise latched made every later whenReady()/online recovery return
        // the same failure forever.
        if (inFlightRef.current === promise) {
          inFlightRef.current = null
          startedRef.current = false
          bootstrapFailedRef.current = true
          retryableFailureRef.current = isTransientBootFailure(e)
          retryWithoutConnectivityRef.current = isTransientLocalWorkerFailure(e)
          // A WebKit network-process restart severs this document from its
          // service worker; retries here can never succeed, a reload can.
          if (retryableFailureRef.current) void recoverSeveredServiceWorkerChannel()
          setError(e)
          // Recorded (never acted on) so the global ErrorBoundary can guard its
          // reset behind the rollback warning. Integrity/rollback failures are
          // not retried and nothing clears the cache automatically.
          recordEngineBootFailure(e)
          if (EXIT_GATE_HOOKS) {
            clearRuntimeGenerator()
            publishRuntimeError(e.message)
          }
        }
        throw e
      })
    inFlightRef.current = promise
    return promise
  }, [onStage])

  // Idempotently kick off the bootstrap AT MOST ONCE. Guarded by a ref so the
  // landing CTA's prewarm-on-intent (pointerenter/focus/click, which can all
  // fire) and the engine-route entry effect can all call it freely without
  // launching a second bundle sync. The rejection is swallowed here for the same
  // reason as the mount boot: it is published via `error` and recovered through
  // whenReady()/reboot(); an unhandled rejection would noise the console.
  const startBootstrap = useCallback((): void => {
    if (startedRef.current) {
      return
    }
    startedRef.current = true
    runBootstrap().catch(() => {})
  }, [runBootstrap])

  // Await the current in-flight bootstrap; if none is tracked yet, start one.
  const whenReady = useCallback((): Promise<ChartEngine> => {
    if (inFlightRef.current !== null) {
      return inFlightRef.current
    }
    // Keep the scheduled-retry guard coherent when a consumer initiates the
    // recovery first. Otherwise the timer can launch a concurrent worker boot.
    startedRef.current = true
    return runBootstrap()
  }, [runBootstrap])

  // Reset to a clean pre-boot state and run a FRESH bootstrap.
  const reboot = useCallback((): Promise<ChartEngine> => {
    // A reboot is an explicit boot — keep the idempotency guard coherent so a
    // later prewarm-on-intent doesn't fire a redundant second sync.
    startedRef.current = true
    setEngine(null)
    setError(null)
    setStage(null)
    reportedOnlineRetryCountRef.current = 0
    retryWithoutConnectivityRef.current = false
    // Drop the stale verify key / update pointer first: a CacheFirst-pinned dev
    // key is the classic cause of a fail-closed "signature verification failed",
    // and a plain reboot would just re-read the same stale key. Best-effort.
    return clearStaleEngineCaches().then(() => runBootstrap())
  }, [runBootstrap])

  // Initial mount bootstrap — auto-run once, EXCEPT on the marketing landing
  // route. A fresh visitor sitting on `/` (no saved chart) only reads the pitch;
  // they must NOT pay the ~38 MB engine download. Every other case (direct
  // /onboarding, /dashboard, a returning visitor with a chart redirected to
  // /dashboard, etc.) boots on mount exactly as before. The provider sits ABOVE
  // the router (see main.tsx), so we read the initial path from window.location.
  // Intent on the landing CTA (and entry to engine routes) calls startBootstrap.
  useEffect(() => {
    if (window.location.pathname === '/' && !hasLocalChart()) return
    startBootstrap()
  }, [startBootstrap])

  // Count browser `online` transitions even while bootstrap is still pending.
  // The failure may arrive after connectivity returned; retaining the epoch
  // prevents that event from being missed without spawning a parallel worker.
  useEffect(() => {
    const recordOnline = () => setOnlineEpoch((epoch) => epoch + 1)
    window.addEventListener('online', recordOnline)
    return () => window.removeEventListener('online', recordOnline)
  }, [])

  // Consume at most one retry for each connectivity transition. Browsers can
  // also keep `navigator.onLine === true` during a partial origin outage (or a
  // just-restored service-worker route), so keep a short bounded backoff window
  // without depending on an event. Attempts remain sequential; success,
  // unmount, or a real online transition cancels/accelerates the next timer.
  // Integrity/signature failures always remain fail-closed.
  useEffect(() => {
    if (!bootstrapFailedRef.current || !retryableFailureRef.current) return
    const hasOnlineTransition = onlineEpoch > consumedOnlineEpochRef.current
    if (hasOnlineTransition) {
      consumedOnlineEpochRef.current = onlineEpoch
      reportedOnlineRetryCountRef.current = 0
      startBootstrap()
      return
    }
    const retryIndex = reportedOnlineRetryCountRef.current
    if (
      (!navigator.onLine && !retryWithoutConnectivityRef.current) ||
      retryIndex >= REPORTED_ONLINE_RETRY_DELAYS_MS.length
    ) return
    reportedOnlineRetryCountRef.current += 1
    const timer = window.setTimeout(startBootstrap, REPORTED_ONLINE_RETRY_DELAYS_MS[retryIndex])
    return () => window.clearTimeout(timer)
  }, [error, onlineEpoch, startBootstrap])

  // An explicit user reset tears the live Workers down first, so the sync
  // Worker releases its Web Lock + OPFS/IndexedDB handles before the clear.
  useEffect(() => registerEngineTeardown(() => runtimeRef.current?.dispose?.()), [])

  // Workers and Pyodide hold substantial resources outside React's tree. Stop
  // them on unmount, and reset the refs so a StrictMode remount can boot again.
  useEffect(() => () => {
    startedRef.current = false
    bootstrapFailedRef.current = false
    retryableFailureRef.current = false
    retryWithoutConnectivityRef.current = false
    consumedOnlineEpochRef.current = 0
    reportedOnlineRetryCountRef.current = 0
    inFlightRef.current = null
    void runtimeRef.current?.dispose?.()
  }, [])

  const value = useMemo(
    () => ({ engine, stage, error, meta, reboot, whenReady, startBootstrap }),
    [engine, stage, error, meta, reboot, whenReady, startBootstrap],
  )

  return <ChartEngineContext.Provider value={value}>{children}</ChartEngineContext.Provider>
}
