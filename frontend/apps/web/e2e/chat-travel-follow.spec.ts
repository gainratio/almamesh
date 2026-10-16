/**
 * Three chat journeys (the first two caught by the dashboard.agentic real spec, 0/2, 2026-10-14), with a stubbed
 * provider and the real engine:
 *
 *  1. "Take me to September 2017 in Mumbai": the travel tool opens a new trip thread and the
 *     answer follows the user there; the thread it was asked in keeps one clickable line.
 *  3. A model that calls travel without being asked (2026-10-16): the answer carries a "Move to…?" button;
 *     it moves only on a tap, and expires on the next question.
 *  2. A today question sent before the predictive layer is ready waits ("Preparing your chart…")
 *     and goes out WITH the ENGINE TIMING CONTEXT block once it is.
 *
 * Run: bunx playwright test --config=playwright.time-travel.config.ts e2e/chat-travel-follow.spec.ts
 */
import { expect, type Page } from '@playwright/test';

import { LLM_SETTINGS_KEY, bootEngine, seedChart } from './interpretation.helpers';
import { waitForLifeAtlasAsOf } from './lifeAtlas.helpers';
import { stubModelCatalog } from './modelCatalog.helpers';
import { gotoSettled } from './portableInvariants.helpers';
import { chatToolBody, fulfillEmpty, fulfillToolCall, generalAnswer, type ChatToolBody } from './stubChatProvider';
import { test } from './webkitProfile';

const LLM_CONFIG = {
  apiBase: 'https://openrouter.ai/api/v1',
  apiKey: 'test-key',
  model: 'deepseek/deepseek-v4-pro',
  privacyMode: 'cloud_premium',
  engine: 'openai-http',
};
const SHOTS = process.env.TRAVELFIX_SHOTS ?? 'test-results';
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };

async function prepare(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.addInitScript((tier) => {
    for (const [name, value] of Object.entries(tier)) {
      Object.defineProperty(Navigator.prototype, name, { get: () => value, configurable: true });
    }
  }, { deviceMemory: 8, hardwareConcurrency: 8 });
  await page.addInitScript(([key, cfg]) => window.localStorage.setItem(key as string, cfg as string), [LLM_SETTINGS_KEY, JSON.stringify(LLM_CONFIG)] as const);
  await stubModelCatalog(page);
  return errors;
}

async function todayOnDashboard(page: Page): Promise<void> {
  const today = await page.evaluate(() => new Intl.DateTimeFormat('en', { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date()));
  await expect(page.getByTestId('provenance-footer')).toContainText(`As of ${today}`, { timeout: 120_000 });
}

async function send(page: Page, question: string): Promise<void> {
  await page.getByTestId('chat-input').fill(question);
  await page.getByTestId('chat-send-button').click();
}

async function shoot(page: Page, name: string): Promise<void> {
  await page.setViewportSize(PHONE);
  await page.screenshot({ path: `${SHOTS}/${name}-390.png` });
  await page.setViewportSize(DESKTOP);
  await page.screenshot({ path: `${SHOTS}/${name}-desktop.png` });
}

test('[contract/stubbed] a chat travel takes its question and answer into the new trip; the old thread points there', async ({ page }) => {
  const errors = await prepare(page);
  await page.setViewportSize(DESKTOP);
  const asked: string[] = [];
  await page.route('**/chat/completions', async (route) => {
    const chat = chatToolBody(route.request().postData());
    if (!chat) return fulfillEmpty(route);
    const prompt = JSON.stringify(chat.messages);
    asked.push(prompt);
    // The second turn's prompt carries the first as history, so test for the travel request first.
    if (!prompt.includes('Take me to September 2017')) return fulfillToolCall(route, { name: 'answer', args: generalAnswer('Hello to you too.') });
    const travelled = chat.messages.some((message) => message.role === 'tool');
    if (!travelled) return fulfillToolCall(route, { name: 'travel', args: { to: '2017-09', place: 'Mumbai' } }, 'call_travel');
    return fulfillToolCall(route, { name: 'answer', args: generalAnswer('September 2017 in Mumbai was a turning month.') }, 'call_answer');
  });

  await bootEngine(page);
  await seedChart(page);
  await gotoSettled(page, '/dashboard');
  await todayOnDashboard(page);
  await page.getByTestId('floating-chat-button').click({ timeout: 60_000 });

  const panel = page.getByTestId('chat-panel');
  await send(page, 'Hello');
  await expect(panel.getByText('Hello to you too.')).toBeVisible({ timeout: 60_000 });

  await send(page, 'Take me to September 2017 in Mumbai');
  await expect(page.getByTestId('time-travel-banner')).toBeVisible({ timeout: 120_000 });
  await expect(panel.getByTestId('chat-message-assistant').last()).toContainText('September 2017 in Mumbai was a turning month.', { timeout: 60_000 });
  await expect(panel.getByTestId('chat-message-user')).toHaveCount(1);
  await expect(panel.getByTestId('chat-message-user')).toContainText('Take me to September 2017 in Mumbai');
  await expect(panel.getByText('Hello to you too.')).toHaveCount(0);
  await expect(page.getByTestId('time-travel-button')).toBeEnabled({ timeout: 60_000 });
  await shoot(page, 'after-travel-thread');

  // The today thread keeps one quiet line pointing at the trip.
  await page.getByTestId('chat-threads-button').click();
  await page.getByText('Hello', { exact: true }).click();
  const pointer = panel.getByTestId('chat-moved-pointer');
  await expect(pointer).toHaveText(/^Moved to ⏳ Sep 2017 · Mumbai/);
  await expect(panel.getByText('Hello to you too.')).toBeVisible();
  await expect(panel.getByTestId('chat-message-user')).toHaveCount(1);
  await shoot(page, 'old-thread-pointer');
  await pointer.click();
  await expect(page.getByTestId('time-travel-banner')).toBeVisible();
  await expect(panel.getByTestId('chat-message-assistant').last()).toContainText('September 2017 in Mumbai was a turning month.');
  expect(errors, 'clean console').toEqual([]);
});

test('[contract/stubbed] a travel call nobody asked for becomes a "Move to…?" button: a tap moves, the next question expires it', async ({ page }) => {
  const errors = await prepare(page);
  await page.setViewportSize(DESKTOP);
  // Each turn's prompt carries the earlier ones as history, so the test says which kind of turn is running.
  let phase: 'offer' | 'plain' = 'offer';
  await page.route('**/chat/completions', async (route) => {
    const chat = chatToolBody(route.request().postData());
    if (!chat) return fulfillEmpty(route);
    if (phase === 'plain') return fulfillToolCall(route, { name: 'answer', args: generalAnswer('Plain answer.') });
    const travelled = chat.messages.some((message) => message.role === 'tool');
    if (!travelled) return fulfillToolCall(route, { name: 'travel', args: { to: '2017-09', place: 'Mumbai' } }, 'call_travel');
    return fulfillToolCall(route, { name: 'answer', args: generalAnswer('September 2017 asked for patience. Tap the button if you want to go there.') }, 'call_answer');
  });

  await bootEngine(page);
  await seedChart(page);
  await gotoSettled(page, '/dashboard');
  await todayOnDashboard(page);
  await page.getByTestId('floating-chat-button').click({ timeout: 60_000 });
  const panel = page.getByTestId('chat-panel');

  // Asked about another time, the model called travel anyway: nothing moves, a button is offered.
  await send(page, 'How was September 2017 for me?');
  const offer = panel.getByRole('button', { name: 'Move to Sep 2017?' }).or(panel.getByRole('button', { name: 'Move to September 2017?' }));
  await expect(offer).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId('time-travel-banner')).toHaveCount(0);
  await expect(panel.getByTestId('chat-message-assistant').last()).not.toContainText('moved');
  expect((await offer.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  await shoot(page, 'travel-offer');

  // The next question expires it.
  phase = 'plain';
  await send(page, 'Hello');
  await expect(panel.getByText('Plain answer.')).toBeVisible({ timeout: 60_000 });
  await expect(panel.getByTestId('travel-offer')).toHaveCount(0);
  phase = 'offer';

  // A fresh offer: the tap is the request, and it goes to the offered trip only.
  await send(page, 'How was September 2017 for me?');
  await expect(offer).toBeVisible({ timeout: 120_000 });
  await offer.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('time-travel-banner')).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId('time-travel-banner')).toContainText('Mumbai');
  await expect(panel.getByTestId('travel-offer')).toHaveCount(0);
  expect(errors, 'clean console').toEqual([]);
});

