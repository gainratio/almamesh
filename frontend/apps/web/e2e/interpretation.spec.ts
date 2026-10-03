import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { bootEngine, seedChart, LLM_SETTINGS_KEY } from './interpretation.helpers';

/**
 * Structured Vedic interpretation UNIT / CONTRACT test — REAL chart, STUBBED LLM.
 *
 * This is the FAST contract gate: it boots the real in-browser Pyodide engine and
 * generates a REAL Delhi sidereal chart in-tab (via the shared helpers), but the
 * OpenAI-compatible LLM is STUBBED with `page.route`, so the section payloads are
 * deterministic canned JSON. It asserts the structured 5-section interpretation
 * renders, the loud-failure path, the KeyFocusCard dedup, and the no-model CTA —
 * all with byte-stable assertions. It does NOT touch any real LLM endpoint.
 *
 * For the REAL (unstubbed) integration test that hits a live local Ollama /
 * OpenRouter endpoint, see interpretation.real.spec.ts.
 *
 * WHY this works where a generic browser-MCP fails: the app's module Workers
 * only resolve in a production build, and the chart engine needs the
 * VITE_EXIT_GATE_HOOKS=1 `window.__almameshGenerate` hook. The dedicated config
 * (playwright.interpretation.config.ts) builds + previews exactly that.
 *
 * Run:  bun run test:e2e:interp
 */

// The LLM config that makes describeLlmStatus().configured === true (a cloud
// OpenRouter endpoint with an API key + model + cloud privacy mode). Installed
// via addInitScript BEFORE load; the test then explicitly clicks Generate.
const LLM_CONFIG = {
  apiBase: 'https://openrouter.ai/api/v1',
  apiKey: 'sk-or-test',
  model: 'deepseek/deepseek-v4-pro',
  privacyMode: 'cloud_premium',
  engine: 'openai-http',
};

// ---------------------------------------------------------------------------
// LLM stub: section payloads (field names match the VedicInterpretation shape).
// The structured generator embeds a `SECTION:<key>` marker in each request body,
// so the route picks the right canned JSON by reading request.postData().
// ---------------------------------------------------------------------------
type SectionKey =
  | 'core'
  | 'yoga'
  | 'guidance1'
  | 'guidance2'
  | 'remedial'
  | 'upcoming_periods'
  | 'current_sky';

const SECTION_JSON: Record<SectionKey, unknown> = {
  core: {
    summary: 'STUB SUMMARY about this chart.',
    strengths: [
      { title: 'Determination', layman: 'You persevere.', technical: 'Mars-driven grit.' },
    ],
    challenges: [
      { title: 'Impatience', layman: 'Slow down.', technical: 'Mars excess.' },
    ],
    life_themes: [
      { title: 'Service', layman: 'You help others.', technical: '6th-house emphasis.' },
    ],
  },
  yoga: {
    integrated_yoga_narrative: {
      layman: 'Your life arc bends toward leadership.',
      technical: 'Raja yoga via kendra-trikona lords.',
    },
  },
  guidance1: {
    health_guidance: { layman: 'Rest more.', technical: '6th lord analysis.' },
    education_guidance: { layman: 'Keep learning.', technical: '5th lord.' },
    career_guidance: { layman: 'Lead teams.', technical: '10th lord strong.' },
    relationship_guidance: { layman: 'Communicate.', technical: '7th lord.' },
  },
  guidance2: {
    finances_guidance: { layman: 'Save steadily.', technical: '2nd/11th lords.' },
    spiritual_guidance: { layman: 'Reflect daily.', technical: '12th house.' },
    life_evolution_guidance: { layman: 'You grow through challenge.', technical: 'Dasha sequence.' },
  },
  remedial: {
    remedial_measures: { layman: 'Meditate and journal.', technical: 'Universal practices.' },
  },
  upcoming_periods: {
    upcoming_periods: [
      { title: 'Next chapter', layman: 'Plan deliberately.', technical: 'Dasha timing.' },
    ],
  },
  current_sky: {
    current_sky: [
      { title: 'Current sky', layman: 'Pause before acting.', technical: 'Transit timing.' },
    ],
  },
};

function sectionFor(body: string | null): SectionKey | null {
  if (!body) return null;
  for (const key of Object.keys(SECTION_JSON) as SectionKey[]) {
    if (body.includes(`SECTION:${key}`)) return key;
  }
  return null;
}

