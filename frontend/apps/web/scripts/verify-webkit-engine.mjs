#!/usr/bin/env node
/**
 * Required WebKit runtime gate. It boots the production bundle at iPhone 13
 * size, generates a real chart, then reloads while every /bundle request is
 * blocked. The second boot can only succeed from the durable local cache.
 *
 * Vite preview applies the production CSP and COOP/COEP headers. The gate checks
 * cross-origin isolation before both the online boot and offline reload so the
 * service-worker path cannot silently lose SharedArrayBuffer-backed OPFS.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { devices, webkit } from '@playwright/test'

const BASE_URL = process.argv[2] ?? 'http://localhost:4200'
const FIRST_SESSION_ONLY = process.argv.includes('--first-session')
const TRANSIENT_CACHE_VISIBILITY = process.argv.includes('--transient-cache-visibility')
const CACHE_DATABASE = 'edgeproc-browser-cache'
const FALLBACK_PARAMETER = 'force-indexeddb-engine-cache'
const TRANSIENT_CACHE_VISIBILITY_HASH = '#transient-cache-visibility'
const TRANSIENT_CACHE_INJECTED_KEY = 'almamesh:exit-gate:transient-cache-visibility:injected'
const PRERENDERED_SHELLS = new Set(['/welcome', '/privacy', '/terms', '/data-deletion'])
const BIRTH = {
  datetimeUtc: '1990-01-15T12:00:00.000Z',
  latitude: 28.6139,
  longitude: 77.209,
  referenceDate: '2025-01-01T00:00:00+00:00',
}

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}

async function assertBrowserIsolation(page, label) {
  const evidence = await page.evaluate(() => ({
    isolated: globalThis.crossOriginIsolated,
    sharedArrayBuffer: typeof globalThis.SharedArrayBuffer === 'function',
    waitAsync: typeof Atomics.waitAsync === 'function',
  }))
  invariant(
    evidence.isolated && evidence.sharedArrayBuffer && evidence.waitAsync,
    `${label} lacks the cross-origin-isolated SQLite runtime: ${JSON.stringify(evidence)}`,
  )
  return evidence
}

async function bounded(promise, milliseconds, label) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function openEngineRoute(page) {
  await page.waitForFunction(() => document.querySelector('#root')?.childElementCount > 0, undefined, {
    timeout: 10_000,
  })
  await page.evaluate(() => {
    window.history.pushState({}, '', `/onboarding${window.location.search}`)
    window.dispatchEvent(new window.PopStateEvent('popstate'))
  })
}

async function waitForActiveServiceWorker(page) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const state = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration()
      return registration?.active?.state ?? null
    })
    if (state === 'activated') return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  const evidence = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration()
    return {
      active: registration?.active?.state ?? null,
      cacheNames: await caches.keys(),
      controller: navigator.serviceWorker.controller?.scriptURL ?? null,
      installing: registration?.installing?.state ?? null,
      waiting: registration?.waiting?.state ?? null,
    }
  })
  throw new Error(`first-session service worker did not activate: ${JSON.stringify(evidence)}`)
}

async function waitForEngine(page) {
  await page.waitForFunction(
    () =>
      window.__ALMAMESH_STAGE__ === 'ready' ||
      typeof window.__ALMAMESH_ERROR__ === 'string',
    undefined,
    { timeout: 300_000 },
  )
  return page.evaluate(() => ({
    stage: window.__ALMAMESH_STAGE__ ?? null,
    error: window.__ALMAMESH_ERROR__ ?? null,
    hasGenerator: typeof window.__almameshGenerate === 'function',
  }))
}

// The provider's own classification of a retryable boot failure
// (AlmaMeshRuntimeProvider TRANSIENT_BOOT_FAILURE plus the worker crash/timeout
// classes). Anything else, such as an integrity failure, is terminal.
const SELF_RECOVERING_BOOT_FAILURE =
  /network unreachable|failed to fetch|load failed|networkerror|timed out after|importing a module script failed|worker crashed/i
const MAX_SELF_RECOVERIES_PER_BOOT = 1

/**
 * Wait for a boot to reach a TERMINAL state. A published transient error is not
 * terminal: the provider retries it on its own, with no reload or user action.
 * WebKit can leave a boot fetch with headers but no body after its network
 * process restarts, so the chart-worker boot times out after 60s and the retry
 * spawns a fresh worker that boots. The gate allows exactly one such automatic
 * recovery and records it. A second one, or any non-transient error, fails.
 * Every bootstrap attempt spawns exactly one sync Worker, so attempts are
 * counted from Worker spawns (the published error text repeats verbatim).
 */
