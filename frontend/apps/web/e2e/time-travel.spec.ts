import { readFileSync } from 'node:fs';

import { expect, type Page } from '@playwright/test';

import { DELHI_BIRTH, DELHI_SEED, LLM_SETTINGS_KEY, bootEngine, seedChart } from './interpretation.helpers';
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
const ANSWER = 'I looked at 1–30 June 2019. A Saturn antar was ending and Jupiter was moving.';
const BIRTH_MONTH = '1990-01'; // DELHI_BIRTH.datetimeUtc
const SCREENSHOT = 'test-results/time-travel-june-2019.png';
/**
 * Pin a full-tier device (devicePolicy: >= 8 GB and > 2 cores). Lite and minimal
 * answer dated questions with dashas only, so without this pin the period-sky
 * path this spec covers would depend on the runner's hardware.
 */
const FULL_TIER = { deviceMemory: 8, hardwareConcurrency: 8 };

interface WireMessage {
  role: string;
  name?: string;
  content?: string | null;
}

interface AgentRequest {
  messages: WireMessage[];
  tools: Array<{ function: { name: string } }>;
}

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
 * that load is still opening SQLite (wasm + Worker); WebKit reports a load a
 * hard navigation cancels as an "access control checks" console error, which
 * would read as an app failure. So let the load settle first, as
 * portableInvariants.helpers.ts gotoSettled does.
 */
async function openDashboard(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle');
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
}

/** Console capture, a full-tier device pin and the stubbed provider's settings: every journey's set-up. */
async function prepare(page: Page): Promise<string[]> {
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(`console: ${message.text()}`);
  });
  await page.addInitScript((tier) => {
    for (const [name, value] of Object.entries(tier)) {
      Object.defineProperty(Navigator.prototype, name, { get: () => value, configurable: true });
    }
  }, FULL_TIER);
  await page.addInitScript(
    ([key, cfg]) => window.localStorage.setItem(key as string, cfg as string),
    [LLM_SETTINGS_KEY, JSON.stringify(LLM_CONFIG)] as const,
  );
  return consoleErrors;
}

test('[contract/stubbed] a typed June 2019 question reads June 2019, not today', async ({ page }) => {
  const consoleErrors = await prepare(page);

  const agentRequests: AgentRequest[] = [];
  await page.route('**/chat/completions', async (route) => {
    const parsed = JSON.parse(route.request().postData() ?? '{}') as {
      messages?: WireMessage[];
      tools?: Array<{ function: { name: string } }>;
    };
    if (!Array.isArray(parsed.tools) || !JSON.stringify(parsed.messages).includes('June 2019')) {
      // Anything else (summaries, other features): a harmless empty answer.
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ choices: [{ message: { content: '' } }] }),
      });
    }
    agentRequests.push({ messages: parsed.messages ?? [], tools: parsed.tools });
    const hasToolResults = (parsed.messages ?? []).some((message) => message.role === 'tool');
    if (!hasToolResults) {
      const call = (id: string, section: string) => ({
        id,
        type: 'function',
        function: {
          name: 'get_timing',
          arguments: JSON.stringify({ section, start: '2019-06-01', end: '2019-06-30' }),
        },
      });
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          choices: [{ message: { content: null, tool_calls: [call('dashas-june', 'dashas'), call('sky-june', 'transits')] } }],
        }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ choices: [{ message: { content: ANSWER } }] }),
    });
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
  const atlasAsOf = page.getByTestId('life-atlas').getByText(/^As of /);
  await expect(atlasAsOf).toBeVisible({ timeout: 240_000 });
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

  // Router: "transits" alone used to pre-run TODAY and label the prompt
  // "(as of <day>, today):". Checked as soon as the first model call lands.
  await expect.poll(() => agentRequests.length, { timeout: 120_000 }).toBeGreaterThan(0);
  const [decision] = agentRequests;
  const prompt = decision.messages.map((message) => message.content ?? '').join('\n');
  expect(prompt, 'a dated question must not pre-run and label today').not.toContain(', today):');
  // Extended 2026-10 (time travel step C): the pinned full tier adds resolve_place.
  expect(decision.tools.map((tool) => tool.function.name)).toEqual([
    'get_current_datetime',
    'get_chart_facts',
    'get_timing',
    'resolve_place',
  ]);

  const chatPanel = page.getByTestId('chat-panel');
  await expect(chatPanel.getByText('I looked at 1–30 June 2019.', { exact: false })).toBeVisible({ timeout: 240_000 });
  // The period compute runs the real engine and said so while it ran.
  const statuses = await page.evaluate(
    () => (window as unknown as { __agentStatusHistory: string[] }).__agentStatusHistory,
  );
  expect(statuses.some((text) => text.includes('Working out the sky')), statuses.join(' | ')).toBe(true);

  expect(agentRequests).toHaveLength(2);
  const toolResults = agentRequests[1].messages.filter((message) => message.role === 'tool');
  expect(toolResults.map((message) => message.name)).toEqual(['get_timing', 'get_timing']);
  for (const result of toolResults) {
    expect(result.content).toContain('"period":{"start":"2019-06-01","end":"2019-06-30","days":30,"basis":"period"}');
    expect(result.content).not.toContain(BIRTH_MONTH);
  }
  expect(toolResults[0].content).toContain('"antar"');
  expect(toolResults[1].content).toContain('"covered_events"');
  expect(toolResults[1].content).not.toContain('"available":false');

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
const LONG_ANSWER = 'I looked at 1 January 2027 to 30 June 2028. Mars turns retrograde in January 2027.';
const LONG_SCREENSHOT = 'test-results/time-travel-18-months.png';
/**
 * Engine events for the Delhi fixture inside 2027-01..2028-06 (CPython, DE421),
 * in timeline order. Mars stations retrograde, backs out of Leo into Cancer,
 * stations direct and re-enters Leo; Rahu/Ketu change sign in June 2028, past
 * a 12-month window's end.
 */