/**
 * Intercept the OpenAI-compatible chat-completions endpoint and reply with an
 * OpenAI-shaped body whose message.content is the canned JSON for the section
 * the request asked for. The structured generator POSTs to
 * `<apiBase>/chat/completions` (here openrouter.ai/api/v1/chat/completions).
 */
interface StubLlmControl {
  readonly providerCalls: () => number;
  readonly requestedSections: () => readonly SectionKey[];
  readonly holdRequests: () => () => void;
}

async function stubLlm(page: Page): Promise<StubLlmControl> {
  let providerCalls = 0;
  const requestedSections: SectionKey[] = [];
  let held: Promise<void> | null = null;
  let releaseHeld: (() => void) | null = null;
  await page.route('**/chat/completions', async (route) => {
    providerCalls += 1;
    const body = route.request().postData();
    const section = sectionFor(body);
    if (!section) {
      // Unknown request — fail it so a missing marker is visible, not silent.
      return route.fulfill({ status: 400, body: 'no SECTION marker' });
    }
    requestedSections.push(section);
    if (held) await held;
    const content = JSON.stringify(SECTION_JSON[section]);
    const openAiBody = JSON.stringify({ choices: [{ message: { content } }] });
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: openAiBody,
    });
  });
  return {
    providerCalls: () => providerCalls,
    requestedSections: () => requestedSections,
    holdRequests: () => {
      held = new Promise<void>((resolve) => {
        releaseHeld = resolve;
      });
      return () => {
        releaseHeld?.();
        held = null;
        releaseHeld = null;
      };
    },
  };
}

/**
 * Redacted user-visible evidence around the hard-navigation boundary. Reading
 * retired IndexedDB rows would no longer prove anything now that canonical
 * state lives in OPFS SQLite; the page after a hard navigation is the consumer
 * proof that the persisted reading rehydrated successfully.
 */
async function interpretationLifecycleSnapshot(page: Page) {
  return page.evaluate(() => {
    const text = (testId: string) =>
      document.querySelector(`[data-testid="${testId}"]`)?.textContent ?? null;
    return {
      path: location.pathname,
      identity: text('identity-strip'),
      reading: text('reading-section'),
      selectedUi: text('life-domain-ai'),
    };
  });
}

async function attachLifecycleSnapshot(
  page: Page,
  testInfo: TestInfo,
  name: string,
) {
  const snapshot = await interpretationLifecycleSnapshot(page);
  await testInfo.attach(name, {
    body: Buffer.from(JSON.stringify(snapshot, null, 2)),
    contentType: 'application/json',
  });
  return snapshot;
}