function trackBootAttempts(page) {
  let attempts = 0
  const countAttempt = (worker) => {
    if (/\/edgeproc\.worker-[^/]+\.js(?:\?|$)/.test(worker.url())) attempts += 1
  }
  page.on('worker', countAttempt)
  return {
    attempts: () => attempts,
    stop: () => page.off('worker', countAttempt),
  }
}

/** Start counting BEFORE the boot is triggered, then call with the tracker. */
async function waitForSettledEngine(page, label, tracker) {
  let evidence = '{}'
  try {
    const deadline = Date.now() + 300_000
    while (Date.now() < deadline) {
      const state = await page.evaluate(() => ({
        stage: window.__ALMAMESH_STAGE__ ?? null,
        error: window.__ALMAMESH_ERROR__ ?? null,
        hasGenerator: typeof window.__almameshGenerate === 'function',
      }))
      const attempts = tracker.attempts()
      const selfRecoveries = Math.max(0, attempts - 1)
      evidence = JSON.stringify({ ...state, attempts })
      invariant(selfRecoveries <= MAX_SELF_RECOVERIES_PER_BOOT, `${label} needed more than one automatic recovery: ${evidence}`)
      if (state.stage === 'ready' && state.hasGenerator) return { ...state, selfRecoveries }
      if (typeof state.error === 'string') {
        invariant(SELF_RECOVERING_BOOT_FAILURE.test(state.error), `${label} failed: ${evidence}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    throw new Error(`${label} did not settle within 300000ms: ${evidence}`)
  } finally {
    tracker.stop()
  }
}

async function runtimeEvidence(page) {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration()
    const cacheNames = await caches.keys()
    const trustCaches = []
    for (const name of cacheNames.filter((entry) => entry.startsWith('almamesh-pubkey-'))) {
      const response = await (await caches.open(name)).match('/public.key')
      trustCaches.push({
        name,
        status: response?.status ?? null,
        bytes: response ? (await response.arrayBuffer()).byteLength : null,
      })
    }
    return {
      stage: window.__ALMAMESH_STAGE__ ?? null,
      error: window.__ALMAMESH_ERROR__ ?? null,
      hasGenerator: typeof window.__almameshGenerate === 'function',
      controller: navigator.serviceWorker.controller?.scriptURL ?? null,
      activeWorker: registration?.active?.state ?? null,
      cacheNames,
      healAttempted: window.sessionStorage.getItem('almamesh:sw-precache-heal') === '1',
      transientCacheReadInjected: window.sessionStorage.getItem('almamesh:exit-gate:transient-cache-visibility:injected') === '1',
      trustCaches,
      databases: (await indexedDB.databases()).flatMap((database) =>
        database.name ? [database.name] : [],
      ),
    }
  })
}

async function waitForRecoveredEngine(page, label, externalEvidence = () => ({})) {
  try {
    await page.waitForFunction(
      () =>
        window.__ALMAMESH_STAGE__ === 'ready' &&
        typeof window.__almameshGenerate === 'function',
      undefined,
      { timeout: 120_000 },
    )
  } catch (error) {
    const evidence = await runtimeEvidence(page).catch((diagnosticError) => ({
      diagnosticError: diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError),
    }))
    throw new Error(`${label} failed: ${JSON.stringify({ ...evidence, ...externalEvidence() })}`, {
      cause: error,
    })
  }
  return waitForEngine(page)
}

async function generateReferenceChart(page) {
  return page.evaluate(async (birth) => {
    const chart = await window.__almameshGenerate(birth)
    return {
      lagna: chart?.lagna?.sign?.toLowerCase() ?? null,
      sun: chart?.planets?.sun?.sign?.toLowerCase() ?? null,
      moon: chart?.planets?.moon?.sign?.toLowerCase() ?? null,
    }
  }, BIRTH)
}

function assertSingleSyncWorker(workerUrls, label) {
  const syncWorkerAssets = [...workerUrls].filter((url) =>
    /\/edgeproc\.worker-[^/]+\.js(?:\?|$)/.test(url),
  )
  invariant(
    syncWorkerAssets.length === 1,
    `${label} did not load exactly one consumer-owned edgeproc Worker asset: ${JSON.stringify(syncWorkerAssets)}`,
  )
  return syncWorkerAssets
}

async function storageEvidence(page) {
  return page.evaluate(async () => {
    const databases = (await indexedDB.databases()).flatMap((database) =>
      database.name ? [database.name] : [],
    )
    try {
      if (new URL(window.location.href).searchParams.has('force-indexeddb-engine-cache')) {
        return {
          selectedCache: window.__EDGEPROC_SELECTED_CACHE__ ?? null,
          opfs: 'forced-unavailable',
          databases,
        }
      }
      await navigator.storage?.getDirectory()
      return {
        selectedCache: window.__EDGEPROC_SELECTED_CACHE__ ?? null,
        opfs: navigator.storage ? 'available' : 'unavailable',
        databases,
      }
    } catch (error) {
      return {
        selectedCache: window.__EDGEPROC_SELECTED_CACHE__ ?? null,
        opfs: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        databases,
      }
    }
  })
}

async function startCutoffProxy(upstreamUrl) {
  const upstream = new URL(upstreamUrl)
  const state = {
    blocked: false,
    keyOverride: null,
    requests: [],
    rejected: [],
  }
  const server = createServer((req, res) => {
    const target = new URL(req.url ?? '/', upstream)
    if (PRERENDERED_SHELLS.has(target.pathname)) target.pathname += '.html'
    state.requests.push(target.pathname)
    if (state.blocked) {
      state.rejected.push(target.pathname)
      req.socket.destroy()
      return
    }
    if (target.pathname === '/public.key' && state.keyOverride !== null) {
      res.writeHead(200, {
        'cache-control': 'no-store',
        'content-length': state.keyOverride.byteLength,
        'content-type': 'application/octet-stream',
      })
      res.end(state.keyOverride)
      return
    }
    const forwarded = httpRequest(target, {
      headers: { ...req.headers, host: upstream.host },
      method: req.method,
    }, (upstreamResponse) => {
      res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
      upstreamResponse.pipe(res)
    })
    forwarded.on('error', () => req.socket.destroy())
    req.pipe(forwarded)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  invariant(address && typeof address === 'object', 'cutoff proxy did not bind')
  return {
    // WebKit's Service Worker implementation treats the localhost hostname as
    // a trustworthy development origin more consistently than a numeric loopback.
    origin: `http://localhost:${address.port}`,
    state,
    close: () => {
      server.closeAllConnections?.()
      server.close()
    },
  }
}

// The first-session offline claim is about DURABLE storage, so the profile must
// be on disk like a real Safari/iOS profile. A default browser.newContext() is
// an ephemeral WebsiteDataStore: its service-worker registrations, CacheStorage,
// IndexedDB, OPFS and sessionStorage live only in the WebKit network process.
// When that process restarts mid-run (CI memory pressure; iOS does it routinely),
// the ephemeral store is wiped and the offline reload fails with an empty
// origin: controller still set, no active registration, zero caches/databases.
// A persistent profile survives the restart, so the gate measures the app, not
// the harness's in-memory storage.
async function launchDurableProfile() {
  const userDataDir = await mkdtemp(join(tmpdir(), 'almamesh-webkit-first-session-'))
  const context = await webkit.launchPersistentContext(userDataDir, {
    ...devices['iPhone 13'],
    headless: true,
    serviceWorkers: 'allow',
  })
  return {
    context,
    close: async () => {
      await context.close()
      await rm(userDataDir, { recursive: true, force: true })
    },
  }
}

async function verifyFirstSessionOffline() {
  const profile = await launchDurableProfile()
  const { context } = profile
  const proxy = await startCutoffProxy(BASE_URL)
  let transientCacheReadInjected = false
  const workerUrls = new Set()
  if (TRANSIENT_CACHE_VISIBILITY) {
    await context.exposeBinding('__almameshRecordTransientCacheRead', () => {
      transientCacheReadInjected = true
    })
    await context.addInitScript(({ hash, injectedKey }) => {
      try {
        if (window.location.hash !== hash) return
        window.sessionStorage.setItem(`${injectedKey}:armed`, '1')
        const cacheStoragePrototype = Object.getPrototypeOf(caches)
        const realKeys = cacheStoragePrototype.keys
        let hideOnce = true
        Object.defineProperty(cacheStoragePrototype, 'keys', {
          configurable: true,
          value: async () => {
            if (!hideOnce) return realKeys.call(caches)
            hideOnce = false
            window.sessionStorage.setItem(injectedKey, '1')
            void globalThis.__almameshRecordTransientCacheRead?.()
            return []
          },
        })
      } catch {
        // about:blank has an opaque origin; the script runs again for the app.
      }
    }, {
      hash: TRANSIENT_CACHE_VISIBILITY_HASH,
      injectedKey: TRANSIENT_CACHE_INJECTED_KEY,
    })
  }
  try {
    let page = await context.newPage()
    page.on('worker', (worker) => workerUrls.add(worker.url()))
    const url = new URL(proxy.origin)
    await bounded(
      page.goto(url.href, { waitUntil: 'domcontentloaded' }),
      60_000,
      'first-session navigation',
    )
    const coldIsolation = await assertBrowserIsolation(page, 'WebKit first-session navigation')
    const uncontrolled = await page.evaluate(() => navigator.serviceWorker.controller === null)
    invariant(uncontrolled, 'first-session proof was vacuous: the initial document was already controlled')
    await waitForActiveServiceWorker(page)
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {
      timeout: 10_000,
    }).catch(async (error) => {
      const evidence = await page.evaluate(async () => {
        const registration = await navigator.serviceWorker.getRegistration()
        return {
          active: registration?.active?.state ?? null,
          activeUrl: registration?.active?.scriptURL ?? null,
          cacheNames: await caches.keys(),
          controller: navigator.serviceWorker.controller?.scriptURL ?? null,
          scope: registration?.scope ?? null,
          waiting: registration?.waiting?.state ?? null,
        }
      })
      throw new Error(`first worker did not claim its page: ${JSON.stringify(evidence)}`, { cause: error })
    })

    await openEngineRoute(page)
    const cold = await waitForRecoveredEngine(page, 'first-session cold boot')
    const syncWorkerAssets = assertSingleSyncWorker(workerUrls, 'WebKit first-session boot')
    const coldChart = await generateReferenceChart(page)
    invariant(coldChart.lagna === 'gemini', `unexpected first-session chart: ${JSON.stringify(coldChart)}`)

    const trustRootBeforeCutoff = await runtimeEvidence(page)
    invariant(
      trustRootBeforeCutoff.trustCaches.some((cache) => cache.bytes === 32 && cache.status === 200),
      `first-session trust root was not durably cached: ${JSON.stringify(trustRootBeforeCutoff)}`,
    )

    const firstTimeOrigin = await page.evaluate(() => performance.timeOrigin)
    if (TRANSIENT_CACHE_VISIBILITY) {
      await page.evaluate((hash) => {
        const nextUrl = new URL(window.location.href)
        nextUrl.hash = hash
        window.history.replaceState(window.history.state, '', nextUrl)
      }, TRANSIENT_CACHE_VISIBILITY_HASH)
    }
    proxy.state.blocked = true
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 120_000 }).catch(async (error) => {
      await new Promise((resolve) => setTimeout(resolve, 0))
      if (!transientCacheReadInjected) throw error
      throw new Error(`first-session offline reload failed after injected transient CacheStorage read: ${JSON.stringify({
        rejectedTransportPaths: proxy.state.rejected,
        requestedTransportPaths: proxy.state.requests,
      })}`, { cause: error })
    })
    const secondTimeOrigin = await page.evaluate(() => performance.timeOrigin)
    invariant(secondTimeOrigin !== firstTimeOrigin, 'offline reload did not create a new document')
    const offlineIsolation = await assertBrowserIsolation(page, 'WebKit service-worker offline reload')
    const controlled = await page.evaluate(() => navigator.serviceWorker.controller !== null)
    invariant(controlled, 'offline reload was not controlled by the installed service worker')
    if (TRANSIENT_CACHE_VISIBILITY) {
      await page.waitForFunction(
        (key) => window.sessionStorage.getItem(key) === '1',
        TRANSIENT_CACHE_INJECTED_KEY,
        { timeout: 10_000 },
      ).catch(async (error) => {
        const evidence = await runtimeEvidence(page)
        throw new Error(`transient CacheStorage visibility fault was not injected: ${JSON.stringify(evidence)}`, {
          cause: error,
        })
      })
    }
    const offline = await waitForRecoveredEngine(page, 'first-session offline reload', () => ({
      rejectedTransportPaths: proxy.state.rejected,
      requestedTransportPaths: proxy.state.requests,
    }))
    const offlineRuntime = await runtimeEvidence(page)
    invariant(!offlineRuntime.healAttempted, `transient cache read triggered destructive heal: ${JSON.stringify(offlineRuntime)}`)
    invariant(
      offlineRuntime.activeWorker === 'activated' && offlineRuntime.cacheNames.some((name) => /precache/i.test(name)),
      `service worker or precache was lost after transient cache read: ${JSON.stringify(offlineRuntime)}`,
    )
    const offlineChart = await generateReferenceChart(page)
    invariant(offlineChart.lagna === 'gemini', `unexpected offline first-session chart: ${JSON.stringify(offlineChart)}`)
    invariant(
      proxy.state.rejected.includes('/public.key'),
      `offline trust-root proof was vacuous: ${JSON.stringify(proxy.state.rejected)}`,
    )

    // Simulate a rotated 32-byte trust root. A controlled online fetch must
    // reach the origin and return the new bytes; if precache shadowed the
    // NetworkFirst route this would return the install-time key instead.
    proxy.state.blocked = false
    proxy.state.keyOverride = new Uint8Array(32).fill(0x5a)
    const keyRequestsBeforeRotation = proxy.state.requests.filter((path) => path === '/public.key').length
    const rotatedKey = await page.evaluate(async () =>
      Array.from(new Uint8Array(await (await fetch('/public.key', { cache: 'no-store' })).arrayBuffer())),
    )
    const keyRequestsAfterRotation = proxy.state.requests.filter((path) => path === '/public.key').length
    invariant(keyRequestsAfterRotation > keyRequestsBeforeRotation, 'online key rotation did not reach the origin')
    invariant(rotatedKey.length === 32 && rotatedKey.every((byte) => byte === 0x5a), 'online key rotation returned a stale key')

    const evidence = {
      cold,
      coldChart,
      trustRootBeforeCutoff,
      offline,
      offlineRuntime,
      offlineChart,
      initialDocumentControlled: !uncontrolled,
      offlineDocumentControlled: controlled,
      rejectedTransportPaths: proxy.state.rejected,
      keyRequestsBeforeRotation,
      keyRequestsAfterRotation,
      syncWorkerAssets,
      coldIsolation,
      offlineIsolation,
    }
    console.log(JSON.stringify({ firstSessionOffline: evidence }, null, 2))
    return evidence
  } finally {
    await profile.close()
    proxy.close()
  }
}

