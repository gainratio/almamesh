// frontend/apps/web/e2e/ai-setup-panel.egress.spec.ts
import { expect, test, type Page } from '@playwright/test';

import { collectConsoleErrors } from './live/liveJourney';
import {
  PROVIDER_HOSTS,
  carriesKey,
  type EgressEntry,
  type EgressLog,
  fillLocalEndpoint,
  fillOpenRouterKey,
  openAiSettings,
  recordEgress,
  saveLocalEndpoint,
  saveOpenRouterKey,
  stubLocalEndpoint,
  stubOpenRouter,
  stubOpenRouterRejectingKey,
} from './aiSetupPanel.helpers';

/**
 * The privacy claim on Settings → AI, as a CI gate (Chromium, Dagger
 * `browserSuites`): "Your key stays on this device and goes only to the
 * provider you choose."
 *
 * - Nothing reaches a provider (openrouter.ai or the local endpoint) until the
 *   user clicks Save: opening the page and typing are silent.
 * - After Save with OpenRouter, every cross-origin request goes to openrouter.ai,
 *   and the key (in a header, URL or body) appears only on openrouter.ai's
 *   /api/v1/chat/completions and /api/v1/credits; never on the app's own origin
 *   and never on the public /models catalog.
 * - With a local endpoint, nothing at all goes to openrouter.ai.
 * - The console stays clean throughout.
 *
 * Every request in the browser context is recorded (page, popups, service
 * worker; same-origin included). CI runs this on the lane's hooked build; the
 * hooks only add test entry points, not network calls.
 *
 * The pixel half lives in ai-setup-panel.spec.ts (local-only: its baselines are
 * gitignored). Run:  bun run test:e2e:ai-panel:egress
 */

/** Long enough for any debounced validation of what was typed to fire. */
const QUIET_MS = 1_500;

/** The only places the OpenRouter key may go: the probe/reading and the balance. */
const KEYED_PATHS: readonly string[] = ['/api/v1/chat/completions', '/api/v1/credits'];

function providerRequests(sent: readonly EgressEntry[]): readonly EgressEntry[] {
  return sent.filter((entry) => PROVIDER_HOSTS.includes(entry.host));
}

/** Everything sent so far, after the page has gone quiet. */
async function sentWhenQuiet(page: Page, egress: EgressLog): Promise<readonly EgressEntry[]> {
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(QUIET_MS);
  return egress.settle();
}

async function startJourney(page: Page, baseURL: string | undefined): Promise<EgressLog> {
  await stubOpenRouter(page);
  await stubLocalEndpoint(page);
  const egress = recordEgress(page, new URL(baseURL ?? '').origin);
  await openAiSettings(page);
  return egress;
}

test.describe('Settings → AI: the key goes only to the provider you choose', () => {
  test('opening the page with AI off sends nothing to any provider', async ({ page, baseURL }) => {
    const errors = collectConsoleErrors(page);
    const egress = await startJourney(page, baseURL);
    await expect(page.getByTestId('tier-none-active')).toBeVisible();

    expect(providerRequests(await sentWhenQuiet(page, egress))).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('OpenRouter: silent until Save, then the key goes only to openrouter.ai', async ({ page, baseURL }) => {
    const errors = collectConsoleErrors(page);
    const egress = await startJourney(page, baseURL);

    await fillOpenRouterKey(page);
    await page.keyboard.press('Tab');
    expect(providerRequests(await sentWhenQuiet(page, egress))).toEqual([]);

    await saveOpenRouterKey(page);
    const sent = await egress.settle();
    const crossOrigin = sent.filter((entry) => !entry.sameOrigin);
    expect(crossOrigin.map((entry) => entry.host).filter((host) => host !== 'openrouter.ai')).toEqual([]);
    const keyed = sent.filter(carriesKey);
    expect(keyed.map((entry) => entry.host).filter((host) => host !== 'openrouter.ai')).toEqual([]);
    expect(keyed.map((entry) => entry.path)).toContain('/api/v1/chat/completions');
    expect(keyed.map((entry) => entry.path).filter((path) => !KEYED_PATHS.includes(path))).toEqual([]);
    // The model catalog is a public read: it never carries the key. Require the read
    // to have happened, so the key check can never pass vacuously.
    const catalog = sent.filter((entry) => entry.host === 'openrouter.ai' && entry.path.endsWith('/models'));
    expect(catalog.length).toBeGreaterThan(0);
    expect(catalog.filter(carriesKey)).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('a local endpoint: silent until Save, then probed locally and nothing goes to openrouter.ai', async ({
    page,
    baseURL,
  }) => {
    const errors = collectConsoleErrors(page);
    const egress = await startJourney(page, baseURL);

    await fillLocalEndpoint(page);
    await page.keyboard.press('Tab');
    expect(providerRequests(await sentWhenQuiet(page, egress))).toEqual([]);

    await saveLocalEndpoint(page);
    const sent = await egress.settle();
    expect(sent.filter((entry) => entry.host === 'openrouter.ai')).toEqual([]);
    expect(sent.map((entry) => `${entry.host}${entry.path}`)).toContain('localhost:11434/v1/chat/completions');
    expect(errors).toEqual([]);
  });

  /**
   * A REAL HTTP 401 on the first-ever connect, through the real fetch and the
   * real error classifier (the unit tests hand the panel a pre-built error).
   * The rejected key must not stay saved or active, now or after a reload.
   */
  test('a 401 on the first-ever connect leaves AI off, and a reload still has no key', async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await stubOpenRouter(page);
    await stubOpenRouterRejectingKey(page);
    await stubLocalEndpoint(page);
    const statuses: number[] = [];
    page.on('response', (response) => {
      if (response.url().startsWith('https://openrouter.ai/') && response.url().endsWith('/chat/completions')) {
        statuses.push(response.status());
      }
    });
    await openAiSettings(page);

    await fillOpenRouterKey(page);
    await page.getByTestId('llm-save').click();
    await expect(page.getByTestId('llm-connection-result')).toContainText(/rejected/i, { timeout: 15_000 });
    expect(statuses, 'the provider really answered 401 over the wire').toContain(401);
    await expect(page.getByTestId('tier-none-active')).toBeVisible();
    await expect(page.getByTestId('tier-cloud-active')).toHaveCount(0);
    await expect(page.getByTestId('llm-credits')).toHaveCount(0);

    await page.reload();
    await expect(page.getByTestId('ai-model-settings')).toBeVisible();
    await expect(page.getByTestId('tier-none-active')).toBeVisible();
    await expect(page.getByTestId('tier-cloud-active')).toHaveCount(0);
    await expect(page.getByTestId('llm-openrouter-key')).toHaveValue('');
    await expect(page.getByTestId('llm-credits')).toHaveCount(0);
    // Only the two lines this failure is meant to log: the app's own coded diagnostic and the browser's 401 resource line.
    const expected = /almamesh:error:provider\.connection_test_failed|status of 401/;
    expect(errors.filter((message) => !expected.test(message))).toEqual([]);
  });
});
