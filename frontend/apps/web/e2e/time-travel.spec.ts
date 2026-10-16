import { readFileSync, writeFileSync } from 'node:fs';

import { expect, type ConsoleMessage, type Frame, type Locator, type Page, type Worker as PlaywrightWorker } from '@playwright/test';

import { DELHI_BIRTH, DELHI_SEED, LLM_SETTINGS_KEY, bootEngine, seedChart, waitForEngineReady } from './interpretation.helpers';
import { stubModelCatalog } from './modelCatalog.helpers';
import { gotoSettled } from './portableInvariants.helpers';
import { captureReloadConsole, type ReloadConsoleCapture } from './reloadConsole';
import { waitForLifeAtlasAsOf } from './lifeAtlas.helpers';
import { withReloadJourneyDiagnostics } from './reloadJourneyDiagnostics';
import {
  chatToolBody,
  fulfillEmpty,
  fulfillReadThenAnswer,
  fulfillToolCall,
  generalAnswer,
  readPeriodArgs,
  stubCallFor,
  toolNames,
  toolResults,
  type ChatToolBody,
  type StubToolCall,
} from './stubChatProvider';
import { BIRTH_FIELD_NAMES, birthPlaceMarkers } from './tripPrivacy.helpers';
import { pageServiceWorkerReader, waitForServiceWorkerActive } from './serviceWorkerActivation';
import { test } from './webkitProfile';

/**
 * Journey 1 (spec 2026-10-08): "what was going on for me in June 2019?" typed
 * into plain Dashboard chat. The provider is stubbed with page.route (as in
 * chat.grounding.spec.ts) so the run is deterministic; the engine is real.
 */
const LLM_CONFIG = {
  apiBase: 'https://openrouter.ai/api/v1',
  apiKey: 'test-key',
  model: 'deepseek/deepseek-v4-pro',
  privacyMode: 'cloud_premium',
  engine: 'openai-http',
};
/** The only off-origin URLs a journey may request: the stubbed provider's, fulfilled by page.route. */
const PROVIDER_ORIGIN = new URL(LLM_CONFIG.apiBase).origin;
const QUESTION = 'What was going on for me in June 2019? Any big transits?';
const BIRTH_MONTH = '1990-01'; // DELHI_BIRTH.datetimeUtc
const SCREENSHOT = 'test-results/time-travel-june-2019.png';
/**
 * Pin a full-tier device for the desktop journeys. Separate iPhone journeys
 * exercise the minimal tier with the same deterministic period capabilities.
 */
const FULL_TIER = { deviceMemory: 8, hardwareConcurrency: 8 };

/** Every requestKey the predictive store held on this page (the exit-gate hook). */
async function predictiveRequestKeys(page: Page): Promise<string[]> {
  const keys = await page.evaluate(
    () => (window as unknown as { __almameshPredictiveRequestKeys?: string[] }).__almameshPredictiveRequestKeys,
  );
  if (!keys) throw new Error('window.__almameshPredictiveRequestKeys is missing: build with VITE_EXIT_GATE_HOOKS=1');
  return [...keys];
}

/**
 * Open the dashboard after seedChart. seedChart's restore reloads the app, and
 * that load is still opening SQLite and the engine. WebKit can emit a native
 * navigation diagnostic; reloadConsole distinguishes proven resource evidence
 * from the explicit exception with unproven source and cause. The app's own
 * navigation can cut the goto short ("Frame load interrupted").
 * gotoSettled waits for the document to settle and retries an interrupted goto.
 */
async function openDashboard(page: Page): Promise<void> {
  await gotoSettled(page, '/dashboard');
}

/** Every console error and uncaught page error, for the clean-console checks. */
const consoleCaptures = new WeakMap<Page, ReloadConsoleCapture>();

function captureConsole(page: Page): string[] {
  const capture = captureReloadConsole(page, test.info());
  consoleCaptures.set(page, capture);
  return capture.errors;
}

function explicitReload<T>(page: Page, reload: () => Promise<T>): Promise<T> {
  const capture = consoleCaptures.get(page);
  if (!capture) throw new Error('Explicit reload requires console capture');
  return capture.duringReload(reload);
}

function captureLocalModelDownloads(page: Page): string[] {
  const paths: string[] = [];
  page.context().on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/models/')) paths.push(path);
  });
  return paths;
}

/** The stubbed provider's settings, so chat shows its composer and the Time travel button. */
async function configureStubbedAi(page: Page): Promise<void> {
  await page.addInitScript(
    ([key, cfg]) => window.localStorage.setItem(key as string, cfg as string),
    [LLM_SETTINGS_KEY, JSON.stringify(LLM_CONFIG)] as const,
  );
  await stubModelCatalog(page);
}

/** Console capture, a full-tier device pin and the stubbed provider's settings: every full-tier journey's set-up. */
async function prepare(page: Page): Promise<string[]> {
  const consoleErrors = captureConsole(page);
  await page.addInitScript((tier) => {
    for (const [name, value] of Object.entries(tier)) {
      Object.defineProperty(Navigator.prototype, name, { get: () => value, configurable: true });
    }
  }, FULL_TIER);
  await configureStubbedAi(page);
  return consoleErrors;
}

test('[contract/stubbed] a typed June 2019 question reads June 2019, not today', async ({ page }) => {
  const consoleErrors = await prepare(page);

  const agentRequests: ChatToolBody[] = [];
  await page.route('**/chat/completions', async (route) => {
    const chat = chatToolBody(route.request().postData());
    // Anything else (summaries, other features): a harmless empty answer.
    if (!chat || !JSON.stringify(chat.messages).includes('June 2019')) return fulfillEmpty(route);
    agentRequests.push(chat);
    return fulfillReadThenAnswer(route, chat, readPeriodArgs('2019-06'));
  });

  await bootEngine(page);
  await seedChart(page);
  await openDashboard(page);

  // The seeded chart re-anchors to today first; an answer streamed across that
  // is discarded by design, so chat about the chart the user will see.
  const today = await page.evaluate(() =>
    new Intl.DateTimeFormat('en', { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date()),
  );
  await expect(page.getByTestId('provenance-footer')).toContainText(`As of ${today}`, { timeout: 120_000 });

  // The Life Atlas reads the predictive-store slot; wait for today's reading
  // so the period compute below has a slot it could (wrongly) take.
  const atlasAsOf = await waitForLifeAtlasAsOf(page);
  const atlasBefore = (await atlasAsOf.textContent()) ?? '';
  expect(atlasBefore).not.toContain('2019');
  // The predictive store's requestKey history (an exit-gate hook) from here
  // on: a period compute that borrowed the slot and handed it back would pass
  // a before/after compare, but not this.
  const keysBefore = await predictiveRequestKeys(page);
  const baselineKey = keysBefore[keysBefore.length - 1];
  expect(baselineKey, 'the Life Atlas slot holds a computed reading').not.toBe('(none)');
  // The "Working out the sky" status can be brief; record every text it shows.
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { __agentStatusHistory: string[] }).__agentStatusHistory = seen;
    new MutationObserver(() => {
      const text = document.querySelector('[data-testid="chat-agent-status"]')?.textContent;
      if (text && seen[seen.length - 1] !== text) seen.push(text);
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });

  await page.getByTestId('floating-chat-button').click({ timeout: 60_000 });
  await page.getByTestId('chat-input').fill(QUESTION);
  await page.getByTestId('chat-send-button').click();

  // A dated question in a today thread: no router pre-runs today; the model reads the period.
  await expect.poll(() => agentRequests.length, { timeout: 120_000 }).toBeGreaterThan(0);
  const [decision] = agentRequests as [ChatToolBody];
  const prompt = decision.messages.map((message) => message.content ?? '').join('\n');
  expect(prompt, 'a dated question must not pre-run and label today').not.toContain(', today):');
  // Contract changed (chat tool layer redesign, Task 6, 2026-10-14): one tool reads any period,
  // one moves the conversation, and the turn finishes with `answer`.
  expect(toolNames(decision)).toEqual(['read_period', 'travel', 'answer']);
  expect(decision.tool_choice).toBe('required');

  const chatPanel = page.getByTestId('chat-panel');
  await expect(chatPanel.getByText('A steady stretch for work.', { exact: false })).toBeVisible({ timeout: 240_000 });
  // The period compute runs the real engine and said which span while it ran.
  const statuses = await page.evaluate(
    () => (window as unknown as { __agentStatusHistory: string[] }).__agentStatusHistory,
  );
  expect(statuses.some((text) => text.includes('Reading June 2019')), statuses.join(' | ')).toBe(true);

  expect(agentRequests).toHaveLength(2);
  const [reading] = toolResults(agentRequests[1]!);
  expect(reading?.name).toBe('read_period');
  expect(reading?.content, 'the reading is June 2019').toContain('"start":"2019-06-01","end":"2019-06-30"');
  expect(reading?.content).toContain('"antar"');
  expect(reading?.content).not.toContain('"available":false');
  expect(reading?.content).not.toContain(BIRTH_MONTH);

  // The Life Atlas still describes today: the period compute did not take its slot.
  await expect(atlasAsOf).toHaveText(atlasBefore);
  const keysAfter = await predictiveRequestKeys(page);
  expect(keysAfter.slice(keysBefore.length), 'the Life Atlas slot must keep its requestKey').toEqual([]);
  await page.screenshot({ path: SCREENSHOT, fullPage: true });
  expect(consoleErrors, 'the journey must keep a clean console').toEqual([]);
});

/**
 * Journey 2 (Inc B): an 18-month period. The engine's 12-month window from
 * 1 January 2027 ends on 31 December 2027, so the app must ask for 24 months,
 * in one compute, and the model must see the 2028 events too.
 */
const LONG_QUESTION = 'How do 2027 and the first half of 2028 look for me?';
const LONG_SCREENSHOT = 'test-results/time-travel-18-months.png';

interface PredictiveCompute {
  referenceInstant: string;
  windowMonths: number | null;
}

/** Record every computePredictive request the page posts to the engine worker. */
async function recordPredictiveComputes(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const log: Array<{ referenceInstant: string; windowMonths: number | null }> = [];
    (window as unknown as { __predictiveComputes: typeof log }).__predictiveComputes = log;
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (this: Worker, ...args: Parameters<Worker['postMessage']>) {
      const data = args[0] as { kind?: string; input?: { referenceInstant: string; windowMonths?: number } };
      if (data?.kind === 'computePredictive' && data.input) {
        log.push({ referenceInstant: data.input.referenceInstant, windowMonths: data.input.windowMonths ?? null });
      }
      return post.apply(this, args as never);
    } as Worker['postMessage'];
  });
}

async function predictiveComputes(page: Page): Promise<PredictiveCompute[]> {
  return page.evaluate(
    () => (window as unknown as { __predictiveComputes: PredictiveCompute[] }).__predictiveComputes,
  );
}

