#!/usr/bin/env node
/**
 * Memory attribution by journey stage (diagnostic). Private memory of the
 * biggest web-content process: USS from /proc on Linux, phys_footprint (the
 * metric iOS jetsam uses) from `footprint` on macOS.
 *
 * Walks one first-time visitor through the app in stages and, after each stage
 * settles, records that private memory (WebKit WebContent / Chromium renderer)
 * and the live Workers. The delta between stages attributes memory to the
 * feature that stage turned on:
 *
 *   blank -> welcome (landing + force field) -> onboarding-ready (SQLite +
 *   bundle sync + Pyodide boot) -> chart (dashboard, engine compute, force
 *   field) -> chat-search (embedder + sqlite-vector) -> settings (dashboard
 *   unmounted) -> idle (after the embedder idle window)
 *
 * Usage (inside the Playwright Linux container):
 *   node scripts/attribute-memory.mjs http://127.0.0.1:4199 --browser=webkit
 */

import { execFileSync } from 'node:child_process'
import { clearInterval, setInterval } from 'node:timers'

import { chromium, devices, webkit } from '@playwright/test'

import { readProcessTree } from './processMemory.mjs'

const BASE_URL = process.argv.find((argument) => /^https?:\/\//.test(argument)) ?? 'http://127.0.0.1:4199'
const BROWSER_NAME = process.argv.find((a) => a.startsWith('--browser='))?.slice(10) ?? 'webkit'
const IDLE_MS = Number(process.argv.find((a) => a.startsWith('--idle-ms='))?.slice(10) ?? '0')
const SETTLE_MS = 4_000
const ABLATE = new Set((process.argv.find((a) => a.startsWith('--ablate='))?.slice(9) ?? '').split(',').filter(Boolean))
const STOP_AFTER = process.argv.find((a) => a.startsWith('--stop-after='))?.slice(13)
const WEB_KINDS = { webkit: 'webkit-web', chromium: 'renderer' }
const MAC = process.platform === 'darwin'

/** macOS: phys_footprint MiB of one pid (the number iOS jetsam compares against its limit). */
function footprintMiB(pid) {
  try {
    const text = execFileSync('footprint', ['-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const match = /phys_footprint:\s+([\d.]+)\s+(KB|MB|GB)/.exec(text)
    if (!match) return 0
    return Number(match[1]) * { KB: 1 / 1024, MB: 1, GB: 1024 }[match[2]]
  } catch {
    return 0
  }
}

function macProcesses() {
  return execFileSync('ps', ['-A', '-o', 'pid=,ppid=,args='], { encoding: 'utf8' })
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter(Boolean)
    .map(([, pid, ppid, args]) => ({ pid: Number(pid), ppid: Number(ppid), args }))
}

// WebKit's WebContent XPC services are children of launchd on macOS, so ours are
// the Playwright-build WebContent processes that did not exist before launch.
const playwrightWebContent = (processes) =>
  processes.filter((p) => p.args.includes('ms-playwright/webkit') && p.args.includes('WebContent'))
let tainted = false
const preexisting = new Set(MAC ? playwrightWebContent(macProcesses()).map((p) => p.pid) : [])

/** The page's web-content processes with their private memory (USS on Linux, phys_footprint on macOS). */
function webProcesses() {
  if (!MAC) {
    const tree = readProcessTree(process.pid)
    if (tree === null) throw new Error('needs Linux /proc or macOS footprint')
    return tree.filter((e) => e.kind === WEB_KINDS[BROWSER_NAME]).map((e) => ({ pid: e.pid, privateMiB: (e.privateBytes ?? 0) / 1048576 }))
  }
  const all = macProcesses()
  if (BROWSER_NAME === 'webkit') {
    // Another Playwright WebKit on this Mac would make "new WebContent" ambiguous.
    const ancestors = new Set([process.pid])
    for (const p of all) if (ancestors.has(p.ppid)) ancestors.add(p.pid)
    for (const p of all) if (ancestors.has(p.ppid)) ancestors.add(p.pid)
    const foreign = all.filter((p) => p.args.includes('Playwright.app/Contents/MacOS/Playwright') && !ancestors.has(p.pid))
    if (foreign.length > 0) tainted = true
    return playwrightWebContent(all).filter((p) => !preexisting.has(p.pid)).map((p) => ({ pid: p.pid, privateMiB: footprintMiB(p.pid) }))
  }
  const children = new Map()
  for (const p of all) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p])
  const ours = []
  const queue = [...(children.get(process.pid) ?? [])]
  while (queue.length > 0) {
    const p = queue.shift()
    ours.push(p)
    queue.push(...(children.get(p.pid) ?? []))
  }
  return ours.filter((p) => p.args.includes('--type=renderer')).map((p) => ({ pid: p.pid, privateMiB: footprintMiB(p.pid) }))
}

function webMemory() {
  const web = webProcesses()
  return {
    each: web.map((p) => Math.round(p.privateMiB)).join(' + '),
    biggest: Math.max(0, ...web.map((p) => p.privateMiB)),
    sum: web.reduce((total, p) => total + p.privateMiB, 0),
  }
}

let peakBiggest = 0
const peakTimer = setInterval(() => {
  peakBiggest = Math.max(peakBiggest, webMemory().biggest)
}, MAC ? 500 : 250)

const liveWorkers = new Map()
function trackWorkers(page) {
  page.on('worker', (worker) => {
    const name = new URL(worker.url()).pathname.replace(/-[\w-]{8}\.js$/, '.js')
    liveWorkers.set(worker, name)
    worker.on('close', () => liveWorkers.delete(worker))
  })
}

async function heapMiB(page) {
  if (BROWSER_NAME !== 'chromium') return null
  return page
    .evaluate(async () => (await performance.measureUserAgentSpecificMemory()).bytes / 1048576)
    .catch(() => null)
}

const rows = []
class StopHere extends Error {}
async function stage(page, name) {
  await page.waitForTimeout(SETTLE_MS)
  const now = webMemory()
  peakBiggest = Math.max(peakBiggest, now.biggest)
  const row = {
    stage: name,
    privateMiB: Math.round(now.biggest),
    peakPrivateMiB: Math.round(peakBiggest),
    eachWebPrivateMiB: now.each,
    heapMiB: (await heapMiB(page))?.toFixed(0) ?? null,
    workers: [...liveWorkers.values()].sort().join(','),
  }
  rows.push(row)
  console.log(`attribute ${BROWSER_NAME} ${JSON.stringify(row)}`)
  if (name === STOP_AFTER) throw new StopHere()
}

/** Turn one feature off to bisect what it costs. */
async function applyAblations(context) {
  if (ABLATE.has('webgl')) {
    await context.addInitScript(() => {
      const original = window.HTMLCanvasElement.prototype.getContext
      window.HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
        return /webgl/.test(type) ? null : original.call(this, type, ...rest)
      }
    })
  }
  if (ABLATE.has('sqlite-worker')) await context.route(/\/assets\/worker-[^/]+\.js/, (route) => route.abort())
}

