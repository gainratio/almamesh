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
 * allowed onboards for real and requires the dashboard chart, no notice, and
 * no page errors. The control uses a persistent profile: Playwright's
 * ephemeral WebKit contexts refuse OPFS (UnknownError), which is not what a
 * normal Safari window does.
 *
 * Usage:
 *   node scripts/verify-storage-blocked.mjs http://127.0.0.1:4200 --browser=webkit
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { chromium, webkit } from '@playwright/test'

const BASE_URL = process.argv.find((argument) => /^https?:\/\//.test(argument))
  ?? 'http://127.0.0.1:4199'
const BROWSER_NAME = process.argv.find((argument) => argument.startsWith('--browser='))
  ?.slice('--browser='.length) ?? 'webkit'
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

async function typeSections(page, testId, digits, trailing) {
  await page.locator(`[data-testid="${testId}"] [role="spinbutton"]`).first().click()
  await page.keyboard.type(digits, { delay: 50 })
  if (trailing) await page.keyboard.type(trailing, { delay: 50 })
}

/** The real onboarding journey (mirrors e2e/live/liveJourney.ts generateChart). */
async function onboard(page) {
  await page.getByTestId('name-input').fill('Reference Native')
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

async function visit(context, path) {
  const page = await context.newPage()
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

  const profile = mkdtempSync(join(tmpdir(), 'almamesh-storage-allowed-'))
  const allowed = await browserType.launchPersistentContext(profile, { headless: true })
  try {
    const control = await visit(allowed, '/onboarding')
    await control.page.getByTestId('name-input').waitFor({ state: 'visible', timeout: 30_000 })
    invariant(
      !(await control.page.getByTestId('storage-blocked-notice').isVisible()),
      'storage-blocked notice shown although storage is allowed',
    )
    await onboard(control.page)
    await control.page.waitForURL('**/dashboard', { timeout: 60_000 })
    await control.page.getByTestId('identity-strip').waitFor({ state: 'visible', timeout: 60_000 })
    await control.page.getByTestId('chart-visualization').first().waitFor({ state: 'visible', timeout: 30_000 })
    invariant(control.pageErrors.length === 0, `control run threw: ${control.pageErrors.join(' | ')}`)
  } finally {
    await allowed.close()
    rmSync(profile, { recursive: true, force: true })
  }

  console.log(`storage-blocked: ${BROWSER_NAME} renders /welcome, explains /onboarding + /dashboard when blocked, renders the dashboard chart when allowed, no page errors`)
} finally {
  await browser.close()
}
