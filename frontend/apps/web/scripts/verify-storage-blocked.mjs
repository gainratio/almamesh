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
 * some embedded WebViews, and every throwaway Playwright WebKit context. Until
 * 2026-10-01 the dashboard hung there forever on "Loading Your Chart": the
 * SQLite Worker refused to open, zustand persist never finished hydrating, and
 * nothing said why. This pass onboards for real and, within a fixed time
 * bound, requires the dashboard chart plus a visible "won't be saved" note.
 * It runs in every browser (no --journey needed): it never touches OPFS.
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

/** Runs before any app script: OPFS refuses, Web Storage and IndexedDB still work. */
function refuseOpfsOnly() {
  if (typeof globalThis.StorageManager === 'undefined') return
  globalThis.StorageManager.prototype.getDirectory = function getDirectory() {
    return Promise.reject(new globalThis.DOMException(
      'The operation failed for an unknown transient reason (e.g. out of memory).',
      'UnknownError',
    ))
  }
}

const ONBOARDED_NAME = 'Reference Native'
const BACKUP_PASSPHRASE = 'storage blocked passphrase'

/**
 * Runs in the page before any app script: decrypt every exported backup
 * (format v3: authenticated 64-byte header, PBKDF2 + AES-GCM, plaintext is the
 * SQLite file) and record whether the onboarded name's bytes are in it.
 */
function captureBackups({ passphrase, needle }) {
  // Chromium would open its native save picker; force the download path.
  for (let target = window; target; target = Object.getPrototypeOf(target)) {
    Reflect.deleteProperty(target, 'showSaveFilePicker')
  }
  const createObjectUrl = URL.createObjectURL.bind(URL)
  URL.createObjectURL = (blob) => {
    window.__backupHasNeedle = blob.arrayBuffer().then(async (buffer) => {
      const file = new Uint8Array(buffer)
      const header = file.slice(0, 64)
      const iterations = new DataView(header.buffer).getUint32(16, false)
      const base = await window.crypto.subtle.importKey('raw', new window.TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey'])
      const key = await window.crypto.subtle.deriveKey(
        { name: 'PBKDF2', hash: 'SHA-256', salt: header.slice(36, 52), iterations },
        base, { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
      )
      const bytes = new Uint8Array(await window.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: header.slice(52, 64), additionalData: header }, key, file.slice(64),
      ))
      const target = new window.TextEncoder().encode(needle)
      return bytes.some((_, offset) => target.every((value, index) => bytes[offset + index] === value))
    })
    return createObjectUrl(blob)
  }
}

/** Client-side navigation: a full load would start a new in-memory database. */
async function navigateInApp(page, path) {
  await page.evaluate((target) => {
    window.history.pushState({}, '', target)
    window.dispatchEvent(new window.PopStateEvent('popstate'))
  }, path)
}

/**
 * Runs in the page: every IndexedDB record and localStorage value that
 * contains the onboarded name. SQLite (here in memory) is the only allowed home.
 */
async function findUserDataOutsideSqlite(needle) {
  const leaks = []
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index)
    if (String(localStorage.getItem(key)).includes(needle)) leaks.push(`localStorage:${key}`)
  }
  const settle = (request) => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  for (const { name } of await indexedDB.databases()) {
    if (!name) continue
    const database = await settle(indexedDB.open(name))
    try {
      for (const storeName of database.objectStoreNames) {
        const values = await settle(database.transaction(storeName).objectStore(storeName).getAll())
        const text = (value) => {
          try { return typeof value === 'string' ? value : JSON.stringify(value) } catch { return '' }
        }
        if (values.some((value) => text(value).includes(needle))) leaks.push(`indexedDB:${name}/${storeName}`)
      }
    } finally {
      database.close()
    }
  }
  return leaks
}