test('[contract/stubbed] a today question sent before the predictive layer is ready waits, then carries its facts', async ({ page }) => {
  const errors = await prepare(page);
  await page.setViewportSize(DESKTOP);
  // Hold the dashboard's predictive compute until the test releases it.
  await page.addInitScript(() => {
    if (!window.location.pathname.startsWith('/dashboard')) return;
    const post = Worker.prototype.postMessage;
    const held: Array<[Worker, Parameters<Worker['postMessage']>]> = [];
    let released = false;
    (window as unknown as { __releasePredictive: () => void }).__releasePredictive = () => {
      released = true;
      for (const [worker, args] of held.splice(0)) post.apply(worker, args);
    };
    Worker.prototype.postMessage = function (this: Worker, ...args: Parameters<Worker['postMessage']>) {
      const message = args[0] as { kind?: string } | null;
      if (!released && message?.kind === 'computePredictive') {
        held.push([this, args]);
        return;
      }
      return post.apply(this, args);
    } as Worker['postMessage'];
  });
  const agentRequests: ChatToolBody[] = [];
  await page.route('**/chat/completions', async (route) => {
    const chat = chatToolBody(route.request().postData());
    if (!chat) return fulfillEmpty(route);
    agentRequests.push(chat);
    return fulfillToolCall(route, { name: 'answer', args: generalAnswer('Saturn steadies your day.') });
  });

  await bootEngine(page);
  await seedChart(page);
  await gotoSettled(page, '/dashboard');
  await todayOnDashboard(page);
  await page.getByTestId('floating-chat-button').click({ timeout: 60_000 });
  await send(page, 'What matters for me today?');

  await expect(page.getByTestId('chat-agent-status')).toHaveText('Preparing your chart…', { timeout: 30_000 });
  await page.waitForTimeout(3_000);
  expect(agentRequests, 'nothing leaves before the predictive facts are ready').toHaveLength(0);
  await shoot(page, 'waiting-status');

  await page.evaluate(() => (window as unknown as { __releasePredictive: () => void }).__releasePredictive());
  await waitForLifeAtlasAsOf(page);
  await expect(page.getByTestId('chat-panel').getByText('Saturn steadies your day.')).toBeVisible({ timeout: 120_000 });
  const prompt = JSON.stringify(agentRequests[0]?.messages ?? []);
  expect(prompt).toContain('ENGINE TIMING CONTEXT');
  expect(prompt).toContain('Current transits (Gochara)');
  await expect(page.getByTestId('chat-panel')).not.toContainText('birth chart only');
  expect(errors, 'clean console').toEqual([]);
});
