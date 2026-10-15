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
 * Chat turn context budget, stress (plan 2026-10-13 Phase 1; chat tool layer
 * redesign 2026-10-14). A stubbed OpenRouter answers three rounds with as many
 * read_period calls as it can (a read, an identical repeat plus a new span, six at
 * once past the per-turn cap), then answers with an `answer` call. For a 1M and an
 * 8k chat model, every outbound request's prompt (messages + tools, chars / 4) must
 * stay within half the model's context window, every tool_call must keep its tool
 * message, and the turn must render its answer with no error row and a clean console.
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

const FORCED_ANSWER = JSON.stringify({ type: 'function', function: { name: 'answer' } });

/**
 * A 1M window: the stub's stress plan was actually reached: all three read rounds, the
 * six-call round, and the per-turn read_period cap answering the extra calls as skipped.
 * An 8k window: the budget closed every turn (Task 6b, 2026-10-14, restoring the old loop's
 * budget gate on the seam): its last request offers only `answer`, forces it, and carries the
 * budget note, and that request's estimate still fits (assertBudget).
 */
function assertStressReached(provider: BudgetProvider, model: MockModelId): void {
  if (model === 'mock/ctx-8k') return assertBudgetClosed(provider);
  const toolRounds = provider.captured.filter((request) => request.reply !== 'answer');
  const deepest = Math.max(0, ...toolRounds.map((request) => request.round));
  expect.soft(deepest, 'the stub answered read round 3 with tool calls').toBe(3);
  expect.soft(toolRounds.some((request) => request.reply.length === 6), 'the six-parallel round was requested').toBe(true);
  expect.soft(toolMessagesContaining(provider.captured, 'already read enough'), 'calls past the read_period cap came back skipped').toBeGreaterThan(0);
  expect.soft(provider.captured.filter((request) => request.toolChoice === FORCED_ANSWER), 'a 1M window never forces the answer').toEqual([]);
  // Restored (final review): dropped with the old loop in 8e852548; the seam's budget compacts
  // only under pressure, so a 1M window still carries every result whole.
  expect.soft(toolMessagesContaining(provider.captured, '"compacted":true'), 'a 1M window never compacts a tool result').toBe(0);
}

function assertBudgetClosed(provider: BudgetProvider): void {
  const turns = new Set(provider.captured.map((request) => request.turn));
  for (const turn of turns) {
    const last = provider.captured.filter((request) => request.turn === turn).at(-1);
    const where = `turn ${turn + 1} round ${last?.round}`;
    expect.soft(last?.toolChoice, `${where}: the budget forces the answer`).toBe(FORCED_ANSWER);
    expect.soft(last?.toolNames, `${where}: only the answer tool is offered`).toEqual(['answer']);
    const notes = (last?.messages ?? []).filter((message) => message.role === 'system').map((message) => message.content ?? '');
    expect.soft(notes.some((note) => note.startsWith('The context budget for this turn is used up')), `${where}: the budget note`).toBe(true);
  }
}

async function assertBudget(page: Page, provider: BudgetProvider, model: MockModelId, journey: string, turns: number): Promise<void> {
  const contextLength = MOCK_MODELS.find((entry) => entry.id === model)?.context_length ?? 0;
  const budget = Math.floor(0.5 * contextLength);
  const rounds = roundRecords(model, journey, budget, provider.captured);
  const telemetry = await appTelemetry(page);
  writeBudgetReport(model, journey, rounds, telemetry);
  console.log(JSON.stringify(turnRecords(rounds).map(({ turn, requests, peak, sum }) => ({ model, journey, turn, requests, peak, sum, budget }))));
  expect(new Set(provider.captured.map((request) => request.turn)).size, 'every turn reached the provider').toBe(turns);
  for (const request of provider.captured) {
    const where = `${model} ${journey} turn ${request.turn + 1} round ${request.round} (tool_choice ${request.toolChoice})`;
    expect.soft(estimatePromptTokens(request), `${where}: prompt within floor(0.5 × ${contextLength}) = ${budget}`).toBeLessThanOrEqual(budget);
    expect.soft(pairingViolations(request.messages), `${where}: every tool_call keeps its tool message`).toEqual([]);
  }
  assertStressReached(provider, model);
  if (model === 'mock/ctx-8k') assertAppCompacted(telemetry, budget);
}

interface AppRoundRow {
  readonly turn: number;
  readonly round: number;
  readonly estimate: number;
  readonly budget: number;
  readonly compacted: number;
}

/**
 * The app's own rows: each 8k turn's last (forced-answer) round carried its reading compact and its
 * calibrated estimate fits. The wire-side chars/4 check above has only a few tokens of margin there,
 * so it cannot tell whether compaction ran; the loop's provider-calibrated estimate can.
 */
function assertAppCompacted(telemetry: readonly unknown[], budget: number): void {
  const rows = telemetry as readonly AppRoundRow[];
  const turns = [...new Set(rows.map((row) => row.turn))];
  expect.soft(turns.length, 'the app recorded round rows').toBeGreaterThan(0);
  for (const turn of turns) {
    const last = rows.filter((row) => row.turn === turn).at(-1);
    expect.soft(last?.compacted, `app turn ${turn} round ${last?.round}: the forced answer carried its reading compact`).toBeGreaterThan(0);
    expect.soft(last?.estimate, `app turn ${turn} round ${last?.round}: the loop's calibrated estimate fits`).toBeLessThanOrEqual(budget);
    expect.soft(last?.budget, `app turn ${turn}: the app's budget is half the window`).toBe(budget);
  }
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
