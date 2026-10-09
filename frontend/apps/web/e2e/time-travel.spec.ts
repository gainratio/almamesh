import { expect, test } from '@playwright/test';

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

interface WireMessage {
  role: string;
  name?: string;
  content?: string | null;
}

interface AgentRequest {
  messages: WireMessage[];
  tools: Array<{ function: { name: string } }>;
}

test('[contract/stubbed] a typed June 2019 question reads June 2019, not today', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(`console: ${message.text()}`);
  });
  await page.addInitScript(
    ([key, cfg]) => window.localStorage.setItem(key as string, cfg as string),
    [LLM_SETTINGS_KEY, JSON.stringify(LLM_CONFIG)] as const,
  );

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
  // A period compute that borrowed the store slot and handed it back would
  // pass a before/after compare, so watch the line for the whole journey.
  await page.evaluate((baseline) => {
    const atlas = document.querySelector('[data-testid="life-atlas"]');
    const seen: string[] = [];
    (window as unknown as { __atlasAsOfChanges: string[] }).__atlasAsOfChanges = seen;
    const record = () => {
      const line = [...(atlas?.querySelectorAll('p') ?? [])].find((p) => p.textContent?.startsWith('As of '));
      const text = line?.textContent ?? '(no As of line)';
      if (text !== baseline && seen[seen.length - 1] !== text) seen.push(text);
    };
    new MutationObserver(record).observe(document.body, { subtree: true, childList: true, characterData: true });
  }, atlasBefore);

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

  // The period compute runs the real engine (~30 s) and says so.
  await expect(page.getByTestId('chat-agent-status')).toContainText('Working out the sky', { timeout: 60_000 });
  const chatPanel = page.getByTestId('chat-panel');
  await expect(chatPanel.getByText('I looked at 1–30 June 2019.', { exact: false })).toBeVisible({ timeout: 240_000 });

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
  const atlasChanges = await page.evaluate(
    () => (window as unknown as { __atlasAsOfChanges: string[] }).__atlasAsOfChanges,
  );
  expect(atlasChanges, 'the Life Atlas "As of" line must not change during the journey').toEqual([]);
  await page.screenshot({ path: SCREENSHOT, fullPage: true });
  expect(consoleErrors, 'the journey must keep a clean console').toEqual([]);
});
