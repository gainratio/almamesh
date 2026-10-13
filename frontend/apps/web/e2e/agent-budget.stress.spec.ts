import { expect, test, type Page, type TestInfo } from '@playwright/test';

import {
  BudgetProvider,
  MOCK_MODELS,
  answerText,
  estimatePromptTokens,
  pairingViolations,
  roundRecords,
  toolMessagesContaining,
  turnRecords,
  writeBudgetReport,
  type MockModelId,
} from './agentBudget.helpers';
import { LLM_SETTINGS_KEY, bootEngine, seedChart } from './interpretation.helpers';
import { waitForLifeAtlasAsOf } from './lifeAtlas.helpers';
import { gotoSettled } from './portableInvariants.helpers';
import { captureReloadConsole } from './reloadConsole';

/**
 * Agent-loop context budget, stress (plan 2026-10-13 Phase 1). A stubbed
 * OpenRouter answers every decision round with as many tool calls as it can
 * (parallel grounding, detail, an identical repeat, six at once) for up to four
 * rounds, then answers in text. For a 1M and an 8k chat model, every outbound
 * request's prompt (messages + tools, chars / 4) must stay within half the
 * model's context window, every tool_call must keep its tool message, and the
 * turn must render its answer with no error row and a clean console.
 * Numbers for every round land in BUDGET_REPORT (agentBudget.helpers.ts).
 */
const FULL_TIER = { deviceMemory: 8, hardwareConcurrency: 8 };
const QUESTIONS = [
  'Budget question one: what did this period mean for my career?',
  'Budget question two: and for my relationships?',
  'Budget question three: what about money and savings?',
  'Budget question four: how was my health then?',
  'Budget question five: which planets mattered most?',
  'Budget question six: sum it all up for me.',
] as const;

async function prepare(page: Page, testInfo: TestInfo, model: MockModelId): Promise<string[]> {
  const capture = captureReloadConsole(page, testInfo);
  await page.addInitScript((tier) => {
    for (const [name, value] of Object.entries(tier)) {
      Object.defineProperty(Navigator.prototype, name, { get: () => value, configurable: true });
    }
  }, FULL_TIER);
  const settings = { apiBase: 'https://openrouter.ai/api/v1', apiKey: 'test-key', model, chatModel: model, privacyMode: 'cloud_premium', engine: 'openai-http' };
  await page.addInitScript(
    ([key, cfg]) => window.localStorage.setItem(key as string, cfg as string),
    [LLM_SETTINGS_KEY, JSON.stringify(settings)] as const,
  );
  return capture.errors;
}

async function openChat(page: Page): Promise<void> {
  await bootEngine(page);
  await seedChart(page);
  await gotoSettled(page, '/dashboard');
  await waitForLifeAtlasAsOf(page);
  await page.getByTestId('floating-chat-button').click({ timeout: 120_000 });
  await expect(page.getByTestId('floating-chat-drawer')).toBeVisible();
}

/** ⏳ → Month → May 2019 → Singapore → Go: a new trip thread. */
async function travelToSingapore(page: Page): Promise<void> {
  await page.getByTestId('time-travel-button').click();
  await expect(page.getByTestId('time-travel-sheet')).toBeVisible();
  await page.getByTestId('time-travel-tab-month').click();
  await page.getByTestId('time-travel-month').selectOption('05');
  await page.getByTestId('time-travel-month-year').selectOption('2019');
  await page.getByTestId('time-travel-where-input').fill('Singapore');
  await page.getByTestId('time-travel-where-option-0').click({ timeout: 60_000 });
  await page.getByTestId('time-travel-go').click();
  await expect(page.getByTestId('time-travel-sheet')).toBeHidden();
  await expect(page.getByTestId('chat-thread-title')).toHaveText(/^⏳ May 2019 · Singapore/);
}

/** Send one question and wait for its answer or an error row, whichever comes first. */
async function askAndSettle(page: Page, provider: BudgetProvider, question: string): Promise<void> {
  const turn = provider.ask(question);
  await page.getByTestId('chat-input').fill(question);
  await page.getByTestId('chat-send-button').click();
  const answer = page.getByTestId('chat-message-assistant').filter({ hasText: answerText(turn) });
  const error = page.getByTestId('chat-error-bubble');
  await expect(answer.or(error).first()).toBeVisible({ timeout: 300_000 });
  expect.soft(await error.count(), `turn ${turn + 1}: no chat error row (${await error.allTextContents()})`).toBe(0);
  await expect.soft(answer, `turn ${turn + 1}: the final answer renders`).toBeVisible();
}

/** The app's own per-round rows (hook builds only). */
async function appTelemetry(page: Page): Promise<readonly unknown[]> {
  const rows = await page.evaluate(() => (window as unknown as { __almameshAgentRounds?: () => unknown[] }).__almameshAgentRounds?.());
  expect.soft(rows, 'window.__almameshAgentRounds is exposed by the hook build').toBeDefined();
  return rows ?? [];
}