const LONG_PERIOD_DESCRIPTORS = [
  'mars.station.retrograde',
  'mars.ingress.cancer',
  'mars.station.direct',
  'mars.ingress.leo',
  'rahu.ingress.sagittarius',
  'ketu.ingress.gemini',
] as const;

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
  const toolResults: WireMessage[] = [];
  await page.route('**/chat/completions', async (route) => {
    const parsed = JSON.parse(route.request().postData() ?? '{}') as { messages?: WireMessage[]; tools?: unknown[] };
    const messages = parsed.messages ?? [];
    if (!Array.isArray(parsed.tools) || !JSON.stringify(messages).includes('first half of 2028')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ choices: [{ message: { content: '' } }] }),
      });
    }
    const results = messages.filter((message) => message.role === 'tool');
    if (results.length === 0) {
      const call = {
        id: 'sky-long',
        type: 'function',
        function: {
          name: 'get_timing',
          arguments: JSON.stringify({ section: 'transits', start: '2027-01-01', end: '2028-06-30' }),
        },
      };
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ choices: [{ message: { content: null, tool_calls: [call] } }] }),
      });
    }
    toolResults.push(...results);
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ choices: [{ message: { content: LONG_ANSWER } }] }),
    });
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
  const atlasAsOf = page.getByTestId('life-atlas').getByText(/^As of /);
  await expect(atlasAsOf).toBeVisible({ timeout: 240_000 });
  const atlasBefore = (await atlasAsOf.textContent()) ?? '';
  expect(atlasBefore).not.toContain('2027');
  await page.getByTestId('floating-chat-button').click({ timeout: 120_000 });
  await page.getByTestId('chat-input').fill(LONG_QUESTION);
  await page.getByTestId('chat-send-button').click();

  const started = Date.now();
  await expect(page.getByTestId('chat-panel').getByText('I looked at 1 January 2027', { exact: false })).toBeVisible({
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

  expect(toolResults).toHaveLength(1);
  const content = toolResults[0].content ?? '';
  expect(content).toContain('"period":{"start":"2027-01-01","end":"2028-06-30","days":547,"basis":"period"}');
  expect(content).not.toContain('"available":false');
  expect(content).not.toContain('Transit events are listed only until');
  // Real engine events reach the model, in timeline order (not the covered_events constants).
  const positions = LONG_PERIOD_DESCRIPTORS.map((descriptor) => content.indexOf(`"descriptor":"${descriptor}"`));
  expect(positions.every((position) => position >= 0), LONG_PERIOD_DESCRIPTORS.join(', ')).toBe(true);
  expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  expect(content).toContain('"station_direction":"retrograde"');
  expect(content).not.toContain(BIRTH_MONTH);
  await page.screenshot({ path: LONG_SCREENSHOT, fullPage: true });
  expect(consoleErrors, 'the journey must keep a clean console').toEqual([]);
});

