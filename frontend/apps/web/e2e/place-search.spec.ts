import { mkdirSync, readFileSync } from 'node:fs';

import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';

import { DELHI_BIRTH, LLM_SETTINGS_KEY, bootEngine, seedChart } from './interpretation.helpers';
import { waitForLifeAtlasAsOf } from './lifeAtlas.helpers';
import { stubModelCatalog } from './modelCatalog.helpers';
import { gotoSettled } from './portableInvariants.helpers';
import { captureReloadConsole } from './reloadConsole';
import {
  chatToolBody,
  fulfillEmpty,
  fulfillToolCall,
  generalAnswer,
  readPeriodArgs,
  stubCallFor,
  toolResults,
  type ChatToolBody,
  type StubToolCall,
} from './stubChatProvider';
import { BIRTH_FIELD_NAMES, birthPlaceMarkers } from './tripPrivacy.helpers';
import { test } from './webkitProfile';

/**
 * Place search (fix/place-search): every place box reads "City, State, Country".
 * The time-travel "Where?" box and the chat's "Which Springfield?" popup share
 * one combobox over the bundled offline list. Each journey TYPES into the box
 * (never the birth-place suggestion). The provider is stubbed with page.route;
 * the engine is real. Chromium only: the place box is the same on every engine.
 */
const LLM_CONFIG = {
  apiBase: 'https://openrouter.ai/api/v1',
  apiKey: 'test-key',
  model: 'deepseek/deepseek-v4-pro',
  privacyMode: 'cloud_premium',
  engine: 'openai-http',
};
const FULL_TIER = { deviceMemory: 8, hardwareConcurrency: 8 };
const NOVATO_LIST_SHOT = 'test-results/place-search-novato-list.png';
const POPUP_SHOT = 'test-results/place-search-popup.png';

const NOVATO = 'Novato, California, United States';
const VADODARA = 'Vadodara, Gujarat, India';
const SPRINGFIELD_IL = 'Springfield, Illinois, United States';

const MAY_QUESTION = 'What did May 2019 look like for me?';
const MAY_ANSWER = 'May 2019 in Novato was a restless, changeable month.';
const YEAR_QUESTION = 'What did 2019 look like for me?';
const YEAR_ANSWER = 'That year in Vadodara was a long stretch of change.';
const PICK_QUESTION = 'I may move to Springfield. What should I know?';
const PICK_ANSWER = 'Springfield in mid-May 2019 had a steady sky.';
const CANCEL_QUESTION = 'Thinking of visiting Springfield. Any advice?';
const CANCEL_ANSWER = 'Tell me which Springfield you mean and I will look.';

interface CityRow {
  readonly n: string;
  readonly s?: string;
  readonly c: string;
  readonly lat: number;
  readonly lon: number;
}

const CITY_ROWS = JSON.parse(readFileSync(new URL('../src/data/cities.min.json', import.meta.url), 'utf8')) as CityRow[];

function cityRow(name: string, state: string): CityRow {
  const row = CITY_ROWS.find((candidate) => candidate.n === name && candidate.s === state);
  if (!row) throw new Error(`${name}, ${state} is missing from cities.min.json`);
  return row;
}

/** A coordinate as a standalone 3-decimal number, sign dropped, truncated or rounded (chart degrees print 2 decimals). */
function coordinatePattern(value: number): RegExp {
  const magnitude = Math.abs(value);
  const truncated = /^\d+\.\d{3}/.exec(String(magnitude))?.[0] ?? magnitude.toFixed(3);
  const forms = [...new Set([truncated, magnitude.toFixed(3)])].map((form) => form.replace('.', '\\.'));
  return new RegExp(`(?<!\\d)(?:${forms.join('|')})`);
}

