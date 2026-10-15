#!/usr/bin/env node
/**
 * REAL first-run onboarding journey — the exact path a brand-new visitor walks,
 * driven end-to-end in headless Chromium (Playwright) against a NO-HOOKS
 * production build with the REAL in-browser Pyodide engine. Nothing is stubbed
 * and NOTHING is seeded via `window.__almameshGenerate`.
 *
 * This is the gate the hooked exit gate can NOT be: the hooked gates build with
 * VITE_EXIT_GATE_HOOKS=1 and inject the chart, bypassing onboarding → engine
 * bootstrap → Generate → dashboard entirely. A green hooked gate has shipped a
 * permanently-stuck real first-run before (scar 2026-06-19). This script drives
 * the actual UI: it types the name, drives the MUI X v8 DatePicker /
 * TimePicker section spinbuttons (focus-first-section-then-type — the accessible
 * DOM has NO fillable <input>, which is what stalled the earlier attempt),
 * runs the online-primary city typeahead (offline fallback), picks birth-time confidence, skips life
 * events, clicks Generate, and then WAITS for the real ~38 MB engine bootstrap
 * + on-device compute before asserting a chart renders on /dashboard with a
 * clean console.
 *
 * Build + run (module Workers need a production build; `vite dev` won't boot the
 * engine):
 *   cd frontend/apps/web
 *   VITE_API_URL= bun run build          # NO VITE_EXIT_GATE_HOOKS — real path
 *   bun run preview                      # port 4173
 *   node scripts/verify-real-onboarding.mjs http://localhost:4173
 *
 * Screenshots land in /tmp/almamesh-proof-real-onboarding/. Exit code is
 * non-zero if any step fails or the console logs an error.
 */

import { mkdirSync } from 'node:fs'
import { chromium } from '@playwright/test'
import { passOnboardingAiStep } from './onboardingAiStep.mjs'

const BASE_URL = process.argv[2] ?? 'http://localhost:4173'
const PROOF_DIR = '/tmp/almamesh-proof-real-onboarding'
mkdirSync(PROOF_DIR, { recursive: true })

// Synthetic reference native — NO real birth data. Bengaluru, 08 Aug 1988,
// 06:44 local (the same fixture the other live gates use). The chart's exact
// content is irrelevant here; we assert only that the journey produces one.
const REF = {
  name: 'Reference Native',
  date: '08081988', // MM DD YYYY, typed into the date field's spinbuttons
  time: '0644', // hh mm, then meridiem 'a'
  meridiem: 'a', // AM
  city: 'Bengaluru',
}

