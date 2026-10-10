import { readFileSync } from 'node:fs';

import { expect, type BrowserContext, type Page, type Route } from '@playwright/test';

/**
 * Helpers for the portable-state invariants suite (portable-invariants.spec.ts).
 *
 * Everything here drives the shipped UI. The only fakes are the two third-party
 * network services the app talks to: the OpenAI-compatible LLM endpoint and the
 * Open-Meteo birthplace geocoder. Both are answered by `context.route`, so no
 * test ever leaves the machine and every answer is deterministic.
 */

export const PASSPHRASE = 'portable invariants passphrase';
export const AI_KEY = 'sk-or-portable-invariants-0123456789';

// Sentinels: unique strings that can only be on screen if that row survived.
export const READING_SENTINEL = 'INVARIANT NATAL READING survives export and import.';
export const CHAT_QUESTION = 'Which invariant should survive the move between browsers?';
export const CHAT_ANSWER = 'INVARIANT CHAT ANSWER: every row survives the move.';
export const MESH_SENTINEL = 'INVARIANT MESH READING for the kept friend.';
export const EVENT_SUMMARY = 'Invariant move to Pune for work';

// ---------------------------------------------------------------------------
// Browser hygiene
// ---------------------------------------------------------------------------

export interface BrowserProblems {
  readonly consoleErrors: string[];
  readonly pageErrors: string[];
  readonly failedRequests: string[];
}

/**
 * Requests the browser itself cancels while the app is healthy: navigating
 * away mid-download aborts engine/model prefetches (Chromium: net::ERR_ABORTED,
 * WebKit: "cancelled" / "Load request cancelled"), and a full reload after
 * Import cancels whatever was in flight. Only same-origin static engine assets
 * and the routed fakes qualify; an app-shell or data failure still fails.
 */
const ABORT_TEXTS = [/ERR_ABORTED/, /cancell?ed/i, /Load request cancelled/i, /NS_BINDING_ABORTED/];
const ABORTABLE_PATHS = [/^\/pyodide\//, /^\/bundle\//, /^\/models\//, /^\/assets\//];

function isBenignAbort(url: URL, origin: string, errorText: string): boolean {
  if (!ABORT_TEXTS.some((pattern) => pattern.test(errorText))) return false;
  if (url.origin !== origin) return isFakedHost(url);
  return ABORTABLE_PATHS.some((pattern) => pattern.test(url.pathname));
}

function isFakedHost(url: URL): boolean {
  return url.hostname === 'openrouter.ai' || url.hostname === 'geocoding-api.open-meteo.com';
}

export function watchBrowser(context: BrowserContext, origin: string): BrowserProblems {
  const problems: BrowserProblems = { consoleErrors: [], pageErrors: [], failedRequests: [] };
  const watchPage = (page: Page) => {
    page.on('console', (message) => {
      if (message.type() === 'error') problems.consoleErrors.push(`${page.url()} :: ${message.text()}`);
    });
    page.on('pageerror', (error) => problems.pageErrors.push(error.message));
  };
  for (const page of context.pages()) watchPage(page);
  context.on('page', watchPage);
  context.on('requestfailed', (request) => {
    const errorText = request.failure()?.errorText ?? '';
    if (isBenignAbort(new URL(request.url()), origin, errorText)) return;
    problems.failedRequests.push(`${request.method()} ${request.url()} — ${errorText}`);
  });
  return problems;
}

export function expectCleanBrowser(problems: BrowserProblems, label: string): void {
  expect(problems.pageErrors, `${label}: uncaught page errors`).toEqual([]);
  expect(problems.consoleErrors, `${label}: console errors`).toEqual([]);
  expect(problems.failedRequests, `${label}: failed requests`).toEqual([]);
}

/**
 * Remove the File System Access pickers so Export uses the `<a download>`
 * path iOS Safari takes, and Import uses a plain `<input type=file>`.
 */
export async function forceDownloadAndFileInputPaths(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    Reflect.deleteProperty(window, 'showSaveFilePicker');
    Reflect.deleteProperty(window, 'showOpenFilePicker');
  });
}

// ---------------------------------------------------------------------------
// Network fakes (LLM + geocoder)
// ---------------------------------------------------------------------------

// `*` in allow-headers never covers Authorization, so name the headers the
// app sends (WebKit routes the CORS preflight through the handler).
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type, accept, http-referer, x-title',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'cross-origin-resource-policy': 'cross-origin',
};

