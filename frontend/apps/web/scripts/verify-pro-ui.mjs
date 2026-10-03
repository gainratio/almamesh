#!/usr/bin/env node
/**
 * Pro-UI / yoga-integrity LIVE journey — REAL browser (headless Chromium via
 * Playwright), REAL in-browser Pyodide engine, NO stubbing.
 *
 * Drives the surfaces this branch changed, with the reference fixture chart
 * (Bengaluru, 08 Aug 1988, 06:44 IST == 01:14 UTC):
 *   a. /dashboard — ONE AlmaMesh wordmark (DOM-counted), IdentityStrip with
 *      Leo lagna, the BIRTH-TIME SENSITIVITY callout naming Cancer with
 *      the "Refine your birth time" link, Life Atlas 7 cards in the designed
 *      pending state with ONE compute affordance, and NO accordion anywhere.
 *   b. Life Atlas compute -> click the career card -> /life/career shows the
 *      labeled engine-forecast + AI-narration sections; back link returns.
 *   c. (removed) the legacy /astrologer-view surface — its YogaSection grades,
 *      classical citations and no-percentages bar now live on /report below.
 *   d. /report — cover cusp note naming Cancer; yogas section shows grades +
 *      citations with NO "%"/"100"; the D9 plate carries the Navamsa centre
 *      label (never "Rasi - D1") and NO degree text; page.pdf() saved.
 *   e. es spot-check — language switch, then the dashboard identity strip and
 *      the sensitivity callout render Spanish.
 *   f. console clean (zero errors / page errors) throughout.
 *
 * Expects the production build previewed with VITE_EXIT_GATE_HOOKS=1:
 *   VITE_API_URL= VITE_EXIT_GATE_HOOKS=1 bun run build
 *   bun run preview            # port 4173
 *   node scripts/verify-pro-ui.mjs http://localhost:4173
 *
 * Screenshots + PDF land in /tmp/almamesh-proof-pro-ui/.
 */

import { mkdirSync } from 'node:fs'
import { Buffer } from 'node:buffer'
import { chromium } from '@playwright/test'
import { chartDayReferenceInstant } from './predictiveReference.mjs'
import { confirmLegacyBackupImport } from './confirmLegacyBackupImport.mjs'

const BASE_URL = process.argv[2] ?? 'http://localhost:4173'
const PROOF_DIR = '/tmp/almamesh-proof-pro-ui'
mkdirSync(PROOF_DIR, { recursive: true })

const CHART_TIMEZONE = 'Asia/Kolkata'
// The app keys its predictive request by the CHART's local day (predictiveReferenceInstant),
// never the UTC calendar day, so seed the same instant.
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

// /report and the dashboard reading section are gated on a complete structured
// interpretation; the LLM is out of scope for this deterministic journey, so
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
    name: 'verify-pro-ui.json',
    mimeType: 'application/json',
    buffer: Buffer.from(backup, 'utf8'),
  })
  await confirmLegacyBackupImport(page)
}

/** Innermost elements whose entire visible text is exactly "AlmaMesh" — the
 *  brand wordmark; prose mentions (e.g. the provenance footer line) have
 *  longer parent text and do not count. */
