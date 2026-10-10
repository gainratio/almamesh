// frontend/apps/web/e2e/aiSetupPanel.helpers.ts
import type { Page, Request } from '@playwright/test';

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
