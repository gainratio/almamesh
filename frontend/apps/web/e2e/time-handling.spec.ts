/**
 * Time handling, driven through the REAL onboarding UI and the real in-browser
 * engine (no seeding hooks are used even on the hooked build):
 *
 *   1. A spring-forward gap time (02:30, 2024-03-10, Los Angeles) is refused;
 *      switching to "I don't know" computes the chart at noon instead of the
 *      stale typed 02:30 (the regression that failed with CHART_GEN_001).
 *   2. A fall-back time that happened twice (01:30, 2024-11-03, Los Angeles)
 *      asks which occurrence and blocks Continue until one is picked.
 *   3. Apia (Samoa, civil day ~24 h ahead of solar time): a 10:00 birth on
 *      Wednesday 2024-01-10 gets the Wednesday lord (Mercury).
 *   4. Sydney 00:30 on 2024-01-10 is before sunrise, so the Vedic day is
 *      Tuesday the 9th (Mars), and the sunrise prints on Sydney's calendar.
 *   5. A stored chart with NO birthplace zone (a real onboarded chart whose
 *      stored zone is then removed) shows "birthplace timezone is missing" with a link
 *      to the Settings birthplace field — never "generate your chart first";
 *      re-selecting the birthplace there and saving writes the zone back and
 *      the timing layer computes.
 *
 * The birthplace geocoder is forced onto the bundled offline city list (the
 * online request answers with an unreadable body), so CI needs no egress and
 * the console stays clean. Every journey asserts a clean console.
 */
import { expect, test, type Page } from '@playwright/test';

function watchConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

async function offlineGeocoder(page: Page): Promise<void> {
  // A 200 with an unreadable body makes the online lookup throw, so search falls
  // back to the bundled list without a failed-request console error.
  await page.route('https://geocoding-api.open-meteo.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: 'offline' }),
  );
}

async function typeSections(page: Page, testId: string, digits: string, trailing = ''): Promise<void> {
  await page.locator(`[data-testid="${testId}"] [role="spinbutton"]`).first().click();
  await page.keyboard.type(digits, { delay: 40 });
  if (trailing) await page.keyboard.type(trailing, { delay: 40 });
}

interface Birth {
  readonly mmddyyyy: string;
  readonly city: string;
  readonly country: RegExp;
  readonly hhmm: string;
  readonly meridiem: 'a' | 'p';
}

/** Name -> date -> place -> time; leaves the page on the time step. */
async function toTimeStep(page: Page, birth: Birth): Promise<void> {
  await offlineGeocoder(page);
  await page.goto('/onboarding');
  await page.getByTestId('name-input').fill('Synthetic Native');
  await page.getByTestId('next-button').click();
  await typeSections(page, 'birth-date-input', birth.mmddyyyy);
  await page.getByTestId('next-button').click();
  await page.getByTestId('location-search-input').fill(birth.city);
  await page.locator('[role="option"]').filter({ hasText: birth.country }).first().click({ timeout: 30_000 });
  await page.getByTestId('next-button').click();
  await typeSections(page, 'birth-time-input', birth.hhmm, birth.meridiem);
}

async function generateExact(page: Page): Promise<void> {
  await page.getByTestId('confidence-option-exact').click();
  await page.getByTestId('next-button').click();
  await page.getByTestId('skip-life-events-button').click();
  await page.waitForURL('**/dashboard', { timeout: 300_000 });
}

async function strengthLines(page: Page): Promise<{ lord: string; sunrise: string }> {
  await page.goto('/predictive?tab=strength');
  const lord = page.getByTestId('strength-day-lord');
  await expect(lord).toBeVisible({ timeout: 300_000 });
  return {
    lord: (await lord.textContent()) ?? '',
    sunrise: (await page.getByTestId('strength-sunrise-basis').textContent()) ?? '',
  };
}

const LA = { city: 'Los Angeles', country: /United States/ } as const;

test('a spring-forward gap time is refused; "unknown" then computes at noon', async ({ page }) => {
  const errors = watchConsole(page);
  await toTimeStep(page, { ...LA, mmddyyyy: '03102024', hhmm: '0230', meridiem: 'a' });
  await page.getByTestId('confidence-option-exact').click();
  await expect(page.getByTestId('dst-gap-notice')).toContainText('did not exist');
  await expect(page.getByTestId('next-button')).toBeDisabled();

  await page.getByTestId('confidence-option-unknown').click();
  await expect(page.getByTestId('dst-gap-notice')).toHaveCount(0);
  await expect(page.getByTestId('next-button')).toBeEnabled();
  await page.getByTestId('next-button').click();
  await page.getByTestId('skip-life-events-button').click();
  // Unknown time routes to rectification once the noon chart is saved.
  await page.waitForURL('**/rectify/**', { timeout: 300_000 });
  expect(errors).toEqual([]);
});

