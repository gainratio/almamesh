import { expect, test, type Page } from '@playwright/test';

import { LLM_SETTINGS_KEY, bootEngine, seedChart } from './interpretation.helpers';

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
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });

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
  expect(decision.tools.map((tool) => tool.function.name)).toEqual([
    'get_current_datetime',
    'get_chart_facts',
    'get_timing',
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
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  // As in the June 2019 journey: wait for the re-anchor to today, or the answer is discarded by design.
  const today = await page.evaluate(() =>
    new Intl.DateTimeFormat('en', { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date()),
  );
  await expect(page.getByTestId('provenance-footer')).toContainText(`As of ${today}`, { timeout: 120_000 });
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
