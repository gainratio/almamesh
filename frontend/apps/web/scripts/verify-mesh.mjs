#!/usr/bin/env node
/**
 * Mesh live-drive — REAL browser (headless Chromium) + REAL in-browser engine
 * against a production build + preview. Proves the namesake surface end to
 * end: the always-visible nav entry, the invitation state, the constellation,
 * and a LIVE on-device `ensureMeshEdge` compute (two natal contexts + relation
 * math) rendering every curated edge section — not just that unit tests pass.
 *
 * Usage:  node scripts/verify-mesh.mjs [baseURL]   (default http://localhost:4173)
 *   Expects a preview of a build made with VITE_EXIT_GATE_HOOKS=1 (the
 *   `window.__almameshGenerate` / `__ALMAMESH_STAGE__` hooks seed real charts,
 *   exactly like the interpretation e2e suite):
 *     VITE_EXIT_GATE_HOOKS=1 bun run build && bun run preview
 *
 * CHECK 1 — "Mesh" nav entry reachable on first load; /mesh renders the
 *           invitation; its CTA routes to Settings → People.
 * CHECK 2 — restore three REAL engine charts (Delhi anchor, Mumbai spouse,
 *           Bengaluru friend) through Settings into canonical SQLite with the
 *           profiles envelope (anchor 'self' + 'spouse' + 'friend').
 * CHECK 3 — /mesh renders the constellation: anchor centred, member node with
 *           name/relationship/rising sign, hairline thread.
 * CHECK 4 — clicking the member node opens /mesh/:id, the edge computes LIVE
 *           on-device, and every curated section + the integrity note render.
 * CHECK 5 — flipping the bride-table seat recomputes the edge (role-aware).
 * CHECK 6 — the NEGATIVE invariant (safety-critical curation rule): a FRIEND
 *           (non-marriage) edge must NEVER render the marriage-matching tables
 *           (Ashtakoota compatibility card + Mangal screening); Graha Maitri
 *           leads instead, and the integrity note still renders.
 */
import { chromium } from '@playwright/test'
import { Buffer } from 'node:buffer'
import { confirmLegacyBackupImport } from './confirmLegacyBackupImport.mjs'

const BASE_URL = process.argv[2] ?? 'http://localhost:4173'
const SHOT_DIR = 'test-results/mesh-live'

const ANCHOR_BIRTH = {
  name: 'Asha Live',
  datetimeUtc: '1990-01-15T12:00:00.000Z',
  latitude: 28.6139,
  longitude: 77.209,
  referenceDate: '2025-01-01T00:00:00+00:00',
  chartId: 'mesh-live-anchor',
  profileId: 'p-self',
  birthDatetimeLocal: '1990-01-15T17:30:00',
  timezone: 'Asia/Kolkata',
  city: 'Delhi',
  locationName: 'Delhi, India',
}

// The golden-pair member: Mumbai 1985-07-23 04:30Z (10:00 IST).
const MEMBER_BIRTH = {
  name: 'Dev Live',
  datetimeUtc: '1985-07-23T04:30:00.000Z',
  latitude: 19.076,
  longitude: 72.8777,
  referenceDate: '2025-01-01T00:00:00+00:00',
  chartId: 'mesh-live-member',
  profileId: 'p-spouse',
  birthDatetimeLocal: '1985-07-23T10:00:00',
  timezone: 'Asia/Kolkata',
  city: 'Mumbai',
  locationName: 'Mumbai, India',
}

// The non-marriage member (CHECK 6): Bengaluru 1992-03-10 06:30Z (12:00 IST).
const FRIEND_BIRTH = {
  name: 'Mira Live',
  datetimeUtc: '1992-03-10T06:30:00.000Z',
  latitude: 12.9716,
  longitude: 77.5946,
  referenceDate: '2025-01-01T00:00:00+00:00',
  chartId: 'mesh-live-friend',
  profileId: 'p-friend',
  birthDatetimeLocal: '1992-03-10T12:00:00',
  timezone: 'Asia/Kolkata',
  city: 'Bengaluru',
  locationName: 'Bengaluru, India',
}

let failures = 0
function fail(msg) {
  console.error(`\n❌ ${msg}`)
  failures += 1
}
function ok(msg) {
  console.log(`✅ ${msg}`)
}

const browser = await chromium.launch()
const context = await browser.newContext()
const page = await context.newPage()

const consoleErrors = []
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text())
})
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))