/** The stub's stress plan was actually reached: rounds 3-4, the six-call round, a repeat and a compaction (1M); the budget gate closing the turn (8k). */
function assertStressReached(provider: BudgetProvider, model: MockModelId): void {
  const toolRounds = provider.captured.filter((request) => request.reply !== 'answer');
  const deepest = Math.max(0, ...toolRounds.map((request) => request.round));
  expect.soft(toolMessagesContaining(provider.captured, 'compacted'), 'a consumed tool result was compacted').toBeGreaterThan(0);
  if (model === 'mock/ctx-8k') {
    // Contract changed 2026-10-13 (period-reading merge): this asserted that an 8k window still
    // reaches decision round 3. The trip's first request is now ~3.2k of the 4,096-token turn
    // budget (system prompt ~5 KB, seven tool schemas ~6.8 KB with get_period_reading and
    // get_period_detail), so after round 1's results the budget gate closes the turn: one tool
    // round, then the app grounds the reading locally and answers with tools off. Asserted as
    // that, so a regression in the gate still fails here.
    expect.soft(deepest, 'an 8k trip still runs one tool round').toBeGreaterThanOrEqual(1);
    expect.soft(provider.captured.filter((request) => request.toolChoice === 'none' && JSON.stringify(request.messages).includes('context budget for this turn is used up')).length,
      'the budget gate, not a crash, closed every 8k turn').toBe(new Set(provider.captured.map((request) => request.turn)).size);
    return;
  }
  // The 1M window must run all four rounds.
  expect.soft(deepest, 'the stub answered decision round 4 with tool calls').toBe(4);
  expect.soft(toolRounds.some((request) => request.reply.length === 6), 'the six-parallel round was requested').toBe(true);
  expect.soft(toolMessagesContaining(provider.captured, 'unchanged; see the earlier result'), 'an identical repeat came back "unchanged"').toBeGreaterThan(0);
}

async function assertBudget(page: Page, provider: BudgetProvider, model: MockModelId, journey: string, turns: number): Promise<void> {
  const contextLength = MOCK_MODELS.find((entry) => entry.id === model)?.context_length ?? 0;
  const budget = Math.floor(0.5 * contextLength);
  const rounds = roundRecords(model, journey, budget, provider.captured);
  writeBudgetReport(model, journey, rounds, await appTelemetry(page));
  console.log(JSON.stringify(turnRecords(rounds).map(({ turn, requests, peak, sum }) => ({ model, journey, turn, requests, peak, sum, budget }))));
  expect(new Set(provider.captured.map((request) => request.turn)).size, 'every turn reached the provider').toBe(turns);
  for (const request of provider.captured) {
    const where = `${model} ${journey} turn ${request.turn + 1} round ${request.round} (tool_choice ${request.toolChoice})`;
    expect.soft(estimatePromptTokens(request), `${where}: prompt within floor(0.5 × ${contextLength}) = ${budget}`).toBeLessThanOrEqual(budget);
    expect.soft(pairingViolations(request.messages), `${where}: every tool_call keeps its tool message`).toEqual([]);
    // A budget-closed trip still runs its required grounding tools before it answers.
    if (request.toolChoice === 'none') {
      expect.soft(JSON.stringify(request.messages), `${where}: every required trip tool ran`).not.toContain('did not succeed this turn');
    }
  }
  assertStressReached(provider, model);
}

for (const { id: model } of MOCK_MODELS) {
  test(`[stress/stubbed] ${model}: one trip question driven to max tool rounds stays within budget`, async ({ page }, testInfo) => {
    test.setTimeout(900_000);
    const consoleErrors = await prepare(page, testInfo, model);
    const provider = new BudgetProvider();
    await provider.install(page);
    await openChat(page);
    await travelToSingapore(page);
    await askAndSettle(page, provider, QUESTIONS[0]);
    await assertBudget(page, provider, model, 'trip-max-rounds', 1);
    expect.soft(consoleErrors, 'a clean console').toEqual([]);
  });

  test(`[stress/stubbed] ${model}: a six-turn trip thread stays within budget every turn`, async ({ page }, testInfo) => {
    test.setTimeout(1_800_000);
    const consoleErrors = await prepare(page, testInfo, model);
    const provider = new BudgetProvider();
    await provider.install(page);
    await openChat(page);
    await travelToSingapore(page);
    for (const question of QUESTIONS) await askAndSettle(page, provider, question);
    await assertBudget(page, provider, model, 'trip-six-turns', QUESTIONS.length);
    expect.soft(consoleErrors, 'a clean console').toEqual([]);
  });
}
