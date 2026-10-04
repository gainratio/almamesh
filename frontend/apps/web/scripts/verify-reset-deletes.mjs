#!/usr/bin/env node

/**
 * "Reset & reload" must actually delete IndexedDB before it reloads.
 *
 * Until 2026-10-04 the page's own idb-keyval connection blocked
 * `deleteDatabase('keyval-store')` in Chromium, WebKit and Firefox. Reset gave
 * up after 3 s and reloaded anyway, so it looked finished while user rows could
 * still be on disk. Now every connection closes on versionchange, and a delete
 * that still cannot complete stops the reload with a visible alert.
 *
 * The journey: serve a build WITHOUT its engine bundle (so onboarding lands on
 * the recovery card), plant a marker row in keyval-store, click "Reset &
 * reload", and require a reload with no reset-incomplete alert and no marker
 * afterwards. The bundle is removed on disk rather than with Playwright
 * routing: in WebKit any context route stopped the page's classic scripts
 * (public/idb-connection-hygiene.js) from taking effect.
 *
 * Usage (serve a copy of dist with bundle/, pyodide/ and public.key deleted):
 *   node scripts/verify-reset-deletes.mjs http://127.0.0.1:4198 --browser=chromium
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { chromium, firefox, webkit } from '@playwright/test'

const BASE_URL = process.argv.find((argument) => /^https?:\/\//.test(argument)) ?? 'http://127.0.0.1:4199'
const BROWSER_NAME = process.argv.find((argument) => argument.startsWith('--browser='))
  ?.slice('--browser='.length) ?? 'chromium'
const BROWSERS = { chromium, firefox, webkit }
const MARKER = 'reset-proof-marker'

function invariant(condition, message) {
  if (!condition) throw new Error(`reset-deletes (${BROWSER_NAME}): ${message}`)
}

async function typeSections(page, testId, digits, trailing) {
  await page.locator(`[data-testid="${testId}"] [role="spinbutton"]`).first().click()
  await page.keyboard.type(digits, { delay: 50 })
  if (trailing) await page.keyboard.type(trailing, { delay: 50 })
}

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

/** Runs in the page: put the marker in keyval-store, or read it back. */
function keyvalMarker({ marker, write }) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('keyval-store')
    request.onupgradeneeded = () => request.result.createObjectStore('keyval')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const database = request.result
      if (!database.objectStoreNames.contains('keyval')) {
        database.close()
        resolve(false)
        return
      }
      const transaction = database.transaction('keyval', write ? 'readwrite' : 'readonly')
      const store = transaction.objectStore('keyval')
      const read = write ? store.put(marker, marker) : store.get(marker)
      transaction.oncomplete = () => {
        database.close()
        resolve(read.result === marker)
      }
      transaction.onerror = () => reject(transaction.error)
    }
  })
}

const profile = mkdtempSync(join(tmpdir(), `almamesh-reset-${BROWSER_NAME}-`))
const context = await BROWSERS[BROWSER_NAME].launchPersistentContext(profile, { headless: true, serviceWorkers: 'block' })
try {
  const page = context.pages()[0] ?? (await context.newPage())
  await page.goto(new URL('/onboarding', BASE_URL).href)
  await page.getByTestId('name-input').waitFor({ timeout: 60_000 })
  await onboard(page)
  const reset = page.getByTestId('reset-app-data-button')
  await reset.waitFor({ timeout: 120_000 })
  invariant(await page.evaluate(keyvalMarker, { marker: MARKER, write: true }), 'could not plant the marker row')

  const reloaded = page.waitForEvent('load', { timeout: 60_000 }).then(() => 'reloaded', () => 'hang')
  const refused = page.getByTestId('reset-incomplete').waitFor({ timeout: 60_000 }).then(() => 'refused', () => 'hang')
  await reset.click()
  const outcome = await Promise.race([reloaded, refused])
  if (outcome === 'refused') {
    const databases = await page.getByTestId('reset-incomplete').getAttribute('data-databases')
    invariant(false, `Reset could not delete IndexedDB database(s): ${databases}`)
  }
  invariant(outcome === 'reloaded', 'Reset neither reloaded nor explained itself within 60 s')
  await page.waitForLoadState('load')
  invariant(!(await page.evaluate(keyvalMarker, { marker: MARKER, write: false })), 'the marker row survived Reset & reload')
  console.log(`reset-deletes: ${BROWSER_NAME} Reset & reload deleted keyval-store (marker gone after reload)`)
} finally {
  await context.close()
  rmSync(profile, { recursive: true, force: true })
}
