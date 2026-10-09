import { test, expect, type Page } from '@playwright/test';
import { bootEngine, seedChart, LLM_SETTINGS_KEY } from './interpretation.helpers';

/**
 * Saves finish before the app says they're done.
 *
 * Every journey here waits for the app's own "done" signal and then does a
 * full page load with NO extra wait. The data must survive. Before the fix a
 * finished chat turn could be lost this way: the turn ended while the SQLite
 * write was still queued.
 */

const DUMMY_KEY = 'sk-or-test-dummy-key-1234567890';
const QUESTION = 'How is my Saturn this year?';
const ANSWER = 'Saturn is steady for you this year.';

const LLM_CONFIG = {
  apiBase: 'https://openrouter.ai/api/v1',
  apiKey: 'test-key',
  model: 'deepseek/deepseek-v4-pro',
  privacyMode: 'cloud_premium',
  engine: 'openai-http',
};

/** Stub OpenRouter: catalog/credits/probe answer, and a one-shot chat answer. */
async function stubOpenRouter(page: Page): Promise<void> {
  await page.route('https://openrouter.ai/**', async (route) => {
    const url = route.request().url();
    if (url.includes('/models')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"data":[]}' });
    }
    if (url.includes('/credits')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: { total_credits: 10, total_usage: 2 } }),
      });
    }
    if (url.includes('/chat/completions')) {
      const parsed = JSON.parse(route.request().postData() ?? '{}') as {
        tools?: unknown[];
        stream?: boolean;
      };
      if (!Array.isArray(parsed.tools)) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: '{"ok":true}' } }] }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: `data: ${JSON.stringify({ choices: [{ delta: { content: ANSWER } }] })}\n\ndata: [DONE]\n\n`,
      });
    }
    return route.fulfill({ status: 418, body: 'unexpected OpenRouter call in e2e' });
  });
}

/**
 * In-page: the moment the chat panel shows `answer` with the turn ended (no
 * spinner on Send), start a full page load. Resolves as the load begins.
 */
function reloadWhenTurnEnds(answer: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const turnEnded = (): boolean => {
      const panel = document.querySelector('[data-testid="chat-panel"]');
      const spinner = document.querySelector('[data-testid="chat-send-button"] svg.animate-spin');
      return (panel?.textContent ?? '').includes(answer) && spinner === null;
    };
    const observer = new MutationObserver(() => {
      if (!turnEnded()) return;
      observer.disconnect();
      resolve();
      window.location.assign('/dashboard');
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  });
}

/** In-page: start a full page load the instant the AI badge reads OpenRouter. */
function reloadWhenBadgeFlips(): Promise<void> {
  return new Promise<void>((resolve) => {
    const observer = new MutationObserver(() => {
      const badge = document.querySelector('[data-testid="ai-status-badge"]');
      if (!/AI:\s*OpenRouter/.test(badge?.textContent ?? '')) return;
      observer.disconnect();
      resolve();
      window.location.reload();
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
  });
}

test('a saved AI key survives an immediate full page load', async ({ page }) => {
  await stubOpenRouter(page);
  await page.goto('/settings/ai');
  const badge = page.getByTestId('ai-status-badge');
  await expect(badge).toHaveText(/Set up AI/);

  await page.getByTestId('llm-openrouter-key').fill(DUMMY_KEY);
  // The app's "saved" signal is the header badge flipping to the new provider.
  // Reload from inside the page the instant it flips (no Playwright round trip).
  const reload = page.evaluate(reloadWhenBadgeFlips);
  await page.getByTestId('llm-save').click();
  await reload;
  await page.waitForLoadState('domcontentloaded');

  await expect(page.getByTestId('ai-status-badge')).toHaveText(/AI:\s*OpenRouter/);
  await expect(page.getByTestId('llm-openrouter-key')).toHaveValue(DUMMY_KEY);
});

test('a finished chat turn survives an immediate full page load', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.addInitScript(
    ([key, cfg]) => {
      window.localStorage.setItem(key as string, cfg as string);
    },
    [LLM_SETTINGS_KEY, JSON.stringify(LLM_CONFIG)] as const,
  );
  await stubOpenRouter(page);
  await bootEngine(page);
  await seedChart(page);
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });

  await page.getByTestId('floating-chat-button').click({ timeout: 60_000 });
  const panel = page.getByTestId('chat-panel');
  // The seeded chart is days old: let today's re-anchor land before asking,
  // or the answer is (correctly) discarded as being about a stale chart.
  const today = await page.evaluate(() =>
    new Intl.DateTimeFormat('en', { year: 'numeric', month: 'short', day: 'numeric' }).format(
      new Date(),
    ),
  );
  await expect(page.getByTestId('provenance-footer')).toContainText(`As of ${today}`, {
    timeout: 120_000,
  });
  await expect(page.getByTestId('chat-reanchor-status')).toHaveCount(0);
  await page.getByTestId('chat-input').fill(QUESTION);
  await page.getByTestId('chat-send-button').click();

  // The app's "done" signal: the answer is shown and the turn has ended. The
  // reload starts from inside the page in the same DOM mutation that shows it,
  // like a user hitting refresh the instant the spinner stops (a Playwright
  // round trip here would add tens of ms and hide the race).
  await expect(panel).toBeVisible();
  await page.evaluate(reloadWhenTurnEnds, ANSWER);
  await page.waitForURL(/\/dashboard/);
  await page.waitForLoadState('domcontentloaded');

  await page.getByTestId('floating-chat-button').click({ timeout: 60_000 });
  await expect(page.getByTestId('chat-panel')).toContainText(QUESTION);
  await expect(page.getByTestId('chat-panel')).toContainText(ANSWER);
  expect(pageErrors).toEqual([]);
});
