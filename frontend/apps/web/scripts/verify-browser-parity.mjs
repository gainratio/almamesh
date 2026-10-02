#!/usr/bin/env node
/**
 * Byte-parity gate — REAL browser (headless Chromium via Playwright).
 *
 * The README claims the in-browser engine is "byte-parity gated". THIS is the
 * script that makes that true. It boots the shipped app from a served origin,
 * drives the REAL Pyodide Web Worker (`packages/browser/src/pyodide/chartWorker.ts`)
 * through the app's own runtime, and asserts every chart it returns is
 * byte-identical to the committed CPython golden.
 *
 * Why a browser and not node
 * --------------------------
 * A node-hosted Pyodide harness proves nothing about the browser. Different
 * host, different filesystem, different worker semantics, different asset
 * delivery: node reads wheels off disk with `readFileSync`, the browser syncs
 * them out of a signed edge-proc bundle into OPFS and hands the BYTES to a real
 * `Worker`. The claim on the README is about what users run, so the gate runs
 * what users run.
 *
 * The reference date is an INPUT, not a constant
 * ----------------------------------------------
 * `--reference-date` is REQUIRED and has no default. A gate that hardcodes the
 * one value it is pinning cannot tell you whether the pin is reaching the
 * engine at all. To prove it is, this script runs a SENSITIVITY CONTROL: the
 * same fixture recomputed at a DIFFERENT reference date must produce DIFFERENT
 * bytes. If the control matches the golden, the reference date is being
 * ignored somewhere and the whole parity comparison is vacuous — so the gate
 * fails loudly rather than reporting a green it did not earn.
 *
 * Fixture coverage is derived from the golden
 * -------------------------------------------
 * The fixture set below must cover the committed golden EXACTLY. A fixture the
 * golden has and this gate does not is silent lost coverage, so a mismatch in
 * either direction is a hard failure, not a skip.
 *
 * Usage
 * -----
 *   # build + serve first (same build the exit gate uses)
 *   VITE_API_URL= VITE_EXIT_GATE_HOOKS=1 ./node_modules/.bin/vite build --outDir dist-verify
 *   VITE_API_URL= ./node_modules/.bin/vite preview --outDir dist-verify --port 4199 --strictPort &
 *
 *   node scripts/verify-browser-parity.mjs http://localhost:4199 \
 *     --reference-date=2025-01-01T00:00:00+00:00
 *
 * Exit 0 = every golden fixture is byte-identical in a real browser AND the
 * gate demonstrably reacts to the reference date. Non-zero = anything else.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

// scripts/ -> web -> apps -> frontend -> repo root
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const GOLDEN_PATH = join(REPO_ROOT, 'backend/tests/fixtures/chart_golden_de421.json')

// Coordinates for each golden fixture. Keyed by the golden's own ISO key, which
// is passed through to the worker verbatim so the gate computes the exact
// instant the golden was built from. Mirrors backend/tests/test_chart_golden.py
// FIXTURES; the key-set assertion below is what keeps the two honest.
const FIXTURE_COORDS = {
  '1990-01-15T12:00:00+00:00': { latitude: 28.6139, longitude: 77.209, label: 'Delhi' },
  '1985-07-23T04:30:00+00:00': { latitude: 19.076, longitude: 72.8777, label: 'Mumbai' },
  '2000-12-31T23:59:00+00:00': { latitude: 40.7128, longitude: -74.006, label: 'NYC' },
  '1972-03-10T08:15:00+00:00': { latitude: 51.5074, longitude: -0.1278, label: 'London' },
  '2010-06-21T18:00:00+00:00': { latitude: -33.8688, longitude: 151.2093, label: 'Sydney' },
  '1988-08-08T01:14:00+00:00': { latitude: 12.9716, longitude: 77.5946, label: 'Bengaluru cusp' },
  '2019-11-09T17:45:00+00:00': { latitude: 35.6895, longitude: 139.6917, label: 'Tokyo' },
}

// The fixture the sensitivity control re-runs at a different reference date.
const CONTROL_FIXTURE = '1990-01-15T12:00:00+00:00'

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const positional = []
  const flags = {}
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const [k, ...rest] = arg.slice(2).split('=')
      flags[k] = rest.join('=')
    } else {
      positional.push(arg)
    }
  }
  return { positional, flags }
}

const { positional, flags } = parseArgs(process.argv.slice(2))
const BASE_URL = positional[0] ?? 'http://localhost:4199'

const REFERENCE_DATE = flags['reference-date'] ?? process.env.ALMAMESH_PARITY_REFERENCE_DATE ?? ''
if (!REFERENCE_DATE) {
  console.error(
    'FATAL: --reference-date=<ISO-8601> is required (or ALMAMESH_PARITY_REFERENCE_DATE).\n' +
      '       It must match backend/tests/test_chart_golden.py FIXED_REFERENCE_DATE,\n' +
      '       which is what the committed golden was generated with. This gate\n' +
      '       deliberately has no default: the pinned instant is an input, so that\n' +
      '       the sensitivity control below can prove the pin actually reaches the\n' +
      '       engine.',
  )
  process.exit(2)
}

/** Control reference date: default = the pinned date shifted +40y (past any maha dasha length). */
function defaultControlDate(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  d.setUTCFullYear(d.getUTCFullYear() + 40)
  return d.toISOString()
}

