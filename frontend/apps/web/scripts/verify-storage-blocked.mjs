#!/usr/bin/env node

/**
 * Production-preview probe: AlmaMesh must not go blank when the browser
 * blocks site storage.
 *
 * Safari with "Block all cookies" (Settings > Privacy) makes the Web Storage
 * getters THROW: reading `window.localStorage` raises
 * `SecurityError: The operation is insecure.`, IndexedDB.open() and OPFS
 * getDirectory() refuse too. On 2026-10-01 a module-init read of
 * `globalThis.localStorage` threw while the entry chunk evaluated, React never
 * mounted, and every app route rendered an empty page in Safari. Playwright's
 * WebKit allows storage by default, so the existing WebKit lane never saw it.
 *
 * This script reproduces that browser state with an init script, then
 * requires: no uncaught page error on /welcome or /onboarding, and a visible
 * explanation on /onboarding and /dashboard. A control pass with storage
 * allowed requires the normal onboarding form, no notice, and no page errors.
 *
 * `--journey` additionally onboards for real and requires the dashboard chart
 * (persistent profile). Dagger passes it to the Chromium run only: Linux
 * Playwright WebKit has no working OPFS even in a persistent profile
 * (UnknownError, see verify-sqlite-memory.mjs), so the chart can never load
 * there. macOS WebKit passes it.
 *
 * A second blocked realm refuses ONLY the Origin Private File System while
 * localStorage and IndexedDB keep working: Safari Private Browsing, older iOS,
 * some embedded WebViews, and every throwaway Playwright WebKit context.
 * SQLite on OPFS is the only place AlmaMesh keeps data (Harish, 2026-10-05:
 * "sqlite persistent is the only option"), so this realm must show the block
 * screen within a time bound: no in-memory SQLite, no engine, no IndexedDB.
 * The screen must say AlmaMesh needs permission to store data on this device,
 * never claim AlmaMesh uses cookies, list numbered steps for this browser, and
 * offer "Allow storage" and "Check again". Once storage is allowed, "Check
 * again" must continue into the app without reloading the page.
 *
 * STORAGE_BLOCKED_SCREENSHOT_DIR=<dir> saves both block screens as PNGs.
 *
 * Usage:
 *   node scripts/verify-storage-blocked.mjs http://127.0.0.1:4200 --browser=webkit
 *   node scripts/verify-storage-blocked.mjs http://127.0.0.1:4199 --browser=chromium --journey
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { chromium, webkit } from '@playwright/test'

const BASE_URL = process.argv.find((argument) => /^https?:\/\//.test(argument))
  ?? 'http://127.0.0.1:4199'
const BROWSER_NAME = process.argv.find((argument) => argument.startsWith('--browser='))
  ?.slice('--browser='.length) ?? 'webkit'
const RUN_JOURNEY = process.argv.includes('--journey')
const BROWSERS = { chromium, webkit }

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}

/** Runs in the page before any app script: Safari's "Block all cookies" realm. */
function blockSiteStorage() {
  const refuse = (message) => new globalThis.DOMException(message, 'SecurityError')
  for (const name of ['localStorage', 'sessionStorage']) {
    Object.defineProperty(window, name, {
      configurable: true,
      get() {
        throw refuse('The operation is insecure.')
      },
    })
  }
  globalThis.IDBFactory.prototype.open = function open() {
    throw refuse('IDBFactory.open() called in an invalid security context')
  }
  if (typeof globalThis.StorageManager !== 'undefined') {
    globalThis.StorageManager.prototype.getDirectory = function getDirectory() {
      return Promise.reject(refuse('Context not access storage'))
    }
  }
}

const ONBOARDED_NAME = 'Reference Native'

/**
 * Runs before any app script: OPFS refuses until the test flips
 * `window.__allowOpfs`, so "Check again" can be proven without a reload.
 */
