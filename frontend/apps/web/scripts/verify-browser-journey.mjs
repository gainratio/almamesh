#!/usr/bin/env node

/**
 * The real first-run journey in any Playwright browser, timed and with a clean
 * console: open /onboarding, onboard, wait for the chart on /dashboard, reload,
 * and require the chart again.
 *
 * Why it exists: AlmaMesh has to work on Chrome, Edge, Firefox and Safari, and
 * on low-powered devices. Until 2026-10-04 CI drove only Chromium and Linux
 * WebKit. A measured audit then found Firefox logging 25 SqliteStateConflictError
 * lines per boot (the app's own writes racing each other's SQLite epoch) that
 * no Chromium lane could see, because Chromium does not log those worker
 * exceptions.
 *
 * Usage:
 *   node scripts/verify-browser-journey.mjs http://127.0.0.1:4199 --browser=firefox
 *   node scripts/verify-browser-journey.mjs http://127.0.0.1:4199 --browser=chromium --channel=msedge
 *   node scripts/verify-browser-journey.mjs http://127.0.0.1:4199 --browser=chromium \
 *     --cpu-throttle=4 --ready-budget-ms=20000 --chart-budget-ms=240000
 *
 * Budgets are wall-clock, measured end to end. CDP's CPU throttle slows only the
 * page's main thread; the SQLite, engine and embedder Workers run at full speed.
 * The low-end CI lane therefore also pins the whole browser to one CPU core
 * (`taskset -c 0`), which slows the Workers too, and the chart budget covers
 * everything a Worker does between Generate and the drawn chart.
 *
 *   ready = navigation start -> onboarding form usable (SQLite open + hydration)
 *   chart = Generate clicked  -> chart drawn (engine download, boot, compute)
 *
 * Memory is REPORT ONLY (not gated yet): one `memory-report journey-...` line
 * with the RSS peak of the browser's process tree over the whole journey
 * (Linux /proc; null elsewhere) and the page+workers JS/wasm heap after the
 * chart where the browser exposes measureUserAgentSpecificMemory (null in the
 * Chromium headless shell and Firefox, with the reason).
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { chromium, firefox, webkit } from '@playwright/test'

import { formatMemoryReport, processTreeReport, sampleProcessTreePeak } from './processMemory.mjs'

const BROWSERS = { chromium, firefox, webkit }

function option(name, fallback) {
  const prefix = `--${name}=`
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) ?? fallback
}

const BASE_URL = process.argv.find((argument) => /^https?:\/\//.test(argument)) ?? 'http://127.0.0.1:4199'
const BROWSER_NAME = option('browser', 'chromium')
const CHANNEL = option('channel', undefined)
const CPU_THROTTLE = Number(option('cpu-throttle', '1'))
const READY_BUDGET_MS = Number(option('ready-budget-ms', '60000'))
const CHART_BUDGET_MS = Number(option('chart-budget-ms', '240000'))
const LABEL = CHANNEL ?? BROWSER_NAME

function invariant(condition, message) {
  if (!condition) throw new Error(`browser-journey (${LABEL}): ${message}`)
}

invariant(BROWSERS[BROWSER_NAME], `unsupported browser ${BROWSER_NAME}; use chromium, firefox, or webkit`)
invariant(CPU_THROTTLE === 1 || BROWSER_NAME === 'chromium', 'CPU throttling needs Chromium (CDP)')
for (const [name, value] of [['cpu-throttle', CPU_THROTTLE], ['ready-budget-ms', READY_BUDGET_MS], ['chart-budget-ms', CHART_BUDGET_MS]]) {
  invariant(Number.isFinite(value) && value > 0, `--${name} must be a positive number`)
}

/** Every error a user's devtools would show: page console, uncaught errors, and Worker consoles. */
function recordConsole(page, errors) {
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(`uncaught: ${error.message}`))
  page.on('worker', (worker) => {
    worker.on('console', (message) => {
      if (message.type() === 'error') errors.push(`worker: ${message.text()}`)
    })
  })
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

async function throttle(context, page) {
  if (CPU_THROTTLE === 1) return
  const cdp = await context.newCDPSession(page)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE })
}

async function bodyText(page) {
  return (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300)
}

