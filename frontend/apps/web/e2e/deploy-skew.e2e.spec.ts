/**
 * Deploy skew: a tab open across a deploy keeps working.
 *
 * The regression (2026-10-13): a tab opened on release A, still open when
 * release B went live, sent a chat message. The send lazy-imports
 * `placeLookup-<hash>.js` of A; B's deployment no longer had it, the import
 * failed, and chat said "Couldn't reach your AI endpoint". Cloudflare Pages
 * serves only the newest deployment on the production domain, so every hashed
 * chunk of the previous release 404s the moment a new one is live.
 *
 * The fix is in the deploy, not the app: each upload carries the previous
 * releases' hashed /assets/* (scripts/carryForwardAssets.mjs, run by the Dagger
 * deploy against the live deployment). This gate runs that same step against
 * the origin while it serves A, swaps the origin to B, and drives the open A tab.
 *
 *   carried     the A tab's chat send loads A's chunk; the answer renders, no
 *               reload, no failed /assets request, clean console.
 *   red runs    nothing carried: the chunk 404s. The first stale chunk of a
 *               session self-heals (swSelfHeal.installChunkErrorRecovery reloads
 *               the tab onto B, losing the open chat); once that heal is spent
 *               the app says "AlmaMesh was updated. Reload to continue."
 *               (lib/appStale.ts -> UpdateBanner). Never an AI error.
 *   service     A's worker precached A's chunks. Accepting B's worker in another
 *   worker      tab purges them and B's worker takes over the A tab too (no
 *               reload: swUpdate.ts reloads only the tab that clicked). The A
 *               tab's lazy import then goes to the network, where carried
 *               assets answer 200; without them it 404s and the tab heals onto B.
 *
 * Fixtures: `node scripts/build-skew-fixtures.mjs` (two hooked builds; B renames
 * every hashed file). Config: playwright.deploy-skew.config.ts.
 */
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { carryForwardAssets } from '../scripts/carryForwardAssets.mjs';
import { LLM_SETTINGS_KEY, bootEngine, seedChart } from './interpretation.helpers';
import { gotoSettled } from './portableInvariants.helpers';
import { startTwoBuildServer, type TwoBuildServer } from './swUpdateServer';

const PORT = Number(process.env.DEPLOY_SKEW_E2E_PORT ?? 4230);
const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist-sw-update', 'deploy-skew');
const BUILD_A = path.join(FIXTURES, 'a');
const BUILD_B = path.join(FIXTURES, 'b');
/** Node fetches the origin directly (localhost may resolve to ::1; the server binds 127.0.0.1). */
const NODE_ORIGIN = `http://127.0.0.1:${PORT}`;
/** swSelfHeal's once-per-session marker for the global chunk-error reload. */
const CHUNK_HEAL_SPENT = 'almamesh:chunk-reload:global';

const LLM_CONFIG = {
  apiBase: 'https://openrouter.ai/api/v1',
  apiKey: 'test-key',
  model: 'deepseek/deepseek-v4-pro',
  privacyMode: 'cloud_premium',
  engine: 'openai-http',
};
/** Full tier, so the chat registers resolve_place (its tool lazy-imports placeLookup). */
const FULL_TIER = { deviceMemory: 8, hardwareConcurrency: 8 };
const QUESTION = 'What is the sky doing over Chennai this week?';
const ANSWER = 'Chennai sits under a calm sky this week.';
const STALE_BANNER = 'AlmaMesh was updated. Reload to continue.';
const AI_UNREACHABLE = "Couldn't reach your AI endpoint";

function readEntry(buildDir: string): string {
  const html = readFileSync(path.join(buildDir, 'index.html'), 'utf8');
  const entry = html.match(/<script[^>]+src="(\/assets\/index-[^"]+)"/)?.[1];
  if (!entry) throw new Error(`no entry chunk in ${buildDir}/index.html`);
  return entry;
}

/** A's lazy chat chunk, by file name (what the open tab will request). */
function placeLookupChunk(buildDir: string): string {
  const manifest = readFileSync(path.join(buildDir, 'assets-manifest.json'), 'utf8');
  const match = manifest.match(/assets\/placeLookup-[^"]+\.js/)?.[0];
  if (!match) throw new Error(`no placeLookup chunk listed in ${buildDir}/assets-manifest.json`);
  return `/${match}`;
}

/** B's upload as the deploy builds it: a copy of B with A's assets carried from the live origin. */
async function carriedB(scratch: string[]): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), 'deploy-skew-b-'));
  scratch.push(dir);
  cpSync(BUILD_B, dir, { recursive: true });
  const summary = await carryForwardAssets({ distDir: dir, previousOrigin: NODE_ORIGIN });
  expect(summary.carriedFiles, 'release A assets carried into B').toBeGreaterThan(0);
  expect(summary.carriedReleases).toEqual(['a'.repeat(40)]);
  return dir;
}