async function main() {
  if (FIRST_SESSION_ONLY) {
    await verifyFirstSessionOffline()
    return
  }
  const browser = await webkit.launch({ headless: true })
  try {
    const context = await browser.newContext({
      ...devices['iPhone 13'],
      serviceWorkers: 'block',
    })
    const page = await context.newPage()
    const workerUrls = new Set()
    page.on('worker', (worker) => workerUrls.add(worker.url()))

    const coldAttempts = trackBootAttempts(page)
    const forcedFallbackUrl = new URL(BASE_URL)
    forcedFallbackUrl.searchParams.set(FALLBACK_PARAMETER, '1')
    await page.goto(forcedFallbackUrl.href, { waitUntil: 'domcontentloaded' })
    const coldIsolation = await assertBrowserIsolation(page, 'WebKit forced-fallback navigation')
    await openEngineRoute(page)
    const cold = await waitForSettledEngine(page, 'WebKit cold boot', coldAttempts)
    invariant(coldAttempts.attempts() >= 1, 'WebKit cold boot attempt count was vacuous')
    const syncWorkerAssets = assertSingleSyncWorker(workerUrls, 'WebKit forced-fallback boot')

    const storage = await storageEvidence(page)
    invariant(storage.opfs === 'forced-unavailable', `OPFS fallback was not forced: ${JSON.stringify(storage)}`)
    invariant(storage.selectedCache === 'indexeddb', `worker did not select IndexedDB: ${JSON.stringify(storage)}`)
    invariant(
      storage.databases.includes(CACHE_DATABASE),
      `durable IndexedDB fallback was not opened: ${JSON.stringify(storage)}`,
    )
    const firstChart = await generateReferenceChart(page)
    invariant(firstChart.lagna === 'gemini', `unexpected cold chart: ${JSON.stringify(firstChart)}`)

    const blocked = []
    await context.route('**/bundle/**', (route) => {
      const url = route.request().url()
      blocked.push(url)
      return route.abort('failed')
    })
    const cachedAttempts = trackBootAttempts(page)
    await page.evaluate(() => window.history.replaceState({}, '', `/${window.location.search}`))
    await page.reload({ waitUntil: 'domcontentloaded' })
    await openEngineRoute(page)
    const cached = await waitForSettledEngine(page, 'WebKit cached boot', cachedAttempts)
    invariant(cachedAttempts.attempts() >= 1, 'WebKit cached boot attempt count was vacuous')
    invariant(
      blocked.some((u) => u.includes('/bundle/latest')),
      'cached boot was vacuous: /bundle/latest was not blocked',
    )
    const cachedChart = await generateReferenceChart(page)
    invariant(cachedChart.lagna === 'gemini', `unexpected cached chart: ${JSON.stringify(cachedChart)}`)

    // A hard-offline boot failure used to remain latched after connectivity
    // returned: the provider held the rejected promise forever when WebKit
    // continued reporting `navigator.onLine`. Reproduce that transport-shaped
    // failure, keep the route blocked through the first backoff attempt, then
    // restore it WITHOUT a synthetic online event. This is intentionally
    // after the durable-cache proof above, so the retry reuses IndexedDB data.
    await context.unroute('**/bundle/**')
    const blockedKeys = []
    await context.route('**/public.key', (route) => {
      blockedKeys.push(route.request().url())
      return route.abort('failed')
    })
    await page.evaluate(() => window.history.replaceState({}, '', `/${window.location.search}`))
    await page.reload({ waitUntil: 'domcontentloaded' })
    await openEngineRoute(page)
    const failedOfflineBoot = await waitForEngine(page)
    invariant(
      failedOfflineBoot.stage !== 'ready' && /network unreachable/i.test(failedOfflineBoot.error ?? ''),
      `WebKit transport failure was not reproduced: ${JSON.stringify(failedOfflineBoot)}`,
    )
    invariant(blockedKeys.length > 0, 'transport-failure recovery was vacuous: public.key was not blocked')

    // Hold the block until the provider's first automatic retry has actually
    // hit it. A fixed sleep raced that retry: on a loaded runner the retry's
    // public.key request can land after the sleep, which fails the gate below
    // with nothing wrong in the app.
    const firstRetryDeadline = Date.now() + 30_000
    while (blockedKeys.length < 2 && Date.now() < firstRetryDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    await context.unroute('**/public.key')
    const recovered = await waitForRecoveredEngine(page, 'forced-cache transport recovery')
    const recoveredChart = await generateReferenceChart(page)
    invariant(recoveredChart.lagna === 'gemini', `unexpected recovered chart: ${JSON.stringify(recoveredChart)}`)
    invariant(blockedKeys.length >= 2, 'public-key recovery did not outlive the first retry')

    console.log(
      JSON.stringify(
        {
          cold,
          cached,
          storage,
          firstChart,
          cachedChart,
          failedOfflineBoot,
          recovered,
          recoveredChart,
          blockedBundleRequests: blocked.length,
          blockedPublicKeyRequests: blockedKeys.length,
          syncWorkerAssets,
          coldIsolation,
        },
        null,
        2,
      ),
    )
    await context.close()
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  console.error('WebKit engine gate failed:', error)
  process.exitCode = 1
})