const CONTROL_REFERENCE_DATE = flags['control-reference-date'] ?? defaultControlDate(REFERENCE_DATE)
if (!CONTROL_REFERENCE_DATE) {
  console.error(`FATAL: --reference-date="${REFERENCE_DATE}" is not a parseable ISO-8601 instant.`)
  process.exit(2)
}
if (new Date(CONTROL_REFERENCE_DATE).getTime() === new Date(REFERENCE_DATE).getTime()) {
  console.error(
    'FATAL: --control-reference-date equals --reference-date. The sensitivity\n' +
      '       control would then be a tautology and prove nothing.',
  )
  process.exit(2)
}

// ---------------------------------------------------------------------------
// Canonicalization — the SAME rule the golden was built with
// (backend/tests/test_chart_golden.py::_canonicalize): round floats to 6
// decimals recursively, preserve bool, sort dict keys. Integers stay integers.
//
// Rounding note: JS rounds decimal ties away from zero, Python rounds them to
// even. That can only ever produce a FALSE FAILURE (never a false pass) on a
// value that is exactly a tie at the 7th decimal, which no computed
// astronomical float in this set is. A gate whose only failure mode is
// over-strictness is a safe gate.
// ---------------------------------------------------------------------------
function canonicalize(value) {
  if (typeof value === 'boolean' || value === null) return value
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value : Number(value.toFixed(6))
  }
  if (Array.isArray(value)) return value.map(canonicalize)
  if (typeof value === 'object') {
    const out = {}
    for (const k of Object.keys(value).sort()) out[k] = canonicalize(value[k])
    return out
  }
  return value
}

function deepEqual(a, b) {
  if (a === b) return true
  if (typeof a === 'number' && typeof b === 'number') return a === b || (a !== a && b !== b)
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]))
  }
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  return ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]))
}

/** First differing path between two canonicalized values — an actionable failure. */
function firstDiff(a, b, path = '') {
  if (deepEqual(a, b)) return null
  const atom = (v) => v === null || typeof v !== 'object'
  if (atom(a) || atom(b)) return { path: path || '(root)', golden: a, browser: b }
  if (Array.isArray(a) !== Array.isArray(b)) return { path: path || '(root)', golden: a, browser: b }
  if (Array.isArray(a)) {
    if (a.length !== b.length) {
      return { path: `${path}.length`, golden: a.length, browser: b.length }
    }
    for (let i = 0; i < a.length; i++) {
      const d = firstDiff(a[i], b[i], `${path}[${i}]`)
      if (d) return d
    }
  }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const d = firstDiff(a[k], b[k], path ? `${path}.${k}` : k)
    if (d) return d
  }
  return { path: path || '(root)', golden: a, browser: b }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------
