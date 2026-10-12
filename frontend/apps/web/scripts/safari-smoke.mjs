#!/usr/bin/env node
/**
 * Real-Safari smoke. Every other "WebKit" check runs Playwright's bundled
 * WebKit build, which is not the Safari people use (different version, and
 * different OPFS behaviour). This drives the Safari installed on the Mac
 * through Apple's safaridriver (WebDriver), via selenium-webdriver.
 *
 * Journey, against a hook-free production build (the same build the WebKit
 * memory lane serves: VITE_EXIT_GATE_HOOKS empty, so nothing is seeded):
 *   shell        `/` renders the app shell
 *   isolation    crossOriginIsolated === true (SQLite on OPFS needs it)
 *   open-route   the onboarding route opens (`--route` overrides it)
 *   onboarding-* name, birth date, birthplace, birth time, skip life events
 *   engine       the real engine boots and Generate reaches /dashboard
 *   dashboard-chart  [data-testid="chart-visualization"] renders
 *   console      no console errors / page errors were captured
 * It also records the storage mode the app reports (OPFS, or in-memory SQLite
 * when Safari refused OPFS) and the Safari version.
 *
 * Console capture: safaridriver has no WebDriver log endpoint, so an injected
 * console.error / onerror / unhandledrejection wrapper collects errors after
 * each page load. Errors raised before injection and inside Workers are not
 * seen; that limit is printed in the result.
 *
 * On a timeout or failure it prints the stage name and a JSON snapshot (route,
 * heading, storage mode, runtime stage, last engine error) and saves a
 * screenshot. Evidence lands in safari-smoke-evidence/ (or --evidence).
 *
 * One-time Mac setup: Safari > Settings > Advanced > "Show features for web
 * developers", then Develop > "Allow Remote Automation", and
 * `sudo safaridriver --enable`.
 *
 *   cd frontend/apps/web
 *   bash scripts/setup-dev-assets.sh          # once: Pyodide + signed dev bundle
 *   node scripts/safari-smoke.mjs             # builds dist-safari, serves it, runs
 *   node scripts/safari-smoke.mjs --base-url http://127.0.0.1:4310   # reuse a preview
 */

import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Browser, Builder, By, until } from 'selenium-webdriver'

import { formatStageFailure, parseSmokeArgs, runStage, SafariSmokeStageError, storageModeFrom } from './safariSmoke.mjs'

const PORT = 4310
const DIST = 'dist-safari'
// The synthetic reference native the other real-onboarding gates use
// (scripts/verify-real-onboarding.mjs). No real birth data.
const FIXTURE = { name: 'Reference Native', date: '08081988', time: '0644', meridiem: 'a', city: 'Bengaluru' }
const SECONDS = 1_000

const options = parseSmokeArgs(process.argv.slice(2))
mkdirSync(options.evidenceDir, { recursive: true })
const evidence = (name) => join(options.evidenceDir, name)

function run(command, args, env = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', env: { ...process.env, ...env } })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${result.status}`)
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return
    } catch {
      // The preview is still starting; retry until the deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`preview at ${url} did not answer within ${timeoutMs} ms`)
}