/** Which storage the app says it is on: opfs (no note) or memory. */
async function storageNote(page) {
  const note = page.getByTestId('ephemeral-storage-notice')
  return (await note.isVisible().catch(() => false)) ? await note.getAttribute('data-durability') : 'opfs'
}

const seconds = (milliseconds) => `${(milliseconds / 1000).toFixed(1)}s`

/** Page+workers heap in MiB, or the reason it cannot be read in this browser. */
async function pageHeapReport(page) {
  return page.evaluate(async () => {
    const isolated = globalThis.crossOriginIsolated
    if (!isolated || performance.measureUserAgentSpecificMemory === undefined) {
      return { heapAfterChartMiB: null, heapReason: `measureUserAgentSpecificMemory unavailable (crossOriginIsolated=${isolated})` }
    }
    return { heapAfterChartMiB: (await performance.measureUserAgentSpecificMemory()).bytes / (1024 * 1024) }
  }).catch((error) => ({ heapAfterChartMiB: null, heapReason: String(error).replace(/\s+/g, ' ').slice(0, 240) }))
}

// The whole journey's process tree, sampled from outside the page every second.
const rssSampler = sampleProcessTreePeak(1_000)
const profile = mkdtempSync(join(tmpdir(), `almamesh-journey-${LABEL}-`))
// A persistent profile: a pristine first visit whose storage survives the reload.
const context = await BROWSERS[BROWSER_NAME].launchPersistentContext(profile, {
  headless: true,
  ...(CHANNEL ? { channel: CHANNEL } : {}),
})
try {
  const page = context.pages()[0] ?? (await context.newPage())
  const errors = []
  recordConsole(page, errors)
  await throttle(context, page)

  const navigated = Date.now()
  await page.goto(new URL('/onboarding', BASE_URL).href, { waitUntil: 'commit' })
  await page.getByTestId('name-input').waitFor({ state: 'visible', timeout: READY_BUDGET_MS })
    .catch(() => invariant(false, `onboarding was not usable within the ${seconds(READY_BUDGET_MS)} budget`))
  const ready = Date.now() - navigated
  invariant(ready <= READY_BUDGET_MS, `onboarding took ${seconds(ready)}, budget ${seconds(READY_BUDGET_MS)}`)

  await onboard(page)
  const generated = Date.now()
  await page.getByTestId('chart-visualization').first()
    .waitFor({ state: 'visible', timeout: CHART_BUDGET_MS })
    // The console carries the engine's typed boot failure; the page text alone
    // only says "Connection Issue" (Edge, #244 CI run 37313819528).
    .catch(async () => invariant(false, `no chart within ${seconds(CHART_BUDGET_MS)} of Generate: ${await bodyText(page)}`
      + ` | console (${errors.length}): ${errors.slice(0, 5).join(' | ')}`))
  const chart = Date.now() - generated
  invariant(page.url().endsWith('/dashboard'), `the chart rendered on ${page.url()}, not /dashboard`)
  const heapReport = await pageHeapReport(page)

  await page.reload({ waitUntil: 'commit' })
  const reloaded = Date.now()
  await page.getByTestId('chart-visualization').first()
    .waitFor({ state: 'visible', timeout: READY_BUDGET_MS })
    .catch(async () => invariant(false, `the chart did not come back within ${seconds(READY_BUDGET_MS)} of a reload `
      + `(${page.url()}; storage ${await storageNote(page)}): ${await bodyText(page)}`))
  const reload = Date.now() - reloaded

  invariant(errors.length === 0, `console was not clean (${errors.length}): ${errors.slice(0, 5).join(' | ')}`)
  const browserVersion = context.browser()?.version() ?? 'persistent'
  console.log(
    `browser-journey: ${LABEL} ${browserVersion} cpu-throttle=${CPU_THROTTLE}x ready=${seconds(ready)} `
    + `chart=${seconds(chart)} reload=${seconds(reload)} console=clean`,
  )
  console.log(formatMemoryReport(`journey-${LABEL}-${CPU_THROTTLE}x`, {
    ...processTreeReport(await rssSampler.stop(), ['renderer', 'gpu', 'browser', 'webkit-web']),
    ...heapReport,
  }))
} finally {
  await rssSampler.stop()
  await context.close()
  rmSync(profile, { recursive: true, force: true })
}