const results = []
function record(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`)
}

const consoleErrors = []
const pageErrors = []
function wireConsole(page) {
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text())
  })
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  page.on('worker', (w) => {
    w.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(`[worker] ${m.text()}`)
    })
  })
}

async function shot(page, name) {
  const path = `${PROOF_DIR}/${name}`
  await page.screenshot({ path, fullPage: false }).catch(() => {})
  return path
}

/**
 * Drive a MUI X v8 accessible picker field (DatePicker / TimePicker). The
 * visible field is NOT an <input> — it is a row of contenteditable
 * role="spinbutton" section spans. Focus the first section, then type the
 * digits; MUI auto-advances section→section. `trailing` (e.g. 'a' for the
 * AM/PM meridiem section) is typed last.
 */
async function driveSectionField(page, testid, digits, trailing) {
  const first = page.locator(`[data-testid="${testid}"] [role="spinbutton"]`).first()
  await first.click()
  await page.keyboard.type(digits, { delay: 60 })
  if (trailing) await page.keyboard.type(trailing, { delay: 60 })
}

async function main() {
  const browser = await chromium.launch()
  // A pristine context = a genuine first-time visitor (no chart, empty OPFS).
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  wireConsole(page)

  // ---- Step 1: land on onboarding (fresh visitor, no chart) ----
  await page.goto(`${BASE_URL}/onboarding`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-testid="name-input"]', { timeout: 20_000 })
  record('1 — onboarding first screen reachable (name step)', true, page.url())
  await shot(page, '01-name.png')

  // ---- Step 2: name ----
  await page.getByTestId('name-input').fill(REF.name)
  await page.getByTestId('next-button').click()

  // ---- Step 3: birth date (MUI X v8 DatePicker sections) ----
  await page.waitForSelector('[data-testid="birth-date-input"]', { timeout: 15_000 })
  await driveSectionField(page, 'birth-date-input', REF.date)
  // The Continue button only enables once a COMPLETE, in-range date commits to
  // the store (isStepValid) — so an enabled button proves the field was driven.
  await page.waitForSelector('[data-testid="next-button"]:not([disabled])', { timeout: 10_000 })
  record('2 — birth date committed via section spinbuttons (Continue enabled)', true, REF.date)
  await shot(page, '02-date.png')
  await page.getByTestId('next-button').click()

  // ---- Step 4: birth location (online-primary typeahead, offline fallback) ----
  await page.waitForSelector('[data-testid="location-search-input"]', { timeout: 15_000 })
  await page.getByTestId('location-search-input').fill(REF.city)
  // Debounced 250 ms + online geocode (or offline city-DB fallback) → wait for
  // the listbox, then pick #1. Either path resolves a major city like Bengaluru.
  await page.waitForSelector('[role="option"]', { timeout: 15_000 })
  const firstOption = page.locator('[role="option"]').first()
  const optionText = (await firstOption.innerText()).replace(/\s+/g, ' ').trim()
  await firstOption.click()
  await page.waitForSelector('[data-testid="next-button"]:not([disabled])', { timeout: 10_000 })
  record('3 — city search selected a match', true, optionText)
  await shot(page, '03-location.png')
  await page.getByTestId('next-button').click()

  // ---- Step 5: birth time (MUI X v8 TimePicker sections) + confidence ----
  await page.waitForSelector('[data-testid="birth-time-input"]', { timeout: 15_000 })
  await driveSectionField(page, 'birth-time-input', REF.time, REF.meridiem)
  // 'exact' confidence → the flow routes to /dashboard (not /rectify).
  await page.getByTestId('confidence-option-exact').click()
  await page.waitForSelector('[data-testid="next-button"]:not([disabled])', { timeout: 10_000 })
  record('4 — birth time committed via section spinbuttons + confidence=exact', true, `${REF.time}${REF.meridiem}`)
  await shot(page, '04-time.png')
  await page.getByTestId('next-button').click()

  // ---- Step 6: life events → skip ----
  await page.waitForSelector('[data-testid="skip-life-events-button"]', { timeout: 15_000 })
  await page.getByTestId('skip-life-events-button').click()

  // ---- Step 7: generating → REAL engine bootstrap + compute ----
  // Success navigates to /dashboard; a bootstrap/compute failure surfaces the
  // recovery card (retry/reset). Race the two so a failure fails FAST with the
  // on-screen error instead of hanging to the timeout.
  await page.waitForSelector('[data-testid="still-warming-hint"], h2', { timeout: 10_000 }).catch(() => {})
  await shot(page, '05-generating.png')

  const outcome = await Promise.race([
    passOnboardingAiStep(page, { timeout: 180_000 }).then((via) => {
      // No AI is set up in this fresh profile, so the AI step must show first.
      record('5a — no AI set up: the onboarding AI step shows, and "Not now" reaches /dashboard', via === 'ai-step', `via=${via}`)
      return 'dashboard'
    }),
    page
      .waitForSelector('[data-testid="retry-generation-button"]', { timeout: 180_000 })
      .then(() => 'error-card'),
  ]).catch(() => 'timeout')

  if (outcome !== 'dashboard') {
    const errText = await page
      .locator('h2, [data-testid="interpretation-error"], p')
      .allInnerTexts()
      .then((t) => t.join(' | ').slice(0, 300))
      .catch(() => '(no text)')
    record('5 — engine bootstrap + Generate reaches /dashboard', false, `outcome=${outcome}; screen="${errText}"`)
    await shot(page, '06-generate-FAILED.png')
    return finish(browser)
  }

  // ---- Step 8: dashboard renders a real chart ----
  await page.waitForSelector('[data-testid="identity-strip"]', { timeout: 30_000 })
  const hasChartViz = await page.locator('[data-testid="chart-visualization"]').count()
  const stripText = (await page.locator('[data-testid="identity-strip"]').innerText())
    .replace(/\s+/g, ' ')
    .trim()
  record('5 — engine bootstrap + Generate reaches /dashboard', true, page.url())
  record('6 — dashboard renders the identity strip (real chart)', stripText.length > 0, stripText.slice(0, 120))
  record('7 — chart visualization present', hasChartViz > 0, `count=${hasChartViz}`)
  await shot(page, '06-dashboard.png')

  // ---- Console hygiene across the whole journey ----
  record(
    '8 — clean console (no errors / page errors) through the journey',
    consoleErrors.length === 0 && pageErrors.length === 0,
    `console=${consoleErrors.length} page=${pageErrors.length}${
      consoleErrors.length ? ` :: ${consoleErrors.slice(0, 3).join(' | ')}` : ''
    }${pageErrors.length ? ` :: ${pageErrors.slice(0, 3).join(' | ')}` : ''}`,
  )

  return finish(browser)
}

async function finish(browser) {
  await browser.close()
  const failed = results.filter((r) => !r.pass)
  console.log(`\n${'='.repeat(60)}`)
  console.log(`REAL onboarding journey: ${results.length - failed.length}/${results.length} checks passed`)
  console.log(`Proof: ${PROOF_DIR}`)
  if (failed.length) {
    console.log(`FAILED: ${failed.map((f) => f.name).join('; ')}`)
    process.exit(1)
  }
  console.log('ALL PASS ✅')
  process.exit(0)
}

main().catch((err) => {
  console.error('FATAL:', err)
  process.exit(1)
})
