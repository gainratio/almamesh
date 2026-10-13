import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { expect, type Browser, type Locator, type Page, type TestInfo } from '@playwright/test';

import { DELHI_BIRTH, DELHI_SEED, LLM_SETTINGS_KEY, bootEngine, seedChart } from './interpretation.helpers';
import { waitForLifeAtlasAsOf } from './lifeAtlas.helpers';
import { exportBackup, forceDownloadAndFileInputPaths, gotoSettled, importBackup } from './portableInvariants.helpers';
import { captureReloadConsole, type ReloadConsoleCapture } from './reloadConsole';
import { BIRTH_FIELD_NAMES, birthPlaceMarkers } from './tripPrivacy.helpers';
import { test } from './webkitProfile';

/**
 * Time-travel trips as threads (plan 2026-10-13, "Testing → E2E"). Every trip
 * opens its own thread, titled from its pin ("⏳ May 2019 · Singapore"), with a
 * context card and trip-bound tools: get_natal_summary, get_trip_context and
 * get_timing read the trip's period and place with no arguments. The first
 * decision request of a trip turn is sent with tool_choice "required", the
 * prompt carries no pre-computed facts, and every tool call is persisted on the
 * answer as a visible row. The provider is stubbed with page.route; the engine
 * is real.
 */
const LLM_CONFIG = {
  apiBase: 'https://openrouter.ai/api/v1',
  apiKey: 'test-key',
  model: 'deepseek/deepseek-v4-pro',
  privacyMode: 'cloud_premium',
  engine: 'openai-http',
};
const FULL_TIER = { deviceMemory: 8, hardwareConcurrency: 8 };
const SCREENS = '/private/tmp/claude-501/-Users-harish-dev-oss/38c35802-3a7a-4542-ba44-684db134e40e/scratchpad/tt-screens';

const TRIP_QUESTION = 'What was this period like for me?';
/** No place name in the answer: the search below must find the trip by its title alone. */
const TRIP_ANSWER = 'In May 2019 you were in a Rahu–Rahu period, a time of restless change.';
const SINGAPORE_TITLE = /^⏳ May 2019 · Singapore/;
const SAN_FRANCISCO_TITLE = /^⏳ Jan 2027 · San Francisco/;
/** DELHI_BIRTH in May 2019: Rahu maha (2017-05-13 → 2035-05-14), Rahu antar (2017-05-13 → 2020-01-24). */
const MAY_2019_DASHA = 'Rahu–Rahu';
const TRIP_TOOLS = ['get_natal_summary', 'get_trip_context', 'get_timing'] as const;
/** Retired from trips (plan 2026-10-13): the natal chart comes through get_natal_summary, the date through get_trip_context. */
const TODAY_ONLY_TOOLS = ['get_chart_facts', 'get_current_datetime'] as const;

interface WireMessage {
  role: string;
  name?: string;
  content?: string | null;
  tool_call_id?: string;
}

interface ProviderRequest {
  readonly messages: WireMessage[];
  readonly tools: string[];
  readonly toolChoice: string | undefined;
  readonly body: string;
}

