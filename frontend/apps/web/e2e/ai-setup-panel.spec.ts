// frontend/apps/web/e2e/ai-setup-panel.spec.ts
import { mkdirSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';

import { test } from './webkitProfile';
import { collectConsoleErrors } from './live/liveJourney';
import {
  fillLocalEndpoint,
  fillOpenRouterKey,
  openAiSettings,
  saveLocalEndpoint,
  saveOpenRouterKey,
  stubLocalEndpoint,
  stubOpenRouter,
} from './aiSetupPanel.helpers';

/**
 * Settings → AI after the move to the shared AiSetupPanel (PR 1): it looks
 * exactly as before. Element screenshots are compared pixel-for-pixel against
 * baselines captured from the pre-move code (Task 1.1), in desktop Chromium and
 * the iPhone 15 WebKit profile.
 *
 * LOCAL ONLY: the baselines live in gitignored shots/. The privacy claim (the
 * key goes only to the provider you choose) is the CI-run
 * ai-setup-panel.egress.spec.ts.
 *
 * Run:  bun run test:e2e:ai-panel   (macOS for the WebKit project)
 */

const SHOTS = 'shots/pr1-ai-setup-panel';

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

  test('connecting OpenRouter looks as before', async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await stubOpenRouter(page);
    await openAiSettings(page);
    await fillOpenRouterKey(page);
    await saveOpenRouterKey(page);
    await expect(page.getByTestId('ai-model-settings')).toHaveScreenshot('settings-ai-connected.png');
    await evidence(page, 'settings-ai-connected');
    expect(errors).toEqual([]);
  });

  test('a connected local endpoint looks as before', async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await stubOpenRouter(page);
    await stubLocalEndpoint(page);
    await openAiSettings(page);
    await fillLocalEndpoint(page);
    await saveLocalEndpoint(page);
    await expect(page.getByTestId('ai-model-settings')).toHaveScreenshot('settings-ai-local-connected.png');
    await evidence(page, 'settings-ai-local-connected');
    expect(errors).toEqual([]);
  });
});