/**
 * Journey 3 (spec 2026-10-08, Inc C, coordinator rulings 2026-10-09, P4/P8/P9):
 * June (30 days, a week or longer) with two places is read once with get_timing
 * alone, and the model says the places don't change it (P9: no resolve_place);
 * "the 15th" reuses the place the user named for that half (P4: resolve first,
 * then get_timing, two rounds); "3 pm on 3 July" has no place, so get_timing
 * answers needs_place and the model asks; "Bogotá" reads the event there. No
 * request may leave the app origin, except provider calls that this test's own
 * route handler fulfilled (they never reach the network). Nothing the model is
 * sent may carry a coordinate, the device zone or the birth place.
 */
const SPLIT_QUESTION = 'How was June 2026 for me? I was in LA the first half, then Bogotá.';
const SPLIT_ANSWER = "I looked at 1–30 June 2026. Being in LA and then Bogotá doesn't change June's reading.";
const DAY_QUESTION = 'What about June 15 itself?';
const DAY_ANSWER = 'On 15 June 2026 in Los Angeles the Moon was';
const TIME_QUESTION = 'And 3 pm on 3 July?';
const WHERE_QUESTION = 'Where were you (or will you be) that day?';
const PLACE_REPLY = 'I will be in Bogotá.';
const EVENT_ANSWER = 'At 3 pm on 3 July 2026 in Bogotá, Colombia, the rising sign was';
const PLACE_SCREENSHOT = 'test-results/time-travel-places.png';
const NEEDS_PLACE_RESULT = '{"ok":true,"value":{"error":"needs_place"}}';
/** A zone no journey step names, so any appearance in a model-bound body is the device zone leaking. */
const DEVICE_ZONE = 'Pacific/Chatham';

interface CityRow {
  n: string;
  c: string;
  lat: number;
  lon: number;
}

/** The bundled offline city list resolve_place reads (the rows whose coordinates must never leave). */
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
  new RegExp(DEVICE_ZONE.replace('/', '\\/')),
  new RegExp(DELHI_SEED.timezone.replace('/', '\\/')),
  new RegExp(`\\b(?:${DELHI_SEED.city}|${DELHI_SEED.locationName.split(', ')[1]})\\b`),
];

/** Every leak pattern that matches, with the text around the match. */
function leaks(body: string): string[] {
  return LEAK_PATTERNS.flatMap((pattern) => {
    const match = pattern.exec(body);
    return match ? [`${pattern} ~ ${body.slice(Math.max(0, match.index - 40), match.index + 40)}`] : [];
  });
}

type Script = (turn: WireMessage[]) => object;

const call = (id: string, name: string, args: object) => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});
/** The tool messages of the turn in flight: everything after the last user message. */
const turnTools = (messages: WireMessage[]) => {
  const lastUser = messages.map((m) => m.role).lastIndexOf('user');
  return messages.slice(lastUser + 1).filter((m) => m.role === 'tool');
};
const refFrom = (content: string | null | undefined) =>
  (JSON.parse(content ?? '{}') as { value: { place: { place_ref: string } } }).value.place.place_ref;