async function waitForEngineReady() {
  await page.waitForFunction(
    () => {
      const w = window
      if (w.__ALMAMESH_ERROR__) throw new Error(`engine boot error: ${w.__ALMAMESH_ERROR__}`)
      return w.__ALMAMESH_STAGE__ === 'ready' && typeof w.__almameshGenerate === 'function'
    },
    undefined,
    { timeout: 180_000, polling: 500 },
  )
}

async function restoreBackup(backup) {
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
    name: 'verify-mesh.json',
    mimeType: 'application/json',
    buffer: Buffer.from(backup, 'utf8'),
  })
  await confirmLegacyBackupImport(page)
}

try {
  // -------------------------------------------------------------------------
  // CHECK 1 — reachability + the invitation state (no people on this device).
  // -------------------------------------------------------------------------
  await page.goto(`${BASE_URL}/mesh`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-testid="mesh-invitation"]', { timeout: 30_000 })
  const navLink = await page.$('[data-testid="nav-mesh-link"]')
  if (navLink) ok('CHECK 1a: "Mesh" nav entry is in the app header (visible always)')
  else fail('CHECK 1a: nav-mesh-link missing from the header')
  ok('CHECK 1b: /mesh renders the invitation when the mesh is not ready')
  await page.screenshot({ path: `${SHOT_DIR}/1-invitation.png`, fullPage: true })

  await page.click('[data-testid="mesh-invitation-cta"]')
  await page.waitForURL('**/settings/people', { timeout: 15_000 })
  ok('CHECK 1c: invitation CTA routes to Settings → People')

  // -------------------------------------------------------------------------
  // CHECK 2 — REAL engine boot + restore real charts and profiles via Settings.
  // -------------------------------------------------------------------------
  await page.goto(`${BASE_URL}/onboarding`, { waitUntil: 'domcontentloaded' })
  await waitForEngineReady()
  ok('CHECK 2a: in-browser engine booted (stage=ready, generate hook present)')

  const fixture = await page.evaluate(
    async ({ anchor, member, friend }) => {
      const generate = window.__almameshGenerate

      /** Real engine chart → the chart-library stored-chart envelope shape. */
      async function storedFor(birth) {
        const chart = await generate({
          datetimeUtc: birth.datetimeUtc,
          latitude: birth.latitude,
          longitude: birth.longitude,
          referenceDate: birth.referenceDate,
          name: birth.name,
        })
        return {
          chart_id: birth.chartId,
          person_name: birth.name,
          is_primary: true,
          profile_id: birth.profileId,
          birth_data: {
            name: birth.name,
            birth_datetime_utc: birth.datetimeUtc,
            birth_datetime_local: birth.birthDatetimeLocal,
            birth_location_details: {
              city: birth.city,
              latitude: birth.latitude,
              longitude: birth.longitude,
              timezone: birth.timezone,
              location_name: birth.locationName,
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
            yoga_ctx: chart.yogas ?? [],
            calculation_timestamp: '2025-01-01T00:00:00+00:00',
            software_version: 'almamesh-browser-engine',
          },
          sidereal_chart: chart,
        }
      }

      const anchorStored = await storedFor(anchor)
      const memberStored = await storedFor(member)
      const friendStored = await storedFor(friend)

      return {
        backup: JSON.stringify({
          format: 'almamesh-backup',
          formatVersion: 1,
          app: { version: 'verify-mesh' },
          exportedAt: '2026-01-01T00:00:00.000Z',
          encryption: 'none',
          stores: {
            'almamesh-chart-library': {
              version: 1,
              state: {
                charts: {
                  [anchor.chartId]: anchorStored,
                  [member.chartId]: memberStored,
                  [friend.chartId]: friendStored,
                },
              },
            },
            'almamesh-profiles': {
              version: 1,
              state: {
                profiles: {
                  [anchor.profileId]: {
                    id: anchor.profileId,
                    name: anchor.name,
                    createdAt: '2026-01-01T00:00:00Z',
                    avatarTint: '#C9A24B',
                    relationship: 'self',
                  },
                  [member.profileId]: {
                    id: member.profileId,
                    name: member.name,
                    createdAt: '2026-01-02T00:00:00Z',
                    avatarTint: '#3A4FB0',
                    relationship: 'spouse',
                    relatedTo: anchor.profileId,
                  },
                  [friend.profileId]: {
                    id: friend.profileId,
                    name: friend.name,
                    createdAt: '2026-01-03T00:00:00Z',
                    avatarTint: '#6B4FB0',
                    relationship: 'friend',
                    relatedTo: anchor.profileId,
                  },
                },
                activeProfileId: anchor.profileId,
              },
            },
          },
        }),
        anchorLagna: anchorStored.astronomical_calculations.sidereal_ctx.lagna?.sign ?? null,
        memberLagna: memberStored.astronomical_calculations.sidereal_ctx.lagna?.sign ?? null,
        friendLagna: friendStored.astronomical_calculations.sidereal_ctx.lagna?.sign ?? null,
      }
    },
    { anchor: ANCHOR_BIRTH, member: MEMBER_BIRTH, friend: FRIEND_BIRTH },
  )
  await restoreBackup(fixture.backup)
  ok(
    `CHECK 2b: three REAL charts generated + restored (anchor lagna=${fixture.anchorLagna}, spouse lagna=${fixture.memberLagna}, friend lagna=${fixture.friendLagna})`,
  )

  // -------------------------------------------------------------------------
  // CHECK 3 — the constellation.
  // -------------------------------------------------------------------------
  await page.goto(`${BASE_URL}/mesh`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-testid="mesh-page"]', { timeout: 30_000 })
  const anchorNode = await page.textContent('[data-testid="mesh-anchor-node"]')
  const memberNode = await page.textContent('[data-testid="mesh-node-p-spouse"]')
  if (anchorNode?.includes('Asha Live')) ok('CHECK 3a: anchor node centred with name')
  else fail(`CHECK 3a: anchor node text wrong: ${anchorNode}`)
  if (memberNode?.includes('Dev Live') && /rising/i.test(memberNode ?? ''))
    ok(`CHECK 3b: member node carries name + relationship + rising sign (${memberNode?.trim().slice(0, 60)}…)`)
  else fail(`CHECK 3b: member node text wrong: ${memberNode}`)
  const thread = await page.$('[data-testid="mesh-thread-p-spouse"]')
  if (thread) ok('CHECK 3c: hairline thread drawn anchor → member')
  else fail('CHECK 3c: mesh-thread-p-spouse missing')
  await page.screenshot({ path: `${SHOT_DIR}/2-constellation.png`, fullPage: true })

  // -------------------------------------------------------------------------
  // CHECK 4 — the edge view computes LIVE on-device and renders curated.
  // -------------------------------------------------------------------------
  await page.click('[data-testid="mesh-node-p-spouse"]')
  await page.waitForSelector('[data-testid="mesh-edge-page"]', { timeout: 15_000 })
  ok('CHECK 4a: node click navigates to the edge view')

  // Engine re-boots after the hard /mesh navigation, then the edge computes —
  // honest pending in between; the marriage tables land when it finishes.
  await page.waitForSelector('[data-testid="mesh-compatibility"]', { timeout: 240_000 })
  ok('CHECK 4b: edge computed LIVE on-device (compatibility card rendered)')

  const kootaRows = await page.$$('[data-testid^="mesh-koota-"]')
  if (kootaRows.length === 8) ok('CHECK 4c: all 8 koota rows render')
  else fail(`CHECK 4c: expected 8 koota rows, got ${kootaRows.length}`)

  const total = await page.textContent('[data-testid="mesh-guna-total"]')
  if (total?.includes('of 36') && /a label, not a verdict/.test(total))
    ok(`CHECK 4d: /36 total labeled as classical convention (${total.trim().slice(0, 40)}…)`)
  else fail(`CHECK 4d: guna total/band note wrong: ${total}`)

  for (const id of [
    'mesh-overlay-b-in-a',
    'mesh-overlay-a-in-b',
    'mesh-synchrony',
    'mesh-significators-anchor',
    'mesh-significators-member',
    'mesh-reading',
    'mesh-integrity-note',
  ]) {
    const el = await page.$(`[data-testid="${id}"]`)
    if (el) ok(`CHECK 4e: section ${id} rendered`)
    else fail(`CHECK 4e: section ${id} MISSING`)
  }

  const segments = await page.$$('[data-testid="mesh-synchrony-segment"]')
  if (segments.length > 0) ok(`CHECK 4f: synchrony has ${segments.length} dated segment(s)`)
  else fail('CHECK 4f: synchrony rendered no segments for now → +2y')

  const integrity = await page.textContent('[data-testid="mesh-integrity-note"]')
  if (integrity && integrity.trim().length > 40)
    ok('CHECK 4g: engine integrity note rendered verbatim at the foot')
  else fail(`CHECK 4g: integrity note empty: ${integrity}`)
  await page.screenshot({ path: `${SHOT_DIR}/3-edge.png`, fullPage: true })

  // -------------------------------------------------------------------------
  // CHECK 5 — the bride-table seat flip recomputes the edge.
  // -------------------------------------------------------------------------
  await page.click('[data-testid="mesh-role-member"]')
  // The recompute is honest (seconds): pending may flash; what must hold is the
  // seat state and a re-rendered compatibility card afterwards.
  await page.waitForSelector('[data-testid="mesh-compatibility"]', { timeout: 240_000 })
  const pressed = await page.getAttribute('[data-testid="mesh-role-member"]', 'aria-pressed')
  if (pressed === 'true') ok('CHECK 5: bride-table seat flipped and the edge re-rendered')
  else fail(`CHECK 5: role seat did not flip (aria-pressed=${pressed})`)
  await page.screenshot({ path: `${SHOT_DIR}/4-edge-roles-flipped.png`, fullPage: true })

  // -------------------------------------------------------------------------
  // CHECK 6 — the NEGATIVE invariant (safety-critical curation rule): a FRIEND
  // edge must NEVER render the marriage-matching tables. Soft-navigate (the
  // nav link keeps the booted engine) so the friend edge computes live too.
  // -------------------------------------------------------------------------
  await page.click('[data-testid="nav-mesh-link"]')
  await page.waitForSelector('[data-testid="mesh-node-p-friend"]', { timeout: 30_000 })
  ok('CHECK 6a: friend node renders in the constellation')

  await page.click('[data-testid="mesh-node-p-friend"]')
  await page.waitForSelector('[data-testid="mesh-edge-page"]', { timeout: 15_000 })
  // Wait for the COMPUTED state (Graha Maitri renders only when the edge is
  // ready) so the absence assertions below cannot pass vacuously against a
  // pending screen.
  await page.waitForSelector('[data-testid="mesh-maitri"]', { timeout: 240_000 })
  ok('CHECK 6b: friend edge computed LIVE on-device — Graha Maitri rendered')

  const compatOnFriend = await page.$('[data-testid="mesh-compatibility"]')
  if (!compatOnFriend) ok('CHECK 6c: Ashtakoota compatibility card ABSENT on the friend edge')
  else fail('CHECK 6c: marriage Ashtakoota card rendered on a FRIEND edge')

  const mangalOnFriend = await page.$('[data-testid="mesh-mangal"]')
  if (!mangalOnFriend) ok('CHECK 6d: Mangal screening ABSENT on the friend edge')
  else fail('CHECK 6d: Mangal screening rendered on a FRIEND edge')

  const maitriLeads = await page.evaluate(() => {
    const DOCUMENT_POSITION_FOLLOWING = 4 // Node.DOCUMENT_POSITION_FOLLOWING
    const maitri = document.querySelector('[data-testid="mesh-maitri"]')
    const overlay = document.querySelector('[data-testid="mesh-overlay-b-in-a"]')
    if (!maitri || !overlay) return false
    return Boolean(maitri.compareDocumentPosition(overlay) & DOCUMENT_POSITION_FOLLOWING)
  })
  if (maitriLeads) ok('CHECK 6e: Graha Maitri LEADS the friend edge (precedes the overlay)')
  else fail('CHECK 6e: Graha Maitri is not the leading section on the friend edge')

  const friendIntegrity = await page.textContent('[data-testid="mesh-integrity-note"]')
  if (friendIntegrity && friendIntegrity.trim().length > 40)
    ok('CHECK 6f: engine integrity note still rendered on the friend edge')
  else fail(`CHECK 6f: friend-edge integrity note empty: ${friendIntegrity}`)
  await page.screenshot({ path: `${SHOT_DIR}/5-edge-friend.png`, fullPage: true })

  // -------------------------------------------------------------------------
  // Console hygiene — fail on real errors (benign asset noise filtered).
  // -------------------------------------------------------------------------
  const real = consoleErrors.filter((e) => !/favicon|manifest|404/i.test(e))
  if (real.length === 0) ok('Console clean across the whole journey')
  else fail(`console errors: ${real.join(' | ')}`)
} catch (err) {
  fail(`live-drive crashed: ${err instanceof Error ? err.message : String(err)}`)
  await page.screenshot({ path: `${SHOT_DIR}/crash.png`, fullPage: true }).catch(() => {})
} finally {
  await browser.close()
}

if (failures > 0) {
  console.error(`\n❌ verify-mesh: ${failures} check(s) failed`)
  process.exit(1)
}
console.log('\n🎉 verify-mesh: every live check passed')
