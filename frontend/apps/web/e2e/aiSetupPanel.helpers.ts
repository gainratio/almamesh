// frontend/apps/web/e2e/aiSetupPanel.helpers.ts
import { expect, type Page, type Request } from '@playwright/test';

/** The dummy OpenRouter key both AI panel specs type; never a real secret. */
export const DUMMY_KEY = 'sk-or-test-panel-key-0000000000';

/** The local Ollama-style endpoint the "local" journeys point the panel at. */
export const LOCAL_API_BASE = 'http://localhost:11434/v1';

/**
 * Stubs for the AI setup panel e2e. Every OpenRouter surface the panel can touch
 * is answered locally; anything else to openrouter.ai is refused loudly (418) so
 * a new egress cannot sneak in. CORS preflights are answered so the same stub
 * works in Chromium and WebKit.
 */
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};

export async function stubOpenRouter(page: Page): Promise<void> {
  await page.route('https://openrouter.ai/**', async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS });
      return;
    }
    const url = request.url();
    if (url.includes('/chat/completions')) {
      await route.fulfill({
        status: 200,
        headers: CORS,
        contentType: 'application/json',
        body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: '{"ok":true}' } }] }),
      });
      return;
    }
    if (url.includes('/credits')) {
      await route.fulfill({
        status: 200,
        headers: CORS,
        contentType: 'application/json',
        body: JSON.stringify({ data: { total_credits: 10, total_usage: 2 } }),
      });
      return;
    }
    if (url.includes('/models')) {
      await route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: '{"data":[]}' });
      return;
    }
    await route.fulfill({ status: 418, headers: CORS, body: 'unexpected OpenRouter call in e2e' });
  });
}

/** A local Ollama-style endpoint that answers only the connectivity probe. */
export async function stubLocalEndpoint(page: Page): Promise<void> {
  await page.route('http://localhost:11434/**', async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS });
      return;
    }
    if (request.url().includes('/chat/completions')) {
      await route.fulfill({
        status: 200,
        headers: CORS,
        contentType: 'application/json',
        body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: '{"ok":true}' } }] }),
      });
      return;
    }
    await route.fulfill({ status: 418, headers: CORS, body: 'unexpected local-endpoint call in e2e' });
  });
}

export interface EgressEntry {
  host: string;
  path: string;
  authorization: string | null;
}

export interface EgressLog {
  /** Every cross-origin request seen so far, with its Authorization header. */
  settle(): Promise<readonly EgressEntry[]>;
}

/** Record every request that leaves the app's own origin. */
export function recordEgress(page: Page, appOrigin: string): EgressLog {
  const pending: Promise<EgressEntry>[] = [];
  page.on('request', (request: Request) => {
    const url = new URL(request.url());
    if (url.origin === appOrigin || url.protocol === 'data:' || url.protocol === 'blob:') return;
    pending.push(
      request.headerValue('authorization').then((authorization) => ({
        host: url.host,
        path: url.pathname,
        authorization,
      })),
    );
  });
  return { settle: () => Promise.all(pending) };
}

/** Hosts that count as "a provider": the hosted one and the local endpoint. */
export const PROVIDER_HOSTS: readonly string[] = ['openrouter.ai', new URL(LOCAL_API_BASE).host];

export async function openAiSettings(page: Page): Promise<void> {
  await page.goto('/settings/ai');
  await expect(page.getByRole('heading', { name: 'AI Model' })).toBeVisible();
  await expect(page.getByTestId('ai-model-settings')).toBeVisible();
}

/** Type the OpenRouter key (does not save). */
export async function fillOpenRouterKey(page: Page): Promise<void> {
  await page.getByTestId('llm-openrouter-key').fill(DUMMY_KEY);
}

/** Save the typed OpenRouter key and wait for the connected state. */
export async function saveOpenRouterKey(page: Page): Promise<void> {
  await page.getByTestId('llm-save').click();
  await expect(page.getByTestId('llm-connection-result')).toContainText(/Connected/, { timeout: 15_000 });
  await expect(page.getByTestId('llm-credits-value')).toContainText('$8.00');
}

/** Point the panel at the local endpoint (does not save). */
export async function fillLocalEndpoint(page: Page): Promise<void> {
  await page.getByTestId('llm-advanced-summary').click();
  await page.getByTestId('llm-api-base').fill(LOCAL_API_BASE);
  await page.getByTestId('llm-model').fill('llama3.1');
  await page.keyboard.press('Escape');
}

/** Save the local endpoint and wait for the connected state. */
export async function saveLocalEndpoint(page: Page): Promise<void> {
  await page.getByTestId('llm-save-advanced').click();
  await expect(page.getByTestId('llm-connection-result').last()).toContainText(/Connected/, {
    timeout: 15_000,
  });
  await expect(page.getByTestId('llm-credits')).toHaveCount(0);
}
