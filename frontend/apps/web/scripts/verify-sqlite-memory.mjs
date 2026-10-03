#!/usr/bin/env node
/**
 * Real-browser proof for production semantic memory.
 *
 * Requires a production build created with VITE_EXIT_GATE_HOOKS=1 and served
 * by Vite preview. A browser with working OPFS opens the shipped SQLite +
 * sqlite-vector Worker, writes, queries, closes, reopens, and queries the same
 * durable index again. A browser engine whose OPFS entrypoint refuses instead
 * proves the stable fail-closed path: no Worker and no storage fallback.
 */

import { chromium, webkit } from '@playwright/test'

const arguments_ = process.argv.slice(2)
const BASE_URL = arguments_.find((argument) => !argument.startsWith('--')) ?? 'http://127.0.0.1:4199'
const requestedBrowser = arguments_
  .find((argument) => argument.startsWith('--browser='))
  ?.slice('--browser='.length) ?? 'chromium'
const ORIGIN = new URL(BASE_URL).origin
const EXPECTED_MESSAGE = 'sqlite-proof-message'

/**
 * SQLite's own OPFS / OPFS-WL async-proxy Workers, an internal of the vendored
 * runtime rather than an app Worker. Since @gainratio/browser 3146a2a the
 * runtime spawns them inline from a same-origin Blob URL, so the install never
 * waits on a network fetch (on slow 4G that fetch lost a 4 s race and the
 * durable store refused to open). Nothing in this app spawns a Worker from a
 * Blob URL, so a same-origin blob: Worker is that proxy. Older builds spawned
 * it from the emitted asset with a ?vfs= query; keep recognising those.
 */
function isDocumentedSqliteProxyWorker(url) {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'blob:') return new URL(parsed.pathname).origin === ORIGIN
    return (
      /\/assets\/sqlite3-opfs-async-proxy(?:-[^/]+)?\.js$/.test(parsed.pathname) &&
      ['opfs', 'opfs-wl'].includes(parsed.searchParams.get('vfs'))
    )
  } catch {
    return false
  }
}

async function runBrowser(browserType, browserName) {
  const browser = await browserType.launch({ headless: true })
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' })
    const page = await context.newPage()
    const pageErrors = []
    const requests = []
    const workers = []

    page.on('pageerror', (error) => pageErrors.push(String(error)))
    page.on('request', (request) => requests.push(request.url()))
    page.on('worker', (worker) => workers.push(worker.url()))

    await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(
      () => typeof window.__almameshVerifySqliteMemory === 'function',
      undefined,
      { timeout: 20_000 },
    )

    const capability = await page.evaluate(async () => {
      try {
        await navigator.storage.getDirectory()
        return { opfs: 'available' }
      } catch (error) {
        return {
          opfs: 'unavailable',
          errorName: error instanceof Error ? error.name : 'Error',
          errorMessage: error instanceof Error ? error.message : String(error),
          userAgent: navigator.userAgent,
        }
      }
    })
    const workerStart = workers.length
    const requestStart = requests.length
    let proof = null
    let proofError = null
    try {
      proof = await page.evaluate(() => window.__almameshVerifySqliteMemory())
    } catch (error) {
      proofError = String(error)
    }
    const proofWorkers = workers.slice(workerStart)
    const sqliteProxyWorkers = proofWorkers.filter(isDocumentedSqliteProxyWorker)
    // The proof invokes only semantic memory. Once SQLite's documented OPFS
    // proxy Workers are removed, every remaining lifecycle is the app-owned
    // vector-index Worker regardless of Vite's generated asset basename.
    const appWorkers = proofWorkers.filter((url) => !isDocumentedSqliteProxyWorker(url))
    const uniqueAppWorkerAssets = [...new Set(appWorkers)]
    const proofRequests = requests.slice(requestStart)
    const offOrigin = proofRequests.filter((url) => {
      if (url.startsWith('blob:') || url.startsWith('data:')) return false
      return new URL(url).origin !== ORIGIN
    })

    const assertions = capability.opfs === 'available'
      ? {
          firstQuery: proof?.firstMessageId === EXPECTED_MESSAGE,
          reopenedQuery: proof?.reopenedMessageId === EXPECTED_MESSAGE,
          sqliteRuntime: /^3\./.test(proof?.sqliteVersion ?? ''),
          sqliteVectorRuntime: /^1\./.test(proof?.vectorVersion ?? ''),
          // Closing and reopening memory must create exactly two lifecycles of
          // the one consumer-owned EdgeProc Worker asset. SQLite's documented
          // OPFS/OPFS-WL proxy Workers are implementation internals and are
          // inventoried separately rather than miscounted as duplicate app Workers.
          twoWorkerLifecycles: appWorkers.length === 2,
          oneEmittedWorkerAsset: uniqueAppWorkerAssets.length === 1,
          zeroThirdPartyEgress: offOrigin.length === 0,
          noPageErrors: pageErrors.length === 0,
        }
      : {
          stableFailClosedError: proofError?.includes(
            'Semantic memory requires a working Origin Private File System',
          ) === true,
          noFallbackWorker: proofWorkers.length === 0,
          zeroThirdPartyEgress: offOrigin.length === 0,
          noPageErrors: pageErrors.length === 0,
        }
    const failures = Object.entries(assertions)
      .filter(([, passed]) => !passed)
      .map(([name]) => name)

    const result = {
      browser: browserName,
      passed: failures.length === 0,
      capability,
      proof,
      proofError,
      assertions,
      workers: proofWorkers,
      appWorkers,
      sqliteProxyWorkers,
      requests: proofRequests,
      offOrigin,
      pageErrors,
    }
    if (failures.length > 0) {
      throw new Error(
        `${browserName} SQLite memory proof failed: ${failures.join(', ')}; ` +
          `evidence=${JSON.stringify(result)}`,
      )
    }
    return result
  } finally {
    await browser.close()
  }
}

const browserTypes = { chromium, webkit }
const browserType = browserTypes[requestedBrowser]
if (browserType === undefined) {
  throw new Error(`Unsupported browser: ${requestedBrowser}`)
}
const result = await runBrowser(browserType, requestedBrowser)
console.log(JSON.stringify(result, null, 2))
