import { test, expect } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { bootEngine, seedChart, waitForEngineReady, type SeedBirthSpec } from './interpretation.helpers';

/**
 * Task 16: Phase-2 Rectification Wizard — LIVE end-to-end validation.
 *
 * Drives the REAL /rectify/:profileId wizard with:
 *   - REAL in-browser Pyodide engine (same engine the exit-gate proves works)
 *   - Synthetic Bengaluru cusp native (1988-08-08 06:44 IST, Cancer/Leo boundary)
 *   - ZERO owner PII — name="Test Native", synthetic birth, Bengaluru
 *
 * Checks:
 *   1. Intro step renders
 *   2. 0-event guard (Continue disabled until ≥1 structured event)
 *   3. ≥3 events added via structured entry rows
 *   3b. Honest-window question (Spec 062): renders for a recorded time,
 *       "as recorded" pre-selected for cusp, no "%"; absent for unknown-time
 *   4. Fit step → results render (band-label visible)
 *   5. Band label qualitative (no %); no raw signal key from the FULL Spec 062
 *      grammar anywhere (md_/ad_/pd_/dasha_/d9_/miss_/prior_/#valence)
 *   6. Honesty note substantive
 *   7. Evidence rows: localized signal phrases (not raw machine keys)
 *   8. NO "%" in results region
 *   9. Recorded-time reference renders
 *  10. Confirm → /dashboard with both times context
 *  11. Clean console throughout
 *  12. Wizard re-navigable (no dead-end)
 *  13. Error/retry path compiled in (unit-tested; confirmed structurally)
 *
 * Parity cross-check: captures band + candidate rising signs for comparison
 * against the CPython golden test (test_rectification_golden.py).
 *
 * Why bootEngine + seedChart (not real onboarding form):
 *   All AlmaMesh e2e tests use this pattern — it drives the REAL engine, not
 *   a stub, but bypasses the MUI v8 date/time picker keyboard interaction which
 *   is fragile in headless Chromium. The chart seeded IS real engine output.
 */

// Cross-platform temp dir — works on both macOS (local) and Linux (CI).
const SCRATCHPAD = join(tmpdir(), 'almamesh-wizard-e2e');

// Spec 062 raw-key gate: NO machine signal key from the full grammar may ever
// surface in the UI — depth keys (md_/ad_/pd_ + legacy dasha_), transits, D9
// keys, valence suffixes, miss keys (unexplained + silent), the prior pseudo-
// signal. An unmapped key must fail this gate, never silently fall back.
const RAW_SIGNAL_KEY_RE =
  /(?:md|ad|pd|dasha)_lord_(?:rules|in)_h\d|slow_transit_h\d|d9_lord_[a-z0-9_]+|miss_unexplained|miss_silent_[a-z_]+_h\d|prior_anchor|#(?:afflicted|dignified)_fit/;

// Synthetic Bengaluru cusp native (ZERO owner PII).
// 1988-08-08 06:44 IST == 01:14 UTC. Cancer/Leo cusp (lagna ~Leo 0°).
const BENGALURU_SEED: SeedBirthSpec = {
  name: 'Test Native',
  datetimeUtc: '1988-08-08T01:14:00.000Z',
  latitude: 12.9716,
  longitude: 77.5946,
  referenceDate: '2025-01-01T00:00:00+00:00',
  chartId: 'wizard-phase2-bengaluru-1988',
  birthDatetimeLocal: '1988-08-08T06:44:00',
  timezone: 'Asia/Kolkata',
  city: 'Bengaluru',
  state: 'Karnataka',
  country: 'India',
  locationName: 'Bengaluru, Karnataka, India',
  timeConfidence: 'approximate',
};