interface Watch {
  readonly consoleErrors: string[];
  readonly assetFailures: string[];
}

function watch(page: Page): Watch {
  const consoleErrors: string[] = [];
  const assetFailures: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));
  page.on('response', (response) => {
    const { pathname } = new URL(response.url());
    if (pathname.startsWith('/assets/') && response.status() >= 400) assetFailures.push(`${response.status()} ${pathname}`);
  });
  return { consoleErrors, assetFailures };
}

/** Full-tier pin, the stubbed provider's settings, and the provider itself: resolve_place, then the answer. */
async function stubAi(context: BrowserContext): Promise<void> {
  await context.addInitScript((tier) => {
    for (const [name, value] of Object.entries(tier)) {
      Object.defineProperty(Navigator.prototype, name, { get: () => value, configurable: true });
    }
  }, FULL_TIER);
  await context.addInitScript(
    ([key, cfg]) => window.localStorage.setItem(key as string, cfg as string),
    [LLM_SETTINGS_KEY, JSON.stringify(LLM_CONFIG)] as const,
  );
  await context.route('**/chat/completions', async (route) => {
    const parsed = JSON.parse(route.request().postData() ?? '{}') as {
      messages?: Array<{ role: string }>;
      tools?: Array<{ function: { name: string } }>;
    };
    const asked = JSON.stringify(parsed.messages ?? []).includes('Chennai');
    const offersPlace = (parsed.tools ?? []).some((tool) => tool.function.name === 'resolve_place');
    const toolRan = (parsed.messages ?? []).some((message) => message.role === 'tool');
    const message = asked && offersPlace && !toolRan
      ? { content: null, tool_calls: [{ id: 'place-1', type: 'function', function: { name: 'resolve_place', arguments: JSON.stringify({ query: 'Chennai' }) } }] }
      : { content: asked ? ANSWER : '' };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message }] }) });
  });
}

async function scripts(page: Page): Promise<Array<string | null>> {
  return page.evaluate(() => [...document.scripts].map((script) => script.getAttribute('src'))).catch(() => []);
}

/** Open the dashboard on release A with a seeded chart; the chat's lazy chunks are not loaded yet. */
async function openOnReleaseA(page: Page): Promise<number> {
  await bootEngine(page);
  await seedChart(page);
  await gotoSettled(page, '/dashboard');
  await expect(page.getByTestId('chart-visualization').first()).toBeVisible({ timeout: 120_000 });
  expect(await scripts(page)).toContain(readEntry(BUILD_A));
  return page.evaluate(() => performance.timeOrigin);
}

async function sendChat(page: Page): Promise<void> {
  await page.getByTestId('floating-chat-button').click({ timeout: 60_000 });
  await page.getByTestId('chat-input').fill(QUESTION);
  await page.getByTestId('chat-send-button').click();
}

/** The A tab still runs A's document (no reload) and the stubbed answer rendered. */
async function expectAnsweredOnA(page: Page, documentOrigin: number, seen: Watch): Promise<void> {
  await expect(page.getByTestId('chat-panel').getByText(ANSWER)).toBeVisible({ timeout: 120_000 });
  expect(await page.evaluate(() => performance.timeOrigin), 'the A tab was not reloaded').toBe(documentOrigin);
  await expect(page.getByText(STALE_BANNER)).toHaveCount(0);
  expect(seen.assetFailures).toEqual([]);
  expect(seen.consoleErrors).toEqual([]);
}

/** The red outcome of a first stale chunk: a 404 on A's chunk, then the tab heals onto B. Never an AI error. */
async function expectHealedOntoB(page: Page, seen: Watch, chunk: string): Promise<void> {
  await expect.poll(() => seen.assetFailures, { timeout: 120_000 }).toContain(`404 ${chunk}`);
  await expect.poll(() => scripts(page), { timeout: 60_000 }).toContain(readEntry(BUILD_B));
  await expect(page.getByText(AI_UNREACHABLE, { exact: false })).toHaveCount(0);
  await expect(page.getByTestId('chart-visualization').first()).toBeVisible({ timeout: 120_000 });
}