test('[contract/stubbed] an 18-month period is one engine run with Mars, nodes and stations', async ({ page }) => {
  test.setTimeout(600_000);
  const consoleErrors = await prepare(page);
  await recordPredictiveComputes(page);
  const readings: string[] = [];
  await page.route('**/chat/completions', async (route) => {
    const chat = chatToolBody(route.request().postData());
    if (!chat || !JSON.stringify(chat.messages).includes('first half of 2028')) return fulfillEmpty(route);
    readings.push(...toolResults(chat).filter((result) => result.name === 'read_period').map((result) => result.content));
    return fulfillReadThenAnswer(route, chat, readPeriodArgs('2027-01', { end: '2028-06' }));
  });

  await bootEngine(page);
  await seedChart(page);
  await openDashboard(page);
  // As in the June 2019 journey: wait for the re-anchor to today, or the answer is discarded by design.
  const today = await page.evaluate(() =>
    new Intl.DateTimeFormat('en', { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date()),
  );
  await expect(page.getByTestId('provenance-footer')).toContainText(`As of ${today}`, { timeout: 120_000 });
  // Today's Life Atlas reading, recorded before the 24-month compute can touch its slot.
  const atlasAsOf = await waitForLifeAtlasAsOf(page);
  const atlasBefore = (await atlasAsOf.textContent()) ?? '';
  expect(atlasBefore).not.toContain('2027');
  await page.getByTestId('floating-chat-button').click({ timeout: 120_000 });
  await page.getByTestId('chat-input').fill(LONG_QUESTION);
  await page.getByTestId('chat-send-button').click();

  const started = Date.now();
  await expect(page.getByTestId('chat-panel').getByText('A steady stretch for work.', { exact: false })).toBeVisible({
    timeout: 480_000,
  });
  test.info().annotations.push({ type: '18-month answer wall time (ms)', description: String(Date.now() - started) });

  // One engine run answers the whole period, and it asked for 24 months.
  const periodComputes = (await predictiveComputes(page)).filter((c) => c.referenceInstant.startsWith('2027-01-01'));
  expect(periodComputes).toEqual([{ referenceInstant: '2027-01-01T00:00:00Z', windowMonths: 24 }]);
  // Step A: the period compute never takes the Life Atlas slot.
  const keys = await predictiveRequestKeys(page);
  expect(keys.filter((key) => key.includes('2027-01-01')), 'the Life Atlas slot must keep its requestKey').toEqual([]);
  // The Life Atlas still describes today after the 24-month compute.
  await expect(atlasAsOf).toHaveText(atlasBefore);

  // One read_period call covers the whole span (never split into months), with one row per month.
  expect(readings).toHaveLength(1);
  const reading = JSON.parse(readings[0]!) as { period: { start: string; end: string }; months?: unknown[]; sky?: Array<{ graha: string; sign: string }>; available?: boolean };
  expect(reading.period).toMatchObject({ start: '2027-01-01', end: '2028-06-30' });
  expect(reading.available).toBeUndefined();
  expect(reading.months).toHaveLength(18);
  // Real engine sky reaches the model, past a 12-month window's end: the nodes change sign in June 2028.
  const rahuSigns = new Set(reading.sky?.filter((span) => span.graha === 'rahu').map((span) => span.sign));
  expect(rahuSigns.size, JSON.stringify(reading.sky?.map((span) => [span.graha, span.sign]))).toBeGreaterThan(1);
  expect(readings[0]).not.toContain(BIRTH_MONTH);
  await page.screenshot({ path: LONG_SCREENSHOT, fullPage: true });
  expect(consoleErrors, 'the journey must keep a clean console').toEqual([]);
});

/**
 * Journey 3 (spec 2026-10-08, Inc C, coordinator rulings 2026-10-09, P4/P8/P9):
 * June (30 days, a week or longer) with two places is read once with read_period
 * and no place, and the model says the places don't change it (P9: no place
 * lookup); "the 15th" reads the day with the place the user named for that half
 * (P4: read_period resolves it on the device, one call); "3 pm on 3 July" has no
 * place, so read_period answers needs_place and the model asks; "Bogotá" reads
 * the event there. No
 * request may leave the app origin, except provider calls that this test's own
 * route handler fulfilled (they never reach the network). Nothing the model is
 * sent may carry a coordinate, the device zone or the birth place.
 */
const SPLIT_QUESTION = 'How was June 2026 for me? I was in LA the first half, then Bogotá.';
const SPLIT_ANSWER = "Being in LA and then Bogotá doesn't change June's reading.";
const DAY_QUESTION = 'What about June 15 itself?';
const DAY_ANSWER = 'On 15 June 2026 in Los Angeles the Moon was in a calm sign.';
const TIME_QUESTION = 'And 3 pm on 3 July?';
const WHERE_QUESTION = 'Where were you (or will you be) that day?';
const PLACE_REPLY = 'I will be in Bogotá.';
const EVENT_ANSWER = 'At 3 pm on 3 July 2026 in Bogotá the rising sign set the tone.';
const PLACE_SCREENSHOT = 'test-results/time-travel-places.png';
/** A zone no journey step names: where it reaches the model, it is the viewer zone (the NOW line, an unplaced read). */
const DEVICE_ZONE = 'Pacific/Chatham';

interface CityRow {
  n: string;
  c: string;
  lat: number;
  lon: number;
}

/** The bundled offline city list read_period's place lookup reads (the rows whose coordinates must never leave). */
const CITY_ROWS = JSON.parse(
  readFileSync(new URL('../src/data/cities.min.json', import.meta.url), 'utf8'),
) as CityRow[];

function cityRow(name: string, country: string): CityRow {
  const row = CITY_ROWS.find((candidate) => candidate.n === name && candidate.c === country);
  if (!row) throw new Error(`${name}, ${country} is missing from cities.min.json`);
  return row;
}

/**
 * A coordinate as a standalone 3-decimal number, sign dropped, truncated (4.60971 -> 4.609) or
 * rounded (4.610). Final review ruling: facts.ts prints degrees with toFixed(2), so a 2-decimal
 * prefix could match a planet's degree on some dates; 3 decimals cannot.
 */
function coordinatePattern(value: number): RegExp {
  const magnitude = Math.abs(value);
  const truncated = /^\d+\.\d{3}/.exec(String(magnitude))?.[0];
  if (!truncated) throw new Error(`${value} has fewer than three decimals`);
  const forms = [...new Set([truncated, magnitude.toFixed(3)])].map((form) => form.replace('.', '\\.'));
  return new RegExp(`(?<!\\d)(?:${forms.join('|')})`);
}

/** Ruling P8: patterns from the real resolved rows and the seeded birth, not hand-typed digits. */
const LEAK_PATTERNS: readonly RegExp[] = [
  ...[cityRow('Los Angeles', 'United States'), cityRow('Bogotá', 'Colombia')].flatMap((row) => [
    coordinatePattern(row.lat),
    coordinatePattern(row.lon),
  ]),
  coordinatePattern(DELHI_BIRTH.latitude),
  coordinatePattern(DELHI_BIRTH.longitude),
  /latitude|longitude|home_time_zone/i,
  BIRTH_FIELD_NAMES,
  // Contract reversed (chat tool layer redesign, Tasks 4 and 6, 2026-10-14): the device zone was
  // banned from every body. A chat turn now states today in the viewer's zone (the NOW line), and a
  // read with no place frames its span in that same zone, so the zone is no longer a leak. Coordinates,
  // field names and the birth place still are.
  // These journeys open no trip at the birth place, so nothing names the birth city or zone. (A
  // trip at the birth place names its label and zone since 39d51337; time-travel-threads.spec.ts
  // covers that. A marker saying a place is the birth place is banned everywhere: leaks below.)
  new RegExp(DELHI_SEED.timezone.replace('/', '\\/')),
  new RegExp(`\\b(?:${DELHI_SEED.city}|${DELHI_SEED.locationName.split(', ')[1]})\\b`),
];

/**
 * A body without its NOW line. Contract changed (chat tool layer redesign, Task 4/6, 2026-10-14):
 * a chat turn's system prompt states today in the viewer's zone ("NOW: today is <day>, <zone>"),
 * so the device zone reaches the model there, and only there.
 */
const withoutNowLine = (body: string): string => body.replace(/NOW: today is [^\\"]*/g, 'NOW: <today>');

/** Every leak pattern that matches, with the text around the match. */
function leaks(raw: string): string[] {
  const body = withoutNowLine(raw);
  const patterns = LEAK_PATTERNS.flatMap((pattern) => {
    const match = pattern.exec(body);
    return match ? [`${pattern} ~ ${body.slice(Math.max(0, match.index - 40), match.index + 40)}`] : [];
  });
  return body.trimStart().startsWith('{') ? [...patterns, ...birthPlaceMarkers(body)] : patterns;
}

/** One scripted reply per request of a turn, read from the request itself. */
type Script = (body: ChatToolBody) => StubToolCall;

/** The read_period results the last request of a turn carried. */
const reads = (body: ChatToolBody | undefined) => (body ? toolResults(body).filter((result) => result.name === 'read_period') : []);

/**
 * The stubbed provider: one script per user message; records every model-bound
 * body and every URL it fulfilled.
 */
async function scripted(
  page: Page,
  scripts: Record<string, Script>,
  seen: ChatToolBody[],
  bodies: string[],
  fulfilled: Set<string>,
): Promise<unknown> {
  // Registered after configureStubbedAi's, so this one answers and records the catalog read.
  await stubModelCatalog(page, fulfilled);
  return page.route('**/chat/completions', async (route) => {
    fulfilled.add(route.request().url());
    const raw = route.request().postData() ?? '{}';
    bodies.push(raw);
    const chat = chatToolBody(raw);
    const lastUser = [...(chat?.messages ?? [])].reverse().find((m) => m.role === 'user')?.content ?? '';
    // Recalled history can quote earlier questions inside the user message; the asked one comes last.
    const key = Object.keys(scripts)
      .filter((text) => lastUser.includes(text))
      .sort((a, b) => lastUser.lastIndexOf(b) - lastUser.lastIndexOf(a))[0];
    if (!chat || !key) return fulfillEmpty(route);
    seen.push(chat);
    return fulfillToolCall(route, scripts[key]!(chat), `call_${seen.length}`);
  });
}

const PLACE_SCRIPTS: Record<string, Script> = {
  // A week or longer needs no place, so June is one read_period and the model says so.
  [SPLIT_QUESTION]: (body) => stubCallFor(body, readPeriodArgs('2026-06'), SPLIT_ANSWER),
  // The user named LA for the first half: the day is read there, the city found on the device.
  [DAY_QUESTION]: (body) => stubCallFor(body, readPeriodArgs('2026-06-15', { place: 'Los Angeles' }), DAY_ANSWER),
  // No place named for 3 July: the stub tries without one; only needs_place makes it ask.
  [TIME_QUESTION]: (body) => (toolResults(body).length === 0
    ? { name: 'read_period', args: readPeriodArgs('2026-07-03', { time: '15:00' }) }
    : { name: 'answer', args: generalAnswer(reads(body)[0]?.content.includes('"needs_place"') ? WHERE_QUESTION : 'Here is 3 July without a place.') }),
  [PLACE_REPLY]: (body) => stubCallFor(body, readPeriodArgs('2026-07-03', { place: 'Bogotá', time: '15:00' }), EVENT_ANSWER),
};

test('[contract/pure] leak patterns are 3-decimal prefixes of the real rows, so 2-decimal chart degrees never collide', () => {
  // Final review ruling: facts.ts prints degrees with toFixed(2), so a 2-decimal prefix can match a planet's degree.
  const bogota = cityRow('Bogotá', 'Colombia');
  const twoDecimalDegrees = [bogota.lat, bogota.lon, DELHI_BIRTH.latitude, DELHI_BIRTH.longitude].map((value) =>
    Math.abs(value).toFixed(2),
  );
  expect(twoDecimalDegrees.flatMap((degrees) => leaks(`"degree":${degrees}`))).toEqual([]);
  expect(leaks(`"at":"${bogota.lat},${bogota.lon}"`)).toHaveLength(2);
  // A leak rounded to 3 decimals (4.60971 -> 4.610) is caught as well as one truncated (4.609).
  expect(leaks(`"lat":${bogota.lat.toFixed(3)},"lon":${bogota.lon.toFixed(3)}`)).toHaveLength(2);
});

test.describe('places', () => {
  test.use({ timezoneId: DEVICE_ZONE });

  test('[contract/stubbed] June with two places, a day, needs_place and an event in Bogotá, all on device', async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(600_000);
    const consoleErrors = await prepare(page);
    const origin = new URL(baseURL ?? '').origin;
    const offOrigin: string[] = [];
    const cityChunks: string[] = [];
    // Registered before the first navigation, so app boot traffic is covered too.
    page.on('request', (request) => {
      if (/\/cities\/cities-part-\d{2}\.json$/.test(new URL(request.url()).pathname)) cityChunks.push(request.url());
    });
    // Ruling 16: context level, so service-worker and worker requests count too, not only the page's.
    let serviceWorkerRequests = 0;
    page.context().on('request', (request) => {
      if (request.serviceWorker()) serviceWorkerRequests += 1;
      if (new URL(request.url()).origin !== origin) offOrigin.push(request.url());
    });
    const seen: ChatToolBody[] = [];
    const bodies: string[] = [];
    const fulfilled = new Set<string>();
    await scripted(page, PLACE_SCRIPTS, seen, bodies, fulfilled);

    await bootEngine(page);
    await seedChart(page);
    await openDashboard(page);
    // As in Journey 1: wait for the re-anchor to today, or the answer is discarded by design.
    const today = await page.evaluate(() =>
      new Intl.DateTimeFormat('en', { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date()),
    );
    await expect(page.getByTestId('provenance-footer')).toContainText(`As of ${today}`, { timeout: 120_000 });
    await waitForLifeAtlasAsOf(page);
    const keysBefore = await predictiveRequestKeys(page);
    expect(cityChunks, 'the city list must not load before a place is asked about').toEqual([]);

    await page.getByTestId('floating-chat-button').click({ timeout: 60_000 });
    const ask = async (text: string, answer: string) => {
      await page.getByTestId('chat-input').fill(text);
      await page.getByTestId('chat-send-button').click();
      await expect(page.getByTestId('chat-panel').getByText(answer, { exact: false })).toBeVisible({ timeout: 240_000 });
    };
    const lastReads = () => reads(seen[seen.length - 1]);

    await ask(SPLIT_QUESTION, SPLIT_ANSWER);
    expect(lastReads()).toHaveLength(1);
    expect(lastReads()[0]?.content).toContain('"start":"2026-06-01","end":"2026-06-30"');
    expect(lastReads()[0]?.content).not.toContain('"place_moon"');
    expect(cityChunks, 'a week or longer never loads the city list').toEqual([]);

    await ask(DAY_QUESTION, DAY_ANSWER);
    expect(lastReads()).toHaveLength(1);
    // The city was found on the device; the model gets its label and zone, and the Moon there.
    expect(lastReads()[0]?.content).toMatch(/"label":"Los Angeles, [^"]*United States"/);
    expect(lastReads()[0]?.content).toContain('"timezone":"America/Los_Angeles"');
    expect(lastReads()[0]?.content).toContain('"place_moon":{"at_start":');

    await ask(TIME_QUESTION, WHERE_QUESTION);
    expect(lastReads()[0]?.content).toContain('"status":"needs_place"');

    await ask(PLACE_REPLY, EVENT_ANSWER);
    expect(lastReads()[0]?.content).toMatch(/"label":"Bogotá, [^"]*Colombia"/);
    expect(lastReads()[0]?.content).toContain('"event":{"local_time":"15:00","lagna_sign":');

    // Every body the provider was sent (system prompt, history, tool results, all four turns).
    expect(bodies.flatMap(leaks), 'no coordinate, field name, birth place or birth-place marker may reach the model').toEqual([]);
    expect(
      offOrigin.filter((url) => !(fulfilled.has(url) && new URL(url).origin === PROVIDER_ORIGIN)),
      'no request may leave the app origin (only stubbed provider calls, fulfilled locally, are allowed)',
    ).toEqual([]);
    if (test.info().project.use.serviceWorkers === 'block') {
      // WebKit projects block the worker (see the config), so there is no
      // service-worker traffic to miss: prove none controls the page.
      const controlled = await page.evaluate(() => navigator.serviceWorker?.controller !== null && navigator.serviceWorker?.controller !== undefined);
      expect(controlled, 'with service workers blocked, no worker may control the page').toBe(false);
    } else {
      expect(serviceWorkerRequests, 'the off-origin check must see service-worker traffic too').toBeGreaterThan(0);
    }
    const cityManifest = JSON.parse(readFileSync(new URL('../src/data/cities.manifest.json', import.meta.url), 'utf8')) as { parts: number };
    expect(cityChunks, 'each bounded city part loads once for the shared SQL import').toHaveLength(cityManifest.parts);
    expect(new Set(cityChunks).size, 'later place questions reuse the imported SQL dataset').toBe(cityManifest.parts);
    expect(cityChunks.every((url) => new URL(url).origin === origin)).toBe(true);
    expect(
      (await predictiveRequestKeys(page)).slice(keysBefore.length),
      'the Life Atlas slot must keep its requestKey',
    ).toEqual([]);
    await page.screenshot({ path: PLACE_SCREENSHOT, fullPage: true });
    expect(consoleErrors, 'the journey must keep a clean console').toEqual([]);
  });
});

/**
 * Journey 2 (spec 2026-10-08, Inc D; plan Ruling 11: the shared ChatPanel, on the
 * Dashboard): ⏳ Time travel → Year 2027 (next year) → Go. The thread is pinned, survives a
 * reload, shows the badge, title, banner and future starters, and a question
 * with no dates reads that year in the future tense. Today is never pre-run.
 */
const PIN_QUESTION = 'Will work get easier?';
// Next year: 2027 when this lands (the spec's journey), and never a past year as the calendar moves.
const PIN_YEAR = String(new Date().getUTCFullYear() + 1);
const PIN_ANSWER = 'Work should get easier from spring.';
const PIN_SCREENSHOT = 'test-results/time-travel-next-year.png';

/** The pinned threads the app holds (the exit-gate hook): ids and pins only. */
async function pinnedThreads(page: Page): Promise<Array<{ id: string; as_of: unknown }>> {
  const rows = await page.evaluate(() =>
    (window as unknown as { __almameshPinnedThreads?: () => Array<{ id: string; as_of: unknown }> }).__almameshPinnedThreads?.(),
  );
  if (!rows) throw new Error('window.__almameshPinnedThreads is missing: build with VITE_EXIT_GATE_HOOKS=1');
  return rows;
}

/**
 * Contract reversed 2026-10-13 (071faf4f): with no earlier trip, "Where?" no longer starts
 * silently on the birth place. It starts empty and asks; the birth place is a suggestion the
 * person taps (or they pick a city), and Go stays disabled until then.
 */
async function confirmBirthPlaceSuggestion(page: Page, day = false): Promise<void> {
  await expect(page.getByTestId('time-travel-where-input')).toHaveValue('');
  await expect(page.getByTestId('time-travel-where-question')).toHaveText(day ? 'Where were you that day?' : 'Where were you living then?');
  await expect(page.getByTestId('time-travel-where-suggestion')).toHaveText(`Use ${DELHI_SEED.locationName} (your birth place)`);
  await expect(page.getByTestId('time-travel-go'), 'Go waits for a place').toBeDisabled();
  await page.getByTestId('time-travel-where-suggestion').click();
  await expect(page.getByTestId('time-travel-where-input')).toHaveValue(DELHI_SEED.locationName);
  await expect(page.getByTestId('time-travel-go')).toBeEnabled();
}

async function openPinnedYear(page: Page, year: string): Promise<void> {
  await page.getByTestId('time-travel-button').click();
  await expect(page.getByTestId('time-travel-sheet')).toBeVisible();
  await page.getByTestId('time-travel-tab-year').click();
  // Contract reversed 2026-10-13: every trip has a place, so "Where?" shows for a Year too.
  await expect(page.getByTestId('time-travel-where')).toBeVisible();
  await page.getByTestId('time-travel-year').selectOption(year);
  // The first trip of the profile: no earlier trip to prefill from.
  await confirmBirthPlaceSuggestion(page);
  await page.getByTestId('time-travel-go').click();
  // The banner shows from memory at once; the sheet closes only after the pin is saved (Ruling 12).
  await expect(page.getByTestId('time-travel-sheet')).toBeHidden();
  await expect(page.getByTestId('time-travel-banner')).toBeVisible();
}

/** The device zone is a zone no step names, so any appearance in a model request is the device zone leaking. */
const BANNER_380_SCREENSHOT = 'test-results/time-travel-banner-380.png';

/**
 * The banner's rendered lines at the current viewport, read glyph by glyph
 * (one Range per character), so the check sees where the browser actually
 * wrapped, not the DOM structure.
 */
async function bannerLines(page: Page, width?: number): Promise<string[]> {
  return page.getByTestId('time-travel-banner').evaluate((banner, forcedWidth) => {
    banner.style.width = forcedWidth === undefined ? '' : `${forcedWidth}px`;
    const glyphs: Array<{ char: string; top: number; left: number; height: number }> = [];
    const walker = document.createTreeWalker(banner, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const text = node.textContent ?? '';
      for (let i = 0; i < text.length; i += 1) {
        const char = text[i] ?? '';
        if (/\s/.test(char)) continue;
        const range = document.createRange();
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        const rect = range.getBoundingClientRect();
        if (rect.width > 0) glyphs.push({ char, top: rect.top, left: rect.left, height: rect.height });
      }
    }
    glyphs.sort((a, b) => a.top - b.top || a.left - b.left);
    const lines: Array<typeof glyphs> = [];
    for (const glyph of glyphs) {
      const line = lines.at(-1);
      const first = line?.[0];
      if (line !== undefined && first !== undefined && glyph.top < first.top + first.height / 2) line.push(glyph);
      else lines.push([glyph]);
    }
    banner.style.width = '';
    return lines.map((line) => line.sort((a, b) => a.left - b.left).map((g) => g.char).join(''));
  }, width);
}

/** Banner widths swept below the 380 px viewport, so every wrap point is tried whatever the font metrics. */
const BANNER_WIDTHS = Array.from({ length: 23 }, (_, i) => 340 - i * 10);

/**
 * At 380 px the banner wraps, and no wrapped line may start with a "·"
 * separator. Where a line breaks depends on the platform's font metrics, so a
 * single width can miss a separator wrap: the banner is also swept from 340 px
 * down to 120 px in 10 px steps, which puts a break before every item.
 */
async function expectBannerWrapsCleanlyAt380(page: Page): Promise<void> {
  const original = page.viewportSize();
  await page.setViewportSize({ width: 380, height: 800 });
  await expect(page.getByTestId('time-travel-banner')).toBeVisible();
  const lines = await bannerLines(page);
  expect(lines.length, `the banner wraps at 380 px: ${JSON.stringify(lines)}`).toBeGreaterThan(1);
  expect(lines.filter((line) => line.startsWith('·')), `no line starts with "·": ${JSON.stringify(lines)}`).toEqual([]);
  const separatorStarts: string[] = [];
  for (const width of BANNER_WIDTHS) {
    const swept = await bannerLines(page, width);
    if (swept.some((line) => line.startsWith('·'))) separatorStarts.push(`${width}px: ${JSON.stringify(swept)}`);
  }
  expect(separatorStarts, 'no line starts with "·" at any banner width').toEqual([]);
  await page.getByTestId('time-travel-banner').screenshot({ path: BANNER_380_SCREENSHOT });
  if (original !== null) await page.setViewportSize(original);
}

test.describe('pinned threads on a device in another zone', () => {
  test.use({ timezoneId: DEVICE_ZONE });

  test('[contract/stubbed] Time travel → next year pins a thread that reads it without dates', async ({ page }) => {
    const consoleErrors = await prepare(page);
    const seen: ChatToolBody[] = [];
    const bodies: string[] = [];
    const fulfilled = new Set<string>();
    await scripted(
      page,
      {
        // A trip reads before it answers; read_period with no place reads the trip's own place.
        [PIN_QUESTION]: (body) => stubCallFor(body, readPeriodArgs(PIN_YEAR), PIN_ANSWER),
      },
      seen,
      bodies,
      fulfilled,
    );
    await bootEngine(page);
    await seedChart(page);
    await openDashboard(page);
    const today = await page.evaluate(() =>
      new Intl.DateTimeFormat('en', { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date()),
    );
    await expect(page.getByTestId('provenance-footer')).toContainText(`As of ${today}`, { timeout: 120_000 });
    await waitForLifeAtlasAsOf(page);
    const keysBefore = await predictiveRequestKeys(page);

    await page.getByTestId('floating-chat-button').click({ timeout: 60_000 });
    await openPinnedYear(page, PIN_YEAR);
    await expect(page.getByTestId('time-travel-badge')).toHaveText('⏳');
    // Contract reversed 2026-10-13 (4869958b): the chat's period row shows the short period, with no "Time travel ·" prefix.
    await expect(page.getByTestId('time-travel-title')).toHaveText(PIN_YEAR);
    await expect(page.getByTestId('time-travel-banner')).toContainText('what your chart highlights for this period');
    await expect(page.getByRole('button', { name: 'What does my chart highlight for this time?' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Which months look strongest?' })).toBeVisible();

    // The pin was on disk before the sheet closed: a full reload keeps it.
    await explicitReload(page, () => page.reload({ waitUntil: 'domcontentloaded' }));
    await page.getByTestId('floating-chat-button').click({ timeout: 120_000 });
    // Contract reversed 2026-10-13 (4869958b): the chat's period row shows the short period, with no "Time travel ·" prefix.
    await expect(page.getByTestId('time-travel-title')).toHaveText(PIN_YEAR);
    // Contract reversed 2026-10-13: every trip has a place; with no pins it is the birth place.
    expect((await pinnedThreads(page)).map((row) => row.as_of)).toEqual([
      { start: `${PIN_YEAR}-01-01`, end: `${PIN_YEAR}-12-31`, granularity: 'year', place: expect.objectContaining({ label: DELHI_SEED.locationName, timezone: DELHI_SEED.timezone }) },
    ]);

    await page.evaluate(() => {
      const history: string[] = [];
      (window as unknown as { __agentStatusHistory: string[] }).__agentStatusHistory = history;
      new MutationObserver(() => {
        const text = document.querySelector('[data-testid="chat-agent-status"]')?.textContent;
        if (text && history.at(-1) !== text) history.push(text);
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    await page.getByTestId('chat-input').fill(PIN_QUESTION);
    await page.getByTestId('chat-send-button').click();
    await expect(page.getByTestId('chat-panel').getByText(PIN_ANSWER)).toBeVisible({ timeout: 240_000 });

    // Contract changed (chat tool layer redesign, Task 6): a trip turn must read before it may answer,
    // so round 1 offers read_period and travel only; the answer tool comes once a reading is in.
    expect(seen).toHaveLength(2);
    const [roundOne, roundTwo] = seen as [ChatToolBody, ChatToolBody];
    expect(roundOne.tool_choice).toBe('required');
    expect(toolNames(roundOne)).toEqual(['read_period', 'travel']);
    expect(toolNames(roundTwo)).toContain('answer');
    const [reading] = reads(roundTwo);
    expect(reading?.content, 'read_period with no dates is not possible: the model names the pinned year').toContain(`"start":"${PIN_YEAR}-01-01","end":"${PIN_YEAR}-12-31","granularity":"year"`);
    expect(reading?.content).toContain('"tense":"future"');
    const system = roundTwo.messages.find((m) => m.role === 'system')?.content ?? '';
    expect(system).toContain(`PINNED PERIOD: this conversation is about ${PIN_YEAR}-01-01 to ${PIN_YEAR}-12-31 (relative: future)`);
    expect(system).toContain('future tense');
    expect(system).toContain(`THIS THREAD: a trip to ${PIN_YEAR}, when the user lived in ${DELHI_SEED.locationName} (${DELHI_SEED.timezone}).`);
    const statuses = await page.evaluate(() => (window as unknown as { __agentStatusHistory: string[] }).__agentStatusHistory);
    expect(statuses.some((text) => text === `Reading ${PIN_YEAR}…`), statuses.join(' | ')).toBe(true);
    expect((await predictiveRequestKeys(page)).slice(keysBefore.length), 'the Life Atlas slot keeps its requestKey').toEqual([]);
    expect(bodies.length, 'the question reached the stubbed model').toBeGreaterThan(0);
    // Only the device zone is checked here; the trip's place (prefilled from the birth place) is a separate finding.
    expect(bodies.filter((body) => withoutNowLine(body).includes(DEVICE_ZONE)), 'the device zone reaches the model only in the NOW line').toEqual([]);
    await page.screenshot({ path: PIN_SCREENSHOT, fullPage: true });
    expect(consoleErrors, 'the journey must have no unexpected runtime or page errors').toEqual([]);
  });

  /**
   * The Day pin (spec Testing, e2e): "Where?" is required, and the city search
   * makes no request off the app origin. Then Change → Month and Back to today.
   * No coordinates reach the model. Contract reversed 2026-10-13 (plan "Place is
   * part of every trip"): "Where?" shows for every granularity and starts on the
   * birth place, and Change on a thread with messages opens a new thread.
   */
  test('[contract/stubbed] a Day pin needs a place found on the device, then Change and Back to today', async ({ page }) => {
    const consoleErrors = await prepare(page);
    const fulfilled = new Set<string>();
    const bodies: string[] = [];
    const seen: ChatToolBody[] = [];
    const DAY_ANSWER_TEXT = 'That day looks calm.';
    await scripted(
      page,
      {
        // read_period with no place reads the pinned Day at the pinned place.
        'How was that day?': (body) => stubCallFor(body, readPeriodArgs('2026-06-15'), DAY_ANSWER_TEXT),
      },
      seen,
      bodies,
      fulfilled,
    );
    await bootEngine(page);
    await seedChart(page);
    await openDashboard(page);
    const origin = new URL(page.url()).origin;
    const offOrigin: string[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).origin !== origin) offOrigin.push(request.url());
    });

    await page.getByTestId('floating-chat-button').click({ timeout: 120_000 });
    await page.getByTestId('time-travel-button').click();
    // Contract reversed 2026-10-13: "Where?" shows on Month (the default) too. Reversed again
    // (071faf4f): with no earlier trip it starts empty, asks, and offers the birth place to tap.
    await expect(page.getByTestId('time-travel-where')).toBeVisible();
    await page.getByTestId('time-travel-tab-day').click();
    await expect(page.getByTestId('time-travel-where-input')).toHaveValue('');
    await expect(page.getByTestId('time-travel-where-question')).toHaveText('Where were you that day?');
    await expect(page.getByTestId('time-travel-where-suggestion')).toHaveText(`Use ${DELHI_SEED.locationName} (your birth place)`);
    await page.getByTestId('time-travel-day').fill('2026-06-15');
    await expect(page.getByTestId('time-travel-go')).toBeDisabled();
    // Editing the place clears it until a city is picked: still required.
    await page.getByTestId('time-travel-where-input').fill('Bogotá');
    await expect(page.getByTestId('time-travel-where-required')).toBeVisible();
    await expect(page.getByTestId('time-travel-go')).toBeDisabled();
    await page.getByTestId('time-travel-where-option-0').click({ timeout: 30_000 });
    await expect(page.getByTestId('time-travel-go')).toBeEnabled();
    await page.getByTestId('time-travel-go').click();
    await expect(page.getByTestId('time-travel-banner')).toContainText('Bogotá, Colombia');
    await expectBannerWrapsCleanlyAt380(page);
    const [dayPin] = await pinnedThreads(page);
    expect(dayPin?.as_of).toMatchObject({ start: '2026-06-15', end: '2026-06-15', granularity: 'day', place: { timezone: 'America/Bogota' } });

    await page.getByTestId('chat-input').fill('How was that day?');
    await page.getByTestId('chat-send-button').click();
    await expect(page.getByTestId('chat-panel').getByText(DAY_ANSWER_TEXT)).toBeVisible({ timeout: 240_000 });

    await page.getByTestId('time-travel-change').click();
    await page.getByTestId('time-travel-tab-month').click();
    await page.getByTestId('time-travel-month').selectOption('06');
    await page.getByTestId('time-travel-month-year').selectOption('2026');
    await page.getByTestId('time-travel-go').click();
    // Contract reversed 2026-10-13 (4869958b): the chat's period row shows the short period, with no "Time travel ·" prefix.
    await expect(page.getByTestId('time-travel-title')).toHaveText('Jun 2026');
    // Contract reversed 2026-10-13: the month keeps a place (prefilled from the Day pin it
    // contains), and Change on a thread with messages opens a NEW thread: the Day thread stays.
    await expect(page.getByTestId('time-travel-banner')).toContainText('Bogotá, Colombia');
    await expect(page.getByTestId('chat-panel').getByText(DAY_ANSWER_TEXT)).toHaveCount(0);
    expect((await pinnedThreads(page)).map((row) => row.as_of)).toEqual(expect.arrayContaining([
      expect.objectContaining({ start: '2026-06-15', end: '2026-06-15', granularity: 'day' }),
      expect.objectContaining({ start: '2026-06-01', end: '2026-06-30', granularity: 'month' }),
    ]));
    // The chat banner shows the pin from memory before it is saved. The Dashboard moment is set only
    // after the save, so waiting for it pins the order: Change has landed before Back is clicked.
    await expect(page.getByTestId('dashboard-time-travel-title')).toHaveText(/June 2026/);

    await page.getByTestId('time-travel-back').click();
    await expect(page.getByTestId('time-travel-banner')).toHaveCount(0);
    expect(offOrigin.filter((url) => !fulfilled.has(url)), 'nothing may leave the app origin').toEqual([]);
    expect(bodies.length, 'the question reached the stubbed model').toBeGreaterThan(0);
    expect(bodies.flatMap(leaks), 'no coordinates reach the model').toEqual([]);
    const dayReads = seen.flatMap((request) => reads(request)).filter((result) => /Bogot/.test(result.content));
    expect(dayReads.length, 'read_period read the pinned Day at the pinned place').toBeGreaterThan(0);
    const COORDINATES = /4\.6097|-?74\.0817|latitude|longitude/i;
    expect(dayReads.filter((result) => COORDINATES.test(result.content)), 'the tool result carries the place label, not its coordinates').toEqual([]);
    expect(bodies.filter((body) => COORDINATES.test(body)), 'no model request body carries coordinates').toEqual([]);
    expect(bodies.some((body) => body.includes('Bogot')), 'the place label reaches the model').toBe(true);
    expect(consoleErrors, 'the journey must keep a clean console').toEqual([]);
  });
});

/**
 * Delay every message the page posts to a Worker that names the chat store's
 * row, by `window.__chatWriteDelayMs` (0 = off). That is the slow save of a
 * busy device: the pin is in memory at once, on disk seconds later. Nothing
 * else is delayed, and the delay is switched on only after boot.
 */
async function slowChatWrites(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __chatWriteDelayMs: number; __chatWritesDelayed: number };
    w.__chatWriteDelayMs = 0;
    w.__chatWritesDelayed = 0;
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (this: Worker, ...args: Parameters<Worker['postMessage']>) {
      let named = false;
      if (w.__chatWriteDelayMs > 0) {
        try {
          named = JSON.stringify(args[0]).includes('almamesh-chat-history');
        } catch {
          named = false;
        }
      }
      if (!named) return post.apply(this, args);
      w.__chatWritesDelayed += 1;
      setTimeout(() => post.apply(this, args), w.__chatWriteDelayMs);
      return undefined;
    } as Worker['postMessage'];
  });
}

test.describe('Change then Back to today while the pin is still saving', () => {
  test.use({ timezoneId: DEVICE_ZONE });
  const SLOW_SAVE_MS = 4_000;
  const HELLO = 'Say hello to me.';

  test('[contract/stubbed] a slow Change save landing after Back to today moves nothing', async ({ page }) => {
    const consoleErrors = await prepare(page);
    await slowChatWrites(page);
    await scripted(page, { [HELLO]: () => ({ name: 'answer', args: generalAnswer('Hello.') }) }, [], [], new Set<string>());
    await bootEngine(page);
    await seedChart(page);
    await openDashboard(page);
    await page.getByTestId('floating-chat-button').click({ timeout: 120_000 });
    // An ordinary unpinned thread: Back to today will find it without waiting on any save.
    await page.getByTestId('chat-input').fill(HELLO);
    await page.getByTestId('chat-send-button').click();
    await expect(page.getByTestId('chat-panel').getByText('Hello.', { exact: true })).toBeVisible({ timeout: 240_000 });
    await openPinnedYear(page, PIN_YEAR);

    await page.evaluate((ms) => ((window as unknown as { __chatWriteDelayMs: number }).__chatWriteDelayMs = ms), SLOW_SAVE_MS);
    await page.getByTestId('time-travel-change').click();
    await page.getByTestId('time-travel-tab-month').click();
    await page.getByTestId('time-travel-month').selectOption('06');
    await page.getByTestId('time-travel-month-year').selectOption('2026');
    await page.getByTestId('time-travel-go').click();
    // In memory at once, on disk in SLOW_SAVE_MS: press Back inside that window.
    // Contract reversed 2026-10-13 (4869958b): the chat's period row shows the short period, with no "Time travel ·" prefix.
    await expect(page.getByTestId('time-travel-title')).toHaveText('Jun 2026');
    await page.getByTestId('time-travel-back').click();
    await expect(page.getByTestId('time-travel-banner')).toHaveCount(0);

    // Let the slow save land, then require the Change not to have been re-applied.
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __chatWritesDelayed: number }).__chatWritesDelayed))
      .toBeGreaterThan(0);
    await page.waitForTimeout(SLOW_SAVE_MS + 2_000);
    await expect(page.getByTestId('time-travel-banner'), 'the slow Change must not re-pin the thread').toHaveCount(0);
    await expect(page.getByTestId('dashboard-time-travel-banner')).toHaveCount(0);
    await expect(page.getByTestId('dashboard-time-travel-title')).toHaveCount(0);
    expect(consoleErrors, 'the journey must keep a clean console').toEqual([]);
  });
});

/**
 * The iPhone (iphone-webkit project only). iOS is always the minimal device tier
 * (packages/browser/src/deviceTier.ts), whatever navigator reports, so the
 * Day and place controls are available with bounded SQLite-backed queries.
 * Month and Year remain available too. Pin next year, keep it across a
 * reload, ask a question with no dates, and the banner wraps cleanly at 380 px.
 */
test.describe('time travel on an iPhone', () => {
  test.use({ timezoneId: DEVICE_ZONE });

  test('[contract/stubbed] @iphone offers Day, Month and Year, pins next year and reads it without dates', async ({ page }) => {
    const consoleErrors = await prepare(page);
    const seen: ChatToolBody[] = [];
    const bodies: string[] = [];
    const fulfilled = new Set<string>();
    await scripted(
      page,
      {
        // A trip reads before it answers; read_period with no place reads the trip's own place.
        [PIN_QUESTION]: (body) => stubCallFor(body, readPeriodArgs(PIN_YEAR), PIN_ANSWER),
      },
      seen,
      bodies,
      fulfilled,
    );
    await bootEngine(page);
    await seedChart(page);
    await openDashboard(page);

    await page.getByTestId('floating-chat-button').click({ timeout: 120_000 });
    await page.getByTestId('time-travel-button').click();
    await expect(page.getByTestId('time-travel-sheet')).toBeVisible();
    await expect(page.getByTestId('time-travel-tab-month')).toBeVisible();
    await expect(page.getByTestId('time-travel-tab-year')).toBeVisible();
    await expect(page.getByTestId('time-travel-tab-day'), 'Day is available on iOS').toBeVisible();
    await page.getByTestId('time-travel-tab-year').click();
    await page.getByTestId('time-travel-year').selectOption(PIN_YEAR);
    await confirmBirthPlaceSuggestion(page);
    await page.getByTestId('time-travel-go').click();
    await expect(page.getByTestId('time-travel-sheet')).toBeHidden();
    // Contract reversed 2026-10-13 (4869958b): the chat's period row shows the short period, with no "Time travel ·" prefix.
    await expect(page.getByTestId('time-travel-title')).toHaveText(PIN_YEAR);
    await expect(page.getByTestId('time-travel-banner')).toContainText('what your chart highlights for this period');

    // The pin was on disk before the sheet closed: a full reload keeps it.
    await explicitReload(page, () => page.reload({ waitUntil: 'domcontentloaded' }));
    await page.getByTestId('floating-chat-button').click({ timeout: 120_000 });
    // Contract reversed 2026-10-13 (4869958b): the chat's period row shows the short period, with no "Time travel ·" prefix.
    await expect(page.getByTestId('time-travel-title')).toHaveText(PIN_YEAR);
    // Contract reversed 2026-10-13: every trip has a place; with no pins it is the birth place.
    expect((await pinnedThreads(page)).map((row) => row.as_of)).toEqual([
      { start: `${PIN_YEAR}-01-01`, end: `${PIN_YEAR}-12-31`, granularity: 'year', place: expect.objectContaining({ label: DELHI_SEED.locationName, timezone: DELHI_SEED.timezone }) },
    ]);

    await page.getByTestId('chat-input').fill(PIN_QUESTION);
    await page.getByTestId('chat-send-button').click();
    await expect(page.getByTestId('chat-panel').getByText(PIN_ANSWER)).toBeVisible({ timeout: 240_000 });
    // The minimal tier has the same two tools; a trip reads before it answers.
    expect(seen).toHaveLength(2);
    expect(toolNames(seen[0]!)).toEqual(['read_period', 'travel']);
    expect(reads(seen[1])[0]?.content).toContain(`"start":"${PIN_YEAR}-01-01","end":"${PIN_YEAR}-12-31","granularity":"year"`);
    expect(bodies.filter((body) => withoutNowLine(body).includes(DEVICE_ZONE)), 'the device zone reaches the model only in the NOW line').toEqual([]);

    await expectBannerWrapsCleanlyAt380(page);
    expect(consoleErrors, 'the journey must have no unexpected runtime or page errors').toEqual([]);
  });
});

/**
 * Desktop Safari as it ships: no tier pin. Safari has no navigator.deviceMemory,
 * so the app reads it as the lite tier. Day, Month and Year are available. WebKit project only (@safari).
 */
test.describe("desktop Safari's own device tier", () => {
  test('[contract/stubbed] @safari offers Day on the lite tier; a Year pin still works', async ({ page }) => {
    const consoleErrors = captureConsole(page);
    await configureStubbedAi(page);
    await bootEngine(page);
    expect(await page.evaluate(() => 'deviceMemory' in navigator), 'Safari reports no deviceMemory').toBe(false);
    await seedChart(page);
    await openDashboard(page);

    await page.getByTestId('floating-chat-button').click({ timeout: 120_000 });
    await page.getByTestId('time-travel-button').click();
    await expect(page.getByTestId('time-travel-sheet')).toBeVisible();
    await expect(page.getByTestId('time-travel-tab-month')).toBeVisible();
    await expect(page.getByTestId('time-travel-tab-day'), 'Day is available on desktop Safari').toBeVisible();
    await page.getByTestId('time-travel-tab-year').click();
    await page.getByTestId('time-travel-year').selectOption(PIN_YEAR);
    await confirmBirthPlaceSuggestion(page);
    await page.getByTestId('time-travel-go').click();
    await expect(page.getByTestId('time-travel-sheet')).toBeHidden();
    // Contract reversed 2026-10-13 (4869958b): the chat's period row shows the short period, with no "Time travel ·" prefix.
    await expect(page.getByTestId('time-travel-title')).toHaveText(PIN_YEAR);
    // Contract reversed 2026-10-13: every trip has a place; with no pins it is the birth place.
    expect((await pinnedThreads(page)).map((row) => row.as_of)).toEqual([
      { start: `${PIN_YEAR}-01-01`, end: `${PIN_YEAR}-12-31`, granularity: 'year', place: expect.objectContaining({ label: DELHI_SEED.locationName, timezone: DELHI_SEED.timezone }) },
    ]);
    expect(consoleErrors, 'the journey must keep a clean console').toEqual([]);
  });
});

/**
 * Off-origin URLs the controlling service worker has fetched, from its own
 * Resource Timing record. Playwright WebKit does not report requests a service
 * worker sends, so a `context.on('request')` check is blind to them; the
 * worker's own record is not. The probe (sw-egress-probe.js) exists only in
 * hooked builds (VITE_EXIT_GATE_HOOKS=1); with no answer this throws.
 */
async function serviceWorkerOffOrigin(page: Page, origin: string): Promise<string[]> {
  const names = await serviceWorkerFetches(page);
  // Not vacuous: the worker's precache fetches are same-origin and must be on record.
  expect(names.length, 'the egress probe saw the service worker fetch').toBeGreaterThan(0);
  return names.filter((name) => new URL(name).origin !== origin);
}

/** Every URL the controlling service worker has fetched (see serviceWorkerOffOrigin). */
async function serviceWorkerFetches(page: Page): Promise<string[]> {
  const names = await page.evaluate(
    () =>
      new Promise<string[]>((resolve, reject) => {
        const worker = navigator.serviceWorker.controller;
        if (worker === null) {
          reject(new Error('no service worker controls the page'));
          return;
        }
        const channel = new MessageChannel();
        const timer = setTimeout(
          () => reject(new Error('the service worker egress probe did not answer: build with VITE_EXIT_GATE_HOOKS=1')),
          10_000,
        );
        channel.port1.onmessage = (event: MessageEvent<string[]>) => {
          clearTimeout(timer);
          resolve(event.data);
        };
        worker.postMessage({ type: 'almamesh:egress-probe' }, [channel.port2]);
      }),
  );
  return names;
}

/**
 * The app as a visitor gets it: the service worker active, AI off, and nothing
 * stubbed or routed. The WebKit projects block the worker for the stubbed
 * journeys (Playwright cannot route through it); this journey turns it back on
 * and needs no routing, so it drives Safari's real setup. With AI off nothing
 * may leave the app origin: the page's requests are read from Playwright, the
 * service worker's own from its Resource Timing record (serviceWorkerOffOrigin).
 * The Dashboard moment journey (Time travel with AI off) runs inside it, so the
 * egress checks cover it too. Runs on every project but the iPhone 15 (@sw is
 * included on the iPhone 13).
 */
test.describe('as shipped: service worker on, AI off, nothing stubbed', () => {
  test.use({ serviceWorkers: 'allow' });

  test('[contract/real] @sw nothing leaves the app origin, service-worker traffic included, with AI off', async ({ page, baseURL }, testInfo) => {
    const consoleErrors = captureConsole(page);
    type Phase = 'boot' | 'restore' | 'openDashboard' | 'SWready' | 'SWnavigation' | 'waitengine' | 'chat' | 'month' | 'finalasserts';
    let phase: Phase = 'boot';
    const started = Date.now();
    const events: Array<Record<string, unknown>> = [];
    const record = (event: string, detail: Record<string, unknown> = {}): void => {
      const at = Date.now();
      events.push({ sequence: events.length + 1, at: new Date(at).toISOString(), elapsedMs: at - started,
        phase, event, observedPageUrlAtReceipt: page.url(), ...detail });
    };
    const enterPhase = (next: Phase): void => { phase = next; record('phase-start'); };
    const onConsole = (message: ConsoleMessage): void => {
      if (message.type() === 'error' || message.text().startsWith('[almamesh] engine')) {
        record('console', { type: message.type(), text: message.text(), location: message.location() });
      }
    };
    const onPageError = (error: Error): void => { record('pageerror', { text: error.message, stack: error.stack }); };
    const onNavigation = (frame: Frame): void => {
      if (frame === page.mainFrame()) record('main-frame-framenavigated', { frameUrl: frame.url() });
    };
    const workerCloseListeners = new Map<PlaywrightWorker, () => void>();
    const onWorker = (worker: PlaywrightWorker): void => {
      const workerId = workerCloseListeners.size + 1;
      record('worker-created', { workerId, workerUrl: worker.url() });
      const onClose = (): void => { record('worker-closed', { workerId, workerUrl: worker.url() }); };
      workerCloseListeners.set(worker, onClose);
      worker.on('close', onClose);
    };
    page.on('console', onConsole);
    page.on('pageerror', onPageError);
    page.on('framenavigated', onNavigation);
    page.on('worker', onWorker);
    let bodyCompleted = false;
    try {
      const origin = new URL(baseURL ?? '').origin;
      const pageOffOrigin: string[] = [];
      page.context().on('request', (request) => {
        const url = new URL(request.url());
        if (url.protocol.startsWith('http') && url.origin !== origin) pageOffOrigin.push(request.url());
      });
      enterPhase('boot');
      await bootEngine(page);
      enterPhase('restore');
      await seedChart(page);
      enterPhase('openDashboard');
      await openDashboard(page);
      enterPhase('SWready');
      // Wait on the registration itself, not a bare race on `ready`: each install
      // state lands in sw-engine-lifecycle.json, and a worker that never activates
      // fails here with its state and its own fetch record (main faa795aa: an
      // iPhone run's worker registered and never activated, and the bare race
      // could only say "the service worker controls the page: false").
      await waitForServiceWorkerActive(pageServiceWorkerReader(page), {
        timeoutMs: 60_000, pollMs: 250, onState: (state) => { record('sw-state', { ...state }); },
      });
      enterPhase('SWnavigation');
      // A fresh navigation now goes through the active worker.
      await gotoSettled(page, '/dashboard');
      expect(await page.evaluate(() => navigator.serviceWorker.controller !== null), 'the service worker controls the page').toBe(true);
      enterPhase('waitengine');
      await waitForEngineReady(page);
      await expect(page.getByTestId('provenance-footer')).toContainText('As of', { timeout: 120_000 });

      enterPhase('chat');
      await page.getByTestId('floating-chat-button').click({ timeout: 120_000 });
      await expect(page.getByTestId('chat-connect-ai')).toBeVisible();
      await expect(page.getByTestId('time-travel-button'), 'no AI, no Time travel in the composer').toHaveCount(0);
      await page.getByTestId('floating-chat-close').click();
      enterPhase('month');
      await expect(page.getByTestId(DASHBOARD_BUTTON), 'Time travel works without AI').toBeEnabled();
      await pickMonth(page, '2019-03');
      await expect(page.getByTestId('time-travel-moment-maha')).toBeVisible();
      await expect(page.getByTestId('time-travel-moment-card')).toBeVisible();
      await expect(page.getByTestId('time-travel-moment-transits')).toBeVisible({ timeout: 180_000 });
      await page.waitForLoadState('networkidle');

      enterPhase('finalasserts');
      expect(await serviceWorkerOffOrigin(page, origin), 'with AI off, the service worker requests only the app origin').toEqual([]);
      expect(pageOffOrigin, 'with AI off, the page requests only the app origin').toEqual([]);
      expect(consoleErrors, 'the journey must keep a clean console').toEqual([]);
      bodyCompleted = true;
    } finally {
      record('capture-finished', { bodyCompleted });
      page.off('console', onConsole);
      page.off('pageerror', onPageError);
      page.off('framenavigated', onNavigation);
      page.off('worker', onWorker);
      for (const [worker, onClose] of workerCloseListeners) worker.off('close', onClose);
      const path = testInfo.outputPath('sw-engine-lifecycle.json');
      writeFileSync(path, JSON.stringify({
        notes: [
          'observedPageUrlAtReceipt is the page URL when the event arrived, not proof of its source document or Worker.',
          'main-frame-framenavigated includes same-document navigation; Worker events cover only Workers exposed by Playwright.',
        ],
        bodyCompleted, events,
      }, null, 2));
      await testInfo.attach('sw-engine-lifecycle', { path, contentType: 'application/json' });
    }
  });
});

/**
 * Dashboard time travel (spec 2026-10-10, PR A): the Dashboard's own Time travel
 * button, with or without AI. March 2019 is a known boundary for DELHI_BIRTH
 * (plan ruling 5, re-derived from the engine CLI on 2026-10-10): Rahu maha
 * 2017-05-13 → 2035-05-14, Rahu antar 2017-05-13 → 2020-01-24. Today (October
 * 2026) is Rahu/Mercury, so a card computed for today fails the antar check.
 */
const MARCH_2019_MAHA = 'Rahu';
const MARCH_2019_ANTAR = 'Rahu';
const DASHBOARD_BUTTON = 'dashboard-time-travel-button';
/**
 * Slow planets for March 2019 (sidereal, Lahiri), re-derived from the engine CLI on
 * 2026-10-10 for 1 and 31 March 2019. Saturn was in Sagittarius from January 2017
 * to January 2020 and Jupiter left Libra in October 2018, so a table computed for
 * today (Saturn in Pisces, Jupiter in Cancer) or a year either side fails one of them.
 */
const MARCH_2019_SIGNS = { Saturn: 'Sagittarius', Jupiter: 'Scorpio' } as const;

/** The sign cell of one graha's row in the moment card's transits table. */
function momentSignCell(page: Page, graha: string): Locator {
  return page
    .getByTestId('time-travel-moment-transits')
    .getByTestId('gochara-table')
    .getByRole('row')
    .filter({ has: page.getByRole('cell', { name: graha, exact: true }) })
    .getByRole('cell')
    .nth(1);
}

/** Open the Dashboard sheet, pick a `YYYY-MM` month and go; the sheet closes. */
async function pickMonth(page: Page, month: string): Promise<void> {
  await page.getByTestId(DASHBOARD_BUTTON).click();
  await page.getByTestId('time-travel-tab-month').click();
  await page.getByTestId('time-travel-month').selectOption(month.slice(5));
  await page.getByTestId('time-travel-month-year').selectOption(month.slice(0, 4));
  await confirmBirthPlaceSuggestion(page);
  await page.getByTestId('time-travel-go').click();
  await expect(page.getByTestId('time-travel-sheet')).toBeHidden();
}

/** Pin a full-tier device without the stubbed AI settings (AI stays off). */
async function pinFullTier(page: Page): Promise<void> {
  await page.addInitScript((tier) => {
    for (const [name, value] of Object.entries(tier)) {
      Object.defineProperty(Navigator.prototype, name, { get: () => value, configurable: true });
    }
  }, FULL_TIER);
}


/**
 * The engine's last supported year (backend EPHEMERIS_LAST_INSTANT, 2053-01-01 exclusive). A year the
 * sheet offers must compute: 2051 and 2052 once failed with a bare "failed" because Saturn's
 * look-ahead read DE421 past its end. Literal on purpose: it guards the sheet's range, not itself.
 */
const LAST_YEAR = '2052';
const PAST_LAST_YEAR = '2053';

/** Open the Dashboard sheet and read the Year selector's options; the sheet stays open. */
async function openYearOptions(page: Page): Promise<string[]> {
  await page.getByTestId(DASHBOARD_BUTTON).click();
  await page.getByTestId('time-travel-tab-year').click();
  return page.getByTestId('time-travel-year').locator('option').evaluateAll((options) =>
    options.map((option) => (option as HTMLOptionElement).value),
  );
}

async function goToLastYear(page: Page): Promise<void> {
  await page.getByTestId('time-travel-year').selectOption(LAST_YEAR);
  await confirmBirthPlaceSuggestion(page);
  await page.getByTestId('time-travel-go').click();
  await expect(page.getByTestId('time-travel-sheet')).toBeHidden();
  await expect(page.getByTestId('dashboard-time-travel-title')).toHaveText(new RegExp(LAST_YEAR));
}

test.describe('Dashboard time travel', () => {
  test('[contract/real] with AI off, desktop: the button opens the sheet and March 2019 shows its dashas and transits', async ({ page }, testInfo) => {
    const consoleErrors = captureConsole(page);
    await pinFullTier(page);
    await bootEngine(page);
    await seedChart(page);
    await openDashboard(page);
    const button = page.getByTestId(DASHBOARD_BUTTON);
    await expect(button).toBeVisible();
    await expect(button.getByText('Time travel', { exact: true })).toBeVisible();
    await expect(button).toBeEnabled();
    // Mouse first, from nothing focused: a WebKit click never focuses a button, so
    // the Dashboard must return focus itself.
    await expect(button).not.toBeFocused();
    await button.click();
    await expect(page.getByTestId('time-travel-sheet')).toBeVisible();
    await expect(page.getByTestId('time-travel-sheet'), 'the Dashboard sheet speaks for the Dashboard').toContainText(
      'The Dashboard will show that moment.',
    );
    await page.getByTestId('time-travel-cancel').click();
    await expect(page.getByTestId('time-travel-sheet')).toBeHidden();
    await expect(button, 'a click then Cancel returns focus to the button').toBeFocused();
    // Then the keyboard: Enter opens, Escape closes, focus comes back.
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('time-travel-sheet')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('time-travel-sheet')).toBeHidden();
    await expect(button, 'Escape returns focus to the button').toBeFocused();
    await pickMonth(page, '2019-03');
    await expect(page.getByTestId('dashboard-time-travel-title')).toHaveText(/March 2019/);
    await expect(page.getByTestId('time-travel-moment-maha')).toHaveText(MARCH_2019_MAHA);
    await expect(page.getByTestId('time-travel-moment-antar')).toHaveText(MARCH_2019_ANTAR);
    await expect(page.getByTestId('time-travel-moment-transits')).toBeVisible({ timeout: 180_000 });
    for (const [graha, sign] of Object.entries(MARCH_2019_SIGNS)) {
      await expect(momentSignCell(page, graha), `${graha} in March 2019`).toHaveText(sign);
    }
    await expect(page.getByTestId('dashboard-today-label-life-atlas')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('dashboard-march-2019-desktop.png'), fullPage: true });
    await page.getByTestId('dashboard-time-travel-change').click();
    await expect(page.getByTestId('time-travel-month')).toHaveValue('03');
    await page.getByTestId('time-travel-cancel').click();
    await page.getByTestId('dashboard-time-travel-back').click();
    await expect(page.getByTestId('dashboard-time-travel-banner')).toHaveCount(0);
    await expect(page.getByTestId('time-travel-moment-card')).toHaveCount(0);
    expect(consoleErrors, 'the journey must keep a clean console').toEqual([]);
  });

  test('[contract/real] the last supported year computes its sky, and the year after it is not offered', async ({ page }) => {
    const consoleErrors = captureConsole(page);
    await pinFullTier(page);
    await bootEngine(page);
    await seedChart(page);
    await openDashboard(page);
    const years = await openYearOptions(page);
    expect(years.at(-1), 'the sheet ends at the engine range').toBe(LAST_YEAR);
    expect(years, 'the year after the engine range is never offered').not.toContain(PAST_LAST_YEAR);
    await goToLastYear(page);
    await expect(page.getByTestId('time-travel-moment-transits'), 'the last year computes a sky, not a failure').toBeVisible({ timeout: 180_000 });
    await expect(page.getByTestId('time-travel-moment-failed')).toHaveCount(0);
    expect(consoleErrors, 'the journey must keep a clean console').toEqual([]);
  });

  test("[contract/real] Back to today shows today's Life Atlas at once: the moment never evicted it", async ({ page }) => {
    const consoleErrors = captureConsole(page);
    await pinFullTier(page);
    await bootEngine(page);
    await seedChart(page);
    await openDashboard(page);
    // The history starts with '(none)' (the empty slot); wait for today's computed reading.
    await expect
      .poll(async () => (await predictiveRequestKeys(page)).slice(-1)[0], { timeout: 180_000 })
      .not.toBe('(none)');
    await waitForLifeAtlasAsOf(page);
    const keysBefore = await predictiveRequestKeys(page);
    await pickMonth(page, '2019-03');
    await expect(page.getByTestId('time-travel-moment-transits')).toBeVisible({ timeout: 180_000 });
    await page.getByTestId('dashboard-time-travel-back').click();
    await expect(page.getByTestId('time-travel-moment-card')).toHaveCount(0);
    await expect(page.getByTestId('life-atlas').getByText(/^As of /), "today's Life Atlas shows at once").toBeVisible({
      timeout: 5_000,
    });
    expect(
      (await predictiveRequestKeys(page)).slice(keysBefore.length),
      'no second Life Atlas compute after Back to today',
    ).toEqual([]);
    expect(consoleErrors, 'the journey must keep a clean console').toEqual([]);
  });

  test('[contract/real] a reload returns the Dashboard to today: the moment is never persisted', async ({ page }, testInfo) => {
    await withReloadJourneyDiagnostics(page, testInfo, async (diagnostics) => {
      const consoleErrors = captureConsole(page);
      await pinFullTier(page);
      diagnostics.phase('engine-boot');
      await bootEngine(page);
      diagnostics.phase('chart-seed');
      await seedChart(page);
      diagnostics.phase('dashboard-open');
      await openDashboard(page);
      diagnostics.phase('period-open');
      await pickMonth(page, '2019-03');
      await expect(page.getByTestId('dashboard-time-travel-banner')).toBeVisible();
      await expect(page.getByTestId('time-travel-moment-card')).toBeVisible();
      diagnostics.phase('period-visible');
      diagnostics.phase('reload-start');
      await explicitReload(page, () => page.reload());
      diagnostics.phase('reload-complete');
      // Settled: the chart and profile are back, so a persisted moment would render now.
      await expect(page.getByTestId(DASHBOARD_BUTTON)).toBeEnabled({ timeout: 180_000 });
      await expect(page.getByTestId('life-atlas')).toBeVisible();
      diagnostics.phase('dashboard-ready');
      await expect(page.getByTestId('dashboard-time-travel-banner'), 'spec ruling 1: a reload returns to today').toHaveCount(0);
      await expect(page.getByTestId('time-travel-moment-card')).toHaveCount(0);
      await expect(page.getByTestId('dashboard-today-label-life-atlas')).toHaveCount(0);
      expect(consoleErrors, 'the journey must have no unexpected runtime or page errors').toEqual([]);
      diagnostics.phase('verified');
    });
  });

  test('[contract/stubbed] with AI on, Go from the Dashboard also opens a pinned chat thread', async ({ page }) => {
    const consoleErrors = await prepare(page);
    await bootEngine(page);
    await seedChart(page);
    await openDashboard(page);
    await pickMonth(page, '2019-03');
    await expect(page.getByTestId('dashboard-time-travel-title')).toHaveText(/March 2019/);
    await page.getByTestId('floating-chat-button').click();
    // Contract reversed 2026-10-13 (4869958b): the chat's period row shows the short period, with no "Time travel ·" prefix.
    await expect(page.getByTestId('time-travel-title')).toHaveText('Mar 2019');
    expect((await pinnedThreads(page)).length).toBe(1);
    expect(consoleErrors, 'the journey must keep a clean console').toEqual([]);
  });
});

