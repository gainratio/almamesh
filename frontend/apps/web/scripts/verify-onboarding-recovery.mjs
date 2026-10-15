#!/usr/bin/env node
/**
 * UNHAPPY boot-path recovery gate — the companion to verify-real-onboarding.mjs.
 *
 * The happy gate proves a good first-run works. This one proves the BAD one is
 * survivable: a cold first visit whose engine bundle can't be fetched (a
 * failed/stale/blocked bundle) must NOT dead-end on a silent "still warming"
 * hang — it must surface the in-app recovery card (Retry / Reset & reload), and
 * Retry (once the bundle is reachable again) must actually recover to a rendered
 * chart. This is the CLAUDE.md engine-recovery invariant, driven live with the
 * REAL engine (no hooks, no seeding) — the exact scar class from 2026-06-19
 * where a fire-once bootstrap left a returning visitor permanently stuck.
 *
 * Interception uses context.route to abort only the engine DATA (/bundle/,
 * /pyodide/, /public.key) — the app shell + offline city DB still load, so the
 * onboarding FORM works and only the engine BOOTSTRAP fails, exactly as a real
 * bundle outage would present. (Same abort technique verify-exit-gate.mjs uses.)
 *
 * Build + run (NO hooks — the real path):
 *   cd frontend/apps/web
 *   VITE_API_URL= bun run build
 *   bun run preview            # port 4173
 *   node scripts/verify-onboarding-recovery.mjs http://localhost:4173
 */

import { mkdirSync } from 'node:fs'
import { chromium } from '@playwright/test'
import { passOnboardingAiStep } from './onboardingAiStep.mjs'

const BASE_URL = process.argv[2] ?? 'http://localhost:4173'
const PROOF_DIR = '/tmp/almamesh-proof-onboarding-recovery'
mkdirSync(PROOF_DIR, { recursive: true })

const REF = { name: 'Reference Native', date: '08081988', time: '0644', meridiem: 'a', city: 'Bengaluru' }

// Engine-data requests to abort to simulate a failed/stale/blocked bundle. The
// app shell (/assets/*), fonts, and the offline city DB are left alone so the
// onboarding form still works — only the engine bootstrap is starved.
const ENGINE_DATA = ['/bundle/', '/pyodide/', '/public.key']

const results = []
function record(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`)
}

async function shot(page, name) {
  await page.screenshot({ path: `${PROOF_DIR}/${name}`, fullPage: false }).catch(() => {})
}

/** Drive a MUI X v8 accessible picker field: focus the first section, then type. */
async function driveSectionField(page, testid, digits, trailing) {
  const first = page.locator(`[data-testid="${testid}"] [role="spinbutton"]`).first()
  await first.click()
  await page.keyboard.type(digits, { delay: 60 })
  if (trailing) await page.keyboard.type(trailing, { delay: 60 })
}

/** Walk the onboarding form up to (and clicking) the final Generate button. */
async function driveOnboardingToGenerate(page) {
  await page.waitForSelector('[data-testid="name-input"]', { timeout: 20_000 })
  await page.getByTestId('name-input').fill(REF.name)
  await page.getByTestId('next-button').click()

  await page.waitForSelector('[data-testid="birth-date-input"]', { timeout: 15_000 })
  await driveSectionField(page, 'birth-date-input', REF.date)
  await page.waitForSelector('[data-testid="next-button"]:not([disabled])', { timeout: 10_000 })
  await page.getByTestId('next-button').click()

  await page.waitForSelector('[data-testid="location-search-input"]', { timeout: 15_000 })
  await page.getByTestId('location-search-input').fill(REF.city)
  await page.waitForSelector('[role="option"]', { timeout: 15_000 })
  await page.locator('[role="option"]').first().click()
  await page.waitForSelector('[data-testid="next-button"]:not([disabled])', { timeout: 10_000 })
  await page.getByTestId('next-button').click()

  await page.waitForSelector('[data-testid="birth-time-input"]', { timeout: 15_000 })
  await driveSectionField(page, 'birth-time-input', REF.time, REF.meridiem)
  await page.getByTestId('confidence-option-exact').click()
  await page.waitForSelector('[data-testid="next-button"]:not([disabled])', { timeout: 10_000 })
  await page.getByTestId('next-button').click()

  await page.waitForSelector('[data-testid="skip-life-events-button"]', { timeout: 15_000 })
  await page.getByTestId('skip-life-events-button').click()
}

async function main() {
  const browser = await chromium.launch()
  const ctx = await browser.newContext()
  const page = await ctx.newPage()

  // ---- Starve the engine: abort every engine-data fetch (cold, empty OPFS) ----
  let abortedCount = 0
  await ctx.route('**/*', (route) => {
    const url = route.request().url()
    if (ENGINE_DATA.some((frag) => url.includes(frag))) {
      abortedCount += 1
      return route.abort('failed')
    }
    return route.continue()
  })

  // ---- Drive the real onboarding form, then click Generate ----
  await page.goto(`${BASE_URL}/onboarding`, { waitUntil: 'domcontentloaded' })
  await driveOnboardingToGenerate(page)
  record('1 — onboarding form completes even with the engine bundle blocked', true, `engine fetches aborted so far: ${abortedCount}`)

  // ---- The bundle can't load → the in-app recovery card MUST appear ----
  // No silent permanent "still warming" hang: Retry + Reset & reload are shown.
  const recovered = await page
    .waitForSelector('[data-testid="retry-generation-button"]', { timeout: 90_000 })
    .then(() => true)
    .catch(() => false)
  const hasReset = await page.locator('[data-testid="reset-app-data-button"]').count()
  record(
    '2 — failed bootstrap surfaces the in-app recovery card (Retry + Reset), not a dead-end',
    recovered && hasReset > 0,
    `retry=${recovered} reset=${hasReset} abortedEngineFetches=${abortedCount}`,
  )
  await shot(page, '01-recovery-card.png')
  if (!recovered) return finish(browser)

  // ---- "Fix" the network, click Retry → the bootstrap must actually recover ----
  await ctx.unroute('**/*')
  await page.getByTestId('retry-generation-button').click()

  const outcome = await Promise.race([
    passOnboardingAiStep(page, { timeout: 180_000 }).then(() => 'dashboard'),
    page.waitForSelector('[data-testid="reset-app-data-button"]', { timeout: 180_000 }).then(() => 'still-error'),
  ]).catch(() => 'timeout')
  const chartRendered =
    outcome === 'dashboard' &&
    (await page
      .waitForSelector('[data-testid="identity-strip"]', { timeout: 30_000 })
      .then(() => true)
      .catch(() => false))
  record(
    '3 — Retry after the bundle is reachable again recovers to a rendered chart',
    chartRendered,
    `outcome=${outcome} url=${page.url()}`,
  )
  await shot(page, '02-recovered-dashboard.png')

  return finish(browser)
}

async function finish(browser) {
  await browser.close()
  const failed = results.filter((r) => !r.pass)
  console.log(`\n${'='.repeat(60)}`)
  console.log(`Unhappy boot-path recovery: ${results.length - failed.length}/${results.length} checks passed`)
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
