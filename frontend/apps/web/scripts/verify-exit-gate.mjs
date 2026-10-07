#!/usr/bin/env node
/**
 * P3 exit-gate verification — REAL browser (headless Chromium via Playwright).
 *
 * Proves the AlmaMesh app runs with NO backend and NO login: it boots the
 * in-browser engine (Pyodide Web Worker + edge-proc bundle sync into OPFS),
 * generates a sidereal chart fully in-tab, renders it, and works offline after
 * the first load — and emits only same-origin network traffic.
 *
 * Drive a build that has the AlmaMeshRuntimeProvider observability hooks
 * installed (gated on import.meta.env.DEV OR VITE_EXIT_GATE_HOOKS=1):
 *   window.__ALMAMESH_STAGE__       latest BootStage.kind
 *   window.__ALMAMESH_ERROR__       bootstrap failure message, if any
 *   window.__almameshGenerate(b)    drive engine.generateChart directly
 *
 * The PROVEN target is a REAL production build (Rollup-bundled module workers)
 * with the hooks opted in — the dev server's ESM module workers fail to resolve
 * the `pyodide` import in worker scope, so use a build:
 *
 *   cd apps/web
 *   VITE_API_URL= VITE_EXIT_GATE_HOOKS=1 ./node_modules/.bin/vite build --outDir dist-verify
 *   VITE_API_URL= ./node_modules/.bin/vite preview --outDir dist-verify --port 4199 --strictPort &
 *   node scripts/verify-exit-gate.mjs http://localhost:4199
 *
 * (Browsers: `bunx playwright install chromium` once.)
 *
 * Usage:  node apps/web/scripts/verify-exit-gate.mjs [baseURL]
 *   baseURL defaults to http://localhost:4199
 */

import { chromium } from '@playwright/test'
import { Buffer } from 'node:buffer'
import { cachePoolDirectory } from './exitGateDurability.mjs'
import { confirmLegacyBackupImport } from './confirmLegacyBackupImport.mjs'
import { DeadlineError, withDeadline } from './stepDeadline.mjs'

const BASE_URL = process.argv[2] ?? 'http://localhost:4199'
const ORIGIN = new URL(BASE_URL).host

// The known-good reference birth: Delhi 1990-01-15 local 17:30 Asia/Kolkata
// (== 1990-01-15T12:00:00Z). referenceDate pins the "current" dasha.
const DELHI_BIRTH = {
  datetimeUtc: '1990-01-15T12:00:00.000Z',
  latitude: 28.6139,
  longitude: 77.209,
  referenceDate: '2025-01-01T00:00:00+00:00',
}
const EXPECTED = { lagna: 'gemini', sun: 'capricorn', moon: 'leo' }

const results = []
function record(name, pass, detail) {
  results.push({ name, pass, detail })
  const tag = pass ? 'PASS' : 'FAIL'
  console.log(`[${tag}] ${name}${detail ? ` — ${detail}` : ''}`)
}

// Per-check deadlines. Playwright's page.evaluate / context.route / setOffline
// have no timeout, so a wedged page main thread used to hang the script until
// the Dagger lane's 900 s watchdog (run 37542383864: stuck after CHECK 4b, then
// CHECK 5/7 blamed "Target page ... has been closed"). Each budget is the sum
// of the check's own bounded waits plus slack; measured durations (CI run
// 37542383864 and a local hooked preview) are far below them. Their sum
// (650 s) plus browser launch and close stays under the 900 s lane watchdog,
// so a wedge always surfaces here, named, before the watchdog fires.
const DEADLINES_MS = {
  // goto (30 s nav default) + 90 s stage poll + slack. Measured: 11.6 s CI cold boot.
  check1: 150_000,
  // One engine.generateChart call. Measured: <1 s CI.
  check2: 60_000,
  // Import (~5 s) + goto + 2.5 s settle + 10 s tab + 20 s canvas + 1.5 s. Measured: ~14 s CI.
  check4: 120_000,
  // route + goto (30 s) + 1 s + 90 s stage poll + 20 s identity strip + OPFS walk.
  check5: 160_000,
  // goto (30 s) + 90 s stage poll + 1.5 s + 20 s identity strip.
  check7: 160_000,
  close: 15_000,
}