test.describe('Dashboard time travel on an iPhone 15', () => {
  test('[contract/real] @iphone15 the button reads "Time travel", is at least 44×44, and with AI off shows dashas and transits', async ({ page }, testInfo) => {
    const consoleErrors = captureConsole(page);
    await bootEngine(page);
    await seedChart(page);
    await openDashboard(page);
    const button = page.getByTestId(DASHBOARD_BUTTON);
    await expect(button).toBeVisible();
    await expect(button.getByText('Time travel', { exact: true })).toBeVisible();
    const box = await button.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: testInfo.outputPath('dashboard-button-iphone15.png') });

    // WebKit does not focus a button on tap; the Dashboard returns focus itself.
    await button.tap();
    await expect(page.getByTestId('time-travel-sheet')).toBeVisible();
    await page.getByTestId('time-travel-cancel').tap();
    await expect(page.getByTestId('time-travel-sheet')).toBeHidden();
    await expect(button, 'a tap then Cancel returns focus to the button').toBeFocused();

    await pickMonth(page, '2019-03');
    await expect(page.getByTestId('dashboard-time-travel-title')).toHaveText(/March 2019/);
    await expect(page.getByTestId('time-travel-moment-maha')).toHaveText(MARCH_2019_MAHA);
    // Today is Rahu/Mercury: the antar is what proves the card is for March 2019.
    await expect(page.getByTestId('time-travel-moment-antar')).toHaveText(MARCH_2019_ANTAR);
    await expect(page.getByTestId('time-travel-moment-transits')).toBeVisible({ timeout: 180_000 });
    // The banner's Change and Back to today are thumb-sized too.
    for (const testId of ['dashboard-time-travel-change', 'dashboard-time-travel-back']) {
      const target = await page.getByTestId(testId).boundingBox();
      expect(target?.width ?? 0, `${testId} width`).toBeGreaterThanOrEqual(44);
      expect(target?.height ?? 0, `${testId} height`).toBeGreaterThanOrEqual(44);
    }
    await page.getByTestId('dashboard-time-travel-banner').screenshot({ path: testInfo.outputPath('dashboard-banner-iphone15.png') });
    await page.screenshot({ path: testInfo.outputPath('dashboard-march-2019-iphone15.png'), fullPage: true });
    expect(consoleErrors, 'the journey must keep a clean console').toEqual([]);
  });
  test('[contract/real] @iphone15 the last supported year gives a moment card, and the year after it is not offered', async ({ page }) => {
    const consoleErrors = captureConsole(page);
    await bootEngine(page);
    await seedChart(page);
    await openDashboard(page);
    const years = await openYearOptions(page);
    expect(years.at(-1), 'the sheet ends at the engine range').toBe(LAST_YEAR);
    expect(years, 'the year after the engine range is never offered').not.toContain(PAST_LAST_YEAR);
    await goToLastYear(page);
    await expect(page.getByTestId('time-travel-moment-card')).toBeVisible();
    await expect(page.getByTestId('time-travel-moment-failed')).toHaveCount(0);
    await expect(page.getByTestId('time-travel-moment-transits')).toBeVisible({ timeout: 180_000 });
    expect(consoleErrors, 'the journey must keep a clean console').toEqual([]);
  });
});


