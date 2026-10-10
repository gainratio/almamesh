import { mkdirSync, writeFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { bootEngine, seedChart, LLM_SETTINGS_KEY } from './interpretation.helpers';
import { E2E_REAL_MODEL } from './realModel';
import { sectionUsageRow, type SectionUsageRow } from './sectionUsage';

const MODEL = process.env.INTERP_REAL_MODEL ?? E2E_REAL_MODEL;

/**
 * Structured Vedic interpretation REAL integration test — REAL chart, REAL LLM.
 *
 * Unlike interpretation.spec.ts (which stubs the OpenAI-compatible endpoint with
 * page.route for byte-stable assertions), this suite installs NO route stub: it
 * boots the real in-browser Pyodide engine, generates a REAL Delhi sidereal chart
 * in-tab (shared helpers), then lets a LIVE endpoint actually answer the 5-section
 * structured interpretation. Because the output is non-deterministic LLM text, the
 * assertions are existence + sanity (non-empty, non-placeholder), not exact-match.
 *
 * UI contract (redesigned dashboard): the AI summary renders as open editorial
 * prose under "The reading" (data-testid="reading-section") — the old "Summary"
 * accordion sections are gone. The identity strip shows the full running daśā
 * stack from the seeded adapter-shaped dasha_ctx.
 *
 * Two endpoints, each independently skippable so the suite is safe to run anywhere:
 *   (a) a local Ollama (http://localhost:11434/v1) — skipped if not reachable;
 *   (b) live OpenRouter — skipped unless OPENROUTER_API_KEY is set in the env.
 *
 * The API key is read ONLY from process.env (never hardcoded, never a VITE_ var,
 * so it is never bundled into the app); Playwright forwards the parent shell env
 * to this test process automatically.
 *
 * Run:  bun run test:e2e:interp:real
 *       (set OPENROUTER_API_KEY=... to exercise the OpenRouter test;
 *        start `ollama serve` with gemma3:4b pulled to exercise the local test.)
 */

const OLLAMA_BASE = 'http://localhost:11434/v1';
const OLLAMA_MODEL = 'gemma3:4b';

/**
 * Probe the required local Ollama model BEFORE the test body runs. An opt-in
 * suite must never hang because the server is running without its test model.
 */
async function ollamaModelAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_BASE}/models`, { signal: AbortSignal.timeout(3_000) });
    return res.ok && (await res.text()).includes(`"${OLLAMA_MODEL}"`);
  } catch {
    return false;
  }
}

/** Strings that signal a non-real / placeholder summary (case-insensitive). */
const PLACEHOLDERS = [
  'pending',
  'analysis pending',
  'please retry',
  'generating',
  'loading',
  'llm call failed',
];

/**
 * Assert the summary text looks like a genuine LLM answer: trimmed, long enough,
 * and not one of the known placeholder/loading strings.
 */
function assertRealSummary(text: string | null): void {
  const trimmed = (text ?? '').trim();
  expect(trimmed.length).toBeGreaterThan(40);
  const lower = trimmed.toLowerCase();
  for (const placeholder of PLACEHOLDERS) {
    expect(lower).not.toBe(placeholder);
  }
}

/** Console/page errors that must NOT appear during a healthy real run. */
const FORBIDDEN_ERROR_FRAGMENTS = [
  'LlmRequestError',
  'CORS',
  'Failed to fetch',
  'response_format',
];

/**
 * Shared post-generation assertions for both endpoints:
 *  - "The reading" section renders a real (non-placeholder) summary paragraph;
 *  - the identity strip shows the seeded running-daśā stack (never the
 *    "Not available" fallback — the regression this seed fix guards);
 *  - generation fully completes (progress checklist gone, no loud-failure
 *    panel, no connect-AI CTA).
 * Returns the rendered summary text.
 */
async function expectRealReading(page: Page, mahaLord: string | null): Promise<string> {
  // The reading appears once the core section lands; a live endpoint writing
  // multi-paragraph prose per section needs real headroom.
  const reading = page.getByTestId('reading-section');
  await expect(reading).toBeVisible({ timeout: 480_000 });
  const summaryP = reading.locator('p').first();
  await expect(summaryP).toBeVisible({ timeout: 30_000 });
  const summaryText = await summaryP.textContent();
  assertRealSummary(summaryText);

  // Identity strip: the seeded adapter-shaped dasha_ctx renders the running
  // daśā stack (maha lord at minimum) instead of "Not available".
  const identity = page.getByTestId('identity-strip');
  await expect(identity).toBeVisible();
  expect(mahaLord, 'engine emitted no current maha dasha for the seeded chart').toBeTruthy();
  await expect(identity).toContainText(new RegExp(String(mahaLord), 'i'));
  await expect(identity).not.toContainText('Not available');

  // All 5 sections complete: the progress checklist disappears, and neither
  // the loud-failure panel nor the connect-AI CTA is present.
  await expect(page.getByTestId('interpretation-progress')).toHaveCount(0, {
    timeout: 480_000,
  });
  await expect(page.getByText('Interpretation could not be generated')).toHaveCount(0);
  await expect(page.getByTestId('connect-ai-link')).toHaveCount(0);

  return (summaryText ?? '').trim();
}

function assertConsoleClean(errors: string[]): void {
  for (const fragment of FORBIDDEN_ERROR_FRAGMENTS) {
    expect(
      errors.some((e) => e.includes(fragment)),
      `console error contained "${fragment}": ${errors.join(' | ')}`,
    ).toBe(false);
  }
}

// ===========================================================================
// Test (a) — REAL interpretation against a live local Ollama model.
// Skipped when no Ollama server is reachable on localhost:11434.
// ===========================================================================
test('[real] interpretation renders against a live local Ollama model', async ({ page }) => {
  test.skip(
    !(await ollamaModelAvailable()),
    `${OLLAMA_MODEL} unavailable at ${OLLAMA_BASE} — pull it to exercise this opt-in local test`,
  );
  // Real local inference (5 parallel sections, CPU) is slow — give it room.
  test.setTimeout(600_000);

  // Local endpoint, privacy local_only, NO apiKey — the fail-closed gate allows
  // a local endpoint without a key. Installed before any app code runs.
  // gemma3:4b is a modern small model that reliably emits strict JSON for the
  // 5-parallel-section schema, fast enough to finish within the test budget on
  // an Apple-silicon laptop (the heavier qwen2.5:14b is reliable but too slow).
  const config = JSON.stringify({
    apiBase: OLLAMA_BASE,
    model: OLLAMA_MODEL,
    privacyMode: 'local_only',
    engine: 'openai-http',
  });
  await page.addInitScript(
    ([key, cfg]) => {
      window.localStorage.setItem(key as string, cfg as string);
    },
    [LLM_SETTINGS_KEY, config] as const,
  );

  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));

  await bootEngine(page);
  const seeded = await seedChart(page);
  expect(String(seeded.lagna).toLowerCase()).toBe('gemini');

  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  await page.getByTestId('generate-reading').click();
  await expectRealReading(page, seeded.mahaLord);
  assertConsoleClean(errors);

  await page.screenshot({
    path: 'test-results/interpretation-real-ollama.png',
    fullPage: true,
  });
});

// ===========================================================================
// Test (b) — REAL interpretation against live OpenRouter.
// Skipped unless OPENROUTER_API_KEY is set. The key is read ONLY from the env.
// ===========================================================================
test('[real] interpretation renders against live OpenRouter', async ({ page }) => {
  const KEY = process.env.OPENROUTER_API_KEY;
  test.skip(!KEY, 'OPENROUTER_API_KEY not set');

  // Cloud endpoint + the verified-working model id (the same default the
  // one-click OpenRouter preset prefills). cloud_premium so the fail-closed
  // gate permits an off-device call. Key comes from the env only.
  const config = JSON.stringify({
    apiBase: 'https://openrouter.ai/api/v1',
    apiKey: KEY,
    model: MODEL,
    privacyMode: 'cloud_premium',
    engine: 'openai-http',
  });
  await page.addInitScript(
    ([key, cfg]) => {
      window.localStorage.setItem(key as string, cfg as string);
    },
    [LLM_SETTINGS_KEY, config] as const,
  );
  // The 5 structured sections fan out in parallel, but the merged `complete`
  // event (which fills the reading) only fires once the SLOWEST section returns.
  // For a reasoning-grade cloud model writing 2-4 paragraphs per field, that
  // slow section (guidance1, 4 sub-personas) measured ~120s, putting the whole
  // run at ~170s — too close to a 3-minute wall. Give it the same headroom the
  // Ollama test has so a normal cloud round-trip is never a flake.
  test.setTimeout(600_000);

  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));

  const usageRows: SectionUsageRow[] = [];
  page.on('response', async (res) => {
    if (!res.url().includes('openrouter.ai/api/v1/chat/completions')) return;
    const request = res.request().postData() ?? '';
    const body = await res.text().catch(() => '');
    const row = sectionUsageRow(request, res.status(), body);
    if (row) usageRows.push(row);
  });

  await bootEngine(page);
  const seeded = await seedChart(page);
  expect(String(seeded.lagna).toLowerCase()).toBe('gemini');

  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  await page.getByTestId('generate-reading').click();
  await expectRealReading(page, seeded.mahaLord);
  assertConsoleClean(errors);

  // ---- Capture the FULL rendered narration as a reviewable artifact ----
  // Saved to test-results/ so a human (or an audit agent) can read exactly what
  // the live model wrote, voice by voice — not just that "something rendered".
  const captured: string[] = [];
  captured.push('===== /dashboard — "The reading" (summary + this-period) =====');
  captured.push(await page.getByTestId('reading-section').innerText());

  // (The legacy /astrologer-view full-document surface was removed in favor of
  // /report; the per-domain and dashboard captures below remain the reviewable
  // artifacts for the live narration.)

  // Per-domain "From your reading": layman voice, then the technical flip.
  await page.goto('/life/career', { waitUntil: 'domcontentloaded' });
  const domainAi = page.getByTestId('life-domain-ai');
  await expect(domainAi).toBeVisible({ timeout: 60_000 });
  captured.push('\n===== /life/career — "From your reading" (layman voice) =====');
  captured.push(await domainAi.innerText());
  await page.getByTestId('astrologer-tab').click();
  await expect(domainAi).toBeVisible();
  captured.push('\n===== /life/career — "From your reading" (technical voice) =====');
  captured.push(await domainAi.innerText());

  mkdirSync('test-results', { recursive: true });
  const fullTextPath = 'test-results/interpretation-real-openrouter-fulltext.txt';
  writeFileSync(fullTextPath, captured.join('\n\n'));
  writeFileSync(
    `test-results/interpretation-real-sections-${MODEL.replace(/\W/g, '_')}.json`,
    JSON.stringify({ model: MODEL, sections: usageRows, costUsd: usageRows.reduce((s, r) => s + r.costUsd, 0) }, null, 2),
  );
  console.log(`[real] full rendered narration saved to ${fullTextPath}`);

  await page.screenshot({
    path: 'test-results/interpretation-real-openrouter.png',
    fullPage: true,
  });
});