/** Total budget from finishing onboarding to a rendered chart in an OPFS-less realm. */
const OPFS_REFUSED_CHART_BUDGET_MS = 120_000

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
    const noticeText = await notice.innerText()
    invariant(/cookies/i.test(noticeText), `${path} notice does not say what to change: ${noticeText}`)
  }
  await blocked.close()

  const opfsRefused = await browser.newContext({ serviceWorkers: 'block' })
  await opfsRefused.addInitScript(refuseOpfsOnly)
  await opfsRefused.addInitScript(captureBackups, { passphrase: BACKUP_PASSPHRASE, needle: ONBOARDED_NAME })
  try {
    const visited = await visit(opfsRefused, '/onboarding')
    await visited.page.getByTestId('name-input').waitFor({ state: 'visible', timeout: 30_000 })
    await onboard(visited.page)
    const started = Date.now()
    const chart = visited.page.getByTestId('chart-visualization').first()
    const outcome = await Promise.race([
      chart.waitFor({ state: 'visible', timeout: OPFS_REFUSED_CHART_BUDGET_MS }).then(() => 'chart'),
      visited.page.getByTestId('storage-blocked-notice')
        .waitFor({ state: 'visible', timeout: OPFS_REFUSED_CHART_BUDGET_MS }).then(() => 'notice'),
    ]).catch(() => 'hang')
    const seconds = ((Date.now() - started) / 1000).toFixed(1)
    if (process.env.STORAGE_BLOCKED_SCREENSHOT_DIR) {
      await visited.page.screenshot({
        path: join(process.env.STORAGE_BLOCKED_SCREENSHOT_DIR, `opfs-refused-${BROWSER_NAME}.png`),
      })
    }
    const bodyText = (await visited.page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 300)
    invariant(outcome !== 'hang', `OPFS refused: no chart and no notice after ${seconds}s (hang): ${bodyText}`)
    invariant(outcome === 'chart', `OPFS refused: expected the in-memory fallback chart, got the blocked notice: ${bodyText}`)
    const note = visited.page.getByTestId('ephemeral-storage-notice')
    invariant(await note.isVisible(), 'OPFS refused: chart rendered without the "will not be saved" note')
    invariant(/export/i.test(await note.innerText()), 'OPFS refused: the ephemeral note does not suggest exporting')
    invariant(
      (await note.getAttribute('data-durability')) === 'memory',
      'OPFS refused: the app does not report in-memory SQLite as its storage mode',
    )
    // SQLite is the only store. In memory mode nothing may quietly land in
    // IndexedDB or localStorage instead (Harish, 2026-10-04).
    const leaks = await visited.page.evaluate(findUserDataOutsideSqlite, ONBOARDED_NAME)
    invariant(leaks.length === 0, `OPFS refused: user data written outside SQLite: ${leaks.join(', ')}`)
    // Deleted data must not survive inside the SQLite file a backup carries.
    // In memory SQLite has no secure_delete, so the freed pages kept the bytes.
    await navigateInApp(visited.page, '/settings/preferences')
    await visited.page.getByTestId('reset-start-fresh').click()
    await visited.page.getByTestId('reset-confirm').click()
    await visited.page.getByTestId('landing-nav-cta').waitFor({ state: 'visible', timeout: 30_000 })
    await navigateInApp(visited.page, '/settings/data')
    await visited.page.getByTestId('backup-passphrase-input').fill(BACKUP_PASSPHRASE)
    await visited.page.getByTestId('backup-export-button').click()
    await visited.page.waitForFunction(() => window.__backupHasNeedle !== undefined, null, { timeout: 60_000 })
    invariant(
      !(await visited.page.evaluate(() => window.__backupHasNeedle)),
      'OPFS refused: a backup exported after Start fresh still contains the deleted profile name',
    )
    // Honest, not hopeful: a reload loses the session and still says so.
    await visited.page.reload({ waitUntil: 'load' })
    await note.waitFor({ state: 'visible', timeout: 30_000 })
    invariant(
      !(await visited.page.getByText(ONBOARDED_NAME).first().isVisible().catch(() => false)),
      'OPFS refused: data survived a reload although the note says it does not',
    )
    await note.getByRole('link').click()
    await visited.page.waitForURL('**/settings/data', { timeout: 15_000 })
    invariant(
      !(await visited.page.getByTestId('storage-blocked-notice').isVisible()),
      'OPFS refused: the export link led to a blocked-storage notice',
    )
    invariant(visited.pageErrors.length === 0, `OPFS refused run threw: ${visited.pageErrors.join(' | ')}`)
    console.log(`storage-blocked: ${BROWSER_NAME} OPFS refused -> chart + ephemeral note in ${seconds}s`)
  } finally {
    await opfsRefused.close()
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
        !(await control.page.getByTestId('ephemeral-storage-notice').isVisible()),
        'ephemeral "not saving" note shown although storage is allowed',
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
