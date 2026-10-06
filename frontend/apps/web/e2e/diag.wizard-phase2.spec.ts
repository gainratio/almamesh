import { test, expect } from '@playwright/test';
import { bootEngine, seedChart, waitForEngineReady, type SeedBirthSpec } from './interpretation.helpers';

// DIAGNOSTIC ONLY (never merged): why does /rectify/:id sometimes not show the
// intro step in CI? Samples the page every 500 ms after the SPA navigation.
const SEED: SeedBirthSpec = {
  name: 'Test Native Window',
  datetimeUtc: '1990-03-21T06:30:00.000Z',
  latitude: 19.076,
  longitude: 72.8777,
  referenceDate: '2025-01-01T00:00:00+00:00',
  chartId: 'wizard-phase2-mumbai-unknown-1990',
  birthDatetimeLocal: '1990-03-21T12:00:00',
  timezone: 'Asia/Kolkata',
  city: 'Mumbai',
  state: 'Maharashtra',
  country: 'India',
  locationName: 'Mumbai, Maharashtra, India',
  timeConfidence: 'unknown',
};
const PROFILE = `${SEED.chartId}-profile`;

for (let i = 0; i < 6; i += 1) {
  test(`diag intro ${i}`, async ({ page }) => {
    const t0 = Date.now();
    const log: string[] = [];
    const at = (s: string) => log.push(`+${Date.now() - t0}ms ${s}`);
    page.on('console', (m) => at(`[${m.type()}] ${m.text().slice(0, 300)}`));
    page.on('pageerror', (e) => at(`[pageerror] ${String(e).slice(0, 300)}`));
    page.on('framenavigated', (f) => { if (f === page.mainFrame()) at(`[nav] ${f.url()}`); });
    page.on('load', () => at('[load]'));
    page.on('crash', () => at('[crash]'));

    await bootEngine(page);
    at('engine ready (onboarding)');
    await seedChart(page, { birth: SEED });
    at('seeded');
    await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    at('dashboard domcontentloaded');
    await waitForEngineReady(page);
    at('engine ready (dashboard)');
    await page.waitForTimeout(1500);
    await page.evaluate((to: string) => {
      (window as unknown as { __diagMarker?: number }).__diagMarker = 1;
      window.history.pushState({}, '', to);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }, `/rectify/${PROFILE}`);
    at('spaNav done');
    let seen = false;
    for (let k = 0; k < 30 && !seen; k += 1) {
      const snap = await page
        .evaluate(() => ({
          url: location.pathname,
          marker: (window as unknown as { __diagMarker?: number }).__diagMarker ?? null,
          intro: document.querySelector('[data-testid="intro-step"]') != null,
          ids: Array.from(document.querySelectorAll('[data-testid]'))
            .map((e) => e.getAttribute('data-testid'))
            .slice(0, 25)
            .join(','),
          text: (document.querySelector('main') ?? document.body).innerText.replace(/\s+/g, ' ').slice(0, 300),
        }))
        .catch((e: unknown) => ({ err: String(e).slice(0, 200) }));
      at(`snap ${k} ${JSON.stringify(snap)}`);
      if ('intro' in snap && snap.intro) seen = true;
      else await page.waitForTimeout(500);
    }
    console.log(`[DIAG ${i}] ${seen ? 'INTRO-OK' : 'INTRO-MISSING'}\n${log.join('\n')}`);
    expect.soft(seen, 'intro step rendered').toBe(true);
  });
}