const sse = (content: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`;

/**
 * The stubbed provider: one script per user message; records every model-bound
 * body and every URL it fulfilled. The forced final round (tool_choice "none")
 * always streams, so its answer goes back as SSE.
 */
function scripted(
  page: Page,
  scripts: Record<string, Script>,
  seen: AgentRequest[],
  bodies: string[],
  fulfilled: Set<string>,
): Promise<unknown> {
  return page.route('**/chat/completions', async (route) => {
    fulfilled.add(route.request().url());
    const raw = route.request().postData() ?? '{}';
    bodies.push(raw);
    const parsed = JSON.parse(raw) as { messages?: WireMessage[]; tools?: AgentRequest['tools']; tool_choice?: string };
    const messages = parsed.messages ?? [];
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    // Recalled history can quote earlier questions inside the user message; the asked one comes last.
    const key = Object.keys(scripts)
      .filter((text) => lastUser.includes(text))
      .sort((a, b) => lastUser.lastIndexOf(b) - lastUser.lastIndexOf(a))[0];
    if (!Array.isArray(parsed.tools) || !key) {
      const empty = { choices: [{ message: { content: '' } }] };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(empty) });
    }
    seen.push({ messages, tools: parsed.tools });
    const message = scripts[key](turnTools(messages)) as { content?: string | null };
    if (parsed.tool_choice === 'none') {
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse(message.content ?? '') });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ choices: [{ message }] }),
    });
  });
}

const PLACE_SCRIPTS: Record<string, Script> = {
  // P9: a week or longer needs no place, so June is one get_timing and the model says so.
  [SPLIT_QUESTION]: (tools) =>
    tools.length === 0
      ? { content: null, tool_calls: [call('june', 'get_timing', { section: 'transits', start: '2026-06-01', end: '2026-06-30' })] }
      : { content: SPLIT_ANSWER },
  // P4: the user named LA for the first half, so resolve it first, then read the day there.
  [DAY_QUESTION]: (tools) => {
    if (tools.length === 0) return { content: null, tool_calls: [call('la', 'resolve_place', { query: 'Los Angeles' })] };
    if (tools.length === 1) {
      const args = { section: 'transits', start: '2026-06-15', place_ref: refFrom(tools[0]?.content) };
      return { content: null, tool_calls: [call('day', 'get_timing', args)] };
    }
    return { content: `${DAY_ANSWER} …` };
  },
  // No place named for 3 July: the stub tries without one; only needs_place makes it ask.
  [TIME_QUESTION]: (tools) => {
    if (tools.length === 0) return { content: null, tool_calls: [call('july', 'get_timing', { section: 'transits', start: '2026-07-03' })] };
    return { content: tools.at(-1)?.content === NEEDS_PLACE_RESULT ? WHERE_QUESTION : 'Here is 3 July without a place.' };
  },
  [PLACE_REPLY]: (tools) => {
    if (tools.length === 0) return { content: null, tool_calls: [call('bog', 'resolve_place', { query: 'Bogotá' })] };
    if (tools.length === 1) {
      const args = { section: 'transits', start: '2026-07-03', place_ref: refFrom(tools[0]?.content), time: '15:00' };
      return { content: null, tool_calls: [call('event', 'get_timing', args)] };
    }
    return { content: `${EVENT_ANSWER} …` };
  },
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
      if (new URL(request.url()).pathname.includes('cities.min')) cityChunks.push(request.url());
    });
    // Ruling 16: context level, so service-worker and worker requests count too, not only the page's.
    let serviceWorkerRequests = 0;
    page.context().on('request', (request) => {
      if (request.serviceWorker()) serviceWorkerRequests += 1;
      if (new URL(request.url()).origin !== origin) offOrigin.push(request.url());
    });
    const seen: AgentRequest[] = [];
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
    const atlasAsOf = page.getByTestId('life-atlas').getByText(/^As of /);
    await expect(atlasAsOf).toBeVisible({ timeout: 240_000 });
    const keysBefore = await predictiveRequestKeys(page);
    expect(cityChunks, 'the city list must not load before a place is asked about').toEqual([]);

    await page.getByTestId('floating-chat-button').click({ timeout: 60_000 });
    const ask = async (text: string, answer: string) => {
      await page.getByTestId('chat-input').fill(text);
      await page.getByTestId('chat-send-button').click();
      await expect(page.getByTestId('chat-panel').getByText(answer, { exact: false })).toBeVisible({ timeout: 240_000 });
    };
    const lastTools = () => turnTools(seen.at(-1)?.messages ?? []);

    await ask(SPLIT_QUESTION, SPLIT_ANSWER);
    expect(lastTools().map((m) => m.name)).toEqual(['get_timing']);
    expect(lastTools()[0]?.content).toContain('"period":{"start":"2026-06-01","end":"2026-06-30","days":30,"basis":"period"}');
    expect(lastTools()[0]?.content).not.toContain('"moon"');
    expect(lastTools()[0]?.content).not.toContain('"places"');
    expect(cityChunks, 'a week or longer never loads the city list').toEqual([]);

    await ask(DAY_QUESTION, DAY_ANSWER);
    expect(lastTools().map((m) => m.name)).toEqual(['resolve_place', 'get_timing']);
    expect(lastTools()[0]?.content).toContain('"label":"Los Angeles, United States"');
    expect(lastTools()[0]?.content).toContain('"timezone":"America/Los_Angeles"');
    expect(lastTools()[1]?.content).toContain('"label":"Los Angeles, United States"');
    expect(lastTools()[1]?.content).toContain('"moon":{"at_start":');

    await ask(TIME_QUESTION, WHERE_QUESTION);
    expect(lastTools().map((m) => m.content)).toEqual([NEEDS_PLACE_RESULT]);

    await ask(PLACE_REPLY, EVENT_ANSWER);
    expect(lastTools().map((m) => m.name)).toEqual(['resolve_place', 'get_timing']);
    expect(lastTools()[0]?.content).toContain('"label":"Bogotá, Colombia"');
    expect(lastTools()[1]?.content).toContain('"label":"Bogotá, Colombia"');
    expect(lastTools()[1]?.content).toContain('"event":{"local_time":"15:00","lagna_sign":');

    // Every body the provider was sent (system prompt, history, tool results, all four turns).
    expect(bodies.flatMap(leaks), 'no coordinate, device zone or birth place may reach the model').toEqual([]);
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
    expect(cityChunks, 'the city list loads once, from the app origin').toHaveLength(1);
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
const PIN_DAYS = new Date(Date.UTC(Number(PIN_YEAR), 1, 29)).getUTCMonth() === 1 ? 366 : 365;
const PIN_ANSWER = `I looked at 1 January–31 December ${PIN_YEAR}. Work should get easier from spring.`;
const PIN_SCREENSHOT = 'test-results/time-travel-next-year.png';

/** The pinned threads the app holds (the exit-gate hook): ids and pins only. */
async function pinnedThreads(page: Page): Promise<Array<{ id: string; as_of: unknown }>> {
  const rows = await page.evaluate(() =>
    (window as unknown as { __almameshPinnedThreads?: () => Array<{ id: string; as_of: unknown }> }).__almameshPinnedThreads?.(),
  );
  if (!rows) throw new Error('window.__almameshPinnedThreads is missing: build with VITE_EXIT_GATE_HOOKS=1');
  return rows;
}

async function openPinnedYear(page: Page, year: string): Promise<void> {
  await page.getByTestId('time-travel-button').click();
  await expect(page.getByTestId('time-travel-sheet')).toBeVisible();
  await page.getByTestId('time-travel-tab-year').click();
  await expect(page.getByTestId('time-travel-where')).toHaveCount(0);
  await page.getByTestId('time-travel-year').selectOption(year);
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
    const seen: AgentRequest[] = [];
    const bodies: string[] = [];
    const fulfilled = new Set<string>();
    await scripted(
      page,
      {
        [PIN_QUESTION]: (tools) =>
          tools.length === 0
            ? { content: null, tool_calls: [call('when', 'get_current_datetime', { scope: 'chart' }), call('sky', 'get_timing', { section: 'transits' })] }
            : { content: PIN_ANSWER },
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
    await expect(page.getByTestId('life-atlas').getByText(/^As of /)).toBeVisible({ timeout: 240_000 });
    const keysBefore = await predictiveRequestKeys(page);

    await page.getByTestId('floating-chat-button').click({ timeout: 60_000 });
    await openPinnedYear(page, PIN_YEAR);
    await expect(page.getByTestId('time-travel-badge')).toHaveText('⏳');
    await expect(page.getByTestId('time-travel-title')).toHaveText(`Time travel · ${PIN_YEAR}`);
    await expect(page.getByTestId('time-travel-banner')).toContainText('answers are about this period');
    await expect(page.getByRole('button', { name: 'What should I prepare for?' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Which months look strongest?' })).toBeVisible();

    // The pin was on disk before the sheet closed: a full reload keeps it.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByTestId('floating-chat-button').click({ timeout: 120_000 });
    await expect(page.getByTestId('time-travel-title')).toHaveText(`Time travel · ${PIN_YEAR}`);
    expect((await pinnedThreads(page)).map((row) => row.as_of)).toEqual([
      { start: `${PIN_YEAR}-01-01`, end: `${PIN_YEAR}-12-31`, granularity: 'year' },
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

    const last = seen.at(-1)!;
    const tools = turnTools(last.messages);
    expect(tools.map((m) => m.name)).toEqual(['get_current_datetime', 'get_timing']);
    expect(tools[0]?.content).toContain(`"pinned_period":{"start":"${PIN_YEAR}-01-01","end":"${PIN_YEAR}-12-31"}`);
    expect(tools[0]?.content).toContain('"relative":"future"');
    expect(tools[1]?.content).toContain(`"period":{"start":"${PIN_YEAR}-01-01","end":"${PIN_YEAR}-12-31","days":${PIN_DAYS},"basis":"period"}`);
    const system = last.messages.find((m) => m.role === 'system')?.content ?? '';
    expect(system).toContain(`PINNED PERIOD: this conversation is about ${PIN_YEAR}-01-01 to ${PIN_YEAR}-12-31 (relative: future)`);
    expect(system).toContain('future tense');
    const statuses = await page.evaluate(() => (window as unknown as { __agentStatusHistory: string[] }).__agentStatusHistory);
    expect(statuses.some((text) => text.startsWith(`Working out the sky for ${PIN_YEAR}`))).toBe(true);
    expect((await predictiveRequestKeys(page)).slice(keysBefore.length), 'the Life Atlas slot keeps its requestKey').toEqual([]);
    expect(bodies.length, 'the question reached the stubbed model').toBeGreaterThan(0);
    // The chart zone (get_current_datetime scope 'chart') legitimately names the birth zone; only the device's must stay out.
    expect(bodies.filter((body) => body.includes(DEVICE_ZONE)), 'the device zone must not reach the model').toEqual([]);
    await page.screenshot({ path: PIN_SCREENSHOT, fullPage: true });
    expect(consoleErrors, 'the journey must keep a clean console').toEqual([]);
  });

  /**
   * The Day pin (spec Testing, e2e): "Where?" shows on Day only, starts empty, is
   * required, and the city search makes no request off the app origin. Then
   * Change → Month and Back to today. No coordinates reach the model.
   */
  test('[contract/stubbed] a Day pin needs a place found on the device, then Change and Back to today', async ({ page }) => {
    const consoleErrors = await prepare(page);
    const fulfilled = new Set<string>();
    const bodies: string[] = [];
    const seen: AgentRequest[] = [];
    const DAY_ANSWER_TEXT = 'That day looks calm.';
    await scripted(
      page,
      {
        // get_timing without dates reads the pinned Day with the pinned place.
        'How was that day?': (tools) =>
          tools.length === 0
            ? { content: null, tool_calls: [call('when', 'get_current_datetime', { scope: 'utc' }), call('sky', 'get_timing', { section: 'transits' })] }
            : { content: DAY_ANSWER_TEXT },
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
    await expect(page.getByTestId('time-travel-where')).toHaveCount(0);
    await page.getByTestId('time-travel-tab-day').click();
    await expect(page.getByTestId('time-travel-where-input')).toHaveValue('');
    await expect(page.getByTestId('time-travel-where-required')).toBeVisible();
    await page.getByTestId('time-travel-day').fill('2026-06-15');
    await expect(page.getByTestId('time-travel-go')).toBeDisabled();
    await page.getByTestId('time-travel-where-input').fill('Bogotá');
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
    await expect(page.getByTestId('time-travel-title')).toHaveText('Time travel · June 2026');
    await expect(page.getByTestId('time-travel-banner')).not.toContainText('Bogotá');

    await page.getByTestId('time-travel-back').click();
    await expect(page.getByTestId('time-travel-banner')).toHaveCount(0);
    expect(offOrigin.filter((url) => !fulfilled.has(url)), 'nothing may leave the app origin').toEqual([]);
    expect(bodies.length, 'the question reached the stubbed model').toBeGreaterThan(0);
    expect(bodies.flatMap(leaks), 'no coordinates reach the model').toEqual([]);
    const timingResult = seen.flatMap((request) => request.messages).filter((m) => m.role === 'tool' && /Bogot/.test(m.content ?? ''));
    expect(timingResult.length, 'get_timing read the pinned Day with the pinned place').toBeGreaterThan(0);
    const COORDINATES = /4\.6097|-?74\.0817|latitude|longitude/i;
    expect(timingResult.filter((m) => COORDINATES.test(m.content ?? '')), 'the tool result carries the place label, not its coordinates').toEqual([]);
    expect(bodies.filter((body) => COORDINATES.test(body)), 'no model request body carries coordinates').toEqual([]);
    expect(bodies.some((body) => body.includes('Bogot')), 'the place label reaches the model').toBe(true);
    expect(consoleErrors, 'the journey must keep a clean console').toEqual([]);
  });
});

/**
 * The iPhone (iphone-webkit project only). iOS is always the minimal device tier
 * (packages/browser/src/deviceTier.ts), whatever navigator reports, so the
 * full-tier journeys above do not exist there: no Day pin, no places. What an
 * iPhone user does get is Month and Year. Pin next year, keep it across a
 * reload, ask a question with no dates, and the banner wraps cleanly at 380 px.
 */
test.describe('time travel on an iPhone', () => {
  test.use({ timezoneId: DEVICE_ZONE });

  test('[contract/stubbed] @iphone offers Month and Year, pins next year and reads it without dates', async ({ page }) => {
    const consoleErrors = await prepare(page);
    const seen: AgentRequest[] = [];
    const bodies: string[] = [];
    const fulfilled = new Set<string>();
    await scripted(
      page,
      {
        [PIN_QUESTION]: (tools) =>
          tools.length === 0
            ? { content: null, tool_calls: [call('when', 'get_current_datetime', { scope: 'chart' }), call('sky', 'get_timing', { section: 'transits' })] }
            : { content: PIN_ANSWER },
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
    await expect(page.getByTestId('time-travel-tab-day'), 'the Day pin is full-tier only, and iOS is minimal').toHaveCount(0);
    await page.getByTestId('time-travel-tab-year').click();
    await page.getByTestId('time-travel-year').selectOption(PIN_YEAR);
    await page.getByTestId('time-travel-go').click();
    await expect(page.getByTestId('time-travel-sheet')).toBeHidden();
    await expect(page.getByTestId('time-travel-title')).toHaveText(`Time travel · ${PIN_YEAR}`);
    await expect(page.getByTestId('time-travel-banner')).toContainText('answers are about this period');

    // The pin was on disk before the sheet closed: a full reload keeps it.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByTestId('floating-chat-button').click({ timeout: 120_000 });
    await expect(page.getByTestId('time-travel-title')).toHaveText(`Time travel · ${PIN_YEAR}`);
    expect((await pinnedThreads(page)).map((row) => row.as_of)).toEqual([
      { start: `${PIN_YEAR}-01-01`, end: `${PIN_YEAR}-12-31`, granularity: 'year' },
    ]);

    await page.getByTestId('chat-input').fill(PIN_QUESTION);
    await page.getByTestId('chat-send-button').click();
    await expect(page.getByTestId('chat-panel').getByText(PIN_ANSWER)).toBeVisible({ timeout: 240_000 });
    const last = seen.at(-1)!;
    expect(last.tools.map((tool) => tool.function.name), 'minimal tier: no place tool').not.toContain('resolve_place');
    const tools = turnTools(last.messages);
    expect(tools.map((m) => m.name)).toEqual(['get_current_datetime', 'get_timing']);
    expect(tools[0]?.content).toContain(`"pinned_period":{"start":"${PIN_YEAR}-01-01","end":"${PIN_YEAR}-12-31"}`);
    expect(tools[0]?.content).toContain('"relative":"future"');
    expect(bodies.filter((body) => body.includes(DEVICE_ZONE)), 'the device zone must not reach the model').toEqual([]);

    await expectBannerWrapsCleanlyAt380(page);
    expect(consoleErrors, 'the journey must keep a clean console').toEqual([]);
  });
});