/**
 * Accept B's worker from a second tab (what its update banner sends) and wait
 * until A's chunk is gone from the precache: B's worker activated and purged A.
 */
async function acceptUpdateElsewhere(context: BrowserContext, chunkA: string): Promise<void> {
  const other = await context.newPage();
  await other.goto('/welcome');
  await expect.poll(() => other.evaluate(async (chunk) => {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) return 'no registration';
    if (registration.waiting) {
      registration.waiting.postMessage({ type: 'SKIP_WAITING' });
      return 'waiting';
    }
    if (registration.installing) return 'installing';
    if (registration.active?.state !== 'activated') return 'activating';
    const name = (await caches.keys()).find((key) => key.includes('-precache-'));
    const keys = name ? await (await caches.open(name)).keys() : [];
    if (keys.some((request) => request.url.includes(chunk))) {
      await registration.update();
      return 'A still precached';
    }
    return 'purged';
    // Accepting the update reloads THIS tab (controllerchange); poll again.
  }, chunkA).catch(() => 'reloading'), { timeout: 90_000, intervals: [500, 1_000] }).toBe('purged');
  await other.close();
}

async function precached(page: Page, chunk: string): Promise<boolean> {
  return page.evaluate(async (url) => {
    const name = (await caches.keys()).find((key) => key.includes('-precache-'));
    const keys = name ? await (await caches.open(name)).keys() : [];
    return keys.some((request) => request.url.includes(url));
  }, chunk);
}

test.describe('a tab open across a deploy', () => {
  let server: TwoBuildServer;
  const scratch: string[] = [];
  const chunkA = placeLookupChunk(BUILD_A);

  test.beforeAll(async () => {
    server = await startTwoBuildServer(BUILD_A, PORT);
  });
  test.afterAll(async () => {
    await server.close();
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  });
  test.beforeEach(async ({ context }) => {
    server.deploy(BUILD_A);
    await stubAi(context);
  });

  test.describe('without a service worker', () => {
    test.use({ serviceWorkers: 'block' });

    test('carried assets: the old tab lazy-loads its chunk and the chat answers', async ({ page }) => {
      const seen = watch(page);
      const documentOrigin = await openOnReleaseA(page);
      server.deploy(await carriedB(scratch));
      await sendChat(page);
      await expectAnsweredOnA(page, documentOrigin, seen);
    });

    test('red run, nothing carried: the chunk 404s and the tab heals onto B, not an AI error', async ({ page }) => {
      const seen = watch(page);
      await openOnReleaseA(page);
      server.deploy(BUILD_B);
      await sendChat(page);
      await expectHealedOntoB(page, seen, chunkA);
    });

    test('red run, heal already spent this session: the update notice, then Reload lands on B', async ({ page }) => {
      const seen = watch(page);
      await page.addInitScript((key) => sessionStorage.setItem(key, '1'), CHUNK_HEAL_SPENT);
      await openOnReleaseA(page);
      server.deploy(BUILD_B);
      await sendChat(page);
      await expect(page.getByText(STALE_BANNER)).toBeVisible({ timeout: 120_000 });
      await expect(page.getByText(AI_UNREACHABLE, { exact: false })).toHaveCount(0);
      expect(seen.assetFailures).toContain(`404 ${chunkA}`);
      await page.getByRole('status').getByRole('button', { name: /reload/i }).click();
      await expect.poll(() => scripts(page), { timeout: 60_000 }).toContain(readEntry(BUILD_B));
    });
  });

  test.describe('with the service worker', () => {
    test('carried assets: a tab whose precache was purged by the new worker still loads its chunk', async ({ context, page }) => {
      const seen = watch(page);
      const documentOrigin = await openOnReleaseA(page);
      await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
      await expect.poll(() => precached(page, chunkA), { timeout: 60_000 }).toBe(true);

      server.deploy(await carriedB(scratch));
      await acceptUpdateElsewhere(context, chunkA);
      expect(await precached(page, chunkA), "B's worker purged A's chunk").toBe(false);

      await sendChat(page);
      await expectAnsweredOnA(page, documentOrigin, seen);
    });

    test('red run, nothing carried: the purged chunk 404s and the tab heals onto B', async ({ context, page }) => {
      const seen = watch(page);
      await openOnReleaseA(page);
      await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
      await expect.poll(() => precached(page, chunkA), { timeout: 60_000 }).toBe(true);

      server.deploy(BUILD_B);
      await acceptUpdateElsewhere(context, chunkA);

      await sendChat(page);
      await expectHealedOntoB(page, seen, chunkA);
    });
  });
});