async function pickDashboardDay(page: Page, day: string): Promise<void> {
  await page.getByTestId('dashboard-time-travel-button').click();
  await page.getByTestId('time-travel-tab-day').click();
  await page.getByTestId('time-travel-day').fill(day);
  await page.getByTestId('time-travel-where-input').fill('Bogotá');
  await page.getByTestId('time-travel-where-option-0').click({ timeout: 120_000 });
  await page.getByTestId('time-travel-go').click();
  await expect(page.getByTestId('time-travel-sheet')).toBeHidden();
  await expect(page.getByTestId('time-travel-moment-transits')).toBeVisible({ timeout: 240_000 });
  await expect(page.getByTestId('dashboard-time-travel-banner')).toContainText('Bogotá');
}

async function periodEngineCalls(page: Page): Promise<number> {
  return page.evaluate(() => {
    const read = (window as unknown as { __almameshPeriodEngineCalls?: () => number }).__almameshPeriodEngineCalls;
    if (!read) throw new Error('Period engine call hook missing');
    return read();
  });
}

for (const tag of ['', '@iphone', '@iphone15', '@safari']) {
  test(`[contract/real] ${tag} Day and place revisit reads SQLite; Back to today restores Life Atlas`, async ({ page }, testInfo) => {
    const errors = captureConsole(page);
    await bootEngine(page);
    await seedChart(page);
    await openDashboard(page);
    await waitForLifeAtlasAsOf(page);
    const atlasKeys = await predictiveRequestKeys(page);
    const before = await periodEngineCalls(page);
    await pickDashboardDay(page, '2019-03-14');
    await expect(page.getByTestId('time-travel-moment-dasha')).toBeVisible();
    expect(await periodEngineCalls(page)).toBeGreaterThan(before);
    await page.screenshot({ path: testInfo.outputPath('day-bogota.png'), fullPage: true });
    await pickDashboardDay(page, '2019-03-15');
    const calls = await periodEngineCalls(page);
    await pickDashboardDay(page, '2019-03-14');
    expect(await periodEngineCalls(page), 'revisiting the evicted period reads SQLite without the engine').toBe(calls);
    await page.getByTestId('dashboard-time-travel-back').click();
    await expect(page.getByTestId('dashboard-time-travel-banner')).toHaveCount(0);
    await expect(page.getByTestId('time-travel-moment-card')).toHaveCount(0);
    await expect(page.getByTestId('life-atlas').getByText(/^As of /)).toBeVisible({ timeout: 5_000 });
    expect((await predictiveRequestKeys(page)).slice(atlasKeys.length), 'travel never replaces today’s Life Atlas').toEqual([]);
    expect(errors, 'the Day journey has a clean console').toEqual([]);
  });
}