/** No picked place's or the birth's coordinates, no coordinate field name, no birth-place marker. */
function leaksFor(rows: readonly CityRow[]): (body: string) => string[] {
  const patterns = [
    ...rows.flatMap((row) => [coordinatePattern(row.lat), coordinatePattern(row.lon)]),
    coordinatePattern(DELHI_BIRTH.latitude),
    coordinatePattern(DELHI_BIRTH.longitude),
    BIRTH_FIELD_NAMES,
  ];
  return (body) => [
    ...patterns.flatMap((pattern) => {
      const match = pattern.exec(body);
      return match ? [`${pattern} ~ ${body.slice(Math.max(0, match.index - 40), match.index + 40)}`] : [];
    }),
    ...birthPlaceMarkers(body),
  ];
}

/** One scripted reply per request of a turn, read from the request itself. */
type Script = (body: ChatToolBody) => StubToolCall;

/** The read_period results a request carries. */
const reads = (body: ChatToolBody | undefined) => (body ? toolResults(body).filter((result) => result.name === 'read_period') : []);

/** Mid-May 2019 at a place the person names: "Springfield" opens the picker. */
const SPRINGFIELD_DAY = readPeriodArgs('2019-05-15', { place: 'Springfield' });

const SCRIPTS: Readonly<Record<string, Script>> = {
  // A trip turn reads its own period at the trip's place (read_period with no place), then answers.
  [MAY_QUESTION]: (body) => stubCallFor(body, readPeriodArgs('2019-05'), MAY_ANSWER),
  [YEAR_QUESTION]: (body) => stubCallFor(body, readPeriodArgs('2019'), YEAR_ANSWER),
  // Plain chat: read a day in "Springfield" (the person picks one), then answer from the reading.
  [PICK_QUESTION]: (body) => stubCallFor(body, SPRINGFIELD_DAY, PICK_ANSWER),
  // The person cancels the picker, so the model asks instead of guessing.
  [CANCEL_QUESTION]: (body) => (toolResults(body).length === 0 ? { name: 'read_period', args: SPRINGFIELD_DAY } : { name: 'answer', args: generalAnswer(CANCEL_ANSWER) }),
};

/** The stubbed provider: one script per question; everything else (summaries) gets a harmless empty answer. */
async function stubProvider(page: Page, seen: ChatToolBody[], bodies: string[]): Promise<void> {
  await stubModelCatalog(page);
  await page.route('**/chat/completions', async (route) => {
    const body = route.request().postData() ?? '{}';
    bodies.push(body);
    const chat = chatToolBody(body);
    const lastUser = [...(chat?.messages ?? [])].reverse().find((m) => m.role === 'user')?.content ?? '';
    const key = Object.keys(SCRIPTS).find((question) => lastUser.includes(question));
    if (!chat || !key) return fulfillEmpty(route);
    seen.push(chat);
    return fulfillToolCall(route, SCRIPTS[key]!(chat), `call_${seen.length}`);
  });
}