function refuseOpfsUntilAllowed() {
  if (typeof globalThis.StorageManager === 'undefined') return
  const real = globalThis.StorageManager.prototype.getDirectory
  window.__allowOpfs = false
  window.__loadMarker = Math.random()
  globalThis.StorageManager.prototype.getDirectory = function getDirectory() {
    if (window.__allowOpfs) return real.call(this)
    return Promise.reject(new globalThis.DOMException(
      'The operation failed for an unknown transient reason (e.g. out of memory).',
      'UnknownError',
    ))
  }
}

/** The block screen must never claim AlmaMesh uses cookies (it doesn't). */
const COOKIE_CLAIM = /\b(we|almamesh)\s+(use|uses|store|stores|set|sets)\s+cookies\b/i
const PERMISSION_COPY = /permission to store data on this device/i

/** How long the block screen may take to appear when OPFS is refused (no hang, no RAM fallback). */
const BLOCK_SCREEN_BUDGET_MS = 20_000

/** Assert the block screen is the whole story: clear copy, numbered steps, both buttons. */
async function expectBlockScreen(page, label) {
  const notice = page.getByTestId('storage-blocked-notice')
  await notice.waitFor({ state: 'visible', timeout: BLOCK_SCREEN_BUDGET_MS }).catch(() => undefined)
  const screen = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 400)
  invariant(await notice.isVisible(), `${label}: no storage-blocked screen within ${BLOCK_SCREEN_BUDGET_MS} ms: ${screen}`)
  const text = await notice.innerText()
  invariant(PERMISSION_COPY.test(text), `${label}: the screen does not say AlmaMesh needs permission to store data: ${text}`)
  invariant(!COOKIE_CLAIM.test(text), `${label}: the screen claims AlmaMesh uses cookies: ${text}`)
  const steps = await notice.locator('ol li').count()
  invariant(steps >= 2, `${label}: expected numbered steps for this browser, found ${steps}`)
  invariant(await page.getByTestId('storage-allow-button').isVisible(), `${label}: no "Allow storage" button`)
  invariant(await page.getByTestId('storage-check-again-button').isVisible(), `${label}: no "Check again" button`)
  invariant(!(await page.getByTestId('name-input').isVisible().catch(() => false)), `${label}: the app ran behind the block screen`)
  const browserBranch = await notice.locator('[data-browser]').first().getAttribute('data-browser').catch(() => null)
  return { reason: await notice.getAttribute('data-reason'), browserBranch, steps }
}

async function typeSections(page, testId, digits, trailing) {
  await page.locator(`[data-testid="${testId}"] [role="spinbutton"]`).first().click()
  await page.keyboard.type(digits, { delay: 50 })
  if (trailing) await page.keyboard.type(trailing, { delay: 50 })
}

/** The real onboarding journey (mirrors e2e/live/liveJourney.ts generateChart). */
async function onboard(page) {
  await page.getByTestId('name-input').fill(ONBOARDED_NAME)
  await page.getByTestId('next-button').click()
  await typeSections(page, 'birth-date-input', '08081988')
  await page.getByTestId('next-button').click()
  await page.getByTestId('location-search-input').fill('Bengaluru')
  await page.locator('[role="option"]').first().click()
  await page.getByTestId('next-button').click()
  await typeSections(page, 'birth-time-input', '0644', 'a')
  await page.getByTestId('confidence-option-exact').click()
  await page.getByTestId('next-button').click()
  await page.getByTestId('skip-life-events-button').click()
}

/**
 * STORAGE_BLOCKED_CPU_THROTTLE=6 slows Chromium's CPU 6x (CDP), the budget
 * phone this product targets. The 2026-10-02 release lost birth-date
 * keystrokes only under load; this knob reproduces that on a fast laptop.
 */
const CPU_THROTTLE = Number(process.env.STORAGE_BLOCKED_CPU_THROTTLE ?? '1')

async function visit(context, path) {
  const page = await context.newPage()
  if (CPU_THROTTLE > 1 && BROWSER_NAME === 'chromium') {
    const cdp = await context.newCDPSession(page)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE })
  }
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(`${path}: ${error.message}`))
  const response = await page.goto(new URL(path, BASE_URL).href, { waitUntil: 'load' })
  invariant(response?.ok(), `${path} navigation failed with HTTP ${response?.status() ?? 'none'}`)
  return { page, pageErrors }
}

