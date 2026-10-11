import { mkdirSync } from 'node:fs';
import { expect, type Route } from '@playwright/test';
import { test } from './webkitProfile';
import { collectConsoleErrors, expectChartRenders } from './live/liveJourney';
import { LLM_SETTINGS_KEY } from './interpretation.helpers';

/**
 * PR 2 ships library code only. This drives the real journey (no hooks) and
 * proves the dashboard reading and timeline still render from the v1
 * sections, and that no report-v2 section is requested yet.
 *
 * Run:  bun run test:e2e:report:regression   (from apps/web)
 */

const LEGACY = ['core', 'yoga', 'guidance1', 'guidance2', 'remedial', 'upcoming_periods', 'current_sky'] as const;
const REPORT_V2 = ['current_period', 'year_ahead', 'life_outlook_1', 'life_outlook_2'] as const;
type LegacySection = (typeof LEGACY)[number];
/**
 * The v1 dashboard also asks for evidence annotations once the reading is
 * saved (hooks/evidenceAnnotations.ts). That request carries no SECTION marker;
 * the stub names it by its output schema so it is counted, not hidden.
 */
const EVIDENCE = 'evidence_annotation';
const EVIDENCE_STUB = { readings: [], general_guidance: ['Stub general guidance.'] };

const p = (text: string) => ({ layman: text, technical: text });
const STUB: Record<LegacySection, unknown> = {
  core: { summary: p('STUB SUMMARY about this chart.'), strengths: [{ title: 'Grit', ...p('You persevere.') }], challenges: [], life_themes: [] },
  yoga: { integrated_yoga_narrative: p('Your life arc bends toward leadership.') },
  guidance1: { career_guidance: p('Lead teams.'), health_guidance: p('Rest more.') },
  guidance2: { finances_guidance: p('Save steadily.') },
  remedial: { remedial_measures: p('Walk and journal.') },
  upcoming_periods: { upcoming_periods: [{ title: 'Next chapter', ...p('Plan deliberately.') }] },
  current_sky: { current_sky: [{ title: 'Current sky', ...p('Pause before acting.') }] },
};

/** OpenRouter account reads the dashboard may make with the stub key; answered so no 401 reaches the console. */
const ACCOUNT_STUB: Record<string, unknown> = {
  '/api/v1/credits': { data: { total_credits: 10, total_usage: 1 } },
  '/api/v1/models': { data: [{ id: 'stub/model', name: 'Stub model' }] },
};

function isLegacy(section: string): section is LegacySection {
  return (LEGACY as readonly string[]).includes(section);
}

function sectionOf(body: string): string {
  const marked = /SECTION:([a-z0-9_]+)/.exec(body)?.[1];
  if (marked) return marked;
  return body.includes('observation_id') ? EVIDENCE : '(unmarked)';
}

function stubFor(section: string): unknown {
  if (section === EVIDENCE) return EVIDENCE_STUB;
  return isLegacy(section) ? STUB[section] : undefined;
}

test('dashboard reading still renders from the v1 sections (no hooks build)', async ({ page }, testInfo) => {
  const shots = `test-results/pr2-evidence/${testInfo.project.name}`;
  mkdirSync(shots, { recursive: true });
  const errors = collectConsoleErrors(page);
  const requested: string[] = [];
  const accountCalls: string[] = [];

  await page.addInitScript(([key, cfg]) => window.localStorage.setItem(key as string, cfg as string), [
    LLM_SETTINGS_KEY,
    JSON.stringify({ apiBase: 'https://openrouter.ai/api/v1', apiKey: 'sk-or-test', model: 'stub/model', privacyMode: 'cloud_premium', engine: 'openai-http' }),
  ] as const);
  // Every other provider request is answered here so nothing leaves the
  // machine; unknown paths fail loudly. Registered first, so the more specific
  // chat/completions route below takes precedence.
  await page.route('https://openrouter.ai/**', async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    accountCalls.push(path);
    const body = ACCOUNT_STUB[path];
    if (!body) return route.fulfill({ status: 404, body: `unexpected provider path ${path}` });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  // The v1 path asks for stream:true; json-stream.ts accepts a single JSON body
  // from servers that ignore streaming, which is what this stub answers.
  await page.route('**/chat/completions', async (route: Route) => {
    const section = sectionOf(route.request().postData() ?? '');
    requested.push(section);
    const payload = stubFor(section);
    if (payload === undefined) return route.fulfill({ status: 400, body: `unexpected section ${section}` });
    const content = JSON.stringify(payload);
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content } }] }) });
  });

  await page.goto('/onboarding');
  await expectChartRenders(page);
  await page.screenshot({ path: `${shots}/1-dashboard-chart.png`, fullPage: true });

  await page.getByTestId('generate-reading').click();
  await expect(page.getByText('STUB SUMMARY about this chart.').and(page.locator('p'))).toBeVisible();
  await page.screenshot({ path: `${shots}/2-dashboard-reading.png`, fullPage: true });

  const timeline = page.getByTestId('generate-timeline').or(page.getByTestId('regenerate-timeline'));
  await expect(timeline).toBeEnabled({ timeout: 300_000 });
  await timeline.click();
  await expect(page.getByTestId('current-timeline-section')).toBeVisible();
  await page.screenshot({ path: `${shots}/3-dashboard-timeline.png`, fullPage: true });

  testInfo.annotations.push(
    { type: 'sections-requested', description: JSON.stringify(requested) },
    { type: 'account-calls', description: JSON.stringify(accountCalls) },
    { type: 'console-errors', description: JSON.stringify(errors) },
  );
  console.log(`[${testInfo.project.name}] sections=${JSON.stringify(requested)} account=${JSON.stringify(accountCalls)} errors=${JSON.stringify(errors)}`);

  expect(requested.filter((section) => (REPORT_V2 as readonly string[]).includes(section))).toEqual([]);
  expect(new Set(requested)).toEqual(new Set([...LEGACY, EVIDENCE]));
  expect(errors).toEqual([]);
});