test('a repeated fall-back hour asks which occurrence before continuing', async ({ page }) => {
  const errors = watchConsole(page);
  await toTimeStep(page, { ...LA, mmddyyyy: '11032024', hhmm: '0130', meridiem: 'a' });
  await page.getByTestId('confidence-option-exact').click();
  const choice = page.getByTestId('dst-fold-choice');
  await expect(choice).toContainText('happened twice');
  await expect(choice).toContainText('UTC−07:00');
  await expect(choice).toContainText('UTC−08:00');
  await expect(page.getByTestId('next-button')).toBeDisabled();
  await page.getByTestId('dst-fold-later').check();
  await expect(page.getByTestId('next-button')).toBeEnabled();
  expect(errors).toEqual([]);
});

test('Apia: the weekday lord follows the civil date, not solar time', async ({ page }) => {
  const errors = watchConsole(page);
  await toTimeStep(page, { city: 'Apia', country: /Samoa/, mmddyyyy: '01102024', hhmm: '1000', meridiem: 'a' });
  await generateExact(page);
  const { lord, sunrise } = await strengthLines(page);
  expect(lord).toContain('Mercury'); // Wednesday 2024-01-10
  expect(sunrise).toMatch(/Jan 10, 2024/);
  expect(sunrise).toContain('Pacific/Apia');
  expect(errors).toEqual([]);
});

test('Sydney just after midnight belongs to the previous Vedic day', async ({ page }) => {
  const errors = watchConsole(page);
  await toTimeStep(page, { city: 'Sydney', country: /Australia/, mmddyyyy: '01102024', hhmm: '1230', meridiem: 'a' });
  await generateExact(page);
  const { lord, sunrise } = await strengthLines(page);
  expect(lord).toContain('Mars'); // before sunrise: Tuesday 2024-01-09
  expect(sunrise).toMatch(/Jan 09, 2024/);
  expect(sunrise).toContain('Australia/Sydney');
  expect(errors).toEqual([]);
});

/**
 * Remove the birthplace zone from every stored chart, as a chart saved by an
 * older build (or edited by hand) can lack it. Reaches the live chart-library
 * store through the already-loaded app chunks, then lets it persist.
 */
async function stripStoredZone(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const urls = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .filter((url) => /\/assets\/.*\.js$/.test(url));
    for (const url of [...new Set(urls)]) {
      let mod: Record<string, unknown>;
      try {
        mod = (await import(/* @vite-ignore */ url)) as Record<string, unknown>;
      } catch {
        continue;
      }
      for (const value of Object.values(mod)) {
        const store = value as {
          getState?: () => Record<string, unknown>;
          setState?: (next: unknown) => void;
        } | null;
        if (!store || typeof store.getState !== 'function' || typeof store.setState !== 'function') continue;
        const state = store.getState();
        if (!state || !('charts' in state) || !('saveChart' in state)) continue;
        type Chart = { birth_data?: { birth_location_details?: Record<string, unknown> } };
        const charts = state.charts as Record<string, Chart>;
        const next: Record<string, Chart> = {};
        for (const [id, chart] of Object.entries(charts)) {
          const copy = structuredClone(chart);
          if (copy.birth_data?.birth_location_details) delete copy.birth_data.birth_location_details.timezone;
          next[id] = copy;
        }
        store.setState({ charts: next });
        return `stripped ${Object.keys(next).length}`;
      }
    }
    return 'store not found';
  });
}

test('a stored chart with no birthplace zone: card -> Settings -> re-select -> save -> timing works', async ({ page }) => {
  const errors = watchConsole(page);
  await toTimeStep(page, { city: 'Delhi', country: /India/, mmddyyyy: '01151990', hhmm: '0530', meridiem: 'p' });
  await generateExact(page);
  expect(await stripStoredZone(page)).toBe('stripped 1');
  await page.waitForTimeout(1_000); // let the chart library persist the edit
  await page.reload();
  await page.goto('/predictive?tab=strength');
  const card = page.getByTestId('birth-zone-missing').first();
  await expect(card).toContainText('timezone is missing', { timeout: 120_000 });
  await expect(page.getByTestId('predictive-no-chart')).toHaveCount(0);

  // The card's link lands on the Settings birthplace field, which says why.
  await card.getByRole('link').click();
  await page.waitForURL('**/settings/profile#birthplace');
  await expect(page.getByTestId('birth-zone-missing-settings')).toBeVisible({ timeout: 30_000 });

  // Re-select the birthplace and save: the zone change must persist + recompute.
  await page.getByTestId('location-search-input').fill('Delhi');
  await page.locator('[role="option"]').filter({ hasText: /India/ }).first().click({ timeout: 30_000 });
  await expect(page.getByTestId('birth-zone-missing-settings')).toHaveCount(0);
  await page.getByRole('button', { name: 'Save Changes' }).click();
  await page.getByRole('button', { name: 'Confirm & Regenerate' }).click();
  await expect(page.getByText('Chart Updated!')).toBeVisible({ timeout: 300_000 });

  // The timing layer now computes: 1990-01-15 17:30 IST was a Monday (Moon).
  const { lord, sunrise } = await strengthLines(page);
  expect(lord).toContain('Moon');
  expect(sunrise).toContain('Asia/Kolkata');
  expect(errors).toEqual([]);
});