// ===========================================================================
// Test 1 (unit/contract, stubbed LLM) — interpretation populates from the stub.
// ===========================================================================
test('[contract/stubbed] interpretation populates from the stubbed LLM on the dashboard', async ({ page }, testInfo) => {
  // Install the LLM config BEFORE any app code runs, so describeLlmStatus()
  // already reports "configured" when the user explicitly generates.
  await page.addInitScript(
    ([key, cfg]) => {
      window.localStorage.setItem(key as string, cfg as string);
    },
    [LLM_SETTINGS_KEY, JSON.stringify(LLM_CONFIG)] as const,
  );
  const llm = await stubLlm(page);
  // Observe the browser through Chrome DevTools Protocol as well as Playwright's
  // route layer. This catches an accidental provider request even if its body
  // no longer matches the section stub.
  const cdp = await page.context().newCDPSession(page);
  const cdpProviderRequests: string[] = [];
  await cdp.send('Network.enable');
  cdp.on('Network.requestWillBeSent', ({ request }) => {
    if (request.url.includes('/chat/completions')) cdpProviderRequests.push(request.url);
  });

  await bootEngine(page);
  const seeded = await seedChart(page);
  // Sanity: the REAL engine ran (Delhi 1990-01-15 12:00Z lagna == Gemini).
  expect(String(seeded.lagna).toLowerCase()).toBe('gemini');

  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  await page.setViewportSize({ width: 390, height: 844 });
  const generate = page.getByTestId('generate-reading');
  await expect(generate).toBeVisible();
  expect(llm.providerCalls(), 'mounting the dashboard must not spend a provider request').toBe(0);
  expect(cdpProviderRequests, 'CDP must observe no automatic provider request').toHaveLength(0);
  const bounds = await generate.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect((bounds?.x ?? 391) + (bounds?.width ?? 0)).toBeLessThanOrEqual(390);
  expect(bounds?.height ?? 0).toBeGreaterThanOrEqual(44);
  await page.setViewportSize({ width: 1280, height: 720 });
  await generate.click();

  // "The reading" section renders the stubbed summary as open editorial prose
  // (no accordion). Scope to the rendered <p> to avoid strict-mode multi-match.
  const summary = page
    .getByText('STUB SUMMARY about this chart.')
    .and(page.locator('p'));
  await expect(summary).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('reading-section')).toBeVisible();

  // The Life Atlas renders all seven domain cards immediately — in the honest
  // pending state here (no predictive compute was requested in this test).
  await expect(page.getByTestId('life-atlas')).toBeVisible();
  await expect(page.getByTestId('life-atlas-card-career')).toBeVisible();
  await expect(page.getByTestId('life-atlas-card-family')).toBeVisible();

  await page.screenshot({
    path: 'test-results/dashboard-new-ia.png',
    fullPage: true,
  });

  // The 5-section progress completes: the progress checklist (data-testid
  // 'interpretation-progress') is only shown while generating; once complete it
  // disappears and the real reading shows.
  await expect(page.getByTestId('interpretation-progress')).toHaveCount(0);
  expect(llm.requestedSections()).toEqual([
    'core',
    'yoga',
    'guidance1',
    'guidance2',
    'remedial',
  ]);

  // Regression: regenerating a retained reading must show the full progress
  // card, not only the tiny button spinner. Hold the provider replies long
  // enough to inspect the in-flight UI while the previous prose stays visible.
  const releaseRegeneration = llm.holdRequests();
  await page.getByTestId('regenerate-reading').click();
  await expect(page.getByTestId('interpretation-progress')).toBeVisible();
  await expect(summary).toBeVisible();
  releaseRegeneration();
  await expect(page.getByTestId('interpretation-progress')).toHaveCount(0, {
    timeout: 60_000,
  });
  expect(llm.requestedSections()).toEqual([
    'core',
    'yoga',
    'guidance1',
    'guidance2',
    'remedial',
    'core',
    'yoga',
    'guidance1',
    'guidance2',
    'remedial',
  ]);

  // The "no interpretation" empty-state must NOT be present.
  await expect(page.getByText('Interpretation data not available')).toHaveCount(0);
  // The "connect an AI model" CTA must NOT show (a model IS configured).
  await expect(page.getByTestId('connect-ai-link')).toHaveCount(0);

  const beforeNavigation = await attachLifecycleSnapshot(
    page,
    testInfo,
    'interpretation-before-hard-navigation',
  );
  expect(beforeNavigation.identity).toContain('Delhi Interp Test');
  expect(beforeNavigation.reading).toContain('STUB SUMMARY about this chart.');

  // Per-domain detail: /life/career carries the matching AI reading section,
  // and the global content-mode toggle flips its depth (layman → technical).
  await page.goto('/life/career', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('life-domain-ai')).toContainText('Lead teams.', {
    timeout: 30_000,
  });
  const afterNavigation = await attachLifecycleSnapshot(
    page,
    testInfo,
    'interpretation-after-hard-navigation',
  );
  expect(afterNavigation.path).toBe('/life/career');
  expect(afterNavigation.selectedUi).toContain('Lead teams.');
  await page.getByTestId('astrologer-tab').click();
  await expect(page.getByTestId('life-domain-ai')).toContainText('10th lord strong.');

  await page.screenshot({
    path: 'test-results/interpretation-populated.png',
    fullPage: true,
  });
});

// ===========================================================================
// Test 1a — current timing is a separate, explicit two-section generation.
// ===========================================================================
test('current timeline is generated only by its explicit control', async ({ page }) => {
  await page.addInitScript(
    ([key, cfg]) => {
      window.localStorage.setItem(key as string, cfg as string);
    },
    [LLM_SETTINGS_KEY, JSON.stringify(LLM_CONFIG)] as const,
  );
  const llm = await stubLlm(page);

  await bootEngine(page);
  await seedChart(page);
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });

  const generateTimeline = page.getByTestId('generate-timeline');
  await expect(generateTimeline).toBeVisible({ timeout: 60_000 });
  expect(llm.providerCalls(), 'a dashboard visit must not refresh the timeline').toBe(0);

  // Life Atlas computes the deterministic current facts locally. The explicit
  // action is enabled after that token-free input settles.
  await expect(generateTimeline).toBeEnabled({ timeout: 90_000 });
  const releaseTimeline = llm.holdRequests();
  await generateTimeline.click();
  await expect(page.getByTestId('timeline-progress')).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId('interpretation-progress')).toHaveCount(0);
  releaseTimeline();

  await expect(page.getByTestId('current-timeline-section')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('dashboard-current-sky')).toContainText('Pause before acting.');
  expect(llm.requestedSections()).toEqual(['upcoming_periods', 'current_sky']);
  await expect(page.getByTestId('generate-reading')).toBeVisible();
});

