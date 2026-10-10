// frontend/apps/web/e2e/ai-setup-panel.spec.ts
import { mkdirSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';

import { test } from './webkitProfile';
import { collectConsoleErrors } from './live/liveJourney';
import { recordEgress, stubLocalEndpoint, stubOpenRouter } from './aiSetupPanel.helpers';

/**
 * Settings → AI after the move to the shared AiSetupPanel (PR 1).
 *
 * 1. It looks exactly as before: element screenshots are compared pixel-for-pixel
 *    against baselines captured from the pre-move code (Task 1.1), in desktop
 *    Chromium and the iPhone 15 WebKit profile.
 * 2. The claim still holds: the key is sent only to the provider the user chose.
 *
 * Run:  bun run test:e2e:ai-panel   (macOS for the WebKit project)
 */

const DUMMY_KEY = 'sk-or-test-panel-key-0000000000';
const SHOTS = 'shots/pr1-ai-setup-panel';

async function openAiSettings(page: Page): Promise<void> {
  await page.goto('/settings/ai');
  await expect(page.getByRole('heading', { name: 'AI Model' })).toBeVisible();
  await expect(page.getByTestId('ai-model-settings')).toBeVisible();
}

async function evidence(page: Page, name: string): Promise<void> {
  const dir = `${SHOTS}/${test.info().project.name}`;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
}

test.describe('Settings → AI renders the shared panel unchanged', () => {
  test('AI off (the default) looks exactly as before', async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await stubOpenRouter(page);
    await openAiSettings(page);
    await expect(page.getByTestId('tier-none-active')).toBeVisible();
    await expect(page.getByTestId('ai-model-settings')).toHaveScreenshot('settings-ai-off.png');
    await evidence(page, 'settings-ai-off');
    expect(errors).toEqual([]);
  });

  test('connecting OpenRouter looks as before and sends the key only to openrouter.ai', async ({
    page,
    baseURL,
  }) => {
    const errors = collectConsoleErrors(page);
    await stubOpenRouter(page);
    const egress = recordEgress(page, new URL(baseURL ?? '').origin);
    await openAiSettings(page);

    await page.getByTestId('llm-openrouter-key').fill(DUMMY_KEY);
    await page.getByTestId('llm-save').click();
    await expect(page.getByTestId('llm-connection-result')).toContainText(/Connected/, { timeout: 15_000 });
    await expect(page.getByTestId('llm-credits-value')).toContainText('$8.00');

    await expect(page.getByTestId('ai-model-settings')).toHaveScreenshot('settings-ai-connected.png');
    await evidence(page, 'settings-ai-connected');

    const sent = await egress.settle();
    const keyed = sent.filter((entry) => entry.authorization?.includes(DUMMY_KEY));
    expect(sent.every((entry) => entry.host === 'openrouter.ai')).toBe(true);
    expect(keyed.map((entry) => entry.path)).toContain('/api/v1/chat/completions');
    expect(keyed.every((entry) => entry.host === 'openrouter.ai')).toBe(true);
    // The model catalog is a public read: it never carries the key. Require the read
    // to have happened, so the `.every` below can never pass vacuously.
    expect(sent.some((e) => e.path.endsWith('/models'))).toBe(true);
    expect(sent.filter((e) => e.path.endsWith('/models')).every((e) => e.authorization === null)).toBe(true);
    expect(errors).toEqual([]);
  });

  test('a local endpoint is probed locally and nothing goes to openrouter.ai', async ({ page, baseURL }) => {
    const errors = collectConsoleErrors(page);
    await stubOpenRouter(page);
    await stubLocalEndpoint(page);
    const egress = recordEgress(page, new URL(baseURL ?? '').origin);
    await openAiSettings(page);

    await page.getByTestId('llm-advanced-summary').click();
    await page.getByTestId('llm-api-base').fill('http://localhost:11434/v1');
    await page.getByTestId('llm-model').fill('llama3.1');
    await page.keyboard.press('Escape');
    await page.getByTestId('llm-save-advanced').click();
    await expect(page.getByTestId('llm-connection-result').last()).toContainText(/Connected/, {
      timeout: 15_000,
    });
    await expect(page.getByTestId('llm-credits')).toHaveCount(0);

    await expect(page.getByTestId('ai-model-settings')).toHaveScreenshot('settings-ai-local-connected.png');
    await evidence(page, 'settings-ai-local-connected');

    const sent = await egress.settle();
    expect(sent.filter((entry) => entry.host === 'openrouter.ai')).toEqual([]);
    expect(sent.map((entry) => `${entry.host}${entry.path}`)).toContain('localhost:11434/v1/chat/completions');
    expect(errors).toEqual([]);
  });
});