for (const tag of ['', '@iphone15']) {
  test(`[contract/real] ${tag} two open tabs share the city database without retaining its owner`, async ({ page }) => {
    const errors = captureConsole(page);
    const partRequests: string[] = [];
    page.context().on('request', (request) => {
      if (request.serviceWorker() === null && /\/cities\/cities-part-\d{2}\.json$/.test(new URL(request.url()).pathname)) partRequests.push(request.url());
    });
    const lookup = async (target: Page) => {
      await target.waitForFunction(() => typeof (window as unknown as { __almameshResolvePlace?: unknown }).__almameshResolvePlace === 'function');
      return target.evaluate(async () => {
        const resolve = (window as unknown as { __almameshResolvePlace: (query: string) => Promise<unknown> }).__almameshResolvePlace;
        return resolve('Bogotá');
      });
    };
    await bootEngine(page);
    const first = await lookup(page);
    expect(first).toMatchObject({ status: 'found' });
    expect(partRequests).toHaveLength(25);
    const other = await page.context().newPage();
    const otherErrors = captureConsole(other);
    try {
      await bootEngine(other);
      expect(await lookup(other), 'the first tab stays alive while the second reads the same SQLite database').toEqual(first);
      expect(await lookup(page), 'ownership returns to the first tab for another session').toEqual(first);
      expect(partRequests, 'other tabs query the imported rows instead of importing again').toHaveLength(25);
    } finally {
      await other.close();
    }
    expect([...errors, ...otherErrors]).toEqual([]);
  });

  test(`[contract/stubbed] ${tag} September 2017 grounds itself through its tools and outlook today escapes the old pin`, async ({ page }, testInfo) => {
    const errors = await prepare(page);
    const modelDownloads = captureLocalModelDownloads(page);
    const seen: ChatToolBody[] = [];
    const pastQuestion = 'this was a challenging time what do you think happened';
    const todayQuestion = 'outlook today?';
    const todayDay = new Intl.DateTimeFormat('en-CA').format(new Date());
    await scripted(page, {
      // A trip turn reads before it answers: September 2017 with the trip's own place.
      [pastQuestion]: (body) => stubCallFor(body, readPeriodArgs('2017-09'), 'The September timing can describe pressure, but cannot name the events of your life.'),
      // "Today" inside the trip: the model names today, and the read is today's, not the trip's.
      [todayQuestion]: (body) => stubCallFor(body, readPeriodArgs(todayDay), 'Here is the outlook for today using the calculated timing.'),
    }, seen, [], new Set<string>());
    await bootEngine(page);
    await seedChart(page);
    await openDashboard(page);
    await waitForLifeAtlasAsOf(page);
    await page.getByTestId('floating-chat-button').click();
    await page.getByTestId('time-travel-button').click();
    await page.getByTestId('time-travel-tab-month').click();
    await page.getByTestId('time-travel-month').selectOption('09');
    await page.getByTestId('time-travel-month-year').selectOption('2017');
    await confirmBirthPlaceSuggestion(page);
    await page.getByTestId('time-travel-go').click();
    // Contract reversed 2026-10-13 (4869958b): the chat's period row shows the short period, with no "Time travel ·" prefix.
    await expect(page.getByTestId('time-travel-title')).toHaveText('Sep 2017');
    await page.getByTestId('chat-input').fill(pastQuestion);
    await page.getByTestId('chat-send-button').click();
    await expect(page.getByTestId('chat-panel').getByText('The September timing can describe pressure, but cannot name the events of your life.')).toBeVisible({ timeout: 240_000 });
    const pastSystem = seen[0]?.messages.find((message) => message.role === 'system')?.content ?? '';
    // No pre-computed timing in the prompt: the trip line names the period, and round 1 must read.
    expect(pastSystem).toContain('THIS THREAD: a trip to September 2017');
    expect(pastSystem).toContain('PINNED PERIOD: this conversation is about 2017-09-01 to 2017-09-30 (relative: past)');
    for (const fact of ['"antar"', '"covered_events"', 'VERIFIED LOCAL TIMING']) expect(pastSystem).not.toContain(fact);
    // Contract changed (chat tool layer redesign, Task 6): round 1 of a trip is required and offers no answer.
    expect(seen[0]?.tool_choice).toBe('required');
    expect(toolNames(seen[0]!)).toEqual(['read_period', 'travel']);
    expect(reads(seen[1])[0]?.content).toContain('"start":"2017-09-01","end":"2017-09-30"');
    expect(reads(seen[1])[0]?.content).toContain('"antar"');
    const beforeToday = seen.length;
    await page.getByTestId('chat-input').fill(todayQuestion);
    await page.getByTestId('chat-send-button').click();
    await expect(page.getByTestId('chat-panel').getByText('Here is the outlook for today using the calculated timing.')).toBeVisible({ timeout: 240_000 });
    const todaySystem = seen[beforeToday]?.messages.find((message) => message.role === 'system')?.content ?? '';
    expect(todaySystem).toContain('NOW: today is ');
    expect(todaySystem).not.toContain('VERIFIED LOCAL TIMING');
    const todayReading = reads(seen[seen.length - 1])[0];
    expect(todayReading?.content).toContain(`"start":"${todayDay}","end":"${todayDay}","granularity":"day"`);
    expect(todayReading?.content).toContain('"tense":"present"');
    expect(todayReading?.content).not.toContain('2017-09-01');
    // Contract reversed 2026-10-13 (4869958b): the chat's period row shows the short period, with no "Time travel ·" prefix.
    await expect(page.getByTestId('time-travel-title')).toHaveText('Sep 2017');
    await page.screenshot({ path: testInfo.outputPath('september-then-today.png'), fullPage: true });
    if (tag) expect(modelDownloads, 'constrained chat must not boot the optional embedding model').toEqual([]);
    expect(errors, 'the regression journey keeps a clean console').toEqual([]);
  });

  test(`[contract/stubbed] ${tag} chat executes place, facts, timing and movement tools in both directions`, async ({ page }, testInfo) => {
    const errors = await prepare(page);
    const modelDownloads = captureLocalModelDownloads(page);
    const seen: ChatToolBody[] = [];
    const go = 'Take me to March 14, 2019 in Bogotá and show that day.';
    const back = 'Back to today, please.';
    const facts = 'Please check the planets in my chart.';
    const OPENING = 'I am opening 14 March 2019 in Bogotá using the calculated timing.';
    await scripted(page, {
      // The natal facts ride in the prompt: a chart question answers at once.
      [facts]: () => ({ name: 'answer', args: generalAnswer('I checked the calculated planets in your chart.') }),
      // Read the day in Bogotá, then move there, then answer from the reading.
      [go]: (body) => {
        const done = toolResults(body).map((result) => result.name);
        if (!done.includes('read_period')) return { name: 'read_period', args: readPeriodArgs('2019-03-14', { place: 'Bogotá' }) };
        if (!done.includes('travel')) return { name: 'travel', args: { to: '2019-03-14', place: 'Bogotá' } };
        return stubCallFor(body, {}, OPENING);
      },
      // Back to today from the trip: travel, then (the answer waits for a read in a trip) today's read, then the answer.
      [back]: (body) => {
        const done = toolResults(body).map((result) => result.name);
        if (!done.includes('travel')) return { name: 'travel', args: { to: 'today', place: null } };
        if (toolNames(body).includes('answer')) return { name: 'answer', args: generalAnswer('Returning to today.') };
        return { name: 'read_period', args: readPeriodArgs(new Intl.DateTimeFormat('en-CA').format(new Date())) };
      },
    }, seen, [], new Set<string>());
    await bootEngine(page);
    await seedChart(page);
    await openDashboard(page);
    await waitForLifeAtlasAsOf(page);
    const keys = await predictiveRequestKeys(page);
    await page.getByTestId('floating-chat-button').click();
    await page.getByTestId('chat-input').fill(facts);
    await page.getByTestId('chat-send-button').click();
    await expect(page.getByTestId('chat-panel').getByText('I checked the calculated planets in your chart.')).toBeVisible({ timeout: 240_000 });
    await page.getByTestId('chat-input').fill(go);
    await page.getByTestId('chat-send-button').click();
    await expect(page.getByTestId('dashboard-time-travel-banner')).toContainText('Bogotá', { timeout: 240_000 });
    await expect(page.getByTestId('time-travel-moment-transits')).toBeVisible({ timeout: 240_000 });
    const results = seen.flatMap((request) => toolResults(request));
    for (const name of ['read_period', 'travel']) expect(results.some((result) => result.name === name), `${name} actually executed`).toBe(true);
    expect(results.find((result) => result.name === 'travel')?.content).toContain('"status":"queued"');
    expect(results.find((result) => result.name === 'read_period')?.content).toMatch(/"label":"Bogotá, [^"]*Colombia"/);
    await page.getByTestId('chat-input').fill(back);
    await page.getByTestId('chat-send-button').click();
    await expect(page.getByTestId('dashboard-time-travel-banner')).toHaveCount(0, { timeout: 240_000 });
    await expect(page.getByTestId('time-travel-banner')).toHaveCount(0);
    await expect(page.getByTestId('life-atlas').getByText(/^As of /)).toBeVisible();
    expect(seen.flatMap((request) => toolResults(request)).some((result) => result.name === 'travel' && result.content.includes('"action":"back_to_today"'))).toBe(true);
    expect((await predictiveRequestKeys(page)).slice(keys.length)).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath('chat-returned-to-today.png'), fullPage: true });
    if (tag) expect(modelDownloads, 'constrained tool use must not boot the optional embedding model').toEqual([]);
    expect(errors, 'the tool journey keeps a clean console').toEqual([]);
  });
}