/** Console capture, a full-tier device pin and the stubbed provider's settings. */
async function prepare(page: Page, testInfo: TestInfo): Promise<string[]> {
  const capture = captureReloadConsole(page, testInfo);
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

/** Seed the Delhi chart, open the Dashboard and its chat drawer once today's Life Atlas has settled. */
async function openChat(page: Page): Promise<void> {
  await bootEngine(page);
  await seedChart(page);
  await gotoSettled(page, '/dashboard');
  await waitForLifeAtlasAsOf(page);
  await page.getByTestId('floating-chat-button').click({ timeout: 120_000 });
  await expect(page.getByTestId('floating-chat-drawer')).toBeVisible();
}

/** ⏳ → a tab, with no earlier trip: the "Where?" box starts empty and asks. */
async function openSheet(page: Page, tab: 'month' | 'year'): Promise<void> {
  await page.getByTestId('time-travel-button').click();
  await expect(page.getByTestId('time-travel-sheet')).toBeVisible();
  await page.getByTestId(`time-travel-tab-${tab}`).click();
  await expect(page.getByTestId('time-travel-where-input')).toHaveValue('');
}

const options = (page: Page, prefix: string): Locator => page.locator(`[data-testid^="${prefix}-option-"][role="option"]`);

async function goAndLand(page: Page): Promise<void> {
  await expect(page.getByTestId('time-travel-go')).toBeEnabled();
  await page.getByTestId('time-travel-go').click();
  await expect(page.getByTestId('time-travel-sheet')).toBeHidden();
  await expect(page.getByTestId('time-travel-banner')).toBeVisible();
}

async function ask(page: Page, question: string, answer: string): Promise<void> {
  await page.getByTestId('chat-input').fill(question);
  await page.getByTestId('chat-send-button').click();
  await expect(page.getByTestId('chat-message-assistant').filter({ hasText: answer })).toBeVisible({ timeout: 240_000 });
}

async function pinnedPlaces(page: Page): Promise<Array<{ start: string; place?: { label: string; timezone: string } }>> {
  const rows = await page.evaluate(() => (window as unknown as { __almameshPinnedThreads?: () => unknown[] }).__almameshPinnedThreads?.());
  if (!rows) throw new Error('window.__almameshPinnedThreads is missing: build with VITE_EXIT_GATE_HOOKS=1');
  return (rows as Array<{ as_of: { start: string; place?: { label: string; timezone: string } } }>).map((row) => row.as_of);
}

test.skip(({ browserName }) => browserName !== 'chromium', 'The place box is engine-independent; one project is enough.');
test.describe.configure({ timeout: 600_000 });

test('[contract/stubbed] typing "novato, ca" in Where? lists Novato, California and the trip reads it by label and zone, never coordinates', async ({ page }, testInfo) => {
  const consoleErrors = await prepare(page, testInfo);
  const seen: ChatToolBody[] = [];
  const bodies: string[] = [];
  await stubProvider(page, seen, bodies);
  await openChat(page);

  await openSheet(page, 'month');
  await page.getByTestId('time-travel-month').selectOption('05');
  await page.getByTestId('time-travel-month-year').selectOption('2019');
  const input = page.getByTestId('time-travel-where-input');
  await input.pressSequentially('novato, ca');
  const listed = options(page, 'time-travel-where');
  await expect(listed).toHaveCount(1, { timeout: 60_000 });
  await expect(page.getByRole('listbox')).toBeVisible();
  await expect(listed.first()).toHaveText(NOVATO);
  await expect(listed.first().locator('[data-part="city"]')).toHaveText('Novato');
  await expect(listed.first().locator('[data-part="region"]')).toHaveText(', California, United States');
  await expect(input).toHaveAttribute('aria-expanded', 'true');
  await expect(listed.first()).toHaveAttribute('aria-selected', 'true');
  mkdirSync('test-results', { recursive: true });
  await page.getByTestId('time-travel-sheet').screenshot({ path: NOVATO_LIST_SHOT });
  await expect(page.getByTestId('time-travel-go'), 'typed but not picked: Go waits').toBeDisabled();
  await input.press('Enter');
  await expect(input).toHaveValue(NOVATO);
  await expect(listed).toHaveCount(0);
  await goAndLand(page);

  await expect(page.getByTestId('chat-thread-title')).toHaveText(/^⏳ May 2019 · Novato/);
  await expect(page.getByTestId('time-travel-title')).toHaveText('May 2019');
  await expect(page.getByTestId('time-travel-banner')).toContainText('Novato');
  const [pin] = await pinnedPlaces(page);
  expect(pin).toMatchObject({ start: '2019-05-01', place: { label: NOVATO, timezone: 'America/Los_Angeles' } });

  await ask(page, MAY_QUESTION, MAY_ANSWER);
  const system = seen[0]?.messages.find((m) => m.role === 'system')?.content ?? '';
  expect(system).toContain(`THIS THREAD: a trip to May 2019, when the user lived in ${NOVATO} (America/Los_Angeles).`);
  // read_period with no place read the trip's place: its label and zone, never its coordinates.
  const [reading] = reads(seen[seen.length - 1]);
  expect(reading?.content).toContain(`"place":{"label":"${NOVATO}","timezone":"America/Los_Angeles"}`);
  expect(reading?.content).not.toContain('"available":false');
  expect(bodies.length).toBeGreaterThan(0);
  expect(bodies.flatMap(leaksFor([cityRow('Novato', 'California')])), 'no coordinate, field name or birth-place marker reaches the model').toEqual([]);
  expect(consoleErrors, 'the journey must keep a clean console').toEqual([]);
});

test('[contract/stubbed] a Year trip asks "Where were you living then?" and typing "vadodara" reads Vadodara, Gujarat in Asia/Kolkata', async ({ page }, testInfo) => {
  const consoleErrors = await prepare(page, testInfo);
  const seen: ChatToolBody[] = [];
  const bodies: string[] = [];
  await stubProvider(page, seen, bodies);
  await openChat(page);

  await openSheet(page, 'year');
  await page.getByTestId('time-travel-year').selectOption('2019');
  await expect(page.getByTestId('time-travel-where-question')).toHaveText('Where were you living then?');
  await expect(page.getByTestId('time-travel-go'), 'no place yet: Go waits').toBeDisabled();
  await page.getByTestId('time-travel-where-input').pressSequentially('vadodara');
  await expect(page.getByTestId('time-travel-where-option-0')).toHaveText(VADODARA, { timeout: 60_000 });
  await expect(page.getByTestId('time-travel-where-question'), 'the suggestions replace the question').toHaveCount(0);
  await page.getByTestId('time-travel-where-option-0').click();
  await expect(page.getByTestId('time-travel-where-input')).toHaveValue(VADODARA);
  await goAndLand(page);

  await expect(page.getByTestId('chat-thread-title')).toHaveText(/^⏳ 2019 · Vadodara/);
  const [pin] = await pinnedPlaces(page);
  expect(pin).toMatchObject({ start: '2019-01-01', place: { label: VADODARA, timezone: 'Asia/Kolkata' } });

  await ask(page, YEAR_QUESTION, YEAR_ANSWER);
  const system = seen[0]?.messages.find((m) => m.role === 'system')?.content ?? '';
  expect(system).toContain(`when the user lived in ${VADODARA} (Asia/Kolkata).`);
  expect(reads(seen[seen.length - 1])[0]?.content).toContain(`"place":{"label":"${VADODARA}","timezone":"Asia/Kolkata"}`);
  expect(bodies.flatMap(leaksFor([cityRow('Vadodara', 'Gujarat')]))).toEqual([]);
  expect(consoleErrors, 'the journey must keep a clean console').toEqual([]);
});

test('[contract/stubbed] a trailing qualifier narrows the box: "Portland, ME" is one row, "Springfield" lists several distinct states', async ({ page }, testInfo) => {
  const consoleErrors = await prepare(page, testInfo);
  await stubProvider(page, [], []);
  await openChat(page);
  await openSheet(page, 'month');

  const input = page.getByTestId('time-travel-where-input');
  const listed = options(page, 'time-travel-where');
  await input.pressSequentially('Portland, ME');
  await expect(listed).toHaveCount(1, { timeout: 60_000 });
  await expect(listed.first()).toHaveText('Portland, Maine, United States');

  await input.fill('');
  await expect(listed).toHaveCount(0);
  await input.pressSequentially('Springfield');
  await expect(listed.filter({ hasText: SPRINGFIELD_IL })).toHaveCount(1, { timeout: 60_000 });
  const texts = (await listed.allTextContents()).map((text) => text.trim());
  expect(texts.length, texts.join(' | ')).toBeGreaterThanOrEqual(5);
  expect(texts.length, texts.join(' | ')).toBeLessThanOrEqual(6);
  expect(new Set(texts).size, `every row is distinct: ${texts.join(' | ')}`).toBe(texts.length);
  for (const text of texts) expect(text).toMatch(/^Springfield, [A-Z][a-z]+, United States$/);
  // Arrows move the active row; Enter picks it.
  await input.press('ArrowDown');
  await expect(listed.nth(1)).toHaveAttribute('aria-selected', 'true');
  await input.press('Enter');
  await expect(input).toHaveValue(texts[1]!);
  await expect(page.getByTestId('time-travel-go')).toBeEnabled();
  expect(consoleErrors, 'the journey must keep a clean console').toEqual([]);
});

/** Ask the Springfield question in plain chat and wait for the "Which Springfield?" popup. */
async function askAndAwaitPopup(page: Page, question: string): Promise<Locator> {
  await page.getByTestId('chat-input').fill(question);
  await page.getByTestId('chat-send-button').click();
  const popup = page.getByTestId('place-pick');
  await expect(popup).toBeVisible({ timeout: 240_000 });
  await expect(popup.getByRole('heading')).toHaveText('Which Springfield?');
  await expect(page.getByTestId('place-pick-input')).toBeFocused();
  await expect(page.getByTestId('place-pick-input')).toHaveValue('Springfield');
  return popup;
}

test('[contract/stubbed] chat asks "Which Springfield?"; the pick goes to the model as a label and zone, and read_period reads it', async ({ page }, testInfo) => {
  const consoleErrors = await prepare(page, testInfo);
  const seen: ChatToolBody[] = [];
  const bodies: string[] = [];
  await stubProvider(page, seen, bodies);
  await openChat(page);

  const popup = await askAndAwaitPopup(page, PICK_QUESTION);
  const listed = options(page, 'place-pick');
  await expect(listed.filter({ hasText: SPRINGFIELD_IL })).toHaveCount(1);
  expect(await listed.count()).toBeGreaterThan(1);
  mkdirSync('test-results', { recursive: true });
  await page.getByTestId('chat-panel').screenshot({ path: POPUP_SHOT });
  expect(seen, 'the model waits: no request goes out while the person chooses').toHaveLength(1);
  await listed.filter({ hasText: SPRINGFIELD_IL }).click();
  await expect(popup).toHaveCount(0);
  await expect(page.getByTestId('chat-message-assistant').filter({ hasText: PICK_ANSWER })).toBeVisible({ timeout: 240_000 });

  // The read ran at the picked place: its label and zone reach the model, never its coordinates.
  const [picked] = reads(seen[seen.length - 1]);
  expect(picked?.content).not.toMatch(/"available":false|needs_place|place_not/);
  expect(picked?.content).toContain(`"label":"${SPRINGFIELD_IL}"`);
  expect(picked?.content).toContain('"timezone":"America/Chicago"');
  expect(picked?.content).not.toMatch(/latitude|longitude/i);

  const readRow = page.locator('[data-testid="chat-tool-call"][data-tool-name="read_period"]');
  await expect(readRow).toHaveCount(1);
  await expect(readRow).toHaveAttribute('data-status', 'complete');
  expect(bodies.flatMap(leaksFor([cityRow('Springfield', 'Illinois')])), 'no coordinate reaches the model').toEqual([]);
  expect(consoleErrors, 'the journey must keep a clean console').toEqual([]);
});

test('[contract/stubbed] Escape in "Which Springfield?" answers place_not_chosen, a neutral row, and the chat stays open', async ({ page }, testInfo) => {
  const consoleErrors = await prepare(page, testInfo);
  const seen: ChatToolBody[] = [];
  await stubProvider(page, seen, []);
  await openChat(page);

  const popup = await askAndAwaitPopup(page, CANCEL_QUESTION);
  await page.getByTestId('place-pick-input').press('Escape');
  await expect(popup).toHaveCount(0);
  await expect(page.getByTestId('floating-chat-drawer'), 'Escape closes only the popup').toBeVisible();
  await expect(page.getByTestId('chat-message-assistant').filter({ hasText: CANCEL_ANSWER })).toBeVisible({ timeout: 240_000 });

  // The cancel comes back as a neutral question for the person, never a guessed place.
  const [asked] = reads(seen[seen.length - 1]);
  expect(asked?.content).toContain('"status":"place_not_chosen"');
  expect(asked?.content).toContain(SPRINGFIELD_IL);
  expect(asked?.content).not.toMatch(/latitude|longitude/i);
  const readRow = page.locator('[data-testid="chat-tool-call"][data-tool-name="read_period"]');
  await expect(readRow).toHaveCount(1);
  await expect(readRow, 'a cancel is not a failed lookup').not.toHaveAttribute('data-status', 'error');
  expect(consoleErrors, 'the journey must keep a clean console').toEqual([]);
});