// ===========================================================================
// Test 1b — total LLM failure surfaces VISIBLY, but CALMLY (regression guard).
// A configured model whose endpoint fails every section must NOT leave the
// dashboard blank — that was the original regression (failures swallowed, the
// run "completed" empty, nothing rendered and no explanation).
// It must also not shout: the chart is fully computed on-device, so an HTTP 500
// is the PROVIDER-UNAVAILABLE mode of an optional extra. The panel says the
// chart is complete, names the reason, and keeps Retry reachable.
// ===========================================================================
test('a failing endpoint degrades calmly with Retry, never a blank dashboard', async ({ page }) => {
  await page.addInitScript(
    ([key, cfg]) => {
      window.localStorage.setItem(key as string, cfg as string);
    },
    [LLM_SETTINGS_KEY, JSON.stringify(LLM_CONFIG)] as const,
  );
  // Every section call fails with a 500 — simulates a wrong key / bad model /
  // upstream outage. The old code swallowed these and completed empty.
  let providerCalls = 0;
  let providerResponses = 0;
  await page.route('**/chat/completions', async (route) => {
    providerCalls += 1;
    await route.fulfill({ status: 500, contentType: 'text/plain', body: 'upstream boom' });
    providerResponses += 1;
  });

  await bootEngine(page);
  const seeded = await seedChart(page);
  expect(String(seeded.lagna).toLowerCase()).toBe('gemini');

  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  await page.getByTestId('generate-reading').click();

  // All five independent sections must reach the provider. This also proves an
  // immediate click cannot disappear behind asynchronous SQLite hydration.
  // A 500 is transient, so each section is retried exactly once (#192):
  // 5 sections x 2 attempts. A poll for 5 passed only when it happened to
  // sample between the first wave and the retries.
  await expect.poll(() => providerCalls, { timeout: 30_000 }).toBe(10);
  await expect.poll(() => providerResponses, { timeout: 30_000 }).toBe(10);

  // The unavailability panel is shown (status === 'error'), NOT hidden (which is
  // what a silent empty 'complete' produced — the blank-dashboard bug).
  const notice = page.getByTestId('interpretation-unavailable');
  await expect(notice).toBeVisible({ timeout: 60_000 });
  // Calm + honest: the chart itself is complete; only the written
  // interpretation is missing, and the reason is the provider, not the app.
  await expect(notice).toContainText('Your chart is complete');
  await expect(notice).toContainText("isn't responding right now");
  // The old red "the product is broken" framing is gone.
  await expect(page.getByText('Interpretation could not be generated')).toHaveCount(0);
  // A retry affordance exists so the user is never stuck.
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
  // The model IS configured, so the "connect a model" CTA must NOT show — this
  // proves the failure is reported as a failure, not mistaken for "no model".
  await expect(page.getByTestId('connect-ai-link')).toHaveCount(0);

  await page.screenshot({
    path: 'test-results/interpretation-error.png',
    fullPage: true,
  });
});

// ===========================================================================
// Test 3 — no LLM configured: the dashboard shows the "Connect an AI model" CTA.
// ===========================================================================
test('shows the Connect-an-AI CTA when no model is configured', async ({ page }) => {
  // Ensure NO llm config is present (clear it before app code runs).
  await page.addInitScript((key) => {
    window.localStorage.removeItem(key as string);
  }, LLM_SETTINGS_KEY);
  // No stubLlm route — nothing should be called anyway.

  await bootEngine(page);
  await seedChart(page);

  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });

  // The "Connect an AI model" CTA / link to /settings/ai is shown.
  const cta = page.getByTestId('connect-ai-link');
  await expect(cta).toBeVisible({ timeout: 60_000 });
  await expect(cta).toHaveAttribute('href', /\/settings\/ai/);

  // And no bare "Interpretation data not available" empty-state.
  await expect(page.getByText('Interpretation data not available')).toHaveCount(0);
});