async function typeSections(page, testId, digits, trailing = '') {
  await page.locator(`[data-testid="${testId}"] [role="spinbutton"]`).first().click()
  await page.keyboard.type(digits, { delay: 30 })
  if (trailing) await page.keyboard.type(trailing, { delay: 30 })
}

async function navigate(page, path) {
  await page.evaluate((target) => {
    window.history.pushState({}, '', target)
    window.dispatchEvent(new window.PopStateEvent('popstate'))
  }, path)
}

const { defaultBrowserType: _ignored, ...iPhone } = devices['iPhone 13']
const launcher = BROWSER_NAME === 'chromium' ? chromium : webkit
const browser = await launcher.launch(
  BROWSER_NAME === 'chromium'
    ? { channel: 'chromium', args: ['--enable-precise-memory-info', '--enable-blink-features=ForceEagerMeasureMemory'] }
    : {},
)
const context = await browser.newContext({
  ...iPhone,
  baseURL: BASE_URL,
  ...(ABLATE.has('service-worker') ? { serviceWorkers: 'block' } : {}),
})
await applyAblations(context)
const page = await context.newPage()
trackWorkers(page)
page.on('pageerror', (error) => console.log(`pageerror ${error.message}`))
page.on('console', (message) => {
  if (message.type() === 'error') console.log(`console-error ${message.text().slice(0, 200)}`)
})
try {
  await page.goto('about:blank')
  await stage(page, 'blank')
  await page.goto('/welcome')
  await stage(page, 'welcome')
  await page.goto('/onboarding')
  await page.waitForFunction(() => window.__ALMAMESH_STAGE__ === 'ready', undefined, { timeout: 300_000 }).catch(() => {})
  await stage(page, 'onboarding-ready')
  await page.getByTestId('name-input').fill('Memory Attribution')
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
  await page.getByTestId('chart-visualization').first().waitFor({ state: 'attached', timeout: 300_000 })
  await stage(page, 'chart')
  await page.getByTestId('floating-chat-button').click()
  await page.getByTestId('chat-search-input').fill('career')
  await page.getByTestId('chat-search-results').getByText('No matching past messages.').waitFor({ timeout: 180_000 })
  await stage(page, 'chat-search')
  await page.keyboard.press('Escape')
  await navigate(page, '/settings')
  await stage(page, 'settings')
  if (IDLE_MS > 0) {
    await page.waitForTimeout(IDLE_MS)
    await stage(page, `idle-${IDLE_MS / 1000}s`)
  }
} catch (error) {
  if (!(error instanceof StopHere)) throw error
} finally {
  clearInterval(peakTimer)
  console.log(`attribute-summary ${BROWSER_NAME} ${tainted ? 'TAINTED(another Playwright WebKit ran) ' : ''}${JSON.stringify(rows.map((r) => [r.stage, r.privateMiB, r.peakPrivateMiB, r.heapMiB]))}`)
  await browser.close()
}
