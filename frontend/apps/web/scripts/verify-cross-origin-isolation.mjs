#!/usr/bin/env node

/**
 * Production-preview probe for the COOP/COEP contract required by SQLite's
 * SharedArrayBuffer-backed OPFS Web-Locks VFS.
 *
 * Usage:
 *   node scripts/verify-cross-origin-isolation.mjs http://127.0.0.1:4199 --browser=chromium
 *   node scripts/verify-cross-origin-isolation.mjs http://127.0.0.1:4199 --browser=webkit --external-egress
 *
 * `--external-egress` additionally exercises the three allowlisted third-party
 * browser paths. It is intentionally opt-in because those upstream services
 * are outside the deterministic CI boundary.
 */

import { chromium, firefox, webkit } from '@playwright/test'

const BASE_URL = process.argv.find((argument) => /^https?:\/\//.test(argument))
  ?? 'http://127.0.0.1:4199'
const BROWSER_NAME = process.argv.find((argument) => argument.startsWith('--browser='))
  ?.slice('--browser='.length) ?? 'chromium'
const CHECK_EXTERNAL_EGRESS = process.argv.includes('--external-egress')
const BROWSERS = { chromium, firefox, webkit }

/** How long the service worker may take to install and control the page. */
const SERVICE_WORKER_READY_MS = 60_000

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}

const browserType = BROWSERS[BROWSER_NAME]
invariant(browserType, `unsupported browser ${BROWSER_NAME}; use chromium, firefox, or webkit`)

