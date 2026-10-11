import { mkdirSync } from 'node:fs';
import { expect, test, type Request } from '@playwright/test';

import { collectConsoleErrors } from './live/liveJourney';
import { E2E_REAL_MODEL } from './realModel';

/**
 * The shared AI setup panel against LIVE OpenRouter: paste a real key, Save,
 * and the real connectivity probe reports Connected on the cheapest e2e model.
 * No route stubs. The key comes only from the runner's env (never a VITE_ var).
 *
 * Run:  OPENROUTER_API_KEY=... bun run test:e2e:ai:real
 */
const KEY = process.env.OPENROUTER_API_KEY ?? '';

test.describe('AI setup panel — live OpenRouter', () => {
  test.skip(!KEY, 'OPENROUTER_API_KEY is not set: the live key test needs a real OpenRouter key');

  test('[real] Settings → AI connects a live key on the e2e model', async ({ page }) => {
    const errors = collectConsoleErrors(page);
    const probes: Request[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/chat/completions')) probes.push(request);
    });

    await page.goto('/settings/ai');
    await expect(page.getByRole('heading', { name: 'AI Model' })).toBeVisible();
    await page.getByTestId('llm-advanced-summary').click();
    await page.getByTestId('llm-model').fill(E2E_REAL_MODEL);
    await page.keyboard.press('Escape');
    await page.getByTestId('llm-openrouter-key').fill(KEY);
    await page.getByTestId('llm-save').click();

    await expect(page.getByTestId('llm-connection-result').first()).toContainText(/Connected/, {
      timeout: 90_000,
    });
    await expect(page.getByTestId('llm-credits-value')).toBeVisible({ timeout: 30_000 });
    expect(probes).toHaveLength(1);
    expect(new URL(probes[0].url()).host).toBe('openrouter.ai');
    expect((probes[0].postDataJSON() as { model: string }).model).toBe(E2E_REAL_MODEL);

    mkdirSync('shots/pr1-ai-setup-panel/real', { recursive: true });
    await page.screenshot({ path: 'shots/pr1-ai-setup-panel/real/settings-ai-live-connected.png', fullPage: true });
    expect(errors).toEqual([]);
  });
});