const browserType = BROWSERS[BROWSER_NAME]
invariant(browserType, `unsupported browser ${BROWSER_NAME}; use chromium or webkit`)
const browser = await browserType.launch({ headless: true })
try {
  const blocked = await browser.newContext({ serviceWorkers: 'block' })
  await blocked.addInitScript(blockSiteStorage)

  const welcome = await visit(blocked, '/welcome')
  await welcome.page.getByRole('heading', { level: 1 }).waitFor({ timeout: 15_000 })
  await welcome.page.waitForTimeout(2_000)
  invariant(welcome.pageErrors.length === 0, `blocked storage threw on /welcome: ${welcome.pageErrors.join(' | ')}`)

  for (const path of ['/onboarding', '/dashboard']) {
    const visited = await visit(blocked, path)
    const notice = visited.page.getByTestId('storage-blocked-notice')
    await notice.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => undefined)
    invariant(visited.pageErrors.length === 0, `blocked storage threw on ${path}: ${visited.pageErrors.join(' | ')}`)
    invariant(await notice.isVisible(), `${path} showed no storage-blocked notice (blank page?)`)
    const shown = await expectBlockScreen(visited.page, `block-all ${path}`)
    if (process.env.STORAGE_BLOCKED_SCREENSHOT_DIR && path === '/onboarding') {
      await visited.page.screenshot({
        path: join(process.env.STORAGE_BLOCKED_SCREENSHOT_DIR, `block-all-${BROWSER_NAME}.png`),
        fullPage: true,
      })
    }
    console.log(`storage-blocked: block-all ${path} -> ${JSON.stringify(shown)}`)
  }
  await blocked.close()

  // CONTRACT REVERSED (2026-10-05, Harish: "sqlite persistent is the only
  // option"). This realm used to require an in-memory SQLite chart plus an
  // ephemeral "won't be saved" note. OPFS refused now means the block screen,
  // within a time bound: no app, no engine, no IndexedDB, no RAM SQLite. Then
  // storage is allowed and "Check again" must move into the app WITHOUT a reload.
  // A persistent profile, so OPFS really works once the init script stops
  // refusing it (an ephemeral WebKit context refuses OPFS by itself). Linux
  // Playwright WebKit has no nested-Worker OPFS even then: there the allow leg
  // is skipped and said so; the block leg runs everywhere.
  const canAllowOpfs = BROWSER_NAME !== 'webkit' || process.platform !== 'linux'
  const refusedProfile = mkdtempSync(join(tmpdir(), 'almamesh-opfs-refused-'))
  const opfsRefused = await browserType.launchPersistentContext(refusedProfile, { headless: true, serviceWorkers: 'block' })
  await opfsRefused.addInitScript(refuseOpfsUntilAllowed)
  try {
    const visited = await visit(opfsRefused, '/onboarding')
    const engineWorkers = []
    visited.page.on('worker', (worker) => {
      if (/edgeproc|pyodide|chart|engine/i.test(worker.url())) engineWorkers.push(worker.url())
    })
    const started = Date.now()
    const shown = await expectBlockScreen(visited.page, 'OPFS refused')
    const seconds = ((Date.now() - started) / 1000).toFixed(1)
    invariant(shown.reason === 'storage-blocked', `OPFS refused: expected data-reason storage-blocked, got ${shown.reason}`)
    if (process.env.STORAGE_BLOCKED_SCREENSHOT_DIR) {
      await visited.page.screenshot({
        path: join(process.env.STORAGE_BLOCKED_SCREENSHOT_DIR, `opfs-refused-${BROWSER_NAME}.png`),
        fullPage: true,
      })
    }
    await visited.page.waitForTimeout(2_000)
    const databases = await visited.page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name))
    invariant(databases.length === 0, `OPFS refused: IndexedDB databases were created: ${JSON.stringify(databases)}`)
    invariant(engineWorkers.length === 0, `OPFS refused: the engine started behind the block screen: ${engineWorkers.join(', ')}`)
    const marker = await visited.page.evaluate(() => window.__loadMarker)

    // Still refused: Check again keeps the screen and says so.
    await visited.page.getByTestId('storage-check-again-button').click()
    await visited.page.waitForTimeout(1_500)
    invariant(await visited.page.getByTestId('storage-blocked-notice').isVisible(), 'OPFS refused: Check again let the app run while storage is still refused')
    invariant(visited.pageErrors.length === 0, `OPFS refused: page errors behind the block screen: ${visited.pageErrors.join(' | ')}`)

    if (canAllowOpfs) {
      // The user allows storage; Check again continues into the app, no reload.
      await visited.page.evaluate(() => { window.__allowOpfs = true })
      await visited.page.getByTestId('storage-check-again-button').click()
      await visited.page.getByTestId('name-input').waitFor({ state: 'visible', timeout: 30_000 })
      invariant(
        (await visited.page.evaluate(() => window.__loadMarker)) === marker,
        'OPFS allowed: Check again reloaded the page instead of continuing in place',
      )
      invariant(!(await visited.page.getByTestId('storage-blocked-notice').isVisible()), 'OPFS allowed: the block screen stayed up')
      invariant(visited.pageErrors.length === 0, `OPFS refused run threw: ${visited.pageErrors.join(' | ')}`)
      console.log(`storage-blocked: ${BROWSER_NAME} OPFS refused -> block screen in ${seconds}s (${shown.browserBranch}, ${shown.steps} steps); allowed -> Check again opens the app in place`)
    } else {
      console.log(`storage-blocked: ${BROWSER_NAME} OPFS refused -> block screen in ${seconds}s; skipped the allow -> Check again leg on Linux WebKit (no nested-Worker OPFS)`)
    }
  } finally {
    await opfsRefused.close()
    rmSync(refusedProfile, { recursive: true, force: true })
  }

  // Playwright's Linux WebKit port exposes document OPFS in a persistent
  // context, but not functional OPFS inside SQLite's nested Worker. It is not
  // a Safari durability oracle. Chromium exercises this control in Linux CI;
  // real macOS WebKit exercises it locally. Both Linux WebKit blocked/fallback
  // realms above still run.
  const canProveDurableStorage = BROWSER_NAME !== 'webkit' || process.platform !== 'linux'
  if (canProveDurableStorage) {
    const profile = mkdtempSync(join(tmpdir(), 'almamesh-storage-allowed-'))
    const allowed = await browserType.launchPersistentContext(profile, { headless: true })
    try {
      const control = await visit(allowed, '/onboarding')
      await control.page.getByTestId('name-input').waitFor({ state: 'visible', timeout: 30_000 })
      invariant(
        !(await control.page.getByTestId('storage-blocked-notice').isVisible()),
        'storage-blocked notice shown although storage is allowed',
      )
      invariant(
        !(await control.page.getByTestId('storage-check-again-button').isVisible()),
        'storage block controls shown although storage is allowed',
      )
      if (RUN_JOURNEY) {
        await onboard(control.page)
        await control.page.waitForURL('**/dashboard', { timeout: 60_000 })
        await control.page.getByTestId('identity-strip').waitFor({ state: 'visible', timeout: 60_000 })
        await control.page.getByTestId('chart-visualization').first().waitFor({ state: 'visible', timeout: 30_000 })
      }
      invariant(control.pageErrors.length === 0, `control run threw: ${control.pageErrors.join(' | ')}`)
    } finally {
      await allowed.close()
      rmSync(profile, { recursive: true, force: true })
    }
  } else {
    console.log('storage-blocked: skipped Linux WebKit durable-storage control (nested-Worker OPFS unsupported)')
  }

  console.log(`storage-blocked: ${BROWSER_NAME} renders /welcome, explains /onboarding + /dashboard when blocked, ${canProveDurableStorage ? (RUN_JOURNEY ? 'renders the dashboard chart' : 'renders onboarding') : 'leaves durable-storage proof to a supported engine'}, no page errors`)
} finally {
  await browser.close()
}
