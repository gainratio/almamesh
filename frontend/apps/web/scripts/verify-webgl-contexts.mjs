#!/usr/bin/env node
/**
 * WebGL context leak gate. Onboards once, then leaves and re-enters the
 * dashboard (whose force field owns a WebGL context) N times, and requires the
 * number of live contexts to stay bounded.
 *
 * Why: three.js keeps one module-level DFG LUT texture; every WebGLRenderer
 * that uploads it adds a dispose listener and never removes it, so each
 * dashboard visit leaked a renderer, its context, canvas and scene. Measured
 * before the fix: 20 visits, 21 contexts alive after a forced GC (Chromium),
 * and WebKit logging "too many active WebGL contexts".
 *
 *   chromium: contexts still reachable after a forced GC (CDP) <= MAX_LIVE
 *   webkit:   no "too many active WebGL contexts" console message
 *             (WebKit counts a context as active until it is collected).
 *             macOS only: Linux Playwright WebKit has no usable OPFS.
 *
 * Usage: node scripts/verify-webgl-contexts.mjs http://127.0.0.1:4199 --browser=chromium [--visits=10]
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, devices, webkit } from '@playwright/test'

const BASE_URL = process.argv.find((argument) => /^https?:\/\//.test(argument)) ?? 'http://127.0.0.1:4199'
const BROWSER_NAME = process.argv.find((a) => a.startsWith('--browser='))?.slice(10) ?? 'chromium'
const VISITS = Number(process.argv.find((a) => a.startsWith('--visits='))?.slice(9) ?? '10')
// The current dashboard's context plus, at most, one not yet collected.
const MAX_LIVE = 2
const TOO_MANY = /too many active WebGL contexts/i

function invariant(condition, message) {
  if (!condition) throw new Error(`webgl-contexts (${BROWSER_NAME}): ${message}`)
}

/** Track every WebGL context the page creates, weakly, so GC still works. */
function trackContexts() {
  const created = []
  const original = window.HTMLCanvasElement.prototype.getContext
  window.HTMLCanvasElement.prototype.getContext = function getContext(type, ...rest) {
    const context = original.call(this, type, ...rest)
    if (context !== null && /webgl/.test(type) && !created.some((ref) => ref.deref() === context)) {
      created.push(new WeakRef(context))
    }
    return context
  }
  window.__webglContexts = () => ({
    created: created.length,
    live: created.filter((ref) => ref.deref() !== undefined).length,
  })
}

async function typeSections(page, testId, digits, trailing = '') {
  await page.locator(`[data-testid="${testId}"] [role="spinbutton"]`).first().click()
  await page.keyboard.type(digits, { delay: 30 })
  if (trailing) await page.keyboard.type(trailing, { delay: 30 })
}

async function onboard(page) {
  await page.goto('/onboarding')
  await page.getByTestId('name-input').fill('WebGL Contexts')
  await page.getByTestId('next-button').click()
  await typeSections(page, 'birth-date-input', '08081988')
  await page.getByTestId('next-button').click()
  await page.getByTestId('location-search-input').fill('Bengaluru')
  await page.locator('[role="option"]').first().click({ timeout: 120_000 })
  await page.getByTestId('next-button').click()
  await typeSections(page, 'birth-time-input', '0644', 'a')
  await page.getByTestId('confidence-option-exact').click()
  await page.getByTestId('next-button').click()
  await page.getByTestId('skip-life-events-button').click()
  await page.waitForURL('**/dashboard', { timeout: 300_000 })
}

const forceFieldCanvas = (page) => page.locator('[data-testid="chart-visualization"] canvas').first()

async function navigate(page, path) {
  await page.evaluate((target) => {
    window.history.pushState({}, '', target)
    window.dispatchEvent(new window.PopStateEvent('popstate'))
  }, path)
}

const { defaultBrowserType: _ignored, ...iPhone } = devices['iPhone 13']
// Linux Playwright WebKit cannot open SQLite's nested-Worker OPFS, so the app
// shows its storage block screen and never reaches the dashboard. Refuse rather
// than fail on onboarding: run the WebKit pass on macOS.
invariant(
  BROWSER_NAME !== 'webkit' || process.platform !== 'linux',
  'needs a WebKit with working OPFS (macOS); Linux Playwright WebKit refuses it',
)
// A persistent, on-disk profile like a real Safari/iOS profile: an ephemeral
// WebKit context has no OPFS, and AlmaMesh (SQLite on OPFS only) refuses to run
// without it (see verify-webkit-engine.mjs).
const userDataDir = await mkdtemp(join(tmpdir(), 'almamesh-webgl-contexts-'))
const context = await (BROWSER_NAME === 'webkit' ? webkit : chromium).launchPersistentContext(userDataDir, {
  ...iPhone,
  baseURL: BASE_URL,
  headless: true,
})
try {
  await context.addInitScript(trackContexts)
  const page = await context.newPage()
  const tooMany = []
  page.on('console', (message) => {
    if (TOO_MANY.test(message.text())) tooMany.push(message.text())
  })
  await onboard(page)
  await forceFieldCanvas(page).waitFor({ timeout: 120_000 })
  for (let visit = 0; visit < VISITS; visit += 1) {
    await navigate(page, '/settings')
    await page.waitForTimeout(600)
    await navigate(page, '/dashboard')
    await forceFieldCanvas(page)
      .waitFor({ state: 'attached', timeout: 60_000 })
      .catch(async () => {
        const state = await page.evaluate(() => ({ contexts: window.__webglContexts(), text: document.body.innerText.slice(0, 200) }))
        throw new Error(`webgl-contexts (${BROWSER_NAME}): visit ${visit + 1} drew no force field: ${JSON.stringify(state)}`)
      })
    await page.waitForTimeout(800)
  }
  await navigate(page, '/settings')
  // R3F disposes an unmounted root after a short delay.
  await page.waitForTimeout(1_500)
  let counts = await page.evaluate(() => window.__webglContexts())
  if (BROWSER_NAME === 'chromium') {
    const cdp = await context.newCDPSession(page)
    await cdp.send('HeapProfiler.collectGarbage')
    await page.waitForTimeout(300)
    await cdp.send('HeapProfiler.collectGarbage')
    counts = await page.evaluate(() => window.__webglContexts())
  }
  console.log(`webgl-contexts ${BROWSER_NAME} visits=${VISITS} ${JSON.stringify({ ...counts, tooManyWarnings: tooMany.length })}`)
  invariant(counts.created > VISITS, `expected a context per visit, saw ${counts.created}`)
  invariant(tooMany.length === 0, `"${tooMany[0]}" logged ${tooMany.length} times`)
  if (BROWSER_NAME === 'chromium') {
    invariant(counts.live <= MAX_LIVE, `${counts.live} WebGL contexts still reachable after ${VISITS} visits and a forced GC (max ${MAX_LIVE})`)
  }
} finally {
  await context.close()
  await rm(userDataDir, { recursive: true, force: true })
}
