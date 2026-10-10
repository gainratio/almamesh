// frontend/apps/web/e2e/ai-setup-panel.egress.spec.ts
import { expect, test, type Page } from '@playwright/test';

import { collectConsoleErrors } from './live/liveJourney';
import {
  DUMMY_KEY,
  PROVIDER_HOSTS,
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
} from './aiSetupPanel.helpers';

/**
 * The privacy claim on Settings → AI, as a CI gate (Chromium, Dagger
 * `browserSuites`): "Your key stays on this device and goes only to the
 * provider you choose."
 *
 * - Nothing reaches a provider (openrouter.ai or the local endpoint) until the
 *   user clicks Save: opening the page and typing are silent.
 * - After Save with OpenRouter, every cross-origin request goes to openrouter.ai,
 *   the key rides only on /api/v1/chat/completions-class calls, and the public
 *   /models catalog never carries it.
 * - With a local endpoint, nothing at all goes to openrouter.ai.
 * - The console stays clean throughout.
 *
 * The pixel half lives in ai-setup-panel.spec.ts (local-only: its baselines are
 * gitignored). Run:  bun run test:e2e:ai-panel:egress
 */

/** Long enough for any debounced validation of what was typed to fire. */
const QUIET_MS = 1_500;

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
    expect(providerRequests(await sentWhenQuiet(page, egress))).toEqual([]);

    await saveOpenRouterKey(page);
    const sent = await egress.settle();
    const keyed = sent.filter((entry) => entry.authorization?.includes(DUMMY_KEY));
    expect(sent.map((entry) => entry.host).filter((host) => host !== 'openrouter.ai')).toEqual([]);
    expect(keyed.map((entry) => entry.path)).toContain('/api/v1/chat/completions');
    // The model catalog is a public read: it never carries the key. Require the read
    // to have happened, so the key check below can never pass vacuously.
    const catalog = sent.filter((entry) => entry.path.endsWith('/models'));
    expect(catalog.length).toBeGreaterThan(0);
    expect(catalog.map((entry) => entry.authorization)).toEqual(catalog.map(() => null));
    expect(errors).toEqual([]);
  });

  test('a local endpoint: silent until Save, then probed locally and nothing goes to openrouter.ai', async ({
    page,
    baseURL,
  }) => {
    const errors = collectConsoleErrors(page);
    const egress = await startJourney(page, baseURL);

    await fillLocalEndpoint(page);
    expect(providerRequests(await sentWhenQuiet(page, egress))).toEqual([]);

    await saveLocalEndpoint(page);
    const sent = await egress.settle();
    expect(sent.filter((entry) => entry.host === 'openrouter.ai')).toEqual([]);
    expect(sent.map((entry) => `${entry.host}${entry.path}`)).toContain('localhost:11434/v1/chat/completions');
    expect(errors).toEqual([]);
  });
});
