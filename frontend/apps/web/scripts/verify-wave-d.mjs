#!/usr/bin/env node
/**
 * Wave-D LIVE end-to-end journey — REAL browser (headless Chromium via
 * Playwright), REAL in-browser Pyodide engine, NO stubbing.
 *
 * Drives the full predictive journey with the reference fixture chart
 * (Bengaluru, 08 Aug 1988, 06:44 IST == 01:14 UTC):
 *   a. dashboard + near-cusp Ascendant banner (Leo ~0.04 deg, Cancer cusp)
 *   b. "Sky & Timing" header link -> /predictive -> honest elapsed-time loading
 *      -> real ~35s+ compute -> Transits tab (Gochara + Sade Sati + timeline)
 *   c. Divisional Charts tab (D10 kundli), Strength tab (SAV 337),
 *      Life Domains tab (7 domain cards with windows)
 *   d. dasha display: current maha + antar + pratyantar (dashboard) and the
 *      julian_365_25 convention (report)
 *   e. /report full-reload -> report-predictive-pending affordance -> compute
 *      -> sections VI-IX render -> page.pdf()
 *   f. console clean throughout
 *   g. es spot-check: settings language select -> /predictive renders Spanish
 *
 * Expects the production build previewed with VITE_EXIT_GATE_HOOKS=1 (the
 * exit-gate observability hooks expose window.__almameshGenerate for seeding).
 *
 *   VITE_API_URL= VITE_EXIT_GATE_HOOKS=1 bun run build
 *   bun run preview            # port 4173
 *   node scripts/verify-wave-d.mjs http://localhost:4173
 *
 * Screenshots + PDF land in /tmp/almamesh-proof-wave-d/.
 */

import { mkdirSync } from 'node:fs'
import { Buffer } from 'node:buffer'
import { chromium } from '@playwright/test'
import { chartDayReferenceInstant } from './predictiveReference.mjs'
import { confirmLegacyBackupImport } from './confirmLegacyBackupImport.mjs'

const BASE_URL = process.argv[2] ?? 'http://localhost:4173'
const PROOF_DIR = '/tmp/almamesh-proof-wave-d'
mkdirSync(PROOF_DIR, { recursive: true })

// Reference fixture: Bengaluru, India, 08 Aug 1988, 06:44 Asia/Kolkata.
// IST is fixed UTC+5:30 (no DST) -> 01:14 UTC. referenceDate is pinned to
// midnight of the CHART's local day, exactly as predictiveReferenceInstant keys
// the predictive request, so the natal dasha "now" matches the predictive
// layer's own per-day reference instant (never the UTC calendar day).
const CHART_TIMEZONE = 'Asia/Kolkata'
const TODAY_REFERENCE_INSTANT = chartDayReferenceInstant(CHART_TIMEZONE)
const REFERENCE_BIRTH = {
  name: 'Reference Native',
  datetimeUtc: '1988-08-08T01:14:00.000Z',
  localDate: '1988-08-08',
  localTime: '06:44',
  latitude: 12.9716,
  longitude: 77.5946,
  timezone: CHART_TIMEZONE,
  referenceDate: TODAY_REFERENCE_INSTANT,
}

// /report is gated on a finished interpretation (useStreamingInterpretation
// must be 'complete'); the LLM is out of scope for this deterministic gate, so
// restore a compact complete reading through the shipped backup boundary.
const persona = (lead) => ({ layman: lead, technical: `${lead} (technical voice)` })
const titled = (title, lead) => ({ title, ...persona(lead) })
const INTERPRETATION = {
  summary: 'A chart built for endurance rather than spectacle.',
  strengths: [titled('Resilience', 'Staying power under load.')],
  challenges: [titled('Over-deliberation', 'The cost of caution.')],
  life_themes: [titled('The long apprenticeship', 'Slow compounding mastery.')],
  health_guidance: persona('Rhythm over intensity.'),
  relationship_guidance: persona('Depth over breadth.'),
  career_guidance: persona('A single deepening track.'),
  education_guidance: persona('Structured study.'),
  finances_guidance: persona('Durable beats fast.'),
  spiritual_guidance: persona('A steady practice.'),
  life_evolution_guidance: persona('Growing into stewardship.'),
  remedial_measures: persona('Simple and repeatable.'),
}