const results = []
function record(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`)
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------
async function main() {
  const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'))

  // --- CHECK 0: this gate covers the golden exactly (no silent lost coverage) ---
  const goldenKeys = new Set(Object.keys(golden))
  const fixtureKeys = new Set(Object.keys(FIXTURE_COORDS))
  const missing = [...goldenKeys].filter((k) => !fixtureKeys.has(k))
  const extra = [...fixtureKeys].filter((k) => !goldenKeys.has(k))
  record(
    'CHECK 0 — gate covers every golden fixture',
    missing.length === 0 && extra.length === 0,
    `golden=${goldenKeys.size} gate=${fixtureKeys.size}` +
      (missing.length ? ` MISSING_FROM_GATE=${missing.join(',')}` : '') +
      (extra.length ? ` NOT_IN_GOLDEN=${extra.join(',')}` : ''),
  )
  if (missing.length || extra.length) return

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext()
  const page = await context.newPage()

  const consoleErrors = []
  const pageErrors = []
  const requests = []
  const workerUrls = new Set()

  // Match the exit gate's observability: a chart computed on the main thread,
  // or inside a service worker this listener cannot see, is exactly the kind of
  // structural blindness this gate exists to avoid.
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  page.on('pageerror', (err) => pageErrors.push(String(err)))
  page.on('request', (req) => requests.push(req.url()))
  page.on('worker', (w) => {
    workerUrls.add(w.url())
    w.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(`[worker] ${msg.text()}`)
    })
  })
  context.on('serviceworker', (sw) => workerUrls.add(`(serviceworker) ${sw.url()}`))

  try {
    // --- CHECK 1: the real engine boots in a real browser ---
    // `/` is the marketing splash and defers the engine; /onboarding is the
    // first route that boots it (same entry point the exit gate drives).
    const t0 = Date.now()
    await page.goto(`${BASE_URL}/onboarding`, { waitUntil: 'domcontentloaded' })

    let stage = null
    let bootError = null
    let hasGen = false
    const deadline = Date.now() + 120_000
    while (Date.now() < deadline) {
      const probe = await page.evaluate(() => ({
        stage: window.__ALMAMESH_STAGE__ ?? null,
        error: window.__ALMAMESH_ERROR__ ?? null,
        hasGen: typeof window.__almameshGenerate === 'function',
      }))
      stage = probe.stage
      bootError = probe.error
      hasGen = probe.hasGen
      if (bootError) break
      if (stage === 'ready' && hasGen) break
      await page.waitForTimeout(500)
    }
    const bootMs = Date.now() - t0

    record(
      'CHECK 1 — engine boots in-browser (real Worker, served origin)',
      stage === 'ready' && hasGen && !bootError && pageErrors.length === 0,
      `stage=${stage} boot=${bootMs}ms workers=${workerUrls.size} pageErrors=${pageErrors.length}` +
        (bootError ? ` bootError="${bootError}"` : '') +
        (hasGen ? '' : ' __almameshGenerate=ABSENT (build without VITE_EXIT_GATE_HOOKS=1?)'),
    )
    if (stage !== 'ready' || !hasGen) return

    // The compute must genuinely happen off the UI thread in a Worker. If no
    // Worker ever spawned, the claim "the Python wheel in Pyodide/WASM, off the
    // UI thread" is not what was measured, whatever the bytes said.
    const realWorkers = [...workerUrls].filter((u) => !u.startsWith('(serviceworker)'))
    record(
      'CHECK 2 — compute runs in a real Worker, off the UI thread',
      realWorkers.length > 0,
      `workers=${realWorkers.length} serviceWorkers=${workerUrls.size - realWorkers.length}`,
    )
    const syncWorkerAssets = realWorkers.filter((url) => /\/edgeproc\.worker-[^/]+\.js(?:\?|$)/.test(url))
    record(
      'CHECK 2b — Chromium loads exactly one consumer-owned edgeproc Worker asset',
      syncWorkerAssets.length === 1,
      `edgeprocWorkers=${JSON.stringify(syncWorkerAssets)}`,
    )

    const generate = async (iso, referenceDate) => {
      const { latitude, longitude } = FIXTURE_COORDS[iso]
      return page.evaluate(
        (birth) => window.__almameshGenerate(birth),
        { datetimeUtc: iso, latitude, longitude, referenceDate },
      )
    }

    // --- CHECK 3: every golden fixture is byte-identical in the browser ---
    let mismatches = 0
    const freshRaw = new Map()
    for (const iso of Object.keys(golden)) {
      const { label } = FIXTURE_COORDS[iso]
      const fxT0 = Date.now()
      let chart = null
      let err = null
      try {
        chart = await generate(iso, REFERENCE_DATE)
      } catch (e) {
        err = String(e)
      }
      const ms = Date.now() - fxT0
      if (err || chart == null) {
        mismatches += 1
        console.log(`   [FAIL] ${iso} (${label}) — generate threw: ${err ?? 'null chart'}`)
        continue
      }
      freshRaw.set(iso, JSON.stringify(chart))
      const actual = canonicalize(chart)
      const expected = canonicalize(golden[iso])
      if (deepEqual(actual, expected)) {
        console.log(`   [ok]   ${iso} (${label}) byte-identical  ${ms}ms`)
      } else {
        mismatches += 1
        const d = firstDiff(expected, actual)
        console.log(`   [FAIL] ${iso} (${label}) DIVERGED  ${ms}ms`)
        console.log(`          first diff at: ${d.path}`)
        console.log(`            cpython(golden): ${JSON.stringify(d.golden)}`)
        console.log(`            browser        : ${JSON.stringify(d.browser)}`)
      }
    }
    record(
      'CHECK 3 — every golden fixture is byte-identical in the browser',
      mismatches === 0,
      `fixtures=${goldenKeys.size} mismatches=${mismatches} referenceDate=${REFERENCE_DATE}`,
    )

    // --- CHECK 3b: a memoized repeat is byte-identical to the fresh compute ---
    // The runtime computes an identical input once per booted engine
    // (packages/browser/src/pyodide/engineMemo.ts). Determinism is the contract
    // that makes that safe, so prove it on the real engine: the repeat (a cache
    // hit) must serialize to EXACTLY the fresh compute's bytes — raw JSON, no
    // canonicalization.
    let memoMismatches = 0
    for (const [iso, fresh] of freshRaw) {
      const t0 = Date.now()
      const repeat = JSON.stringify(await generate(iso, REFERENCE_DATE))
      const ms = Date.now() - t0
      if (repeat === fresh) {
        console.log(`   [ok]   ${iso} repeat byte-identical to fresh  ${ms}ms`)
      } else {
        memoMismatches += 1
        console.log(`   [FAIL] ${iso} repeat DIVERGED from the fresh compute`)
      }
    }
    record(
      'CHECK 3b — a repeated (memoized) compute is byte-identical to the fresh one',
      memoMismatches === 0 && freshRaw.size === goldenKeys.size,
      `fixtures=${freshRaw.size} mismatches=${memoMismatches}`,
    )

    // --- CHECK 4: SENSITIVITY CONTROL — the gate reacts to the reference date ---
    // Break the property on purpose: recompute one fixture at a different
    // pinned instant. It MUST diverge from the golden. If it does not, the
    // reference date never reached the engine and CHECK 3's green is vacuous.
    let controlChart = null
    let controlErr = null
    try {
      controlChart = await generate(CONTROL_FIXTURE, CONTROL_REFERENCE_DATE)
    } catch (e) {
      controlErr = String(e)
    }
    const controlDiverged =
      controlChart != null &&
      !deepEqual(canonicalize(controlChart), canonicalize(golden[CONTROL_FIXTURE]))
    record(
      'CHECK 4 — sensitivity control (a different reference date MUST diverge)',
      controlDiverged,
      controlErr
        ? `error: ${controlErr}`
        : controlDiverged
          ? `control=${CONTROL_REFERENCE_DATE} diverged as required`
          : `control=${CONTROL_REFERENCE_DATE} produced the SAME bytes as the golden — ` +
            'the reference date is NOT reaching the engine, so CHECK 3 proves nothing',
    )

    // --- CHECK 5: clean console over the whole parity run ---
    const realErrors = consoleErrors.filter((e) => !/favicon|manifest|404/i.test(e))
    record(
      'CHECK 5 — clean console during the parity run',
      realErrors.length === 0 && pageErrors.length === 0,
      `consoleErrors=${realErrors.length} pageErrors=${pageErrors.length}` +
        (realErrors.length ? ` first="${realErrors[0]}"` : '') +
        (pageErrors.length ? ` firstPageError="${pageErrors[0]}"` : ''),
    )

    // --- CHECK 6: the engine path stayed same-origin ---
    const origin = new URL(BASE_URL).host
    const offOrigin = requests.filter((u) => {
      if (!/^https?:\/\//i.test(u)) return false
      try {
        return new URL(u).host !== origin
      } catch {
        return true
      }
    })
    record(
      'CHECK 6 — engine path emitted same-origin traffic only',
      offOrigin.length === 0,
      `requests=${requests.length} offOrigin=${offOrigin.length}` +
        (offOrigin.length ? ` first="${offOrigin[0]}"` : ''),
    )
  } finally {
    await browser.close()
  }
}

await main()

const failed = results.filter((r) => !r.pass)
console.log('')
if (failed.length) {
  console.error(`BROWSER BYTE-PARITY GATE FAILED — ${failed.length}/${results.length} checks red`)
  for (const f of failed) console.error(`  - ${f.name}`)
  process.exit(1)
}
console.log(
  `✅ BROWSER BYTE-PARITY GATE PASSED — ${results.length}/${results.length} checks green.\n` +
    '   The in-browser engine is byte-identical to the CPython golden, in a real\n' +
    '   browser, in a real Worker, at a reference date the gate proved it honours.',
)