const PLACES: Record<string, object> = {
  bengaluru: {
    name: 'Bengaluru', latitude: 12.9716, longitude: 77.5946, country: 'India',
    country_code: 'IN', admin1: 'Karnataka', timezone: 'Asia/Kolkata', population: 8443675,
    feature_code: 'PPLA',
  },
  mumbai: {
    name: 'Mumbai', latitude: 19.076, longitude: 72.8777, country: 'India',
    country_code: 'IN', admin1: 'Maharashtra', timezone: 'Asia/Kolkata', population: 12691836,
    feature_code: 'PPLA',
  },
};

async function fulfillJson(route: Route, body: unknown, contentType = 'application/json') {
  await route.fulfill({
    status: 200,
    headers: CORS_HEADERS,
    contentType,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function answerGeocoder(route: Route): Promise<void> {
  if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS_HEADERS });
  const query = (new URL(route.request().url()).searchParams.get('name') ?? '').toLowerCase();
  const key = Object.keys(PLACES).find((name) => name.startsWith(query.slice(0, 4)));
  await fulfillJson(route, { results: key ? [PLACES[key]] : [] });
}

const READING_SECTIONS: Record<string, unknown> = {
  core: {
    summary: READING_SENTINEL,
    strengths: [{ title: 'Steady', layman: 'You persist.', technical: 'Saturn support.' }],
    challenges: [{ title: 'Haste', layman: 'Slow down.', technical: 'Mars excess.' }],
    life_themes: [{ title: 'Service', layman: 'You help.', technical: '6th house.' }],
  },
  yoga: { integrated_yoga_narrative: { layman: 'Leadership arc.', technical: 'Raja yoga.' } },
  guidance1: {
    health_guidance: { layman: 'Rest.', technical: '6th lord.' },
    education_guidance: { layman: 'Learn.', technical: '5th lord.' },
    career_guidance: { layman: 'Lead.', technical: '10th lord.' },
    relationship_guidance: { layman: 'Talk.', technical: '7th lord.' },
  },
  guidance2: {
    finances_guidance: { layman: 'Save.', technical: '2nd lord.' },
    spiritual_guidance: { layman: 'Reflect.', technical: '12th house.' },
    life_evolution_guidance: { layman: 'Grow.', technical: 'Dasha.' },
  },
  remedial: { remedial_measures: { layman: 'Journal.', technical: 'Practice.' } },
  upcoming_periods: { upcoming_periods: [{ title: 'Next', layman: 'Plan.', technical: 'Dasha.' }] },
  current_sky: { current_sky: [{ title: 'Now', layman: 'Pause.', technical: 'Transit.' }] },
};

const MESH_SECTIONS = ['connection', 'timing_together', 'care'];

function sectionOf(body: string, keys: readonly string[]): string | undefined {
  return keys.find((key) => body.includes(`SECTION:${key}`));
}

function completion(content: string) {
  return { choices: [{ message: { role: 'assistant', content } }] };
}

function chatStream(text: string): string {
  const deltas = text.split(/(?<= )/);
  return (
    deltas.map((content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`).join('') +
    'data: [DONE]\n\n'
  );
}

/** One answer per request shape the app sends to an OpenAI-compatible endpoint. */
async function answerLlm(route: Route, calls: string[]): Promise<void> {
  const request = route.request();
  if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS_HEADERS });
  const url = request.url();
  if (url.includes('/credits')) return fulfillJson(route, { data: { total_credits: 10, total_usage: 1 } });
  if (url.includes('/models')) return fulfillJson(route, { data: [] });
  if (!url.includes('/chat/completions')) {
    calls.push(`unexpected ${url}`);
    return route.fulfill({ status: 418, headers: CORS_HEADERS, body: 'unexpected LLM call' });
  }
  const body = request.postData() ?? '';
  const reading = sectionOf(body, Object.keys(READING_SECTIONS));
  if (reading) {
    calls.push(`reading:${reading}`);
    return fulfillJson(route, completion(JSON.stringify(READING_SECTIONS[reading])));
  }
  const mesh = sectionOf(body, MESH_SECTIONS);
  if (mesh) {
    calls.push(`mesh:${mesh}`);
    const persona = { title: mesh, layman: MESH_SENTINEL, technical: MESH_SENTINEL };
    return fulfillJson(route, completion(JSON.stringify(persona)));
  }
  if (body.includes('general_guidance')) {
    calls.push('evidence');
    return fulfillJson(route, completion(JSON.stringify({ readings: [], general_guidance: [] })));
  }
  const parsed = JSON.parse(body || '{}') as { tools?: unknown[]; stream?: boolean };
  if (Array.isArray(parsed.tools)) {
    calls.push('chat');
    if (parsed.stream) return fulfillJson(route, chatStream(CHAT_ANSWER), 'text/event-stream');
    return fulfillJson(route, completion(CHAT_ANSWER));
  }
  // The Settings → AI test-on-save probe (JSON mode, no section marker).
  calls.push('probe');
  return fulfillJson(route, completion('{"ok":true}'));
}

/** Install both fakes on a context; returns the log of LLM request kinds. */
export async function fakeThirdParties(context: BrowserContext): Promise<string[]> {
  const calls: string[] = [];
  await context.route('https://geocoding-api.open-meteo.com/**', answerGeocoder);
  await context.route('https://openrouter.ai/**', (route) => answerLlm(route, calls));
  return calls;
}

// ---------------------------------------------------------------------------
// Real onboarding
// ---------------------------------------------------------------------------

export interface Native {
  readonly name: string;
  /** MMDDYYYY typed into the segmented (en-US) date field. */
  readonly date: string;
  /** hhmm typed into the segmented time field, plus the am/pm key. */
  readonly time: string;
  readonly meridiem: 'a' | 'p';
  readonly city: 'Bengaluru' | 'Mumbai';
  /** Optional life-events narrative (structured on-device when AI is off). */
  readonly narrative?: string;
}

async function typeSegments(page: Page, testId: string, keys: string): Promise<void> {
  await page.locator(`[data-testid="${testId}"] [role="spinbutton"]`).first().click();
  await page.keyboard.type(keys, { delay: 40 });
}

/** Name → date → city → time → confidence → events → Generate → dashboard. */
export async function onboard(page: Page, native: Native): Promise<void> {
  const name = page.getByTestId('name-input');
  await expect(name).toBeVisible({ timeout: 60_000 });
  if ((await name.inputValue()) !== native.name) await name.fill(native.name);
  await page.getByTestId('next-button').click();
  await typeSegments(page, 'birth-date-input', native.date);
  await page.getByTestId('next-button').click();
  await page.getByTestId('location-search-input').fill(native.city);
  await page.locator('[role="option"]').filter({ hasText: native.city }).first().click();
  await page.getByTestId('next-button').click();
  await typeSegments(page, 'birth-time-input', `${native.time}${native.meridiem}`);
  await page.getByTestId('confidence-option-exact').click();
  await page.getByTestId('next-button').click();
  if (native.narrative) {
    await page.getByTestId('life-events-input').fill(native.narrative);
    await page.getByTestId('extract-events-button').click();
    await expect(page.getByTestId('captured-life-events')).toBeVisible();
  } else {
    await page.getByTestId('skip-life-events-button').click();
  }
  await page.waitForURL('**/dashboard', { timeout: 240_000 });
  await expectDashboardChart(page, native.name);
}

export async function expectDashboardChart(page: Page, name: string): Promise<void> {
  await expect(page.getByTestId('identity-strip')).toContainText(name, { timeout: 120_000 });
  await expect(page.getByTestId('chart-visualization').first()).toBeVisible({ timeout: 120_000 });
}

/** SPA navigation: keeps the booted engine alive (a hard load re-boots it). */
export async function spaNavigate(page: Page, path: string): Promise<void> {
  await page.evaluate((to) => {
    window.history.pushState({}, '', to);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
  await page.waitForURL(`**${path}`);
}

export async function profileIdOf(page: Page, name: string): Promise<string> {
  const row = page.locator('[data-testid^="person-row-"]').filter({ hasText: name });
  await expect(row).toHaveCount(1);
  return ((await row.getAttribute('data-testid')) ?? '').replace('person-row-', '');
}

/** Switch the active person through the header's profile switcher. */
export async function switchActivePerson(page: Page, from: string, to: string): Promise<void> {
  await page.getByRole('button', { name: `Active profile: ${from}. Switch person` }).click();
  await page.getByRole('dialog').getByRole('button', { name: to, exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: `Active profile: ${to}. Switch person` })).toBeVisible();
}

/** Confirm the regeneration modal, acknowledging a sign flip when it asks. */
export async function confirmRegeneration(page: Page): Promise<void> {
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  const ack = dialog.getByTestId('regen-flip-ack').locator('input[type="checkbox"]');
  if (await ack.isVisible().catch(() => false)) await ack.check();
  await dialog.locator('button').last().click();
}

// ---------------------------------------------------------------------------
// Export / Import through Settings → Backup & Restore
// ---------------------------------------------------------------------------

export async function exportBackup(page: Page, outputPath: string): Promise<Buffer> {
  await spaNavigateOrGoto(page, '/settings/data');
  await page.getByTestId('backup-passphrase-input').fill(PASSPHRASE);
  await page.getByTestId('backup-passphrase-confirm-input').fill(PASSPHRASE);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('backup-export-button').click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^almamesh-backup-.*\.almamesh$/);
  await download.saveAs(outputPath);
  return readFileSync(outputPath);
}

async function spaNavigateOrGoto(page: Page, path: string): Promise<void> {
  if (page.url().startsWith('http')) {
    await spaNavigate(page, path);
  } else {
    await gotoSettled(page, path);
  }
}

/**
 * Hard navigation that tolerates the app's own boot redirects (a fresh
 * profile's first load may route through `/` or self-heal-reload once).
 */
export async function gotoSettled(page: Page, path: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    // Never cut the current document off mid-load: WebKit reports a load that a
    // navigation cancels (wasm, Worker, blob, bundle chunk) as an "access
    // control" console error, which would read as an app failure.
    if (page.url().startsWith('http')) await settleDocument(page);
    try {
      await page.goto(path, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('load');
      if (new URL(page.url()).pathname === path) return;
    } catch (error) {
      if (attempt >= 2 || !APP_NAVIGATION_INTERRUPT.test(String(error))) throw error;
    }
    if (attempt >= 2) return;
  }
}

/** The app's own navigation (a boot redirect or self-heal reload) cut a goto short: Chromium's and WebKit's wording. */
const APP_NAVIGATION_INTERRUPT = /interrupted by another navigation|Frame load interrupted/;

/**
 * Wait until the current document has finished what it started: the network
 * is idle and, if the engine began booting, it reached ready or reported an
 * error. networkidle alone is not enough on a slow runner: the engine can pause
 * between bundle chunks for longer than its 500 ms window, and a hard
 * navigation then cancels the rest. The stage hook needs VITE_EXIT_GATE_HOOKS=1;
 * on a page that never boots the engine it is absent and only idle is awaited.
 */
export async function settleDocument(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle');
  await page.waitForFunction(
    () => {
      const w = window as unknown as { __ALMAMESH_STAGE__?: string; __ALMAMESH_ERROR__?: string };
      return w.__ALMAMESH_STAGE__ === undefined || w.__ALMAMESH_STAGE__ === 'ready' || w.__ALMAMESH_ERROR__ !== undefined;
    },
    undefined,
    { timeout: 180_000, polling: 250 },
  );
  await page.waitForLoadState('networkidle');
}

/**
 * Import `backupPath` into a NEW, empty browser: pick the file, enter the
 * passphrase, confirm, and wait for the app's own reload. An empty browser has
 * nothing to protect, so no safety copy is asked for or downloaded.
 */
export async function importBackup(page: Page, backupPath: string): Promise<void> {
  await gotoSettled(page, '/settings/data');
  // Let the first boot finish opening SQLite (wasm + Worker) before Import
  // reloads the page; otherwise the app's own reload cancels that load.
  await page.waitForLoadState('networkidle');
  await expect(page.getByTestId('backup-import-button')).toBeEnabled();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByTestId('backup-import-button').click(),
  ]);
  await chooser.setFiles(backupPath);
  await page.getByTestId('backup-passphrase-prompt-input').fill(PASSPHRASE);
  await page.getByTestId('backup-passphrase-prompt-submit').click();
  const confirm = page.getByTestId('backup-confirm-import');
  await expect(confirm).toBeVisible();
  await expect(page.getByTestId('backup-safety-passphrase-input')).toHaveCount(0);
  await Promise.all([page.waitForEvent('domcontentloaded', { timeout: 120_000 }), confirm.click()]);
  await page.waitForLoadState('networkidle');
}
