/**
 * The onboarding AI step and the chat's no-AI prompt, driven through REAL
 * onboarding (no hooks, real engine) on desktop Chromium, desktop WebKit and an
 * iPhone 15 (WebKit).
 *
 * A fresh chart with no AI lands on /onboarding/ai: "Connect AI" has focus,
 * Enter opens the shared setup panel titled once, Escape returns focus, and
 * "Not now" reaches the dashboard. With no AI the chat shows one line and a
 * button that opens the same panel in place. The console stays clean.
 *
 * Run:  bun run test:e2e:onboarding-ai
 */
import { expect, type Page } from '@playwright/test';

import { collectConsoleErrors, generateChart } from './live/liveJourney';
// WebKit gets an on-disk profile, as real Safari and iOS do (no "not saving" banner).
import { test } from './webkitProfile';

async function shot(page: Page, name: string): Promise<void> {
  // Viewport-sized evidence; SHOT_DIR collects them outside the test output too.
  const dir = process.env.SHOT_DIR;
  const file = `${test.info().project.name}-${name}.png`;
  await page.screenshot({ path: dir ? `${dir}/${file}` : test.info().outputPath(file) });
}

async function noHorizontalScroll(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
}

test('no AI: the AI step, its panel, "Not now", then the chat prompt opens the same panel', async ({ page }) => {
  test.setTimeout(420_000);
  const errors = collectConsoleErrors(page);

  await page.goto('/onboarding');
  await generateChart(page);
  await page.waitForURL('**/onboarding/ai', { timeout: 300_000 });

  const connect = page.getByTestId('onboarding-ai-connect');
  await expect(page.getByRole('heading', { name: 'Your chart is ready' })).toBeVisible();
  await expect(connect).toBeFocused();
  await expect(page.getByTestId('onboarding-ai-not-now')).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);
  await shot(page, 'ai-step');

  await connect.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Connect AI' });
  await expect(dialog.getByTestId('llm-openrouter-key')).toBeVisible();
  await expect(dialog.getByText('Connect AI', { exact: true })).toHaveCount(1);
  await expect(dialog.getByTestId('tier-cloud-honesty')).toBeHidden();
  await page.waitForTimeout(500); // let the open animation settle for the shot
  await shot(page, 'ai-panel');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(connect).toBeFocused();

  await page.getByTestId('onboarding-ai-not-now').click();
  await page.waitForURL('**/dashboard', { timeout: 30_000 });
  await expect(page.getByTestId('chart-visualization').first()).toBeVisible({ timeout: 60_000 });

  await page.getByTestId('floating-chat-button').click({ timeout: 60_000 });
  const prompt = page.getByTestId('chat-connect-ai');
  await expect(prompt).toContainText('Connect an AI model');
  await prompt.scrollIntoViewIfNeeded();
  await shot(page, 'chat-prompt');
  await page.getByTestId('chat-connect-ai-link').click();
  await expect(page.getByRole('dialog', { name: 'Connect AI' }).getByTestId('llm-openrouter-key')).toBeVisible();

  expect(errors).toEqual([]);
});