const results = []
function record(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`)
}

const consoleErrors = []
const consoleWarnings = []
const pageErrors = []

function wireConsole(page, label) {
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(`[${label}] ${m.text()}`)
    if (m.type() === 'warning') consoleWarnings.push(`[${label}] ${m.text()}`)
  })
  page.on('pageerror', (e) => pageErrors.push(`[${label}] ${String(e)}`))
  page.on('worker', (w) => {
    w.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(`[${label}:worker] ${m.text()}`)
    })
  })
}

async function bootEngine(page, timeoutMs = 240_000) {
  await page.waitForFunction(
    () => {
      const w = window
      if (w.__ALMAMESH_ERROR__) throw new Error(`engine boot error: ${w.__ALMAMESH_ERROR__}`)
      return w.__ALMAMESH_STAGE__ === 'ready' && typeof w.__almameshGenerate === 'function'
    },
    undefined,
    { timeout: timeoutMs, polling: 500 },
  )
}

async function shot(page, name, fullPage = false) {
  const path = `${PROOF_DIR}/${name}`
  await page.screenshot({ path, fullPage })
  return path
}

async function restoreBackup(page, backup) {
  await page.addInitScript(() => {
    Reflect.deleteProperty(window, 'showOpenFilePicker')
    Reflect.deleteProperty(window, 'showSaveFilePicker')
  })
  await page.goto(`${BASE_URL}/settings/data`, { waitUntil: 'domcontentloaded' })
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByTestId('backup-import-button').click(),
  ])
  await chooser.setFiles({
    name: 'verify-wave-d.json',
    mimeType: 'application/json',
    buffer: Buffer.from(backup, 'utf8'),
  })
  await confirmLegacyBackupImport(page)
}

async function clickTab(page, label) {
  await page.getByRole('tab', { name: label }).click()
}

async function main() {
  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  wireConsole(page, 'main')

  // ---- BOOT + GENERATE the founder chart with the REAL engine ----
  await page.goto(`${BASE_URL}/onboarding`, { waitUntil: 'domcontentloaded' })
  const t0 = Date.now()
  await bootEngine(page)
  const chart = await page.evaluate(async (birth) => {
    const c = await window.__almameshGenerate(birth)
    return {
      lagnaSign: c?.lagna?.sign ?? null,
      lagnaDegInSign: c?.lagna?.longitude != null ? c.lagna.longitude % 30 : null,
      mahaLord: c?.dashas?.current_maha?.lord ?? null,
      antarLord: c?.dashas?.current_antar?.lord ?? null,
      pratyantarLord: c?.dashas?.current_pratyantar?.lord ?? null,
      convention: c?.dashas?.convention ?? null,
      full: c,
    }
  }, REFERENCE_BIRTH)
  record(
    'A0 — engine boots + reference chart generates in-tab',
    chart.lagnaSign?.toLowerCase() === 'leo' && chart.lagnaDegInSign >= 0 && chart.lagnaDegInSign < 1,
    `boot+gen=${Date.now() - t0}ms lagna=${chart.lagnaSign} ${chart.lagnaDegInSign?.toFixed(2)} deg; maha=${chart.mahaLord} antar=${chart.antarLord} pratyantar=${chart.pratyantarLord} convention=${chart.convention}`,
  )

  // ---- RESTORE the fixture through Settings into canonical SQLite ----
  const backup = await page.evaluate(
    ({ chart, birth, interpretation }) => {
      const chartId = 'wave-d-reference-1988'
      const profileId = `${chartId}-profile`
      // The library stores the ADAPTER output (UI `VimshottariDashaData`), not
      // the raw engine dasha ctx — mirror @almamesh/store toDashaCtx
      // field-for-field (the IdentityStrip consumes the typed UI contract).
      const dashaLeg = (p, level) =>
        p
          ? {
              lord: p.lord,
              start_date: p.start_date,
              end_date: p.end_date,
              duration_years: p.duration_years,
              level,
            }
          : undefined
      const rawDashas = chart.dashas ?? {}
      const dashaCtx = rawDashas.current_maha
        ? {
            maha_dasha: dashaLeg(rawDashas.current_maha, 'maha'),
            ...(rawDashas.current_antar
              ? { antar_dasha: dashaLeg(rawDashas.current_antar, 'antar') }
              : {}),
            ...(rawDashas.current_pratyantar
              ? { pratyantar_dasha: dashaLeg(rawDashas.current_pratyantar, 'pratyantar') }
              : {}),
            full_sequence: (rawDashas.maha_dasha_sequence ?? []).map((p) => dashaLeg(p, 'maha')),
            ...(rawDashas.convention ? { convention: rawDashas.convention } : {}),
          }
        : undefined
      const stored = {
        chart_id: chartId,
        profile_id: profileId,
        person_name: birth.name,
        is_primary: true,
        birth_data: {
          name: birth.name,
          birth_datetime_utc: birth.datetimeUtc,
          birth_datetime_local: `${birth.localDate}T${birth.localTime}:00`,
          birth_time_confidence: 'approximate',
          birth_location_details: {
            city: 'Bengaluru',
            state: 'Karnataka',
            country: 'India',
            latitude: birth.latitude,
            longitude: birth.longitude,
            timezone: birth.timezone,
            location_name: 'Bengaluru, Karnataka, India',
          },
        },
        astronomical_calculations: {
          sidereal_ctx: {
            ayanamsa_value: chart.ayanamsa_value ?? 0,
            ayanamsa_type: 'lahiri',
            house_system: 'whole_sign',
            julian_day: 0,
            sidereal_time: 0,
            lagna: chart.lagna,
            planets: chart.planets,
          },
          varga_ctx: chart.varga_ctx ?? undefined,
          dasha_ctx: dashaCtx,
          yoga_ctx: chart.yogas ?? [],
          calculation_timestamp: birth.referenceDate,
          software_version: 'almamesh-browser-engine',
        },
        interpretation: undefined,
        sidereal_chart: chart,
      }
      return JSON.stringify({
        format: 'almamesh-backup',
        formatVersion: 1,
        app: { version: 'verify-wave-d' },
        exportedAt: '2025-01-01T00:00:00.000Z',
        encryption: 'none',
        stores: {
          'almamesh-profiles': {
            version: 1,
            state: {
              profiles: {
                [profileId]: {
                  id: profileId,
                  name: birth.name,
                  createdAt: '2025-01-01T00:00:00.000Z',
                  avatarTint: '#3A4FB0',
                  relationship: 'self',
                },
              },
              activeProfileId: profileId,
            },
          },
          'almamesh-chart-library': {
            version: 1,
            state: { charts: { [chartId]: stored } },
          },
          'almamesh-interpretations': {
            version: 6,
            state: {
              byChart: {
                [chartId]: {
                  profileId,
                  status: 'complete',
                  interpretation,
                  sections: {
                    core: true,
                    yoga: true,
                    guidance1: true,
                    guidance2: true,
                    remedial: true,
                  },
                  updatedAt: Date.now(),
                },
              },
            },
          },
        },
      })
    },
    { chart: chart.full, birth: REFERENCE_BIRTH, interpretation: INTERPRETATION },
  )
  await restoreBackup(page, backup)

  // ---- (a) DASHBOARD + near-cusp Ascendant banner ----
  await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3000)
  let bodyText = await page.evaluate(() => document.body.innerText)
  let cuspVisible = /from the Cancer cusp/i.test(bodyText)
  if (!cuspVisible) {
    // The AscendantBanner lives in the "For Astrologer" (technical) view.
    await page.click('[data-testid="astrologer-tab"]', { timeout: 10_000 }).catch(() => {})
    await page.waitForTimeout(2000)
    bodyText = await page.evaluate(() => document.body.innerText)
    cuspVisible = /from the Cancer cusp/i.test(bodyText)
  }
  const cuspDegrees = bodyText.match(/~([\d.]+)° from the Cancer cusp/i)?.[1] ?? null
  const refineLink = await page.locator('text=Refine your birth time').count()
  const p1 = await shot(page, '01-dashboard-cusp-banner.png')
  record(
    'A — dashboard loads with near-cusp Ascendant banner',
    cuspVisible && refineLink > 0 && /Leo/i.test(bodyText),
    `cusp="~${cuspDegrees} deg from Cancer" refineLink=${refineLink} leoOnScreen=${/Leo/i.test(bodyText)} -> ${p1}`,
  )

  // ---- (d-part-1) dashboard dasha display: maha + antar + pratyantar ----
  const mahaLordOnScreen = chart.mahaLord
    ? new RegExp(chart.mahaLord, 'i').test(bodyText)
    : false
  const dashaOk =
    !!chart.mahaLord &&
    mahaLordOnScreen &&
    !!chart.antarLord &&
    !!chart.pratyantarLord
  record(
    'D1 — dashboard shows the current mahadasha; engine emits antar + pratyantar',
    dashaOk,
    `maha=${chart.mahaLord} antar=${chart.antarLord} pratyantar=${chart.pratyantarLord} (maha lord on screen: ${mahaLordOnScreen})`,
  )

  // ---- (b) "Sky & Timing" header link -> /predictive -> loading copy -> compute ----
  // Switch back to the default "For You" view first: the astrologer view's
  // WebGL force-field canvas, GPU-stalled by the headless screenshot above
  // (ReadPixels), starves the lazy route's startTransition in this harness.
  // (Verified NOT a product bug: without the harness screenshot the link
  // navigates from the astrologer view in <3s — see Wave-D validation notes.)
  await page.click('[data-testid="layman-tab"]', { timeout: 10_000 }).catch(() => {})
  await page.waitForTimeout(1500)
  await page.click('[data-testid="predictive-link"]')
  await page.waitForURL('**/predictive', { timeout: 10_000 })
  // DOM-level wait: the lazy route chunk mounts inside a React Router
  // startTransition (the old dashboard UI stays on screen until it resolves).
  try {
    await page.waitForFunction(
      () => document.querySelector('[data-testid="predictive-page"]') !== null,
      undefined,
      { timeout: 90_000, polling: 500 },
    )
  } catch (e) {
    await shot(page, 'debug-predictive-mount-failure.png', true)
    console.log(`debug: url=${page.url()} predictive-page-count=${await page
      .locator('[data-testid="predictive-page"]')
      .count()}`)
    throw e
  }
  // Loading card with honest elapsed-time copy (auto compute starts when engine ready).
  let loadingCopy = null
  try {
    await page.waitForSelector('[data-testid="predictive-loading"]', { timeout: 60_000 })
    await page.waitForTimeout(2500) // let the elapsed counter tick
    loadingCopy = await page
      .locator('[data-testid="predictive-loading"]')
      .innerText()
      .catch(() => null)
    await shot(page, '02a-predictive-loading.png')
  } catch {
    // compute may have been very fast (or panel already ready) — tolerated below
  }
  // The live counter renders m:ss ("0:04 elapsed") — accept that or "Ns".
  const elapsedCopyOk = loadingCopy
    ? /elapsed/i.test(loadingCopy) && /(\d+:\d{2}|\d+\s*s)/i.test(loadingCopy)
    : false
  record(
    'B1 — /predictive shows honest elapsed-time loading copy',
    elapsedCopyOk,
    loadingCopy ? `copy="${loadingCopy.replace(/\n/g, ' | ').slice(0, 180)}"` : 'loading card never observed',
  )

  // Wait for the REAL compute to finish (3+ min allowance).
  const tCompute = Date.now()
  await page.waitForSelector('[data-testid="transits-panel"]', { timeout: 300_000 })
  const computeMs = Date.now() - tCompute
  const gocharaRows = await page.locator('[data-testid="gochara-table"] tbody tr').count()
  const sadeSati = await page.locator('[data-testid="sade-sati-card"]').innerText().catch(() => '')
  const timelineOk = (await page.locator('[data-testid="transit-timeline"]').count()) > 0
  const p2 = await shot(page, '02-predictive-transits.png', true)
  record(
    'B2 — Transits tab: Gochara table + Sade Sati + 12-month timeline',
    gocharaRows >= 9 && sadeSati.length > 0 && timelineOk,
    `compute=${(computeMs / 1000).toFixed(1)}s gocharaRows=${gocharaRows} sadeSati="${sadeSati.replace(/\n/g, ' | ').slice(0, 140)}" timeline=${timelineOk} -> ${p2}`,
  )

  // ---- (c1) Divisional Charts tab -> D10 kundli ----
  await clickTab(page, 'Divisional Charts')
  await page.waitForSelector('[data-testid="shodasavarga-panel"]', { timeout: 15_000 })
  await page
    .locator('[data-testid="varga-selector"] button')
    .filter({ hasText: /^D10\b/ })
    .first()
    .click()
  await page.waitForTimeout(800)
  const d10Svg = await page.locator('[data-testid="varga-chart-card"] svg').count()
  const d10Lagna = await page.locator('[data-testid="varga-lagna-line"]').innerText().catch(() => '')
  const d10Heading = await page.evaluate(() => document.body.innerText.includes('Daśāṁśa'))
  const p3 = await shot(page, '03-vargas-d10.png', true)
  record(
    'C1 — Divisional Charts tab: D10 kundli renders',
    d10Svg > 0 && d10Heading,
    `svgs=${d10Svg} heading(Dasamsa)=${d10Heading} lagnaLine="${d10Lagna.replace(/\n/g, ' ')}" -> ${p3}`,
  )

  // ---- (c2) Strength tab -> SAV total 337 ----
  await clickTab(page, 'Strength')
  await page.waitForSelector('[data-testid="strength-panel"]', { timeout: 15_000 })
  const savTotal = await page.locator('[data-testid="sav-total"]').innerText().catch(() => '')
  const shadbalaOk = (await page.locator('[data-testid="shadbala-table"]').count()) > 0
  const p4 = await shot(page, '04-strength-sav.png', true)
  record(
    'C2 — Strength tab: SAV total 337 badge + Shadbala table',
    /337/.test(savTotal) && shadbalaOk,
    `savTotal="${savTotal.replace(/\n/g, ' ')}" shadbalaTable=${shadbalaOk} -> ${p4}`,
  )

  // ---- (c3) Life Domains tab -> 7 domain cards with windows ----
  await clickTab(page, 'Life Domains')
  await page.waitForSelector('[data-testid="domains-panel"]', { timeout: 15_000 })
  const domainCards = await page.locator('[data-testid^="domain-card-"]').count()
  const windowBlocks = await page.locator('[data-testid^="domain-windows-"]').count()
  const p5 = await shot(page, '05-domains.png', true)
  record(
    'C3 — Life Domains tab: 7 domain cards with timed windows',
    domainCards === 7 && windowBlocks === 7,
    `domainCards=${domainCards} windowBlocks=${windowBlocks} -> ${p5}`,
  )

  // ---- (e) /report — full reload, pending affordance, compute, sections VI-IX ----
  await page.goto(`${BASE_URL}/report`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-testid="report-document"]', { timeout: 30_000 })
  // The predictive store is in-memory (not persisted) so the reload resets it:
  // the report must show the compute affordance.
  const pendingSeen = (await page.locator('[data-testid="report-predictive-pending"]').count()) > 0
  let reportComputeMs = null
  if (pendingSeen) {
    // Engine must re-boot on this fresh load before compute is enabled.
    await page.waitForSelector('[data-testid="report-predictive-compute"]', { timeout: 240_000 })
    await shot(page, '06a-report-pending-affordance.png')
    const t = Date.now()
    await page.click('[data-testid="report-predictive-compute"]')
    await page.waitForSelector('[data-testid="report-predictive-pending"]', {
      state: 'detached',
      timeout: 300_000,
    })
    reportComputeMs = Date.now() - t
  }
  await page.waitForTimeout(1500)
  const reportText = await page.evaluate(() => document.body.innerText)
  // The report namespace's own section headings (en/report.json).
  const sectionsOk =
    /Transits & Timing/i.test(reportText) &&
    /Divisional Charts \(Shoda[sś]avarga\)/i.test(reportText) &&
    /Planetary Strength/i.test(reportText) &&
    /Life-Domain Forecasts/i.test(reportText)
  const convention = await page
    .locator('[data-testid="report-dasha-convention"]')
    .innerText()
    .catch(() => '')
  const p6 = await shot(page, '06-report-predictive-sections.png', true)
  record(
    'E — /report: pending affordance -> compute -> sections VI-IX render',
    pendingSeen && sectionsOk,
    `pendingAffordance=${pendingSeen} compute=${reportComputeMs ? (reportComputeMs / 1000).toFixed(1) + 's' : 'n/a'} sections(Gochara/Vargas/Strength/Domains)=${sectionsOk} -> ${p6}`,
  )
  record(
    'D2 — report cites the dasha-year convention (julian_365_25)',
    /Julian year \(365\.25 days\)/.test(convention),
    `convention note="${convention.replace(/\n/g, ' ')}"`,
  )
  // Print-to-PDF proof.
  let pdfOk = false
  try {
    await page.emulateMedia({ media: 'print' })
    await page.pdf({ path: `${PROOF_DIR}/almamesh-report.pdf`, format: 'A4', printBackground: true })
    await page.emulateMedia({ media: 'screen' })
    pdfOk = true
  } catch (e) {
    console.log(`(page.pdf failed: ${e})`)
  }
  record('E2 — report print-to-PDF saved', pdfOk, `${PROOF_DIR}/almamesh-report.pdf`)

  // ---- (g) es spot-check: settings language select -> /predictive in Spanish ----
  await page.goto(`${BASE_URL}/settings/preferences`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-testid="language-select"]', { timeout: 20_000 })
  await page.selectOption('[data-testid="language-select"]', 'es')
  await page.waitForFunction(() => document.documentElement.lang === 'es', { timeout: 10_000 })
  await page.goto(`${BASE_URL}/predictive`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-testid="predictive-page"]', { timeout: 20_000 })
  await page.waitForTimeout(1500)
  const esText = await page.evaluate(() => document.body.innerText)
  const esOk = esText.includes('Cielo y Tiempos') && /Tránsitos y Tiempos|Calcula|Calculando/.test(esText)
  const p7 = await shot(page, '07-predictive-es.png')
  record(
    'G — es spot-check: /predictive renders Spanish strings',
    esOk,
    `title(Cielo y Tiempos)=${esText.includes('Cielo y Tiempos')} tabs/gate-es=${/Tránsitos y Tiempos|Calcula|Calculando/.test(esText)} -> ${p7}`,
  )

  // ---- (f) console cleanliness ----
  record(
    'F — console clean (no errors / page errors)',
    consoleErrors.length === 0 && pageErrors.length === 0,
    `errors=${consoleErrors.length} pageErrors=${pageErrors.length} warnings=${consoleWarnings.length}`,
  )
  if (consoleErrors.length) console.log('console errors:\n' + consoleErrors.join('\n'))
  if (pageErrors.length) console.log('page errors:\n' + pageErrors.join('\n'))
  if (consoleWarnings.length) console.log('console warnings:\n' + consoleWarnings.slice(0, 10).join('\n'))

  await browser.close()
  const failed = results.filter((r) => !r.pass)
  console.log(`\n${failed.length === 0 ? 'ALL CHECKS PASSED' : `${failed.length} CHECK(S) FAILED`}`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('FATAL:', e)
  process.exit(2)
})