const browser = await browserType.launch({ headless: true })
try {
  const context = await browser.newContext({ serviceWorkers: 'allow' })
  const page = await context.newPage()
  const response = await page.goto(new URL('/welcome', BASE_URL).href, {
    waitUntil: 'domcontentloaded',
  })
  invariant(response?.ok(), `app navigation failed with HTTP ${response?.status() ?? 'no response'}`)

  const responseHeaders = response.headers()
  invariant(
    responseHeaders['cross-origin-opener-policy'] === 'same-origin',
    `unexpected COOP: ${responseHeaders['cross-origin-opener-policy'] ?? 'missing'}`,
  )
  invariant(
    responseHeaders['cross-origin-embedder-policy'] === 'require-corp',
    `unexpected COEP: ${responseHeaders['cross-origin-embedder-policy'] ?? 'missing'}`,
  )

  const documentRuntime = await page.evaluate(() => ({
    isolated: globalThis.crossOriginIsolated,
    sharedArrayBuffer: typeof globalThis.SharedArrayBuffer === 'function',
    waitAsync: typeof Atomics.waitAsync === 'function',
  }))
  invariant(
    documentRuntime.isolated && documentRuntime.sharedArrayBuffer && documentRuntime.waitAsync,
    `document lacks the isolated SQLite runtime: ${JSON.stringify(documentRuntime)}`,
  )

  // Bounded: an unregistered worker made this await hang CI for 74 minutes
  // (2026-10-05). Fail with a reason instead.
  await page.evaluate(
    (ms) => Promise.race([
      navigator.serviceWorker.ready.then(() => 'ready'),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), ms)),
    ]),
    SERVICE_WORKER_READY_MS,
  ).then((state) => invariant(state === 'ready', `no service worker became ready within ${SERVICE_WORKER_READY_MS} ms (is it registered on this screen?)`))
  const controlledReloadResponse = await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: SERVICE_WORKER_READY_MS })
  const controlledReloadHeaders = controlledReloadResponse?.headers() ?? {}
  invariant(
    controlledReloadHeaders['cross-origin-opener-policy'] === 'same-origin' &&
      controlledReloadHeaders['cross-origin-embedder-policy'] === 'require-corp',
    `service-worker reload lost COOP/COEP: ${JSON.stringify(controlledReloadHeaders)}`,
  )
  const serviceWorkerReloadRuntime = await page.evaluate(() => ({
    controlled: navigator.serviceWorker.controller !== null,
    isolated: globalThis.crossOriginIsolated,
    sharedArrayBuffer: typeof globalThis.SharedArrayBuffer === 'function',
    waitAsync: typeof Atomics.waitAsync === 'function',
  }))
  invariant(
    serviceWorkerReloadRuntime.controlled &&
      serviceWorkerReloadRuntime.isolated &&
      serviceWorkerReloadRuntime.sharedArrayBuffer &&
      serviceWorkerReloadRuntime.waitAsync,
    `service-worker reload lost the isolated SQLite runtime: ${JSON.stringify(serviceWorkerReloadRuntime)}`,
  )

  const workerRuntime = await page.evaluate(() => new Promise((resolve, reject) => {
    const source = `self.postMessage({
      isolated: self.crossOriginIsolated,
      sharedArrayBuffer: typeof self.SharedArrayBuffer === 'function',
      waitAsync: typeof Atomics.waitAsync === 'function'
    })`
    const url = URL.createObjectURL(new globalThis.Blob([source], { type: 'text/javascript' }))
    const worker = new globalThis.Worker(url)
    const timer = setTimeout(() => {
      worker.terminate()
      URL.revokeObjectURL(url)
      reject(new Error('isolation probe worker timed out'))
    }, 10_000)
    worker.addEventListener('message', (event) => {
      clearTimeout(timer)
      worker.terminate()
      URL.revokeObjectURL(url)
      resolve(event.data)
    }, { once: true })
    worker.addEventListener('error', (event) => {
      clearTimeout(timer)
      worker.terminate()
      URL.revokeObjectURL(url)
      reject(new Error(event.message))
    }, { once: true })
  }))
  invariant(
    workerRuntime.isolated && workerRuntime.sharedArrayBuffer && workerRuntime.waitAsync,
    `dedicated worker lacks the isolated SQLite runtime: ${JSON.stringify(workerRuntime)}`,
  )

  let externalEgress = 'not requested'
  if (CHECK_EXTERNAL_EGRESS) {
    externalEgress = await page.evaluate(async () => {
      const [openRouter, openMeteo] = await Promise.all([
        fetch('https://openrouter.ai/api/v1/models'),
        fetch('https://geocoding-api.open-meteo.com/v1/search?name=Delhi&count=1&language=en&format=json'),
      ])
      return {
        openRouter: { ok: openRouter.ok, status: openRouter.status },
        openMeteo: { ok: openMeteo.ok, status: openMeteo.status },
      }
    })
    invariant(externalEgress.openRouter.ok, `OpenRouter CORS fetch failed: ${JSON.stringify(externalEgress)}`)
    invariant(externalEgress.openMeteo.ok, `Open-Meteo CORS fetch failed: ${JSON.stringify(externalEgress)}`)

    await page.addScriptTag({
      url: 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',
    })
    await page.waitForFunction(() => typeof globalThis.turnstile?.render === 'function')
    const turnstileToken = await page.evaluate(() => new Promise((resolve, reject) => {
      const target = document.createElement('div')
      document.body.append(target)
      const timer = setTimeout(() => reject(new Error('Turnstile test challenge timed out')), 30_000)
      globalThis.turnstile.render(target, {
        sitekey: '1x00000000000000000000AA',
        callback: (token) => {
          clearTimeout(timer)
          resolve(token)
        },
        'error-callback': (code) => {
          clearTimeout(timer)
          reject(new Error(`Turnstile test challenge failed: ${code}`))
        },
      })
    }))
    invariant(typeof turnstileToken === 'string' && turnstileToken.length > 0, 'Turnstile returned no token')
    externalEgress.turnstile = 'passed'
  }

  console.log(JSON.stringify({
    browser: BROWSER_NAME,
    url: response.url(),
    headers: {
      coop: responseHeaders['cross-origin-opener-policy'],
      coep: responseHeaders['cross-origin-embedder-policy'],
    },
    documentRuntime,
    serviceWorkerReloadRuntime,
    workerRuntime,
    externalEgress,
  }, null, 2))
  await context.close()
} finally {
  await browser.close()
}