async function startPreview() {
  const env = { VITE_API_URL: '', VITE_EXIT_GATE_HOOKS: '' }
  run('./node_modules/.bin/vite', ['build', '--outDir', DIST], env)
  const preview = spawn(
    './node_modules/.bin/vite',
    ['preview', '--outDir', DIST, '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
    { stdio: 'inherit', env: { ...process.env, ...env } },
  )
  const baseUrl = `http://127.0.0.1:${PORT}`
  await waitForHttp(`${baseUrl}/`, 60 * SECONDS)
  return { baseUrl, stop: () => preview.kill('SIGTERM') }
}

const INSTALL_ERROR_CAPTURE = `
  if (!window.__safariSmokeErrors) {
    const errors = (window.__safariSmokeErrors = [])
    const original = console.error
    console.error = function (...args) {
      errors.push(args.map((value) => (value instanceof Error ? value.message : String(value))).join(' '))
      return original.apply(this, args)
    }
    window.addEventListener('error', (event) => errors.push('error: ' + event.message))
    window.addEventListener('unhandledrejection', (event) => errors.push('unhandledrejection: ' + String(event.reason)))
  }`

const SNAPSHOT = `
  return {
    route: location.pathname,
    heading: (document.querySelector('h1, h2')?.textContent ?? '').trim().slice(0, 120) || null,
    inMemoryNotice: document.querySelector('[data-testid="in-memory-storage-notice"]') !== null,
    runtimeStage: window.__ALMAMESH_STAGE__ ?? null,
    lastErrorCode: window.__ALMAMESH_ERROR__ ?? null,
    capturedErrors: (window.__safariSmokeErrors ?? []).length,
  }`

async function snapshotOf(driver) {
  const raw = await driver.executeScript(SNAPSHOT)
  const { inMemoryNotice, ...rest } = raw
  return { ...rest, storageMode: storageModeFrom({ inMemoryNotice }) }
}

async function capturedErrors(driver) {
  return (await driver.executeScript('return window.__safariSmokeErrors ?? []')) ?? []
}

async function screenshot(driver, name) {
  try {
    writeFileSync(evidence(name), await driver.takeScreenshot(), 'base64')
    return evidence(name)
  } catch {
    return null
  }
}

async function typeSlowly(driver, text) {
  for (const character of text) {
    await driver.actions().sendKeys(character).perform()
    await driver.sleep(60)
  }
}

async function clickTestId(driver, testId, timeoutMs = 15 * SECONDS) {
  const element = await driver.wait(until.elementLocated(By.css(`[data-testid="${testId}"]`)), timeoutMs)
  await driver.wait(until.elementIsEnabled(element), timeoutMs)
  await element.click()
}

async function driveSectionField(driver, testId, digits, trailing = '') {
  const first = await driver.wait(
    until.elementLocated(By.css(`[data-testid="${testId}"] [role="spinbutton"]`)),
    15 * SECONDS,
  )
  await first.click()
  await typeSlowly(driver, digits + trailing)
}

async function waitForEnabledNext(driver) {
  await driver.wait(until.elementLocated(By.css('[data-testid="next-button"]:not([disabled])')), 10 * SECONDS)
}

function stages(driver, baseUrl, record) {
  return [
    ['shell', 30, async () => {
      await driver.get(`${baseUrl}/`)
      await driver.wait(async () => driver.executeScript("return document.querySelector('#root')?.childElementCount > 0"), 30 * SECONDS)
      await driver.executeScript(INSTALL_ERROR_CAPTURE)
      record.shell = await snapshotOf(driver)
    }],
    ['isolation', 10, async () => {
      const isolated = await driver.executeScript('return globalThis.crossOriginIsolated === true')
      record.crossOriginIsolated = isolated
      if (!isolated) throw new Error('crossOriginIsolated is not true on /')
      record.consoleErrors.push(...(await capturedErrors(driver)))
    }],
    ['open-route', 30, async () => {
      await driver.get(`${baseUrl}${options.route}`)
      await driver.executeScript(INSTALL_ERROR_CAPTURE)
    }],
    ['onboarding-name', 30, async () => {
      const input = await driver.wait(until.elementLocated(By.css('[data-testid="name-input"]')), 30 * SECONDS)
      await input.sendKeys(FIXTURE.name)
      await clickTestId(driver, 'next-button')
    }],
    ['onboarding-birth-date', 30, async () => {
      await driveSectionField(driver, 'birth-date-input', FIXTURE.date)
      await waitForEnabledNext(driver)
      await clickTestId(driver, 'next-button')
    }],
    ['onboarding-birthplace', 45, async () => {
      const input = await driver.wait(until.elementLocated(By.css('[data-testid="location-search-input"]')), 15 * SECONDS)
      await input.sendKeys(FIXTURE.city)
      const option = await driver.wait(until.elementLocated(By.css('[role="option"]')), 30 * SECONDS)
      record.birthplace = (await option.getText()).replace(/\s+/g, ' ').trim()
      await option.click()
      await waitForEnabledNext(driver)
      await clickTestId(driver, 'next-button')
    }],
    ['onboarding-birth-time', 30, async () => {
      await driveSectionField(driver, 'birth-time-input', FIXTURE.time, FIXTURE.meridiem)
      await clickTestId(driver, 'confidence-option-exact')
      await waitForEnabledNext(driver)
      await clickTestId(driver, 'next-button')
    }],
    ['onboarding-life-events', 30, async () => {
      await clickTestId(driver, 'skip-life-events-button')
    }],
    ['engine', 300, async () => {
      const outcome = await driver.wait(async () => {
        const state = await driver.executeScript(`return {
          path: location.pathname,
          error: window.__ALMAMESH_ERROR__ ?? null,
          recovery: document.querySelector('[data-testid="retry-generation-button"]') !== null,
        }`)
        if (state.path.endsWith('/dashboard')) return 'dashboard'
        if (state.error || state.recovery) return `engine error: ${state.error ?? 'recovery card shown'}`
        return false
      }, 300 * SECONDS)
      if (outcome !== 'dashboard') throw new Error(outcome)
    }],
    ['dashboard-chart', 60, async () => {
      await driver.wait(until.elementLocated(By.css('[data-testid="chart-visualization"]')), 60 * SECONDS)
      record.dashboard = await snapshotOf(driver)
      record.screenshots.push(await screenshot(driver, 'safari-dashboard.png'))
    }],
    ['console', 10, async () => {
      record.consoleErrors.push(...(await capturedErrors(driver)))
      if (record.consoleErrors.length > 0) {
        throw new Error(`${record.consoleErrors.length} console error(s): ${record.consoleErrors.slice(0, 3).join(' | ')}`)
      }
    }],
  ]
}

function safariVersions() {
  const driver = spawnSync('safaridriver', ['--version'], { encoding: 'utf8' })
  return { safaridriver: (driver.stdout || driver.stderr || '').trim() }
}

async function main() {
  const record = {
    route: options.route,
    versions: safariVersions(),
    consoleCapture: 'injected console.error/onerror/unhandledrejection after each load; Worker and pre-injection errors are not seen',
    consoleErrors: [],
    screenshots: [],
  }
  console.log(`safari-smoke: ${record.versions.safaridriver}`)
  const preview = options.baseUrl ? { baseUrl: options.baseUrl, stop: () => {} } : await startPreview()
  let driver
  try {
    driver = await new Builder().forBrowser(Browser.SAFARI).build()
    record.versions.userAgent = await driver.executeScript('return navigator.userAgent')
    console.log(`safari-smoke: userAgent ${record.versions.userAgent}`)
    for (const [stage, seconds, body] of stages(driver, preview.baseUrl, record)) {
      await runStage(stage, seconds * SECONDS, body, () => snapshotOf(driver))
      console.log(`safari-smoke: [PASS] ${stage}`)
    }
    record.result = 'pass'
    console.log(`safari-smoke: storage mode ${record.dashboard.storageMode}; chart rendered on ${record.dashboard.route}`)
  } catch (error) {
    record.result = 'fail'
    if (error instanceof SafariSmokeStageError) {
      record.failure = { stage: error.stage, message: error.message, snapshot: error.snapshot }
      if (driver) record.screenshots.push(await screenshot(driver, `safari-failure-${error.stage}.png`))
      console.error(formatStageFailure(error))
    } else {
      record.failure = { stage: 'setup', message: error instanceof Error ? error.message : String(error) }
      console.error(`safari-smoke FAILED at stage "setup": ${record.failure.message}`)
    }
  } finally {
    if (driver) await driver.quit().catch(() => {})
    preview.stop()
    writeFileSync(evidence('result.json'), `${JSON.stringify(record, null, 2)}\n`)
  }
  console.log(`safari-smoke: ${record.result}; evidence in ${options.evidenceDir}/`)
  process.exitCode = record.result === 'pass' ? 0 : 1
}

await main()