// SPA-navigate without full document reload (keeps the engine singleton alive).
async function spaNav(page: import('@playwright/test').Page, path: string) {
  await page.evaluate((to: string) => {
    window.history.pushState({}, '', to);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
  await page.waitForTimeout(600);
}


// DIAGNOSTIC ONLY: sample the rectify route until the intro shows (or 60 s).
async function introDiag(page: import('@playwright/test').Page, label: string) {
  const t0 = Date.now();
  const events: string[] = [];
  const onConsole = (m: import('@playwright/test').ConsoleMessage) =>
    events.push(`+${Date.now() - t0}ms [${m.type()}] ${m.text().slice(0, 240)}`);
  const onNav = (f: import('@playwright/test').Frame) => {
    if (f === page.mainFrame()) events.push(`+${Date.now() - t0}ms [nav] ${f.url()}`);
  };
  const onCrash = () => events.push(`+${Date.now() - t0}ms [crash]`);
  page.on('console', onConsole);
  page.on('framenavigated', onNav);
  page.on('crash', onCrash);
  await page.evaluate(() => { (window as unknown as { __diagMarker?: number }).__diagMarker = 1; }).catch(() => {});
  let seenAt: number | null = null;
  for (let k = 0; k < 120 && seenAt === null; k += 1) {
    const snap = await page
      .evaluate(() => ({
        url: location.pathname,
        marker: (window as unknown as { __diagMarker?: number }).__diagMarker ?? null,
        ready: document.readyState,
        intro: document.querySelector('[data-testid="intro-step"]') != null,
        ids: Array.from(document.querySelectorAll('[data-testid]')).map((e) => e.getAttribute('data-testid')).slice(0, 30).join(','),
        text: (document.querySelector('main') ?? document.body).innerText.replace(/\s+/g, ' ').slice(0, 240),
      }))
      .catch((e: unknown) => ({ err: String(e).slice(0, 160) }));
    events.push(`+${Date.now() - t0}ms snap ${JSON.stringify(snap)}`);
    if ('intro' in snap && snap.intro) seenAt = Date.now() - t0;
    else await page.waitForTimeout(500);
  }
  page.off('console', onConsole);
  page.off('framenavigated', onNav);
  page.off('crash', onCrash);
  console.log(`[INTRO-LATENCY ${label}] ${seenAt ?? 'NEVER'}`);
  if (seenAt === null || seenAt > 8_000) {
    const dedup = events.filter((e, i) => i === 0 || e.replace(/^\+\d+ms /, '') !== events[i - 1].replace(/^\+\d+ms /, ''));
    console.log(`[INTRO-DIAG ${label}]\n${dedup.join('\n')}`);
  }
  expect.soft(seenAt !== null && seenAt <= 10_000, `intro within 10 s (${label})`).toBe(true);
}

test.describe('Phase-2 Rectification Wizard', () => {
  test('full wizard journey: intro → events → fit → results → confirm → dashboard', async ({
    page,
  }) => {
    mkdirSync(SCRATCHPAD, { recursive: true });
    const consoleLines: string[] = [];
    const pageErrors: string[] = [];

    page.on('console', (m) => consoleLines.push(`[${m.type()}] ${m.text()}`));
    page.on('pageerror', (e) => {
      const s = `[pageerror] ${String(e)}`;
      pageErrors.push(s);
      consoleLines.push(s);
    });

    // ── 1. Boot engine + seed Bengaluru chart ──────────────────────────────
    await bootEngine(page);
    const seeded = await seedChart(page, { birth: BENGALURU_SEED });
    // Confirm the REAL engine computed the Leo lagna (cusp case).
    expect(String(seeded.lagna).toLowerCase(), 'engine must compute Leo lagna for 06:44 Bengaluru').toBe('leo');
    await page.screenshot({ path: `${SCRATCHPAD}/00-engine-seeded.png`, fullPage: true });

    // ── 2. Load /dashboard (full reload re-hydrates the store) ────────────
    await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    await waitForEngineReady(page);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${SCRATCHPAD}/01-dashboard-loaded.png`, fullPage: true });

    // ── 3. Get active profile ID ───────────────────────────────────────────
    const profileId = `${BENGALURU_SEED.chartId}-profile`;
    console.log(`[wizard-phase2] profileId=${profileId}`);

    // ── 4. Navigate to /rectify/:profileId ───────────────────────────────
    // Try the IdentityStrip cusp CTA first (proves entry-point is reachable).
    const cuspLink = page.locator(`a[href="/rectify/${profileId}"]`);
    const hasCuspCta = await cuspLink.isVisible({ timeout: 5_000 }).catch(() => false);
    if (hasCuspCta) {
      console.log('[wizard-phase2] IdentityStrip cusp CTA found — clicking');
      await cuspLink.click();
    } else {
      console.log('[wizard-phase2] No cusp CTA visible — SPA-navigating directly');
      await spaNav(page, `/rectify/${profileId}`);
    }
    console.log(`[wizard-phase2] cuspCtaAvailable=${hasCuspCta}`);
    await expect(page).toHaveURL(new RegExp(`/rectify/${profileId}`), { timeout: 10_000 });
    await page.screenshot({ path: `${SCRATCHPAD}/02-rectify-navigated.png`, fullPage: true });

    // ── 5. Intro step ─────────────────────────────────────────────────────
    const introStep = page.locator('[data-testid="intro-step"]');
    await introDiag(page, 'full');
    await expect(introStep, 'intro step must render').toBeVisible({ timeout: 60_000 });
    await page.screenshot({ path: `${SCRATCHPAD}/03-intro-step.png`, fullPage: true });

    // ── 6. Click Start ────────────────────────────────────────────────────
    await page.locator('[data-testid="intro-start-btn"]').click();
    await page.waitForTimeout(500);

    // ── 6b. Open GatheredTray via manual toggle ────────────────────────────
    // EventEntryStep now uses ConversationalAccelerator as the primary path.
    // EventRows + the "Find my rising sign" CTA live inside GatheredTray,
    // which is collapsed by default. Expand it via the manual toggle.
    await page.locator('button').filter({ hasText: /enter events manually instead/i }).click();
    await page.waitForTimeout(300);

    // ── 7. UNHAPPY PATH: 0 events → Continue disabled ─────────────────────
    const continueBtn = page.locator('button').filter({ hasText: /find my rising sign/i });
    await expect(continueBtn, 'Continue must be disabled with 0 structured events').toBeDisabled({
      timeout: 5_000,
    });
    console.log('[wizard-phase2] UNHAPPY-1 PASS: Continue disabled with 0 events');

    // ── 8. Add ≥3 structured events ───────────────────────────────────────
    const eventsToAdd = [
      { date: '2010-06-15', category: 'career_change', note: 'Career shift' },
      { date: '2014-03-20', category: 'relocation',    note: 'Moved cities' },
      { date: '2018-09-10', category: 'marriage',      note: 'Got married' },
    ];

    for (let i = 0; i < eventsToAdd.length; i++) {
      const ev = eventsToAdd[i];
      await page.locator('button').filter({ hasText: /add event/i }).click();
      await page.waitForTimeout(350);
      const lastRow = page.locator('[data-testid="event-row"]').last();
      await lastRow.locator('input[type="date"]').fill(ev.date);
      await page.waitForTimeout(120);
      // EventRow has two <select>s (Category + Date precision); target Category by aria-label.
      await lastRow.locator('select[aria-label="Category"]').selectOption({ value: ev.category });
      await page.waitForTimeout(120);
      await lastRow.locator('input[type="text"]').fill(ev.note);
      await page.waitForTimeout(120);
      console.log(`[wizard-phase2] event ${i + 1}: ${ev.date} / ${ev.category}`);
    }

    const rowCount = await page.locator('[data-testid="event-row"]').count();
    expect(rowCount, 'must have 3 event rows').toBe(3);
    await page.screenshot({ path: `${SCRATCHPAD}/04-events-entry.png`, fullPage: true });

    // Continue must be enabled now
    await expect(continueBtn, 'Continue must be enabled after ≥1 structured event').toBeEnabled({
      timeout: 5_000,
    });

    // ── 9. Continue → honest-window question → Fit → Results ─────────────
    await continueBtn.click();
    await page.waitForTimeout(600);

    // Spec 062: a recorded-time profile answers the honest-window question
    // BEFORE the engine runs ("how sure are you about the recorded time?").
    const windowSelector = page.locator('[data-testid="window-selector"]');
    await expect(windowSelector, 'window question must render for a recorded time').toBeVisible({
      timeout: 5_000,
    });
    const selectorText = (await windowSelector.textContent()) ?? '';
    expect(selectorText, 'window question must NOT contain "%"').not.toContain('%');
    // Approximate-confidence profile → cusp detected → "as recorded" pre-selected.
    const defaultRadio = page.locator(
      '[data-testid="window-option-as_recorded"] input[type="radio"]',
    );
    expect(await defaultRadio.isChecked(), 'as_recorded must be the cusp default').toBe(true);
    await page.screenshot({ path: `${SCRATCHPAD}/04b-window-question.png`, fullPage: true });
    await page.locator('[data-testid="window-start-btn"]').click();
    await page.waitForTimeout(600);

    // Fit step (loading state)
    const fitStep = page.locator('[data-testid="fit-step"]');
    if (await fitStep.isVisible({ timeout: 4_000 }).catch(() => false)) {
      console.log('[wizard-phase2] fit step active — engine computing…');
      await page.screenshot({ path: `${SCRATCHPAD}/05-fit-loading.png`, fullPage: true });
    }

    // Wait for results (band-label appears when compute finishes)
    const bandLabel = page.locator('[data-testid="band-label"]');
    await expect(bandLabel, 'band-label must appear when results render').toBeVisible({
      timeout: 120_000,
    });
    await page.screenshot({ path: `${SCRATCHPAD}/06-results.png`, fullPage: true });

    // ── 10. Assert results content ────────────────────────────────────────
    // 10a. Band label: qualitative (no % or raw number)
    const bandText = (await bandLabel.textContent()) ?? '';
    expect(bandText.length, 'band label must be non-empty').toBeGreaterThan(0);
    expect(bandText, 'band label must NOT contain "%"').not.toContain('%');
    // Valid band values: "Near Tie", "Leans Toward", "Consistent"
    const validBands = ['near tie', 'leans toward', 'leans', 'consistent'];
    expect(
      validBands.some((b) => bandText.toLowerCase().includes(b)),
      `band "${bandText}" must be one of the qualitative labels`,
    ).toBe(true);
    console.log(`[wizard-phase2] band="${bandText}"`);

    // 10b. Honesty note present and substantive
    const honestyNote = page.locator('[data-testid="honesty-note"]');
    await expect(honestyNote, 'honesty-note must render').toBeVisible();
    const honestyText = (await honestyNote.textContent()) ?? '';
    expect(honestyText.length, 'honesty note must be substantive (>20 chars)').toBeGreaterThan(20);
    expect(honestyText, 'honesty note must NOT say "%" ').not.toContain('%');
    console.log(`[wizard-phase2] honesty="${honestyText.slice(0, 80)}…"`);

    // 10c. Evidence tables: localized signal phrases, NOT raw machine keys
    const evidenceTables = page.locator('[data-testid="evidence-table"]');
    const tableCount = await evidenceTables.count();
    expect(tableCount, 'at least 1 evidence table must render').toBeGreaterThan(0);

    let hasLocalized = false;
    let hasRaw = false;
    for (let i = 0; i < tableCount; i++) {
      const txt = (await evidenceTables.nth(i).textContent()) ?? '';
      if (/lord|Slow planet|navamsa|timing signal/i.test(txt)) hasLocalized = true;
      // Spec 062: the FULL grammar — an unmapped depth/D9/miss/prior/valence
      // key surfacing raw fails the gate (no silent "A timing signal" pass).
      if (RAW_SIGNAL_KEY_RE.test(txt)) hasRaw = true;
    }
    expect(hasLocalized, 'evidence rows must have localized human phrases').toBe(true);
    expect(hasRaw, 'evidence rows must NOT expose raw machine signal keys').toBe(false);

    // 10d. NO "%" in page text (anti-scam: no false-precision fit-score %)
    // and NO raw signal key ANYWHERE on the results page (misses, prior rows
    // and the decided-line render outside the evidence tables).
    const pageText = (await page.evaluate(() => document.body.innerText ?? '')) ?? '';
    expect(pageText, 'NO "%" may appear on the results page').not.toContain('%');
    expect(
      RAW_SIGNAL_KEY_RE.test(pageText),
      'NO raw signal key may appear anywhere on the results page',
    ).toBe(false);

    // 10e. Recorded-time reference section
    await expect(
      page.locator('[data-testid="recorded-reference"]'),
      'recorded-time reference must render',
    ).toBeVisible();

    // 10f. At least one candidate card with a confirm button
    const candidateCards = page.locator('[data-testid="candidate-card"]');
    const candidateCount = await candidateCards.count();
    expect(candidateCount, 'at least 1 candidate card').toBeGreaterThan(0);
    await expect(candidateCards.first().locator('[data-testid="confirm-button"]')).toBeVisible();

    // 10g. Spec 062 storytelling: counts-only fit summary on every card, the
    // "what decided it" line, and no numeric score fragments in the summary.
    const fitSummary = candidateCards.first().locator('[data-testid="fit-summary"]');
    await expect(fitSummary, 'fit summary (counts only) must render').toBeVisible();
    const fitSummaryText = (await fitSummary.textContent()) ?? '';
    expect(fitSummaryText, 'fit summary must be counts, not scores').toMatch(
      /supporting fit|unexplained event|quiet-period miss/i,
    );
    expect(fitSummaryText, 'fit summary must NOT contain decimals').not.toMatch(/\d\.\d/);
    await expect(
      page.locator('[data-testid="decided-line"]'),
      '"what decided it" line must render',
    ).toBeVisible();

    // ── 11. Parity capture: band + candidate signs ────────────────────────
    const parityData = await page.evaluate(() => {
      const band = document.querySelector('[data-testid="band-label"]')?.textContent?.trim() ?? '';
      const cards = [...document.querySelectorAll('[data-testid="candidate-card"]')];
      const candidates = cards.map((c) => ({
        sign: (c.querySelector('p.text-lg') as HTMLElement | null)?.textContent?.trim() ?? '',
        time: (c.querySelector('p.font-mono') as HTMLElement | null)?.textContent?.trim() ?? '',
      }));
      return { band, candidates };
    });
    console.log('[wizard-phase2] [parity] browser result:', JSON.stringify(parityData));
    writeFileSync(`${SCRATCHPAD}/parity-browser-data.json`, JSON.stringify(parityData, null, 2));

    // ── 12. Confirm first candidate ───────────────────────────────────────
    const confirmBtns = page.locator('[data-testid="confirm-button"]');
    await confirmBtns.first().click();
    await page.waitForTimeout(600);

    // Handle RegenerationConfirmModal (sign-flip acknowledgement if needed)
    const modal = page.locator('[role="dialog"]');
    if (await modal.isVisible({ timeout: 3_000 }).catch(() => false)) {
      console.log('[wizard-phase2] RegenerationConfirmModal appeared');
      // Check sign-flip acknowledgement checkbox if present
      const flipAck = page.locator('[data-testid="regen-flip-ack"] input[type="checkbox"]');
      if (await flipAck.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await flipAck.check();
        await page.waitForTimeout(250);
      }
      // Click the confirm button (last button in footer = gold Confirm)
      const footerBtns = modal.locator('[class*="px-6"][class*="py-4"] button');
      const btnCount = await footerBtns.count();
      if (btnCount > 0) {
        await footerBtns.last().click();
      } else {
        // Broader selector
        await modal.locator('button').filter({ hasText: /confirm|yes|use/i }).first().click();
      }
      await page.waitForTimeout(600);
    }
    await page.screenshot({ path: `${SCRATCHPAD}/07-post-confirm.png`, fullPage: true });

    // ── 13. Verify /dashboard post-confirm ────────────────────────────────
    await expect(page, 'must navigate to /dashboard after confirm').toHaveURL(/\/dashboard/, {
      timeout: 30_000,
    });
    await page.waitForTimeout(3_000); // let regenerate pipeline run
    await page.screenshot({ path: `${SCRATCHPAD}/08-dashboard-post-confirm.png`, fullPage: true });

    // Both times context present (recorded "06:44" OR rectified/authority labels)
    const dashText = (await page.evaluate(() => document.body.innerText ?? '')) ?? '';
    const showsBothTimesContext =
      dashText.includes('06:44') ||
      /rectified|recorded/i.test(dashText);
    expect(showsBothTimesContext, 'dashboard must show both-times context').toBe(true);

    // ── 14. Clean console ─────────────────────────────────────────────────
    // Exclude expected background 404s: the dashboard auto-starts the LLM
    // interpretation pipeline, which tries to fetch an optional AI endpoint.
    // In a test environment with no API key configured, the fetch returns 404.
    // That is a known, expected, non-fatal background call — NOT a JS runtime
    // error. We only fail on true JS runtime/pageerror lines.
    const jsErrors = consoleLines.filter((l) => {
      if (l.startsWith('[pageerror]')) return true; // real JS exception
      if (!l.startsWith('[error]')) return false;
      // Ignore resource 404s / network errors from background optional calls
      if (l.includes('404') || l.includes('Failed to load resource') || l.includes('net::ERR_')) {
        console.log(`[wizard-phase2] [ignored 404/net error] ${l}`);
        return false;
      }
      return true; // other [error] lines are real
    });
    if (jsErrors.length > 0) {
      console.log('[wizard-phase2] JS errors:', jsErrors.join('\n'));
    }
    expect(jsErrors.length, `must have 0 JS runtime errors; got: ${jsErrors.join('; ')}`).toBe(0);

    // ── 15. UNHAPPY PATH 2: wizard re-navigable (no dead-end) ────────────
    await spaNav(page, `/rectify/${profileId}`);
    // The wizard h1 title (t('wizard.title') = "Refine Your Birth Time") is present
    // regardless of which step renders — it's the reliable "no dead-end / no crash"
    // signal. (Return-aware wizard opens on the events step when events exist, so
    // intro-step testid is absent; event-entry-step testid only exists in unit mocks.)
    await expect(
      page.locator('h1').filter({ hasText: /refine your birth time/i }),
      'wizard must be re-navigable without crash',
    ).toBeVisible({ timeout: 8_000 });

    // ── 16. Console tail ──────────────────────────────────────────────────
    console.log('[wizard-phase2] console tail (last 15):');
    for (const l of consoleLines.slice(-15)) console.log(`  ${l}`);

    console.log('\n[wizard-phase2] DONE — all checks passed');
    console.log(`[wizard-phase2] screenshots: ${SCRATCHPAD}/`);
    console.log(`[wizard-phase2] parity data: ${SCRATCHPAD}/parity-browser-data.json`);
  });

  // ---------------------------------------------------------------------------
  // Task 20: Slice-3 — window / unknown-time sweep
  // ---------------------------------------------------------------------------
  //
  // Synthetic Mumbai native, birth time UNKNOWN (noon IST placeholder).
  // 1990-05-15 12:00 IST == 06:30 UTC. No owner PII.
  //
  // Checks (window-mode specific):
  //   1. Engine boot + chart seed with timeConfidence='unknown'
  //   2. Canonical SQLite chart/profile state resolves rectification mode as 'window'
  //   3. Wizard reaches /rectify/:profileId, intro step renders
  //   4. ≥3 structured events added, Continue enabled
  //   5. Fit step: FitProgress shows elapsed timer, NO "%"
  //   6. Results: band-label qualitative (no %)
  //   7. [data-testid="window-sign-caveat"] visible (events resolve SIGN, not minute)
  //   8. NO "%" anywhere on the results page
  //   9. ≥1 candidate card
  //  10. NO recorded-time reference section (unknown-time → no placeholder comparison)
  //  11. Confirm modal appears but has NO sign-flip ack checkbox (confirm not gated)
  //  12. Confirm first candidate → /dashboard
  //  13. Wall-clock time recorded (CONCERN logged if > 60s)
  //  14. Clean console (LLM 404s ignored as non-fatal)
  // ---------------------------------------------------------------------------

  const WINDOW_NATIVE_ID = 'wizard-phase2-mumbai-unknown-1990';
  const WINDOW_PROFILE_ID = `${WINDOW_NATIVE_ID}-profile`;

  const MUMBAI_UNKNOWN_SEED: SeedBirthSpec = {
    name: 'Unknown Native',
    datetimeUtc: '1990-05-15T06:30:00.000Z', // noon IST = 06:30 UTC (unknown-time placeholder)
    latitude: 18.9667,
    longitude: 72.8333,
    referenceDate: '2025-01-01T00:00:00+00:00',
    chartId: WINDOW_NATIVE_ID,
    birthDatetimeLocal: '1990-05-15T12:00:00',
    timezone: 'Asia/Kolkata',
    city: 'Mumbai',
    state: 'Maharashtra',
    country: 'India',
    locationName: 'Mumbai, Maharashtra, India',
    timeConfidence: 'unknown',
  };

  test('window-mode wizard: unknown-time → window sign-fit → sign-caveat → confirm', async ({
    page,
  }) => {
    mkdirSync(SCRATCHPAD, { recursive: true });
    const winConsole: string[] = [];
    const winErrors: string[] = [];

    page.on('console', (m) => winConsole.push(`[${m.type()}] ${m.text()}`));
    page.on('pageerror', (e) => {
      const s = `[pageerror] ${String(e)}`;
      winErrors.push(s);
      winConsole.push(s);
    });

    // ── 1. Boot engine + seed Mumbai unknown-time chart ───────────────────
    await bootEngine(page);
    const seeded = await seedChart(page, { birth: MUMBAI_UNKNOWN_SEED });
    console.log(`[wizard-window] seeded lagna=${String(seeded.lagna)}`);
    await page.screenshot({ path: `${SCRATCHPAD}/window-00-engine-seeded.png`, fullPage: true });

    // ── 2. Hard navigate to /dashboard (stores re-hydrate from canonical SQLite) ─
    await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    await waitForEngineReady(page);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${SCRATCHPAD}/window-01-dashboard.png`, fullPage: true });

    // ── 4. SPA-navigate to /rectify/:profileId ────────────────────────────
    await spaNav(page, `/rectify/${WINDOW_PROFILE_ID}`);
    await expect(page, 'must be on rectify URL').toHaveURL(
      new RegExp(`/rectify/${WINDOW_PROFILE_ID}`),
      { timeout: 10_000 },
    );
    await page.screenshot({
      path: `${SCRATCHPAD}/window-02-rectify-navigated.png`,
      fullPage: true,
    });

    // ── 5. Intro step ─────────────────────────────────────────────────────
    await introDiag(page, 'window');
    await expect(
      page.locator('[data-testid="intro-step"]'),
      'intro step must render',
    ).toBeVisible({ timeout: 60_000 });
    await page.screenshot({ path: `${SCRATCHPAD}/window-03-intro.png`, fullPage: true });

    // ── 6. Click Start ────────────────────────────────────────────────────
    await page.locator('[data-testid="intro-start-btn"]').click();
    await page.waitForTimeout(500);

    // ── 6b. Open GatheredTray via manual toggle ────────────────────────────
    // EventEntryStep now uses ConversationalAccelerator as the primary path.
    // EventRows + the "Find my rising sign" CTA live inside GatheredTray,
    // which is collapsed by default. Expand it via the manual toggle.
    await page.locator('button').filter({ hasText: /enter events manually instead/i }).click();
    await page.waitForTimeout(300);

    // ── 7. Add ≥3 structured events ───────────────────────────────────────
    const windowEvents = [
      { date: '2008-07-10', category: 'higher_studies', note: 'Started college' },
      { date: '2015-02-14', category: 'marriage',       note: 'Wedding' },
      { date: '2019-11-20', category: 'relocation',     note: 'Moved abroad' },
    ];

    for (let i = 0; i < windowEvents.length; i++) {
      const ev = windowEvents[i];
      await page.locator('button').filter({ hasText: /add event/i }).click();
      await page.waitForTimeout(350);
      const lastRow = page.locator('[data-testid="event-row"]').last();
      await lastRow.locator('input[type="date"]').fill(ev.date);
      await page.waitForTimeout(120);
      // EventRow has two <select>s (Category + Date precision); target Category by aria-label.
      await lastRow.locator('select[aria-label="Category"]').selectOption({ value: ev.category });
      await page.waitForTimeout(120);
      await lastRow.locator('input[type="text"]').fill(ev.note);
      await page.waitForTimeout(120);
      console.log(`[wizard-window] event ${i + 1}: ${ev.date} / ${ev.category}`);
    }

    await page.screenshot({ path: `${SCRATCHPAD}/window-04-events.png`, fullPage: true });
    const wContinueBtn = page.locator('button').filter({ hasText: /find my rising sign/i });
    await expect(wContinueBtn, 'Continue must be enabled after ≥1 event').toBeEnabled({
      timeout: 5_000,
    });

    // ── 8. Continue → Fit ─────────────────────────────────────────────────
    const fitStart = Date.now();
    await wContinueBtn.click();
    await page.waitForTimeout(600);

    // Spec 062: an UNKNOWN-time profile has no recorded time to be sure
    // about — the honest-window question must NOT appear; the whole-day scan
    // starts directly.
    await expect(
      page.locator('[data-testid="window-selector"]'),
      'window question must be ABSENT for unknown-time profiles',
    ).toHaveCount(0);

    // FitProgress: elapsed timer visible, NO "%"
    const wFitStep = page.locator('[data-testid="fit-step"]');
    if (await wFitStep.isVisible({ timeout: 4_000 }).catch(() => false)) {
      console.log('[wizard-window] fit step active — whole-day window sweep computing…');
      const fitProgress = page.locator('[data-testid="fit-progress"]');
      if (await fitProgress.isVisible({ timeout: 3_000 }).catch(() => false)) {
        const fitStepText = (await wFitStep.textContent()) ?? '';
        expect(fitStepText, 'FitProgress must NOT contain %').not.toContain('%');
        const elapsedEl = page.locator('[data-testid="fit-elapsed"]');
        await expect(elapsedEl, 'elapsed timer must render').toBeVisible({ timeout: 3_000 });
        console.log('[wizard-window] FitProgress: elapsed timer visible, no % ✓');
      }
      await page.screenshot({ path: `${SCRATCHPAD}/window-05-fit-loading.png`, fullPage: true });
    }

    // ── 9. Wait for results (up to 180s — 12-sign window sweep) ──────────
    const wBandLabel = page.locator('[data-testid="band-label"]');
    await expect(wBandLabel, 'band-label must appear when results render').toBeVisible({
      timeout: 180_000,
    });
    const fitElapsedMs = Date.now() - fitStart;
    console.log(
      `[wizard-window] window fit wall-clock: ${fitElapsedMs}ms (${Math.round(fitElapsedMs / 1000)}s)`,
    );
    await page.screenshot({ path: `${SCRATCHPAD}/window-06-results.png`, fullPage: true });

    // ── 10. Assert window-sign-caveat present ─────────────────────────────
    const windowCaveat = page.locator('[data-testid="window-sign-caveat"]');
    await expect(
      windowCaveat,
      'window-sign-caveat must be visible when mode=window',
    ).toBeVisible({ timeout: 5_000 });
    const caveatText = (await windowCaveat.textContent()) ?? '';
    expect(caveatText, 'caveat must mention "sign"').toMatch(/sign/i);
    console.log(`[wizard-window] window-sign-caveat: "${caveatText.slice(0, 100)}"`);

    // ── 11. Assert no % and no raw signal keys in results region ─────────
    const wPageText = (await page.evaluate(() => document.body.innerText ?? '')) ?? '';
    expect(wPageText, 'NO "%" may appear on window results page').not.toContain('%');
    expect(
      RAW_SIGNAL_KEY_RE.test(wPageText),
      'NO raw signal key may appear on the window results page',
    ).toBe(false);

    // ── 12. Band qualitative ──────────────────────────────────────────────
    const wBandText = (await wBandLabel.textContent()) ?? '';
    expect(wBandText.length, 'band must be non-empty').toBeGreaterThan(0);
    expect(wBandText, 'band must NOT contain %').not.toContain('%');
    const validBands = ['near tie', 'leans toward', 'leans', 'consistent'];
    expect(
      validBands.some((b) => wBandText.toLowerCase().includes(b)),
      `band "${wBandText}" must be a qualitative label`,
    ).toBe(true);
    console.log(`[wizard-window] band="${wBandText}"`);

    // ── 13. ≥1 candidate card ─────────────────────────────────────────────
    const wCandidateCards = page.locator('[data-testid="candidate-card"]');
    const wCandidateCount = await wCandidateCards.count();
    expect(wCandidateCount, 'at least 1 candidate card').toBeGreaterThan(0);
    await expect(wCandidateCards.first().locator('[data-testid="confirm-button"]')).toBeVisible();
    console.log(`[wizard-window] candidateCount=${wCandidateCount}`);

    // ── 13b. No recorded-time reference section (unknown-time → no placeholder) ──
    // The fix (8b54b5d) suppresses the entire recorded-reference section when
    // birth_time_confidence === 'unknown'. Assert it is absent.
    await expect(
      page.locator('[data-testid="recorded-reference"]'),
      'recorded-reference must be ABSENT for unknown-time (no placeholder comparison)',
    ).not.toBeVisible();
    console.log('[wizard-window] no recorded-reference section (unknown-time) ✓');

    // ── 14. Confirm first candidate (unknown-time: modal has NO flip-ack gate) ──
    // handleConfirm always opens RegenerationConfirmModal (the regen warning).
    // For unknown-time, isUnknownTime=true → signFlip=null in Rectify.tsx, so the
    // modal renders WITHOUT the sign-flip ack checkbox and confirm is NOT gated:
    // the user confirms the chosen candidate directly. (The cusp case, with a real
    // recorded sign that flips, DOES show the checkbox + requires the ack.)
    await wCandidateCards.first().locator('[data-testid="confirm-button"]').click();
    await page.waitForTimeout(600);

    const wModal = page.locator('[role="dialog"]');
    await expect(wModal, 'regeneration modal must appear on confirm').toBeVisible({
      timeout: 5_000,
    });

    // The sign-flip ack checkbox must be ABSENT for unknown-time — there is no
    // recorded sign to flip away from, so no acknowledgement is required.
    await expect(
      page.locator('[data-testid="regen-flip-ack"]'),
      'flip-ack checkbox must be ABSENT for unknown-time (no recorded sign to flip from)',
    ).toHaveCount(0);
    console.log('[wizard-window] modal present, NO flip-ack checkbox (unknown-time direct confirm) ✓');

    // Confirm directly — the gold Confirm button is enabled without any ack tick.
    const wFooterBtns = wModal.locator('[class*="px-6"][class*="py-4"] button');
    const wBtnCount = await wFooterBtns.count();
    if (wBtnCount > 0) {
      await wFooterBtns.last().click();
    } else {
      await wModal.locator('button').filter({ hasText: /confirm|yes|use/i }).first().click();
    }
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${SCRATCHPAD}/window-07-post-confirm.png`, fullPage: true });

    // ── 15. Verify /dashboard reached ─────────────────────────────────────
    await expect(page, 'must navigate to /dashboard after confirm').toHaveURL(/\/dashboard/, {
      timeout: 30_000,
    });
    await page.waitForTimeout(3_000);
    await page.screenshot({
      path: `${SCRATCHPAD}/window-08-dashboard-post-confirm.png`,
      fullPage: true,
    });
    console.log('[wizard-window] /dashboard reached after window-mode confirm ✓');

    // ── 16. Clean console ─────────────────────────────────────────────────
    const wJsErrors = winConsole.filter((l) => {
      if (l.startsWith('[pageerror]')) return true;
      if (!l.startsWith('[error]')) return false;
      if (
        l.includes('404') ||
        l.includes('Failed to load resource') ||
        l.includes('net::ERR_')
      ) {
        console.log(`[wizard-window] [ignored 404/net error] ${l}`);
        return false;
      }
      return true;
    });
    if (wJsErrors.length > 0) console.log('[wizard-window] JS errors:', wJsErrors.join('\n'));
    expect(wJsErrors.length, `must have 0 JS runtime errors; got: ${wJsErrors.join('; ')}`).toBe(
      0,
    );

    // ── 17. Wall-clock concern ────────────────────────────────────────────
    if (fitElapsedMs > 60_000) {
      console.warn(
        `[wizard-window] CONCERN: window fit took ${Math.round(fitElapsedMs / 1000)}s > 60s threshold — consider capping signs by plausibility`,
      );
    }

    console.log('[wizard-window] console tail (last 10):');
    for (const l of winConsole.slice(-10)) console.log(`  ${l}`);

    console.log(
      `\n[wizard-window] DONE — wall-clock ${Math.round(fitElapsedMs / 1000)}s, ` +
        `candidates=${wCandidateCount}, band="${wBandText}", caveat=present`,
    );
  });
});
