import { mkdirSync, writeFileSync } from 'node:fs';

import { expect } from '@playwright/test';

import { LLM_SETTINGS_KEY, bootEngine, seedChart } from './interpretation.helpers';
import { waitForLifeAtlasAsOf } from './lifeAtlas.helpers';
import { completionUsage } from './openrouterUsage';
import { gotoSettled } from './portableInvariants.helpers';
import { E2E_REAL_MODEL } from './realModel';
import { captureReloadConsole } from './reloadConsole';
import { test } from './webkitProfile';

/**
 * The trip journey against a LIVE OpenRouter model (plan 2026-10-13, Testing →
 * E2E, "Real-LLM e2e"): travel to May 2019 in Singapore, ask one short
 * question, and the transcript shows the trip's tool calls, then an answer that
 * names Singapore and the dasha (DELHI_BIRTH in May 2019: Rahu–Rahu). The
 * cheapest suitable model (e2e/realModel.ts) is configured for both the
 * reading and the chat, so the run never uses the product default. Self-skips
 * without OPENROUTER_API_KEY. Chromium only.
 */
/**
 * The model: the cheapest shared e2e model by default. TRIP_REAL_MODEL runs the
 * same journey on another provider's model (2026-10-13: OpenAI's gpt-oss-20b, the
 * cheapest tool-capable non-DeepSeek model live on OpenRouter that day).
 */
const MODEL = process.env.TRIP_REAL_MODEL ?? E2E_REAL_MODEL;
const QUESTION = 'In one or two sentences: where was I living on this trip, and which dasha was I in?';

test('[real] a trip to May 2019 in Singapore grounds itself through its tools and names the place and the dasha', async ({ page }, testInfo) => {
  const key = process.env.OPENROUTER_API_KEY;
  test.skip(!key, 'OPENROUTER_API_KEY not set');
  test.skip(testInfo.project.name !== 'chromium', 'One live run, on Chromium only.');
  test.setTimeout(600_000);
  const consoleErrors = captureReloadConsole(page, testInfo).errors;
  const requests: Array<{ tool_choice?: string; model?: string; tools?: unknown[] }> = [];
  const responses: Array<Promise<string>> = [];
  const failures: Array<Promise<string>> = [];
  page.on('request', (request) => {
    if (request.url().includes('openrouter.ai/api/v1/chat/completions') && request.method() === 'POST') {
      requests.push(JSON.parse(request.postData() ?? '{}') as (typeof requests)[number]);
    }
  });
  page.on('response', (response) => {
    if (!response.url().includes('openrouter.ai/api/v1/chat/completions')) return;
    responses.push(response.text().catch(() => ''));
    // A provider refusal, kept short for the evidence line (the request body is not logged).
    if (response.status() >= 400) failures.push(response.text().then((body) => `${response.status()} ${body.slice(0, 300)}`, () => String(response.status())));
  });
  const config = JSON.stringify({
    apiBase: 'https://openrouter.ai/api/v1',
    apiKey: key,
    model: MODEL,
    chatModel: MODEL,
    privacyMode: 'cloud_premium',
    engine: 'openai-http',
  });
  await page.addInitScript(([storageKey, cfg]) => window.localStorage.setItem(storageKey as string, cfg as string), [LLM_SETTINGS_KEY, config] as const);

  await bootEngine(page);
  await seedChart(page);
  await gotoSettled(page, '/dashboard');
  await waitForLifeAtlasAsOf(page);
  await page.getByTestId('floating-chat-button').click({ timeout: 120_000 });
  await page.getByTestId('time-travel-button').click();
  await page.getByTestId('time-travel-tab-month').click();
  await page.getByTestId('time-travel-month').selectOption('05');
  await page.getByTestId('time-travel-month-year').selectOption('2019');
  await page.getByTestId('time-travel-where-input').fill('Singapore');
  await page.getByTestId('time-travel-where-option-0').click({ timeout: 60_000 });
  await page.getByTestId('time-travel-go').click();
  await expect(page.getByTestId('chat-thread-title')).toHaveText(/^⏳ May 2019 · Singapore/);

  await page.getByTestId('chat-input').fill(QUESTION);
  await page.getByTestId('chat-send-button').click();
  const answer = page.getByTestId('chat-message-assistant').last();
  // The ⏳ button is disabled only while the answer streams.
  await expect(page.getByTestId('time-travel-button')).toBeDisabled({ timeout: 30_000 });
  await expect(page.getByTestId('time-travel-button')).toBeEnabled({ timeout: 300_000 });
  // A failed turn shows an error bubble and no answer: read either without waiting.
  const answerText = (await page.getByTestId('chat-message-assistant').allTextContents()).pop() ?? '';
  const errorBubbles = await page.getByTestId('chat-error-bubble').allTextContents();
  const toolRows = await page.getByTestId('chat-tool-call').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-tool-name')));

  const responseBodies = await Promise.all(responses);
  const usage = responseBodies.map(completionUsage);
  const decisions = requests.filter((request) => Array.isArray(request.tools));
  const evidence = {
    model: decisions[0]?.model ?? null,
    firstToolChoice: decisions[0]?.tool_choice ?? null,
    requests: usage.length,
    costUsd: usage.reduce((sum, u) => sum + u.cost, 0),
    promptTokens: usage.reduce((sum, u) => sum + u.promptTokens, 0),
    completionTokens: usage.reduce((sum, u) => sum + u.completionTokens, 0),
    providers: [...new Set(usage.map((u) => u.provider).filter(Boolean))],
    toolRows,
    failures: await Promise.all(failures),
    // On a failed turn, the start of each provider reply (a 200 stream can carry the provider's error).
    ...(errorBubbles.length > 0 ? { errorBubbles, replies: responseBodies.map((body) => body.slice(0, 400)) } : {}),
    answer: answerText.replace(/\s+/g, ' ').trim().slice(0, 600),
  };
  mkdirSync('test-results', { recursive: true });
  writeFileSync(`test-results/time-travel-threads-real-${MODEL.replace(/\W/g, '_')}.json`, JSON.stringify(evidence, null, 2));
  console.log(`[evidence] ${JSON.stringify(evidence)}`);
  testInfo.annotations.push({ type: 'real-llm', description: JSON.stringify(evidence) });

  await expect(page.getByTestId('chat-error-bubble'), 'the turn ends in an answer, not an error').toHaveCount(0);
  await expect(answer).toBeVisible();
  expect(evidence.model, 'the configured e2e model answered, not the product default').toBe(MODEL);
  expect(evidence.firstToolChoice, 'the first trip round must call a tool').toBe('required');
  expect(toolRows.length, 'the transcript shows the tool calls').toBeGreaterThan(0);
  // Tool layer redesign (2026-10-14): the trip's one read tool is read_period (it replaced get_natal_summary,
  // get_trip_context, get_timing, get_period_reading and get_period_detail). A question is not a move: no travel row.
  expect(toolRows.every((name) => name === 'read_period'), JSON.stringify(toolRows)).toBe(true);
  expect(answerText, 'the answer names the trip place').toMatch(/Singapore/i);
  expect(answerText, 'the answer names the dasha').toMatch(/Rahu/i);
  expect(consoleErrors, 'the journey must keep a clean console').toEqual([]);
});
