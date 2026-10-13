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
const QUESTION = 'In one or two sentences: where was I living on this trip, and which dasha was I in?';

test('[real] a trip to May 2019 in Singapore grounds itself through its tools and names the place and the dasha', async ({ page }, testInfo) => {
  const key = process.env.OPENROUTER_API_KEY;
  test.skip(!key, 'OPENROUTER_API_KEY not set');
  test.skip(testInfo.project.name !== 'chromium', 'One live run, on Chromium only.');
  test.setTimeout(600_000);
  const consoleErrors = captureReloadConsole(page, testInfo).errors;
  const requests: Array<{ tool_choice?: string; model?: string; tools?: unknown[] }> = [];
  const responses: Array<Promise<string>> = [];
  page.on('request', (request) => {
    if (request.url().includes('openrouter.ai/api/v1/chat/completions') && request.method() === 'POST') {
      requests.push(JSON.parse(request.postData() ?? '{}') as (typeof requests)[number]);
    }
  });
  page.on('response', (response) => {
    if (response.url().includes('openrouter.ai/api/v1/chat/completions')) responses.push(response.text().catch(() => ''));
  });
  const config = JSON.stringify({
    apiBase: 'https://openrouter.ai/api/v1',
    apiKey: key,
    model: E2E_REAL_MODEL,
    chatModel: E2E_REAL_MODEL,
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
  await expect(page.getByTestId('chat-error-bubble')).toHaveCount(0);
  await expect(answer).toBeVisible();
  const answerText = (await answer.textContent()) ?? '';
  const toolRows = await page.getByTestId('chat-tool-call').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-tool-name')));

  const usage = (await Promise.all(responses)).map(completionUsage);
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
    answer: answerText.replace(/\s+/g, ' ').trim().slice(0, 600),
  };
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/time-travel-threads-real.json', JSON.stringify(evidence, null, 2));
  console.log(`[evidence] ${JSON.stringify(evidence)}`);
  testInfo.annotations.push({ type: 'real-llm', description: JSON.stringify(evidence) });

  expect(evidence.model, 'the cheapest e2e model answered, not the product default').toBe(E2E_REAL_MODEL);
  expect(evidence.firstToolChoice, 'the first trip round must call a tool').toBe('required');
  expect(toolRows.length, 'the transcript shows the tool calls').toBeGreaterThan(0);
  expect(toolRows.every((name) => ['get_natal_summary', 'get_trip_context', 'get_timing'].includes(name ?? '')), JSON.stringify(toolRows)).toBe(true);
  expect(answerText, 'the answer names the trip place').toMatch(/Singapore/i);
  expect(answerText, 'the answer names the dasha').toMatch(/Rahu/i);
  expect(consoleErrors, 'the journey must keep a clean console').toEqual([]);
});