function countWordmarks() {
  const all = Array.from(document.querySelectorAll('body *'))
  const exact = all.filter((el) => {
    if (!(el instanceof HTMLElement)) return false
    if (el.offsetParent === null && el.tagName !== 'BODY') return false // hidden (incl. print-only)
    return el.textContent?.replace(/\s+/g, '') === 'AlmaMesh'
  })
  // keep only innermost matches (a wrapper around the wordmark is the same mark)
  const innermost = exact.filter((el) => !exact.some((other) => other !== el && el.contains(other)))
  const prose = (document.body.innerText.match(/AlmaMesh/g) ?? []).length
  return { wordmarks: innermost.length, proseMentions: prose }
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
      yogaCount: (c?.yogas ?? []).length,
      yogaGrades: (c?.yogas ?? []).map((y) => y.grade),
      venus: c?.planets
        ? Object.values(c.planets).find((p) => p.name?.toLowerCase() === 'venus')
        : null,
      full: c,
    }
  }, REFERENCE_BIRTH)
  record(
    '0 — engine boots + reference chart generates in-tab',
    chart.lagnaSign?.toLowerCase() === 'leo' && chart.yogaCount > 0,
    `boot+gen=${Date.now() - t0}ms lagna=${chart.lagnaSign} ${chart.lagnaDegInSign?.toFixed(2)}deg yogas=${chart.yogaCount} grades=[${chart.yogaGrades.join(',')}] venus(combust=${chart.venus?.is_combust} yogakaraka=${chart.venus?.is_yogakaraka} rules=${JSON.stringify(chart.venus?.houses_ruled)})`,
  )

  // ---- RESTORE the fixture through Settings into canonical SQLite ----
  const backup = await page.evaluate(
    ({ chart, birth, interpretation }) => {
      const chartId = 'pro-ui-reference-1988'
      const profileId = `${chartId}-profile`
      // Mirror @almamesh/store toDashaCtx — the library stores the ADAPTER
      // shape (UI VimshottariDashaData), not the raw engine dasha ctx.
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
        app: { version: 'verify-pro-ui' },
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

  // ============ (a) /dashboard ============
  await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-testid="identity-strip"]', { timeout: 30_000 })
  await page.waitForTimeout(2000)

  const marks = await page.evaluate(countWordmarks)
  record(
    'A1 — exactly ONE AlmaMesh wordmark in the dashboard DOM',
    marks.wordmarks === 1,
    `wordmark elements=${marks.wordmarks} (prose mentions incl. provenance footer=${marks.proseMentions})`,
  )

  const stripText = await page.locator('[data-testid="identity-strip"]').innerText()
  record(
    'A2 — identity strip shows Leo lagna + dasha stack',
    /Leo/i.test(stripText) && /Daśā|Dasha|Maha/i.test(stripText),
    `strip="${stripText.replace(/\n/g, ' | ').slice(0, 220)}"`,
  )

  const sens = page.locator('[data-testid="birth-time-sensitivity"]')
  const sensCount = await sens.count()
  const sensText = sensCount ? await sens.innerText() : ''
  const refineHref =
    sensCount &&
    (await sens.locator('a', { hasText: /refine your birth time/i }).getAttribute('href').catch(() => null))
  record(
    'A3 — BIRTH-TIME SENSITIVITY callout names Cancer + refine link',
    sensCount === 1 &&
      /birth-time sensitivity/i.test(sensText) &&
      /Cancer/.test(sensText) &&
      refineHref === '/settings/profile',
    `text="${sensText.replace(/\n/g, ' | ')}" refineHref=${refineHref}`,
  )

  const pendingCards = await page.locator('div[data-testid^="life-atlas-card-"]').count()
  const pendingHints = await page.locator('[data-testid="life-atlas"]').innerText()
  // The single compute affordance honestly waits for engine readiness (the
  // gate shows an "engine warming" spinner until layer.canCompute) — wait for
  // the engine, then the button must be the ONE affordance.
  await bootEngine(page)
  await page.waitForSelector('[data-testid="life-atlas-compute"]', { timeout: 60_000 })
  const computeBtns = await page.locator('[data-testid="life-atlas-compute"]').count()
  record(
    'A4 — Life Atlas: 7 pending domain cards + ONE compute affordance',
    pendingCards === 7 && computeBtns === 1 && /computed on demand/i.test(pendingHints),
    `pendingCards=${pendingCards} computeButtons=${computeBtns} pendingHint=${/computed on demand/i.test(pendingHints)}`,
  )

  const accordions = await page.evaluate(() => {
    const byTestId = document.querySelectorAll('[data-testid*="accordion" i]').length
    const byClass = document.querySelectorAll('[class*="accordion" i]').length
    const readingMounted = document.querySelector('[data-testid="reading-section"]') !== null
    return { byTestId, byClass, readingMounted }
  })
  record(
    'A5 — editorial reading present, NO accordion in the DOM',
    accordions.byTestId === 0 && accordions.byClass === 0 && accordions.readingMounted,
    `accordionTestids=${accordions.byTestId} accordionClasses=${accordions.byClass} readingSection=${accordions.readingMounted}`,
  )
  const pA = await shot(page, '01-dashboard.png', true)
  console.log(`   -> ${pA}`)

  // ============ (b) Life Atlas compute -> /life/career ============
  await page.click('[data-testid="life-atlas-compute"]')
  // Ready cards are LINKS (pending faces are divs with the same testid).
  await page.waitForSelector('a[data-testid="life-atlas-card-career"]', { timeout: 300_000 })
  const pB0 = await shot(page, '02-life-atlas-ready.png', true)
  console.log(`   -> ${pB0}`)
  await page.click('a[data-testid="life-atlas-card-career"]')
  await page.waitForURL('**/life/career', { timeout: 15_000 })
  await page.waitForSelector('[data-testid="life-domain-engine"]', { timeout: 30_000 })
  // Let the AnimatedRoutes crossfade finish so the screenshot shows the
  // settled page (the content is mounted before the fade completes).
  await page.waitForTimeout(900)
  const engineSec = await page.locator('[data-testid="life-domain-engine"]').innerText()
  const aiSec = await page.locator('[data-testid="life-domain-ai"]').innerText().catch(() => '')
  record(
    'B1 — /life/career: engine-forecast + AI-narration sections labeled',
    /engine forecast/i.test(engineSec) &&
      /deterministic/i.test(engineSec) &&
      /from your reading/i.test(aiSec) &&
      /ai narration/i.test(aiSec),
    `engineHead=${/engine forecast/i.test(engineSec)} engineBadge=${/deterministic/i.test(engineSec)} aiHead=${/from your reading/i.test(aiSec)} aiBadge=${/ai narration/i.test(aiSec)}`,
  )
  const pB = await shot(page, '03-life-career.png', true)
  console.log(`   -> ${pB}`)
  await page.click('[data-testid="life-domain-back"]')
  await page.waitForURL('**/dashboard', { timeout: 15_000 })
  record('B2 — back link returns to /dashboard', page.url().endsWith('/dashboard'), `url=${page.url()}`)

  // (The legacy /astrologer-view surface was removed in favor of /report; the
  // YogaSection grades + classical citations and the no-percentages bar are now
  // asserted on /report below.)

  // ============ (d) /report ============
  await page.goto(`${BASE_URL}/report`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-testid="report-document"]', { timeout: 60_000 })
  await page.waitForTimeout(1500)

  const cuspNote = await page.locator('[data-testid="report-cusp-note"]').innerText().catch(() => '')
  record(
    'D1 — report cover cusp note names Cancer',
    /Cancer/.test(cuspNote) && /cusp/i.test(cuspNote),
    `note="${cuspNote.replace(/\n/g, ' ').slice(0, 180)}"`,
  )

  const yogasSection = await page.locator('[data-testid="report-yogas"]').innerText().catch(() => '')
  const yogaCites = await page.locator('[data-testid="report-yogas"] cite').count()
  const yogaGradeMarks = (yogasSection.match(/\b(strong|moderate|weak)\b/gi) ?? []).length
  record(
    'D2 — report yogas: grades + citations, NO "%" and NO "100"',
    yogaGradeMarks > 0 &&
      yogaCites > 0 &&
      !yogasSection.includes('%') &&
      !yogasSection.includes('100'),
    `gradeMarks=${yogaGradeMarks} citations=${yogaCites} pctFree=${!yogasSection.includes('%')} hundredFree=${!yogasSection.includes('100')}`,
  )

  const d9 = await page.evaluate(() => {
    const svgs = Array.from(document.querySelectorAll('svg'))
    const nav = svgs.find((s) => /Navāṁśa|Navamsa/i.test(s.textContent ?? ''))
    if (!nav) return { found: false }
    const text = nav.textContent ?? ''
    return {
      found: true,
      hasD9: /D9/.test(text),
      saysRasiD1: /Rāśi\s*·\s*D1/.test(text),
      degreeHits: (text.match(/\d+°\d{2}/g) ?? []).length,
      zeroDegree: /0°00/.test(text),
    }
  })
  record(
    'D3 — D9 plate: centre label Navāṁśa/D9 (not Rāśi·D1), NO degree text',
    d9.found && d9.hasD9 && !d9.saysRasiD1 && d9.degreeHits === 0 && !d9.zeroDegree,
    `found=${d9.found} D9label=${d9.hasD9} rasiD1Leak=${d9.saysRasiD1} degreeTexts=${d9.degreeHits} zeroDeg=${d9.zeroDegree}`,
  )
  const pD = await shot(page, '05-report.png', true)
  console.log(`   -> ${pD}`)

  let pdfOk = false
  try {
    await page.emulateMedia({ media: 'print' })
    await page.pdf({ path: `${PROOF_DIR}/report.pdf`, format: 'A4', printBackground: true })
    await page.emulateMedia({ media: 'screen' })
    pdfOk = true
  } catch (e) {
    console.log(`(page.pdf failed: ${e})`)
  }
  record('D4 — report print-to-PDF saved', pdfOk, `${PROOF_DIR}/report.pdf`)

  // ============ (e) es spot-check ============
  await page.goto(`${BASE_URL}/settings/preferences`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-testid="language-select"]', { timeout: 20_000 })
  await page.selectOption('[data-testid="language-select"]', 'es')
  await page.waitForFunction(() => document.documentElement.lang === 'es', { timeout: 10_000 })
  await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-testid="identity-strip"]', { timeout: 30_000 })
  await page.waitForTimeout(1500)
  const esStrip = await page.locator('[data-testid="identity-strip"]').innerText()
  const esSens = await page.locator('[data-testid="birth-time-sensitivity"]').innerText().catch(() => '')
  record(
    'E — es: identity strip + sensitivity callout render Spanish',
    // Case-insensitive: the kicker/labels render with CSS text-transform
    // uppercase ("CARTA NATAL", "SENSIBILIDAD A LA HORA DE NACIMIENTO").
    /Carta natal|Ascendente|Luna|Daśā en curso/i.test(esStrip) &&
      /Sensibilidad a la hora de nacimiento/i.test(esSens) &&
      /Cáncer/i.test(esSens) &&
      /Ajusta tu hora de nacimiento/i.test(esSens),
    `strip="${esStrip.replace(/\n/g, ' | ').slice(0, 140)}" sens="${esSens.replace(/\n/g, ' | ').slice(0, 200)}"`,
  )
  const pE = await shot(page, '06-dashboard-es.png')
  console.log(`   -> ${pE}`)

  // ============ (f) console cleanliness ============
  record(
    'F — console clean (zero errors / page errors)',
    consoleErrors.length === 0 && pageErrors.length === 0,
    `errors=${consoleErrors.length} pageErrors=${pageErrors.length} warnings=${consoleWarnings.length}`,
  )
  if (consoleErrors.length) console.log('console errors:\n' + consoleErrors.join('\n'))
  if (pageErrors.length) console.log('page errors:\n' + pageErrors.join('\n'))
  if (consoleWarnings.length)
    console.log('console warnings (first 10):\n' + consoleWarnings.slice(0, 10).join('\n'))

  await browser.close()
  const failed = results.filter((r) => !r.pass)
  console.log(`\n${failed.length === 0 ? 'ALL CHECKS PASSED' : `${failed.length} CHECK(S) FAILED`}`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('FATAL:', e)
  process.exit(2)
})