/** The tool messages of the turn in flight: everything after the last user message. */
const turnTools = (messages: readonly WireMessage[]) => {
  const lastUser = messages.map((m) => m.role).lastIndexOf('user');
  return messages.slice(lastUser + 1).filter((m) => m.role === 'tool');
};
const call = (id: string, name: string, args: object) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const sse = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`;

/**
 * The stubbed provider. A trip turn stays tool_choice "required" until
 * get_natal_summary, get_trip_context and get_timing have each run (two calls
 * per round), so round 1 reads the natal summary and the trip, round 2 the
 * dashas, all with NO period or place arguments (the tools are bound to the
 * trip), and the forced final round (tool_choice "none", streamed) answers.
 * Everything else (summaries) gets a harmless empty answer.
 */
async function stubProvider(page: Page, seen: ProviderRequest[], bodies: string[]): Promise<void> {
  await page.route('**/chat/completions', async (route) => {
    const body = route.request().postData() ?? '{}';
    bodies.push(body);
    const parsed = JSON.parse(body) as { messages?: WireMessage[]; tools?: Array<{ function: { name: string } }>; tool_choice?: string };
    const messages = parsed.messages ?? [];
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    if (!Array.isArray(parsed.tools) || !lastUser.includes(TRIP_QUESTION)) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: '' } }] }) });
    }
    seen.push({ messages, tools: parsed.tools.map((tool) => tool.function.name), toolChoice: parsed.tool_choice, body });
    const ran = turnTools(messages).length;
    const message = ran === 0
      ? { content: null, tool_calls: [call('natal-1', 'get_natal_summary', {}), call('trip-1', 'get_trip_context', {})] }
      : ran === 1 || ran === 2
        ? { content: null, tool_calls: [call('dashas-1', 'get_timing', { section: 'dashas' })] }
        : { content: TRIP_ANSWER };
    if (parsed.tool_choice === 'none') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse(message.content ?? '') });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message }] }) });
  });
}

const consoleCaptures = new WeakMap<Page, ReloadConsoleCapture>();

/** Console capture, a full-tier device pin and the stubbed provider's settings. */
async function prepare(page: Page, testInfo: TestInfo): Promise<string[]> {
  const capture = captureReloadConsole(page, testInfo);
  consoleCaptures.set(page, capture);
  await page.addInitScript((tier) => {
    for (const [name, value] of Object.entries(tier)) {
      Object.defineProperty(Navigator.prototype, name, { get: () => value, configurable: true });
    }
  }, FULL_TIER);
  await page.addInitScript(
    ([key, cfg]) => window.localStorage.setItem(key as string, cfg as string),
    [LLM_SETTINGS_KEY, JSON.stringify(LLM_CONFIG)] as const,
  );
  return capture.errors;
}

function explicitReload<T>(page: Page, reload: () => Promise<T>): Promise<T> {
  const capture = consoleCaptures.get(page);
  if (!capture) throw new Error('Explicit reload requires console capture');
  return capture.duringReload(reload);
}

async function pinnedThreads(page: Page): Promise<Array<{ id: string; as_of: { start: string; place?: { label: string } } }>> {
  const rows = await page.evaluate(
    () => (window as unknown as { __almameshPinnedThreads?: () => unknown[] }).__almameshPinnedThreads?.(),
  );
  if (!rows) throw new Error('window.__almameshPinnedThreads is missing: build with VITE_EXIT_GATE_HOOKS=1');
  return rows as Array<{ id: string; as_of: { start: string; place?: { label: string } } }>;
}

/** Seed the Delhi chart, open the Dashboard and its chat drawer once today's Life Atlas has settled. */
async function openChat(page: Page): Promise<void> {
  await bootEngine(page);
  await seedChart(page);
  await gotoSettled(page, '/dashboard');
  // The chart re-anchors to today first; wait for it so no answer streams across it.
  await waitForLifeAtlasAsOf(page);
  await page.getByTestId('floating-chat-button').click({ timeout: 120_000 });
  await expect(page.getByTestId('floating-chat-drawer')).toBeVisible();
}

/** ⏳ → Month → `month`/`year` → search the place in "Where?" → Go; the sheet closes once the pin is saved. */
async function travel(page: Page, opener: 'time-travel-button' | 'time-travel-change', month: string, year: string, place: string): Promise<void> {
  await page.getByTestId(opener).click();
  await expect(page.getByTestId('time-travel-sheet')).toBeVisible();
  await page.getByTestId('time-travel-tab-month').click();
  await page.getByTestId('time-travel-month').selectOption(month);
  await page.getByTestId('time-travel-month-year').selectOption(year);
  // Every trip has a place, prefilled (nearest pin, else the birth place) before the user edits it.
  await expect(page.getByTestId('time-travel-where')).toBeVisible();
  await expect(page.getByTestId('time-travel-where-prefilled')).toBeVisible();
  await expect(page.getByTestId('time-travel-go')).toBeEnabled();
  await page.getByTestId('time-travel-where-input').fill(place);
  await expect(page.getByTestId('time-travel-go'), 'an edited, unpicked place cannot be saved').toBeDisabled();
  await page.getByTestId('time-travel-where-option-0').click({ timeout: 60_000 });
  await expect(page.getByTestId('time-travel-where-input')).toHaveValue(new RegExp(`^${place}`));
  await page.getByTestId('time-travel-go').click();
  await expect(page.getByTestId('time-travel-sheet')).toBeHidden();
  await expect(page.getByTestId('time-travel-banner')).toBeVisible();
}

/** Open the thread list, pick the thread whose title matches, and wait for it to be the active one. */
async function openThread(page: Page, title: RegExp): Promise<void> {
  await page.getByTestId('chat-threads-button').click();
  await expect(page.getByTestId('chat-thread-list')).toBeVisible();
  await page.getByTestId('chat-thread-item').filter({ hasText: title }).click();
  await expect(page.getByTestId('chat-thread-title')).toHaveText(title);
  await expect(page.getByTestId('chat-thread-list')).toHaveCount(0);
}

async function threadListTitles(page: Page): Promise<{ trips: string[]; ids: string[] }> {
  await page.getByTestId('chat-threads-button').click();
  const list = page.getByTestId('chat-thread-list');
  await expect(list).toBeVisible();
  await expect(list.getByTestId('chat-thread-group-today')).toBeVisible();
  await expect(list.getByTestId('chat-thread-group-trips')).toBeVisible();
  const items = list.getByTestId('chat-thread-item');
  const trips = (await items.allTextContents()).map((text) => text.trim()).filter((text) => text.startsWith('⏳'));
  const ids = await items.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-thread-id') ?? ''));
  await page.getByTestId('chat-threads-button').click();
  await expect(list).toHaveCount(0);
  return { trips, ids };
}

/** One row per persisted tool call, in call order; each expands to its args and result. */
async function expectToolRows(page: Page): Promise<void> {
  const rows = page.getByTestId('chat-tool-call');
  await expect(rows).toHaveCount(3);
  expect(await rows.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-tool-name')))).toEqual(['get_natal_summary', 'get_trip_context', 'get_timing']);
  const natal = page.locator('[data-testid="chat-tool-call"][data-tool-name="get_natal_summary"]');
  await expect(natal.locator('summary')).toContainText('Natal summary');
  await natal.locator('summary').click();
  await expect(natal.getByTestId('chat-tool-call-result')).toContainText('"lagna"');
  await natal.locator('summary').click();
  const trip = page.locator('[data-testid="chat-tool-call"][data-tool-name="get_trip_context"]');
  await expect(trip).toHaveAttribute('data-status', 'complete');
  await expect(trip.locator('summary')).toContainText('Trip period & place');
  await trip.locator('summary').click();
  await expect(trip.getByTestId('chat-tool-call-args')).toHaveText('{}');
  await expect(trip.getByTestId('chat-tool-call-result')).toContainText('"label": "Singapore');
  await expect(trip.getByTestId('chat-tool-call-result')).toContainText('"start": "2019-05-01"');
  const timing = page.locator('[data-testid="chat-tool-call"][data-tool-name="get_timing"]');
  await timing.locator('summary').click();
  await expect(timing.getByTestId('chat-tool-call-args')).toContainText('"section": "dashas"');
  await expect(timing.getByTestId('chat-tool-call-result')).toContainText('"start": "2019-05-01"');
  // Collapse both again, so the layout checks read the transcript as a person first sees it.
  await trip.locator('summary').click();
  await timing.locator('summary').click();
}

/** A coordinate rendered with two or more decimals, sign dropped, truncated or rounded. */
function coordinatePattern(value: number): RegExp {
  const magnitude = Math.abs(value);
  const truncated = /^\d+\.\d{2}/.exec(String(magnitude))?.[0] ?? magnitude.toFixed(2);
  const forms = [...new Set([truncated, magnitude.toFixed(2)])].map((form) => form.replace('.', '\\.'));
  return new RegExp(`(?<![\\d.])(?:${forms.join('|')})\\d*`);
}

const SINGAPORE = { lat: 1.28967, lon: 103.85007 };
/**
 * Never in any request body (contract 39d51337): a coordinate (the birth's, or a
 * picked place's), the birth date or time, or a birth_location_details field name.
 * A trip's place label and zone are allowed, the birth place's included.
 */
const PRIVACY_PATTERNS: readonly RegExp[] = [
  coordinatePattern(DELHI_BIRTH.latitude),
  coordinatePattern(DELHI_BIRTH.longitude),
  new RegExp(`(?<![\\d.])${SINGAPORE.lat.toFixed(3).replace('.', '\\.')}`),
  new RegExp(`(?<![\\d.])${SINGAPORE.lon.toFixed(3).replace('.', '\\.')}`),
  BIRTH_FIELD_NAMES,
  new RegExp(DELHI_BIRTH.datetimeUtc.slice(0, 10)),
  new RegExp(DELHI_SEED.birthDatetimeLocal.slice(11, 16)),
  /12:00:00/,
];
/** A Singapore trip has no reason to name the birth city or zone (the natal summary carries neither). */
const BIRTH_PLACE_NAMES: readonly RegExp[] = [
  new RegExp(DELHI_SEED.timezone.replace('/', '\\/')),
  new RegExp(`\\b(?:${DELHI_SEED.city}|${DELHI_SEED.locationName.split(', ')[1]})\\b`),
];

function matches(patterns: readonly RegExp[], body: string): string[] {
  return patterns.flatMap((pattern) => {
    const match = pattern.exec(body);
    return match ? [`${pattern} ~ ${body.slice(Math.max(0, match.index - 40), match.index + 40)}`] : [];
  });
}

const privacyLeaks = (body: string): string[] => [...matches(PRIVACY_PATTERNS, body), ...birthPlaceMarkers(body)];

interface Box { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

function intersects(a: Box, b: Box): boolean {
  return a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5;
}

/** The part of `box` the scrolling viewport actually shows (null when scrolled out of sight). */
function clipTo(box: Box, frame: Box): Box | null {
  const x = Math.max(box.x, frame.x);
  const y = Math.max(box.y, frame.y);
  const right = Math.min(box.x + box.width, frame.x + frame.width);
  const bottom = Math.min(box.y + box.height, frame.y + frame.height);
  return right - x > 0.5 && bottom - y > 0.5 ? { x, y, width: right - x, height: bottom - y } : null;
}

async function boxesOf(locator: Locator): Promise<Box[]> {
  const boxes: Box[] = [];
  for (const item of await locator.all()) {
    const box = await item.boundingBox();
    if (box) boxes.push(box);
  }
  return boxes;
}

/**
 * The drawer's one flex column: the banner sits above the scrolling thread and
 * the composer below it, and nothing inside the thread (the card, the chips,
 * the messages) overlaps anything else that is in sight. The empty composer
 * shows its placeholder unclipped.
 */
async function expectCleanLayout(page: Page, shot: string): Promise<void> {
  const viewport = await page.getByTestId('chat-viewport').boundingBox();
  const banner = await page.getByTestId('time-travel-banner').boundingBox();
  const composer = await page.getByTestId('chat-composer').boundingBox();
  if (!viewport || !banner || !composer) throw new Error('chat viewport, banner and composer must all render');
  expect(intersects(banner, viewport), `banner ${JSON.stringify(banner)} overlaps the thread ${JSON.stringify(viewport)}`).toBe(false);
  expect(intersects(composer, viewport), `composer ${JSON.stringify(composer)} overlaps the thread ${JSON.stringify(viewport)}`).toBe(false);
  expect(viewport.height, 'the thread has room to read').toBeGreaterThan(120);
  const inThread = [
    ...(await boxesOf(page.getByTestId('trip-context-card'))).map((box) => ['card', box] as const),
    ...(await boxesOf(page.getByTestId('chat-suggestion'))).map((box) => ['chip', box] as const),
    ...(await boxesOf(page.getByTestId('chat-tool-call'))).map((box) => ['tool row', box] as const),
    ...(await boxesOf(page.locator('[data-testid="chat-message-user"], [data-testid="chat-message-assistant"]'))).map((box) => ['message', box] as const),
  ].flatMap(([name, box]) => {
    const seen = clipTo(box, viewport);
    return seen ? [[name, seen] as const] : [];
  });
  const overlaps: string[] = [];
  for (let i = 0; i < inThread.length; i += 1) {
    for (let j = i + 1; j < inThread.length; j += 1) {
      const [a, boxA] = inThread[i]!;
      const [b, boxB] = inThread[j]!;
      if (intersects(boxA, boxB)) overlaps.push(`${a} ${JSON.stringify(boxA)} × ${b} ${JSON.stringify(boxB)}`);
    }
    const [name, box] = inThread[i]!;
    if (intersects(box, banner)) overlaps.push(`${name} × banner`);
    if (intersects(box, composer)) overlaps.push(`${name} × composer`);
  }
  expect(overlaps, 'nothing in the thread overlays anything else').toEqual([]);
  const input = page.getByTestId('chat-input');
  await expect(input).toHaveValue('');
  const fit = await input.evaluate((node) => ({ scroll: node.scrollHeight, client: node.clientHeight, rows: (node as HTMLTextAreaElement).rows }));
  expect(fit.scroll, `the placeholder is not clipped: ${JSON.stringify(fit)}`).toBeLessThanOrEqual(fit.client + 1);
  mkdirSync(dirname(shot), { recursive: true });
  await page.screenshot({ path: shot });
}

/** At each width the chromium variant checks; the iPhone checks its own 390 px screen. */
async function expectCleanLayoutAtWidths(page: Page, testInfo: TestInfo, state: string): Promise<void> {
  const project = testInfo.project.name;
  if (project !== 'chromium') {
    await expectCleanLayout(page, `${SCREENS}/e2e-${project}-${state}.png`);
    return;
  }
  const original = page.viewportSize();
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
    await expectCleanLayout(page, `${SCREENS}/e2e-${project}-${width}-${state}.png`);
  }
  if (original) await page.setViewportSize(original);
}

for (const tag of ['', '@iphone']) {
  test(`[contract/stubbed] ${tag} a trip to May 2019 in Singapore is its own thread, grounded by its tools, kept and found`, async ({ page }, testInfo) => {
    test.setTimeout(600_000);
    const consoleErrors = await prepare(page, testInfo);
    const seen: ProviderRequest[] = [];
    const bodies: string[] = [];
    await stubProvider(page, seen, bodies);
    await openChat(page);

    // a. Travel to May 2019, Singapore: a new thread, listed and titled from its pin.
    await travel(page, 'time-travel-button', '05', '2019', 'Singapore');
    await expect(page.getByTestId('chat-thread-title')).toHaveText(SINGAPORE_TITLE);
    await expect(page.getByTestId('time-travel-banner')).toContainText('Singapore');
    const listed = await threadListTitles(page);
    expect(listed.trips.filter((title) => SINGAPORE_TITLE.test(title)), JSON.stringify(listed.trips)).toHaveLength(1);
    const [trip2019] = await pinnedThreads(page);
    expect(trip2019?.as_of).toMatchObject({ start: '2019-05-01', end: '2019-05-31', granularity: 'month', place: { timezone: 'Asia/Singapore' } });
    const card = page.getByTestId('trip-context-card');
    await expect(card).toContainText('May 2019');
    await expect(card).toContainText('Singapore');
    await expect(card.getByTestId('trip-context-dasha')).toContainText(MAY_2019_DASHA);
    await expect(page.getByTestId('chat-suggestion').first()).toBeVisible();

    // e (part 1). The Tools list: what this thread registers.
    await page.getByTestId('chat-tools-button').click();
    const toolsList = page.getByTestId('chat-tools-list');
    await expect(toolsList).toBeVisible();
    const listedTools = await toolsList.locator('li[data-tool-name]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-tool-name') ?? ''));
    await page.getByTestId('chat-tools-button').click();
    await expect(toolsList).toHaveCount(0);

    // h (empty thread). Banner, context card and chips never overlap; the placeholder shows whole.
    await expectCleanLayoutAtWidths(page, testInfo, 'trip-empty');

    // b. Ask: the first decision must call a tool, and the prompt carries no pre-computed facts.
    await page.getByTestId('chat-input').fill(TRIP_QUESTION);
    await page.getByTestId('chat-send-button').click();
    const answer = page.getByTestId('chat-message-assistant').filter({ hasText: TRIP_ANSWER });
    await expect(answer).toBeVisible({ timeout: 240_000 });
    // Round 1 (natal + trip) and round 2 (timing) must call tools; the final round answers.
    expect(seen.map((request) => request.toolChoice), 'a trip grounds itself through all three tools before it answers').toEqual(['required', 'required', 'none']);
    const [first, , final] = seen as [ProviderRequest, ProviderRequest, ProviderRequest];
    for (const name of TRIP_TOOLS) expect(first.tools, `${name} is registered for the trip`).toContain(name);
    for (const name of TODAY_ONLY_TOOLS) expect(first.tools, `${name} is not registered for a trip`).not.toContain(name);
    const system = first.messages.find((m) => m.role === 'system')?.content ?? '';
    expect(system).toContain('PINNED PERIOD: this conversation is about 2019-05-01 to 2019-05-31 (relative: past).');
    expect(system).toMatch(/TIME-TRAVEL TRIP: this thread is a time-travel trip to May 2019 \(month, past\), when the user lived in Singapore[^(]*\(Asia\/Singapore\)\./);
    const prompt = first.messages.map((m) => m.content ?? '').join('\n');
    expect(prompt).not.toContain('VERIFIED LOCAL TIMING');
    expect(prompt).not.toContain('Chart facts (sanitized');
    for (const precomputed of ['"maha"', '"antar"', '"covered_events"', '"period":{', '"section":"dashas"', '"section":"transits"']) {
      expect(prompt, `no pre-computed timing JSON (${precomputed}) in the prompt`).not.toContain(precomputed);
    }
    // No-argument calls answer for the trip: Singapore, May 2019.
    const results = turnTools(final.messages);
    expect(results.map((m) => m.name)).toEqual(['get_natal_summary', 'get_trip_context', 'get_timing']);
    expect(results[0]?.content).toContain('"lagna"');
    expect(results[1]?.content).toContain('"place":{"label":"Singapore');
    expect(results[1]?.content).toContain('"timezone":"Asia/Singapore"');
    expect(results[1]?.content).toContain('"start":"2019-05-01"');
    expect(results[1]?.content).toContain('"tense":"past"');
    expect(results[2]?.content).toContain('"start":"2019-05-01"');
    expect(results[2]?.content).toContain('"antar"');

    // e (part 2). The visible Tools list is exactly what the model was offered.
    expect(listedTools).toEqual(first.tools);

    // c. Privacy, on every real request body (system brief, history, tool results).
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies.flatMap(privacyLeaks), 'no birth date, time, coordinate, field name or birth-place marker reaches the model').toEqual([]);
    expect(bodies.flatMap((body) => matches(BIRTH_PLACE_NAMES, body)), 'a Singapore trip never names the birth city or zone').toEqual([]);

    // d. One row per tool call, expandable, surviving a reload.
    await expectToolRows(page);
    await expectCleanLayoutAtWidths(page, testInfo, 'trip-answered');
    await explicitReload(page, () => page.reload({ waitUntil: 'domcontentloaded' }));
    await page.getByTestId('floating-chat-button').click({ timeout: 120_000 });
    if (!SINGAPORE_TITLE.test((await page.getByTestId('chat-thread-title').textContent()) ?? '')) await openThread(page, SINGAPORE_TITLE);
    await expect(page.getByTestId('chat-message-assistant').filter({ hasText: TRIP_ANSWER })).toBeVisible({ timeout: 60_000 });
    await expectToolRows(page);

    // f. Change → January 2027, San Francisco: a second thread; the first keeps its messages and title.
    await travel(page, 'time-travel-change', '01', '2027', 'San Francisco');
    await expect(page.getByTestId('chat-thread-title')).toHaveText(SAN_FRANCISCO_TITLE);
    await expect(page.getByTestId('chat-message-assistant')).toHaveCount(0);
    await expect(page.getByTestId('trip-context-card')).toContainText('San Francisco');
    const pins = await pinnedThreads(page);
    expect(pins.map((row) => row.as_of.start).sort()).toEqual(['2019-05-01', '2027-01-01']);
    expect(pins.find((row) => row.as_of.start === '2019-05-01')?.id, 'Change opened a new thread').toBe(trip2019?.id);
    const both = await threadListTitles(page);
    expect(both.trips.filter((title) => SINGAPORE_TITLE.test(title))).toHaveLength(1);
    expect(both.trips.filter((title) => SAN_FRANCISCO_TITLE.test(title))).toHaveLength(1);
    await openThread(page, SINGAPORE_TITLE);
    await expect(page.getByTestId('chat-message-assistant').filter({ hasText: TRIP_ANSWER })).toBeVisible();
    await expect(page.getByTestId('chat-message-user').filter({ hasText: TRIP_QUESTION })).toBeVisible();
    await openThread(page, SAN_FRANCISCO_TITLE);

    // g. Search "Singapore" from the 2027 thread: the 2019 trip is found and opens. "Singapore" is
    // only in its title; a thread that also has message hits is listed by those (chatSearchFusion.ts),
    // so the hit is the thread title row or one of its messages, all labelled with its period.
    await page.getByTestId('chat-search-input').fill('Singapore');
    const searchResults = page.getByTestId('chat-search-results');
    const hit = searchResults.locator(`[data-testid="chat-search-thread-${trip2019?.id ?? 'missing'}"], [data-testid^="chat-search-result-"]`).filter({ hasText: 'May 2019' }).first();
    await expect(hit).toBeVisible({ timeout: 60_000 });
    await expect(searchResults.getByRole('button').filter({ hasText: '2027' }), 'the empty 2027 trip does not match').toHaveCount(0);
    await hit.click();
    await expect(page.getByTestId('chat-thread-title')).toHaveText(SINGAPORE_TITLE);
    await expect(page.getByTestId('chat-message-assistant').filter({ hasText: TRIP_ANSWER })).toBeVisible();

    // i. Clean console for the whole journey.
    expect(consoleErrors, 'the journey must keep a clean console').toEqual([]);
  });
}

/** A second, empty browser for the import (Chromium: a new context has its own OPFS). */
async function freshChromium(browser: Browser, testInfo: TestInfo) {
  const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL, acceptDownloads: true });
  // The app picks files with the File System Access API where it exists; force the <input type=file> path Playwright can drive.
  await forceDownloadAndFileInputPaths(context);
  const page = await context.newPage();
  return { context, page };
}

test('[contract/stubbed] trip tool-call rows survive an export → import round trip into a new browser', async ({ page, browser }, testInfo) => {
  test.setTimeout(600_000);
  test.skip(testInfo.project.name !== 'chromium', 'The second browser here is a Chromium context; WebKit backups are covered by portable-invariants.');
  const consoleErrors = await prepare(page, testInfo);
  const seen: ProviderRequest[] = [];
  await stubProvider(page, seen, []);
  await openChat(page);
  await travel(page, 'time-travel-button', '05', '2019', 'Singapore');
  await page.getByTestId('chat-input').fill(TRIP_QUESTION);
  await page.getByTestId('chat-send-button').click();
  await expect(page.getByTestId('chat-message-assistant').filter({ hasText: TRIP_ANSWER })).toBeVisible({ timeout: 240_000 });
  await expectToolRows(page);

  const backup = testInfo.outputPath('trip-threads.almamesh');
  await exportBackup(page, backup);

  const b = await freshChromium(browser, testInfo);
  try {
    const importErrors = captureReloadConsole(b.page, testInfo).errors;
    await stubProvider(b.page, [], []);
    await importBackup(b.page, backup).catch(async (error: unknown) => {
      await b.page.screenshot({ path: testInfo.outputPath('import-browser-b.png') });
      throw error;
    });
    await gotoSettled(b.page, '/dashboard');
    await b.page.getByTestId('floating-chat-button').click({ timeout: 120_000 });
    if (!SINGAPORE_TITLE.test((await b.page.getByTestId('chat-thread-title').textContent()) ?? '')) await openThread(b.page, SINGAPORE_TITLE);
    await expect(b.page.getByTestId('chat-message-assistant').filter({ hasText: TRIP_ANSWER })).toBeVisible({ timeout: 120_000 });
    await expectToolRows(b.page);
    await b.page.screenshot({ path: `${SCREENS}/e2e-chromium-imported-tool-rows.png` });
    expect(importErrors, 'the imported browser keeps a clean console').toEqual([]);
  } finally {
    await b.context.close();
  }
  expect(consoleErrors, 'the exporting browser keeps a clean console').toEqual([]);
});

/**
 * The sheet prefills "Where?" with the birth place when there is no nearer pin.
 * Contract reversed 2026-10-13 (39d51337, Harish: the AI must know every trip's
 * location): this test first asserted that a kept prefill never names the birth
 * city or zone. Now the trip names its place like any other (label and zone in
 * the brief and in get_trip_context), and what stays banned is everything that
 * identifies the birth: coordinates, the birth date and time, the stored field
 * names, and any marker saying the place is the birth place.
 */
test('[contract/stubbed] a trip that keeps the prefilled birth place names it by label and zone, with no coordinates, birth date or marker', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'One project is enough for a request-body check.');
  const consoleErrors = await prepare(page, testInfo);
  const seen: ProviderRequest[] = [];
  const bodies: string[] = [];
  await stubProvider(page, seen, bodies);
  await openChat(page);
  await page.getByTestId('time-travel-button').click();
  await page.getByTestId('time-travel-tab-month').click();
  await page.getByTestId('time-travel-month').selectOption('05');
  await page.getByTestId('time-travel-month-year').selectOption('2019');
  await expect(page.getByTestId('time-travel-where-prefilled')).toBeVisible();
  await page.getByTestId('time-travel-go').click();
  await expect(page.getByTestId('time-travel-sheet')).toBeHidden();
  await page.getByTestId('chat-input').fill(TRIP_QUESTION);
  await page.getByTestId('chat-send-button').click();
  await expect(page.getByTestId('chat-message-assistant').filter({ hasText: TRIP_ANSWER })).toBeVisible({ timeout: 240_000 });
  expect(seen.length).toBeGreaterThan(0);
  const system = seen[0]?.messages.find((m) => m.role === 'system')?.content ?? '';
  expect(system).toContain(`when the user lived in ${DELHI_SEED.locationName} (${DELHI_SEED.timezone}).`);
  const trip = turnTools(seen[seen.length - 1]?.messages ?? []).find((m) => m.name === 'get_trip_context');
  expect(trip?.content).toContain(`"place":{"label":"${DELHI_SEED.locationName}","timezone":"${DELHI_SEED.timezone}"}`);
  expect(bodies.flatMap(privacyLeaks), 'no coordinate, birth date or time, field name or birth-place marker reaches the model').toEqual([]);
  expect(consoleErrors, 'the journey must keep a clean console').toEqual([]);
});