// After one check times out the page is wedged: every later page call would
// hang too, so later browser checks fail at once, citing the first timeout.
let wedgedBy = null
async function guarded(name, ms, fn) {
  if (wedgedBy) throw new Error(`skipped: page unresponsive since ${wedgedBy}`)
  try {
    return await withDeadline(name, ms, fn)
  } catch (error) {
    if (error instanceof DeadlineError) wedgedBy = error.message
    throw error
  }
}

// Cleanup on a wedged page must not hang either: give it a short, silent bound.
const CLEANUP_MS = 5_000
const bounded = (promise, ms) =>
  Promise.race([promise.catch(() => {}), new Promise((resolve) => setTimeout(resolve, ms).unref())])

const describeError = (error) =>
  error instanceof DeadlineError || error?.message?.startsWith('skipped:')
    ? error.message
    : `error: ${String(error)}`

async function main() {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext()
  const page = await context.newPage()

  const consoleLines = []
  const pageErrors = []
  const requests = []
  const workerUrls = new Set()

  page.on('console', (msg) => {
    consoleLines.push(`[${msg.type()}] ${msg.text()}`)
  })
  page.on('pageerror', (err) => {
    pageErrors.push(String(err))
    consoleLines.push(`[pageerror] ${String(err)}`)
  })
  page.on('request', (req) => {
    requests.push(req.url())
  })
  page.on('worker', (w) => {
    workerUrls.add(w.url())
    w.on('console', (msg) => consoleLines.push(`[worker:${msg.type()}] ${msg.text()}`))
  })
  // Surface worker-thread errors (the sync/Pyodide workers run off-thread).
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleLines.push(`[console:error] ${msg.text()}`)
  })
  context.on('serviceworker', (sw) => {
    workerUrls.add(`(serviceworker) ${sw.url()}`)
  })

  // The slow-phone first visit: the service worker loses the race. On a weak
  // CPU the SW is still installing (precaching the app shell) when the engine
  // worker fetches the Pyodide runtime, so nothing intercepts those fetches and
  // nothing lands in its CacheFirst cache. Hold /sw.js until the engine reports
  // ready so every run of this gate exercises that worst case deterministically:
  // "ready" must already mean the engine can reboot offline.
  let releaseServiceWorker
  const serviceWorkerHeld = new Promise((resolve) => {
    releaseServiceWorker = resolve
  })
  await context.route('**/sw.js', async (route) => {
    await serviceWorkerHeld
    await route.continue()
  })

  // ---- CHECK 1: engine boots in-browser ----
  const t0 = Date.now()
  // `/` is now the marketing splash, which intentionally DEFERS the engine for a
  // fresh visitor (no saved chart). /onboarding is the first route that boots the
  // engine, so the cold-boot check drives it there.
  let stage = null
  let bootError = null
  let check1Error = null
  try {
    await guarded('CHECK 1', DEADLINES_MS.check1, async ({ step, signal }) => {
      await step('goto /onboarding', () =>
        page.goto(`${BASE_URL}/onboarding`, { waitUntil: 'domcontentloaded' }),
      )
      await step('poll engine stage until ready', async () => {
        const deadline = Date.now() + 90_000
        while (Date.now() < deadline && !signal.aborted) {
          const probe = await page.evaluate(() => ({
            stage: window.__ALMAMESH_STAGE__ ?? null,
            error: window.__ALMAMESH_ERROR__ ?? null,
            hasGen: typeof window.__almameshGenerate === 'function',
          }))
          stage = probe.stage
          bootError = probe.error
          if (bootError) break
          if (stage === 'ready' && probe.hasGen) break
          await page.waitForTimeout(500)
        }
      })
    })
  } catch (e) {
    check1Error = describeError(e)
  }
  const coldBootMs = Date.now() - t0
  releaseServiceWorker()

  // Worker evidence: at least one real Worker spawned (Pyodide + sync).
  // Network evidence: bundle + pyodide fetched.
  const bundleFetched = requests.some((u) => u.includes('/bundle/'))
  const pyodideFetched = requests.some((u) => u.includes('/pyodide/'))
  const workerCount = workerUrls.size

  const boot1Pass =
    check1Error === null &&
    stage === 'ready' &&
    !bootError &&
    pageErrors.length === 0 &&
    bundleFetched &&
    pyodideFetched
  record(
    'CHECK 1 — engine boots in-browser',
    boot1Pass,
    `${check1Error ? `${check1Error} | ` : ''}stage=${stage} cold=${coldBootMs}ms workers=${workerCount} bundleFetched=${bundleFetched} pyodideFetched=${pyodideFetched} pageErrors=${pageErrors.length}${bootError ? ` bootError="${bootError}"` : ''}`,
  )

  // ---- CHECK 2 + 3: generate chart in-tab + correctness ----
  let chart = null
  let genErr = null
  if (stage === 'ready' && check1Error === null) {
    try {
      chart = await guarded('CHECK 2', DEADLINES_MS.check2, ({ step }) =>
        step('generate Delhi chart via __almameshGenerate', () =>
          page.evaluate(async (birth) => {
            const c = await window.__almameshGenerate(birth)
            // Return only what we assert on, to keep the payload small.
            return {
              lagnaSign: c?.lagna?.sign ?? null,
              sunSign: c?.planets?.sun?.sign ?? null,
              moonSign: c?.planets?.moon?.sign ?? null,
              planetKeys: Object.keys(c?.planets ?? {}),
              ayanamsa: c?.ayanamsa_value ?? null,
              full: c,
            }
          }, DELHI_BIRTH),
        ),
      )
    } catch (e) {
      genErr = describeError(e)
    }
  }

  record(
    'CHECK 2 — generate a chart in-tab',
    chart != null && genErr == null,
    genErr ? genErr : `lagna=${chart?.lagnaSign} sun=${chart?.sunSign} moon=${chart?.moonSign} ayanamsa=${chart?.ayanamsa}`,
  )

  // Snapshot the request list at the end of the ENGINE path (boot + generate),
  // before any dashboard navigation. This is the egress that the exit-gate
  // claim is about: the on-device engine itself must make zero third-party
  // calls. (The dashboard's legacy LLM-interpretation calls are a separate,
  // documented P5 concern — see the engine-path vs full-run split in CHECK 6.)
  const enginePathRequests = [...requests]

  const lc = (s) => (typeof s === 'string' ? s.toLowerCase() : s)
  const correct =
    lc(chart?.lagnaSign) === EXPECTED.lagna &&
    lc(chart?.sunSign) === EXPECTED.sun &&
    lc(chart?.moonSign) === EXPECTED.moon
  record(
    'CHECK 3 — correctness (lagna/sun/moon match node golden)',
    !!correct,
    `got lagna=${chart?.lagnaSign} sun=${chart?.sunSign} moon=${chart?.moonSign} | expected lagna=${EXPECTED.lagna} sun=${EXPECTED.sun} moon=${EXPECTED.moon}`,
  )

  // ---- CHECK 4: render (persist via adapter + load dashboard) ----
  // Persist the chart through the app's own store + adapter, then navigate to
  // the dashboard and assert the chart UI renders (no error boundary).
  let renderPass = false
  let renderDetail
  if (correct) {
    try {
      await guarded('CHECK 4', DEADLINES_MS.check4, async ({ step }) => {
        // Reuse the booted engine's chart and build a legacy backup at the
        // transport boundary. Importing it through Settings exercises the shipped
        // restore path, which validates the envelope and commits it into the
        // canonical OPFS SQLite database. This deliberately does not reach around
        // the product with a test-only store hook or a retired IndexedDB write.
        const backup = await step('build legacy backup JSON in page', () => page.evaluate((args) => {
          const { chart, birth } = args
          const chartId = 'verify-delhi-1990'
          const profileId = 'verify-delhi-profile'
          const stored = {
            chart_id: chartId,
            person_name: birth.name,
            is_primary: true,
            profile_id: profileId,
            birth_data: {
              name: birth.name,
              birth_datetime_utc: birth.datetimeUtc,
              birth_datetime_local: '1990-01-15T17:30:00',
              birth_location_details: {
                city: 'Delhi',
                latitude: birth.latitude,
                longitude: birth.longitude,
                timezone: 'Asia/Kolkata',
                location_name: 'Delhi, India',
              },
            },
            astronomical_calculations: {
              sidereal_ctx: {
                ayanamsa_value: chart.ayanamsa,
                ayanamsa_type: 'lahiri',
                house_system: 'whole_sign',
                julian_day: 0,
                sidereal_time: 0,
                lagna: chart.full.lagna,
                planets: chart.full.planets,
              },
              varga_ctx: undefined,
              dasha_ctx: undefined,
              yoga_ctx: chart.full.yogas ?? [],
              calculation_timestamp: '2025-01-01T00:00:00+00:00',
              software_version: 'almamesh-browser-engine',
            },
            interpretation: undefined,
            // The 2D kundli + 3D force-field hero render from the RAW SiderealChart
            // (richest feed) via @almamesh/store's buildChartGeometry/buildEnergyFrame.
            // Seed it so CHECK 4 exercises the real chart pipeline, not the empty state.
            sidereal_chart: chart.full,
          }
          return JSON.stringify({
            format: 'almamesh-backup',
            formatVersion: 1,
            app: { version: 'exit-gate' },
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
                version: 0,
                state: { charts: { [chartId]: stored } },
              },
            },
          })
        }, { chart, birth: { ...DELHI_BIRTH, name: 'Delhi Test' } }))

        await step('remove File System Access pickers', () =>
          context.addInitScript(() => {
            Reflect.deleteProperty(window, 'showOpenFilePicker')
            Reflect.deleteProperty(window, 'showSaveFilePicker')
          }),
        )
        await step('goto /settings/data', () =>
          page.goto(`${BASE_URL}/settings/data`, { waitUntil: 'domcontentloaded' }),
        )
        await step('import backup through Settings', async () => {
          const chooserPromise = page.waitForEvent('filechooser')
          await page.getByTestId('backup-import-button').click()
          const chooser = await chooserPromise
          await chooser.setFiles({
            name: 'verify-delhi-1990.json',
            mimeType: 'application/json',
            buffer: Buffer.from(backup, 'utf8'),
          })
        })
        await step('confirm legacy backup import', () => confirmLegacyBackupImport(page))

        // Navigate to the dashboard. The chart visuals (3D force-field hero +
        // 2D kundli) are a SCREEN feature of the "For Astrologer" (technical)
        // view — the default "For You" (layman) view summarizes the chart in
        // cards and does not embed the canvas/kundli on screen. So switch into
        // the astrologer view the same way a user does (the content-mode toggle)
        // and assert the real chart UI renders there. (contentMode is in-memory
        // only — Spec 036 dropped its persistence — so we drive the toggle UI
        // rather than seeding a store key.)
        await step('goto /dashboard', async () => {
          await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'domcontentloaded' })
          await page.waitForTimeout(2500)
        })
        // Click the "For Astrologer" tab to reveal the on-screen ChartVisualization.
        await step('click astrologer tab', () =>
          page.click('[data-testid="astrologer-tab"]', { timeout: 10_000 }).catch(() => {}),
        )
        // The force-field hero is a lazy chunk (three.js) behind Suspense; give it
        // time to load + mount its <canvas>, then settle the WebGL init.
        await step('wait for force-field canvas', async () => {
          await page
            .waitForSelector('[data-testid="chart-visualization"] canvas', { timeout: 20_000 })
            .catch(() => {})
          await page.waitForTimeout(1500)
        })
        const rendered = await step('read rendered chart DOM', () => page.evaluate(() => {
          const text = document.body.innerText || ''
          // SVG <text> (planet/sign glyphs) is NOT in innerText — use textContent.
          const svgText = document.body.textContent || ''
          const hasError = /something went wrong|error boundary/i.test(text)
          // Real chart evidence (not the empty state, which shows "Chart Data Not
          // Available" + a single generic icon SVG): the 3D force-field hero
          // mounted a <canvas>, the kundli rendered multiple SVGs, and planet
          // glyphs (Su/Mo/Ma/Me/Ju/Ve/Sa/Ra/Ke) appear in SVG text.
          const isEmptyState = /chart data not available/i.test(text)
          const svgCount = document.querySelectorAll('svg').length
          const canvasCount = document.querySelectorAll('canvas').length
          const hasPlanetGlyphs = /\b(Su|Mo|Ma|Me|Ju|Ve|Sa|Ra|Ke)\b/.test(svgText)
          const hasChartUi = !isEmptyState && canvasCount >= 1 && svgCount >= 2
          return { hasError, hasChartUi, isEmptyState, hasPlanetGlyphs, svgCount, canvasCount, bodyLen: text.length }
        }))
        renderPass = rendered.hasChartUi && !rendered.hasError
        renderDetail = `svgCount=${rendered.svgCount} canvasCount=${rendered.canvasCount} planetGlyphs=${rendered.hasPlanetGlyphs} emptyState=${rendered.isEmptyState} hasError=${rendered.hasError}`
      })
    } catch (e) {
      renderPass = false
      renderDetail = describeError(e)
    }
  } else {
    renderDetail = 'skipped (correctness failed)'
  }
  record('CHECK 4 — render dashboard from persisted chart', renderPass, renderDetail)

  // The requests made AFTER the engine path snapshot are the dashboard render
  // window — including the 3D force-field hero. troika-three-text resolves
  // glyphs via @unicode-font-resolver, which (without a pinned font) fetches its
  // data from cdn.jsdelivr.net at render. We pin a same-origin Hanken Grotesk
  // TTF + use an ASCII retrograde marker so NO third-party font fetch happens.
  const forceFieldRequests = requests.slice(enginePathRequests.length)
  const offOrigin = (list) =>
    [...new Set(list)].filter((u) => {
      try {
        if (u.startsWith('data:') || u.startsWith('blob:')) return false
        return new URL(u).host !== ORIGIN
      } catch {
        return false
      }
    })
  const forceFieldOffOrigin = offOrigin(forceFieldRequests)
  const forceFieldCdnHits = [...new Set(forceFieldRequests)].filter((u) =>
    u.includes('cdn.jsdelivr.net'),
  )
  const forceFieldSameOrigin = forceFieldOffOrigin.length === 0 && forceFieldCdnHits.length === 0
  record(
    'CHECK 4b — force-field render is same-origin (no cdn.jsdelivr.net)',
    forceFieldSameOrigin,
    forceFieldSameOrigin
      ? `force-field render: ${new Set(forceFieldRequests).size} request(s), all same-origin to ${ORIGIN}`
      : `force-field third-party egress: ${[...new Set([...forceFieldOffOrigin, ...forceFieldCdnHits])].join(', ')}`,
  )

  // ---- CHECK 5: offline after first load ----
  // The engine's DATA (Pyodide dist + wheels + ephemeris) is synced into OPFS on
  // the first boot. To prove offline durability of that data without a Service
  // Worker (the app *shell* caching is P6, not yet implemented), we reload with
  // a network that ABORTS every engine-data refetch: /bundle/*, /pyodide/*, and
  // public.key — plus any third-party. The static app shell (local index.html +
  // JS/CSS) is allowed through (in a real deploy P6's SW serves it from cache).
  // If the engine still reaches "ready", it MUST have re-used the OPFS bytes.
  let offlinePass = false
  let offlineDetail
  try {
    // The shell itself needs the (late) service worker; the engine bytes must
    // already be durable from the first boot, whoever cached them.
    await page
      .evaluate(() =>
        Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(r, 30_000))]),
      )
      .catch(() => {})
    await guarded('CHECK 5', DEADLINES_MS.check5, async ({ step, signal }) => {
      const abortedDuringOffline = []
      await step('install engine-data abort route', () => context.route('**/*', (route) => {
        const url = route.request().url()
        let host
        try {
          host = new URL(url).host
        } catch {
          host = ''
        }
        const isEngineData =
          url.includes('/bundle/') || url.includes('/pyodide/') || url.includes('/public.key')
        const isThirdParty = host && host !== ORIGIN
        if (isEngineData || isThirdParty) {
          abortedDuringOffline.push(url)
          return route.abort('failed')
        }
        return route.continue()
      }))

      // /dashboard boots the engine unconditionally (the `/` splash defers it for
      // fresh visitors); the offline-reboot-from-OPFS semantics are route-independent.
      await step('goto /dashboard with engine data blocked', async () => {
        await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'load' }).catch((e) => {
          offlineDetail = `goto err: ${String(e)}`
        })
        await page.waitForTimeout(1000)
      })

      // Wait for the engine to reach ready again purely from OPFS-cached bytes.
      let offlineStage = null
      let offlineErr = null
      await step('poll engine stage until ready (engine data blocked)', async () => {
        const odl = Date.now() + 90_000
        while (Date.now() < odl && !signal.aborted) {
          const probe = await page.evaluate(() => ({
            stage: window.__ALMAMESH_STAGE__ ?? null,
            error: window.__ALMAMESH_ERROR__ ?? null,
          }))
          offlineStage = probe.stage
          offlineErr = probe.error
          if (offlineErr) break
          if (offlineStage === 'ready') break
          await page.waitForTimeout(500)
        }
      })

      // The dashboard's identity strip is a user-visible read through the real
      // chart-library store after it rehydrates from canonical SQLite.
      const savedChart = await step('read saved chart identity strip', async () => {
        await page.waitForSelector('[data-testid="identity-strip"]', { timeout: 20_000 }).catch(() => {})
        return page.evaluate(() => ({
          hasIdentity: document.querySelector('[data-testid="identity-strip"]') !== null,
          hasNoChart: document.querySelector('[data-testid="no-chart-state"]') !== null,
          hasReadFailure: document.querySelector('[data-testid="chart-read-failed"]') !== null,
        }))
      })

      // Durability probe: the synced engine DATA persists in OPFS across reload.
      // Since @gainratio/browser 0.3.0 that is one SQLite database in an
      // opfs-sahpool: the library must report OPFS persistence and its pool
      // directory must hold files with bytes in them.
      const cacheStorage = await step('read engine cache storage', () =>
        page.evaluate(() => window.__EDGEPROC_CACHE_STORAGE__ ?? null).catch(() => null),
      )
      const poolDirectory = cachePoolDirectory(cacheStorage)
      const opfs = await step('walk OPFS cache pool', () => page.evaluate(async (directory) => {
        if (directory === null) return { error: 'engine cache is not on OPFS' }
        try {
          // The sahpool keeps its slot files in a subdirectory (`.opaque`): walk it all.
          let files = 0
          let bytes = 0
          const pending = [await (await navigator.storage.getDirectory()).getDirectoryHandle(directory)]
          while (pending.length > 0) {
            for await (const [, handle] of pending.pop().entries()) {
              if (handle.kind === 'directory') {
                pending.push(handle)
                continue
              }
              files += 1
              bytes += (await handle.getFile()).size
            }
          }
          return { files, bytes }
        } catch (e) {
          return { error: String(e) }
        }
      }, poolDirectory).catch((e) => ({ error: String(e) })))

      const chartReadable =
        savedChart.hasIdentity && !savedChart.hasNoChart && !savedChart.hasReadFailure
      const opfsDurable = (opfs?.files ?? 0) > 0 && (opfs?.bytes ?? 0) > 0
      const rebootedOffline = offlineStage === 'ready' && !offlineErr

      // P6 closed both halves of the exit-gate claim:
      //   (a) engine DATA survives first load (OPFS chunks + active version +
      //       canonical SQLite chart);
      //   (b) the engine RE-BOOTS with zero network — the sync tier now falls back
      //       to the cached active version when /latest is unreachable (and the
      //       app shell is served by the Service Worker). So CHECK 5 now requires
      //       the offline reboot too, not just durability.
      offlinePass = chartReadable && opfsDurable && rebootedOffline
      offlineDetail =
        `OPFS cache ${JSON.stringify(cacheStorage)} pool files=${opfs?.files ?? '?'} bytes=${opfs?.bytes ?? '?'}${opfs?.error ? ` error="${opfs.error}"` : ''} | canonical SQLite chart readable=${chartReadable} (identity=${savedChart.hasIdentity}, noChart=${savedChart.hasNoChart}, readFailure=${savedChart.hasReadFailure}). ` +
        `OFFLINE-REBOOT: rebooted=${rebootedOffline} offlineStage=${offlineStage}${offlineErr ? ` err="${offlineErr}"` : ''} (sync fell back to the cached active version; bundle/pyodide refetch aborted).`
    })
  } catch (e) {
    offlinePass = false
    offlineDetail = describeError(e)
  } finally {
    await bounded(context.unroute('**/*'), CLEANUP_MS)
  }
  record('CHECK 5 — engine reboots offline from cached OPFS bytes (sync falls back, no /latest)', offlinePass, offlineDetail)

  // ---- CHECK 7: HARD offline reload (true network kill via setOffline) ----
  // The strongest offline proof: kill the network entirely (context.setOffline),
  // then RELOAD. The Service Worker must serve the precached app shell
  // (index.html + hashed JS/CSS) — without it the reload lands on a
  // chrome-error page — AND the engine must reboot from the OPFS-cached bundle
  // (the sync tier falls back to the cached active version because /latest is
  // unreachable). Finally the saved chart must still render.
  let hardOfflinePass = false
  let hardOfflineDetail
  try {
    await guarded('CHECK 7', DEADLINES_MS.check7, async ({ step, signal }) => {
      // Give the Service Worker a beat to claim the page + finish precaching.
      const swReady = await step('wait for service worker ready', async () => {
        await page.bringToFront().catch(() => {})
        return page
          .evaluate(async () => {
            if (!('serviceWorker' in navigator)) return false
            const reg = await navigator.serviceWorker.ready.catch(() => null)
            return !!reg && !!(reg.active || navigator.serviceWorker.controller)
          })
          .catch(() => false)
      })

      const offlineNet = []
      page.on('requestfailed', (req) => offlineNet.push(req.url()))

      await step('set context offline', () => context.setOffline(true))
      // Navigate to the saved-chart dashboard with the network fully offline.
      let gotoErr = null
      await step('goto /dashboard offline', () =>
        page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'load' }).catch((e) => {
          gotoErr = String(e)
        }),
      )

      // App shell must have loaded from the SW cache (root element + app JS run).
      const shellLoaded = await step('read offline app shell', () => page
        .evaluate(() => {
          const hasRoot = !!document.getElementById('root')
          const text = document.body.innerText || ''
          const isChromeError = /no internet|err_internet_disconnected|this site can.?t be reached/i.test(
            text,
          )
          return { hasRoot, isChromeError, bodyLen: text.length }
        })
        .catch((e) => ({ error: String(e) })))

      // Engine must reboot from OPFS with the network dead (sync fallback path).
      let hoStage = null
      let hoErr = null
      await step('poll engine stage until ready (offline)', async () => {
        const hdl = Date.now() + 90_000
        while (Date.now() < hdl && !signal.aborted) {
          const probe = await page
            .evaluate(() => ({
              stage: window.__ALMAMESH_STAGE__ ?? null,
              error: window.__ALMAMESH_ERROR__ ?? null,
            }))
            .catch(() => ({ stage: null, error: null }))
          hoStage = probe.stage
          hoErr = probe.error
          if (hoErr) break
          if (hoStage === 'ready') break
          await page.waitForTimeout(500)
        }
      })

      // The saved chart must render (chart UI present, no error boundary).
      const rendered = await step('read offline chart render', async () => {
        await page.waitForTimeout(1500)
        await page.waitForSelector('[data-testid="identity-strip"]', { timeout: 20_000 }).catch(() => {})
        return page.evaluate(() => {
          const text = document.body.innerText || ''
          const hasError = /something went wrong|error boundary/i.test(text)
          const hasIdentity = document.querySelector('[data-testid="identity-strip"]') !== null
          const hasNoChart = document.querySelector('[data-testid="no-chart-state"]') !== null
          const hasReadFailure = document.querySelector('[data-testid="chart-read-failed"]') !== null
          return { hasError, hasIdentity, hasNoChart, hasReadFailure }
        })
        .catch((e) => ({ error: String(e) }))
      })

      // No /latest fetch should have SUCCEEDED offline (it must fail -> fallback).
      const latestAttempts = offlineNet.filter((u) => u.includes('/bundle/latest'))
      const shellOk = shellLoaded.hasRoot === true && shellLoaded.isChromeError !== true
      const rebooted = hoStage === 'ready' && !hoErr
      const chartRendered =
        rendered.hasIdentity === true &&
        rendered.hasNoChart !== true &&
        rendered.hasReadFailure !== true &&
        rendered.hasError !== true

      hardOfflinePass = swReady && shellOk && rebooted && chartRendered
      hardOfflineDetail =
        `swReady=${swReady} shellLoaded(root=${shellLoaded.hasRoot},chromeError=${shellLoaded.isChromeError}) ` +
        `engineReboot=${rebooted}(stage=${hoStage}${hoErr ? ` err="${hoErr}"` : ''}) ` +
        `chartRendered=${chartRendered}(identity=${rendered.hasIdentity},noChart=${rendered.hasNoChart},readFailure=${rendered.hasReadFailure}) ` +
        `/latest offline-attempts(failed)=${latestAttempts.length}` +
        (gotoErr ? ` gotoErr=${gotoErr}` : '')
    })
  } catch (e) {
    hardOfflinePass = false
    hardOfflineDetail = describeError(e)
  } finally {
    await bounded(context.setOffline(false), CLEANUP_MS)
  }
  record(
    'CHECK 7 — HARD offline reload: SW serves shell + engine reboots from OPFS + chart renders',
    hardOfflinePass,
    hardOfflineDetail,
  )

  // ---- CHECK 6: network egress is same-origin only ----
  // (offOrigin is defined once near CHECK 4b, above.)
  // The exit-gate claim: the ENGINE path (boot + generate) makes zero
  // third-party requests. This is what CHECK 6 gates on.
  const engineThirdParty = offOrigin(enginePathRequests)
  // For transparency, also report third-party egress over the FULL run, which
  // includes the dashboard's legacy LLM-interpretation/usage calls.
  const fullThirdParty = offOrigin(requests)
  const dashboardOnly = fullThirdParty.filter((u) => !engineThirdParty.includes(u))
  record(
    'CHECK 6 — engine-path network egress is same-origin only',
    engineThirdParty.length === 0,
    engineThirdParty.length === 0
      ? `engine path: ${new Set(enginePathRequests).size} requests, all to ${ORIGIN}` +
          (dashboardOnly.length
            ? ` | NOTE: dashboard (legacy SaaS, P5) attempted ${dashboardOnly.length} backend call(s): ${dashboardOnly.join(', ')}`
            : '')
      : `engine-path third-party: ${engineThirdParty.join(', ')}`,
  )

  // ---- Evidence dump ----
  console.log('\n================ EVIDENCE ================')
  console.log(`cold boot: ${coldBootMs}ms`)
  console.log(`workers spawned (${workerUrls.size}):`)
  for (const w of workerUrls) console.log(`  - ${w}`)
  console.log('\nunique network requests (same-origin filtered to host paths):')
  const uniqueReqs = [...new Set(requests)]
  for (const u of uniqueReqs) {
    let host
    try {
      host = u.startsWith('data:') || u.startsWith('blob:') ? u.slice(0, 24) + '…' : new URL(u).host
    } catch {
      host = '?'
    }
    const flag = host === ORIGIN || host.endsWith('…') ? '' : '  <<< THIRD-PARTY'
    let pathStr
    try {
      pathStr = u.startsWith('data:') || u.startsWith('blob:') ? host : new URL(u).pathname
    } catch {
      pathStr = u
    }
    console.log(`  [${host}] ${pathStr}${flag}`)
  }
  console.log('\nconsole tail (last 40):')
  for (const l of consoleLines.slice(-40)) console.log(`  ${l}`)
  if (pageErrors.length) {
    console.log('\nPAGE ERRORS:')
    for (const e of pageErrors) console.log(`  ${e}`)
  }

  console.log('\n================ SUMMARY ================')
  let allPass = true
  for (const r of results) {
    if (!r.pass) allPass = false
    console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}`)
  }
  console.log(`\nOVERALL: ${allPass ? 'PASS' : 'FAIL'}`)

  await withDeadline('browser.close', DEADLINES_MS.close, ({ step }) =>
    step('close browser', () => browser.close()),
  ).catch((e) => console.log(`browser.close: ${describeError(e)}`))
  process.exit(allPass ? 0 : 1)
}

main().catch((e) => {
  console.error('verify-exit-gate crashed:', e)
  process.exit(2)
})
