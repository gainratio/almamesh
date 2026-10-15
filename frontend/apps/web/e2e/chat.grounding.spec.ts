import { test, expect } from '@playwright/test';
import { bootEngine, seedChart, LLM_SETTINGS_KEY } from './interpretation.helpers';
import { waitForLifeAtlasAsOf } from './lifeAtlas.helpers';
import { stubModelCatalog } from './modelCatalog.helpers';
import {
  chatToolBody,
  fulfillReadThenAnswer,
  fulfillToolCall,
  generalAnswer,
  readPeriodArgs,
  toolNames,
  toolResults,
  type ChatToolBody,
} from './stubChatProvider';

/**
 * Chat-grounding CONTRACT test — REAL chart, STUBBED LLM.
 *
 * This is the fast, deterministic, CI-runnable proof of two branch changes that
 * previously had only unit coverage:
 *
 *   (b) the chat request that goes out on the wire uses the chat-tier default
 *       `~openai/gpt-luna-latest` (CHAT_CLOUD_MODEL, applied by
 *       `applyChatSettings` when no explicit chatModel is saved). So this test
 *       seeds an OpenRouter config with only an interpretation model — a
 *       DIFFERENT one, so the two tiers are distinguishable — and asserts the
 *       OUTBOUND chat body's `model` is the chat default, NOT the seeded
 *       interpretation model.
 *
 *   (c) the chat prompt REUSES the already-generated structured interpretation:
 *       `serializeInterpretationForChat` injects a "Your chart reading
 *       (already generated …)" block into the chat messages. So this test waits
 *       for the six-section reading to COMPLETE first, then asserts the outbound
 *       chat body carries that labelled block AND stubbed interpretation content
 *       — including the "Upcoming periods" group from the sixth section.
 *
 * It boots the REAL in-browser Pyodide engine and generates a REAL Delhi chart
 * in-tab (shared helpers), but the OpenAI-compatible LLM is STUBBED via a
 * page.route on the chat/completions endpoint. The route distinguishes the two
 * request shapes by the `SECTION:<key>` marker the structured generator embeds:
 *   - a request WITH a marker  → an interpretation section (answer with canned JSON)
 *   - a request WITH tools → a chat turn's tool loop (e2e/stubChatProvider.ts)
 *
 * Run:  bun run test:e2e:chat:grounding   (from apps/web)
 */

// The OpenRouter cloud preset that makes describeLlmStatus().configured === true
// with no chatModel, so chat falls back to CHAT_CLOUD_MODEL. Installed via
// addInitScript BEFORE load so the dashboard can explicitly generate the
// reading and the chat override fires. Mirrors interpretation.spec.ts's config.
const LLM_CONFIG = {
  apiBase: 'https://openrouter.ai/api/v1', // === OPENROUTER_API_BASE
  apiKey: 'test-key',
  // Deliberately NOT the chat default: chat and readings now share one default
  // id, so seeding that id here would let "chat reused the interpretation model"
  // pass as "chat applied its own default".
  model: 'deepseek/deepseek-v4-pro',
  privacyMode: 'cloud_premium',
  engine: 'openai-http',
};

// The model the chat tier default (applyChatSettings → CHAT_CLOUD_MODEL) must
// produce on the wire. NOT the seeded interpretation model. Pinned as a literal.
// REVERSED CONTRACT (fix/live-check-followups): this asserted
// 'minimax/minimax-m2.7', which measured 26.7 s to first token on the live site.
const EXPECTED_CHAT_MODEL = '~openai/gpt-luna-latest';

// The exact label `interpretationBlock` (prompt.ts) prefixes the reused reading
// with. Asserting on this proves change (c) end-to-end.
const READING_BLOCK_LABEL = 'Your chart reading (already generated';

// The second chat question: a dated one, read with read_period.
const NEXT_MONTH_QUESTION = 'How does next month look for me?';

// Canned interpretation sections (field names match VedicInterpretation). The
// structured generator embeds a `SECTION:<key>` marker per request, so the route
// picks the right JSON by reading request.postData(). Mirrors
// interpretation.spec.ts. The distinctive summary string is later asserted to
// appear in the OUTBOUND chat body (proving the reading was reused).
//
// EVERY section the generator fans out MUST be listed here: the route treats any
// request WITHOUT a recognized marker as THE CHAT TURN, so a missing key makes
// that section's request (sent with the DEEP interpretation model — correct)
// masquerade as the chat request and fail the fast-model assertion. That is
// exactly how adding the old combined timeline sections broke this gate. Keep
// recognizing them for the explicit timeline action, while this natal-flow test
// asserts that neither is called by Generate Reading.
type SectionKey =
  | 'core'
  | 'yoga'
  | 'guidance1'
  | 'guidance2'
  | 'remedial'
  | 'upcoming_periods'
  | 'current_sky';

const STUB_SUMMARY = 'STUB GROUNDING SUMMARY about this chart.';

// Distinctive sixth-section strings, asserted later in the OUTBOUND chat body —
// proving serializeInterpretationForChat carries the new "Upcoming periods"
// group into the chat prompt end-to-end.
const STUB_PERIOD_TITLE = 'Sun antardasha — 2027-01 to 2028-01';
const STUB_PERIOD_LAYMAN = 'STUB ROAD AHEAD: a year of visible momentum.';

const SECTION_JSON: Record<SectionKey, unknown> = {
  core: {
    summary: STUB_SUMMARY,
    strengths: [
      { title: 'Determination', layman: 'You persevere.', technical: 'Mars-driven grit.' },
    ],
    challenges: [{ title: 'Impatience', layman: 'Slow down.', technical: 'Mars excess.' }],
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
    life_evolution_guidance: {
      layman: 'You grow through challenge.',
      technical: 'Dasha sequence.',
    },
  },
  remedial: {
    remedial_measures: { layman: 'Meditate and journal.', technical: 'Universal practices.' },
  },
  upcoming_periods: {
    upcoming_periods: [
      {
        title: STUB_PERIOD_TITLE,
        layman: STUB_PERIOD_LAYMAN,
        technical: 'Sun in the 10th, dignified; rules the 3rd.',
      },
    ],
  },
  // Seventh section (Spec 065): "What's active now & next". Shape mirrors
  // CURRENT_SKY_TASK ({ current_sky: [ { title, layman, technical } ] }).
  current_sky: {
    current_sky: [
      {
        title: 'The Saturn Mahadasha, Mercury Antardasha',
        layman: 'STUB NOW & NEXT: a steady, building chapter right now.',
        technical: 'Saturn maha active, Mercury antar; no transit data invented.',
      },
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

// The evidence-annotation call (`fetchEvidenceAnnotations`, fired once the
// reading completes, on the DEEP interpretation config — not the chat one) is
// a THIRD request shape: no `SECTION:<key>` marker, so without this check it
// falls through to the agent route below and its deep-model body
// becomes the first captured body, failing the fast-model assertion on a request
// that was never the user's chat turn. `general_guidance` is a JSON key unique
// to this call's output schema (evidence-annotation.ts) — it never appears in
// a SECTION_JSON reading nor in a real chat prompt.
function isEvidenceAnnotationRequest(body: string | null): boolean {
  return (body ?? '').includes('general_guidance');
}

test('[contract/stubbed] chat reuses the reading + sends the fast chat model on the wire', async ({
  page,
}) => {
  const browserErrors: string[] = [];
  page.on('pageerror', (error) => browserErrors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`);
  });
  // Install the OpenRouter preset BEFORE any app code runs so (1) the dashboard
  // reports "configured" for the explicit Generate action and (2) the chat path's
  // applyChatModelPreference override fires on first render.
  await page.addInitScript(
    ([key, cfg]) => {
      window.localStorage.setItem(key as string, cfg as string);
    },
    [LLM_SETTINGS_KEY, JSON.stringify(LLM_CONFIG)] as const,
  );
  // Pin a full-tier device for this desktop journey. Every tier offers the
  // same local capabilities; separate iPhone journeys exercise minimal.
  await page.addInitScript((tier) => {
    for (const [name, value] of Object.entries(tier)) {
      Object.defineProperty(Navigator.prototype, name, { get: () => value, configurable: true });
    }
  }, { deviceMemory: 8, hardwareConcurrency: 8 });

  // Capture every outbound chat-completions request body so we can split the
  // interpretation requests (SECTION marker) from the chat turn (no marker).
  // The chat model's context window comes from the catalog: a 128k window keeps the
  // cloud prompt sizing (raw predictive facts included), and nothing reaches the network.
  await stubModelCatalog(page);
  const initialAgentRequestBodies: ChatToolBody[] = [];
  const agentRequestBodies: ChatToolBody[] = [];
  // The second question reads next month with read_period, on the real engine.
  const nextMonth = await page.evaluate(() => {
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`;
  });
  const interpSections: SectionKey[] = [];

  await page.route('**/chat/completions', async (route) => {
    const body = route.request().postData();
    const section = sectionFor(body);
    if (section) {
      // An interpretation section: answer with the canned JSON so the explicit
      // natal or timeline action can complete (non-streaming JSON path).
      interpSections.push(section);
      const content = JSON.stringify(SECTION_JSON[section]);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ choices: [{ message: { content } }] }),
      });
    }
    if (isEvidenceAnnotationRequest(body)) {
      // The optional evidence-annotation enhancement call: answer with an
      // empty-but-valid payload (schema in evidence-annotation.ts) so it
      // resolves cleanly without becoming part of the chat-turn capture below.
      const content = JSON.stringify({ readings: [], general_guidance: [] });
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ choices: [{ message: { content } }] }),
      });
    }
    const chat = chatToolBody(body);
    if (chat) {
      agentRequestBodies.push(chat);
      if (!JSON.stringify(chat.messages).includes(NEXT_MONTH_QUESTION)) {
        initialAgentRequestBodies.push(chat);
        // A today question may answer at once: the answer's markdown streams in pieces.
        return fulfillToolCall(route, { name: 'answer', args: generalAnswer('Your strengths shine through this chart.') });
      }
      // Keep the local read visible long enough to assert the user-facing progress path.
      if (toolResults(chat).length > 0) await new Promise((resolve) => setTimeout(resolve, 350));
      return fulfillReadThenAnswer(route, chat, readPeriodArgs(nextMonth));
    }
    throw new Error('Dashboard chat must use the bounded agent contract.');
  });

  // Boot the REAL engine + restore a REAL Delhi chart through the production
  // backup boundary into canonical OPFS SQLite.
  await bootEngine(page);
  const seeded = await seedChart(page);
  expect(String(seeded.lagna).toLowerCase()).toBe('gemini');

  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  await page.getByTestId('generate-reading').click();

  await expect
    .poll(() => interpSections.length, {
      timeout: 30_000,
      message: `all five structured-reading requests should be issued; browser errors: ${browserErrors.join(' | ')}`,
    })
    .toBe(5);

  // 1) Wait for the five-section stable natal reading to COMPLETE. interpretationText is only
  //    reused when the stored entry's status === 'complete' (Dashboard.tsx), so
  //    this wait is load-bearing for change (c). Completion signal mirrors
  //    interpretation.spec.ts: the core summary renders AND the progress
  //    checklist is gone.
  const summary = page.getByText(STUB_SUMMARY).and(page.locator('p'));
  await expect(summary).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId('interpretation-progress')).toHaveCount(0);
  expect(browserErrors, 'the complete dashboard + SQLite flow must not emit browser errors').toEqual(
    [],
  );
  expect(interpSections.sort()).toEqual(
    ['core', 'guidance1', 'guidance2', 'remedial', 'yoga'].sort(),
  );

  // 1b) Wait for the chart to re-anchor to today. The seeded chart is pinned to
  //     DELHI_BIRTH.referenceDate (2025-01-01), so it is a day behind and
  //     useChartReanchor recomputes it as soon as the dashboard's engine boots.
  //     That recompute gives the chart a new snapshot, and an answer streamed
  //     across it is discarded by design ("Your chart changed while this answer
  //     was being written"). Engine boot and the reading finish at about the
  //     same time, so without this wait the chat turn raced the re-anchor and
  //     lost on slower or faster runners (main 2649c71). Chat about the chart
  //     the user will actually see: today's.
  const today = await page.evaluate(() =>
    new Intl.DateTimeFormat('en', { year: 'numeric', month: 'short', day: 'numeric' }).format(
      new Date(),
    ),
  );
  await expect(page.getByTestId('provenance-footer')).toContainText(`As of ${today}`, {
    timeout: 60_000,
  });

  // Today's predictive facts ride in a today prompt once computed (withRawPredictive):
  // wait for the Life Atlas, which reads the same slot, so the assertion below is not a race.
  await waitForLifeAtlasAsOf(page);

  // 2) Open the chat panel and send a question (selectors from chat.rag.real.spec.ts).
  await page.getByTestId('floating-chat-button').click({ timeout: 60_000 });
  const chatInput = page.getByTestId('chat-input');
  await expect(chatInput).toBeVisible({ timeout: 30_000 });

  await chatInput.fill('What planetary influences matter for me today?');
  await page.getByTestId('chat-send-button').click();

  // 3) Wait for the chat answer to render (the stubbed SSE token appears in the panel).
  const chatPanel = page.getByTestId('chat-panel');
  await expect(
    chatPanel.getByText('Your strengths shine through this chart.', { exact: false }),
  ).toBeVisible({ timeout: 60_000 });

  // 4) Wait until the always-on agent request was captured.
  await expect
    .poll(() => initialAgentRequestBodies.length, { timeout: 30_000, intervals: [250] })
    .toBeGreaterThanOrEqual(1);

  const chatBody = initialAgentRequestBodies[0]!;

  // ---- ASSERTION (b): the fast chat model went out on the wire ----------------
  expect(
    chatBody.model,
    `outbound chat model must be the chat-tier default "${EXPECTED_CHAT_MODEL}" ` +
      `(applyChatSettings fired on the OpenRouter preset), not the seeded ` +
      `interpretation model "${LLM_CONFIG.model}". Got "${chatBody.model}".`,
  ).toBe(EXPECTED_CHAT_MODEL);
  // Guard against the retired slow default coming back.
  expect(chatBody.model, 'chat must not default to the slow minimax model').not.toMatch(/minimax/);
  expect(chatBody.model, 'chat model must not still be the deep interpretation model').not.toBe(
    LLM_CONFIG.model,
  );
  // INVERTED CONTRACT (fix/agent-chat-streaming): this asserted `false`, which
  // was the regression since 2df38b8 that delivered no-tool answers as one chunk
  // after the whole completion. The decision round must stream.
  expect(chatBody.stream, 'agent decision request is bounded and streaming').toBe(true);
  // Contract changed (chat tool layer redesign, Task 6): every round must call a tool; the answer is the `answer` tool.
  expect(chatBody.tool_choice).toBe('required');

  // ---- ASSERTION (c): the chat prompt reused the already-generated reading ----
  const promptText = chatBody.messages.map((m) => m.content).join('\n');
  expect(
    promptText,
    `the chat prompt must inject the reused-reading block label "${READING_BLOCK_LABEL}…" ` +
      `(serializeInterpretationForChat / interpretationBlock). It was absent, so the ` +
      `chat did NOT reuse the generated interpretation.`,
  ).toContain(READING_BLOCK_LABEL);
  expect(
    promptText,
    `the reused-reading block must carry stubbed interpretation content ` +
      `("${STUB_SUMMARY}"); its absence means an EMPTY reading block was injected.`,
  ).toContain(STUB_SUMMARY);
  // The reused reading is stable natal prose only. Independently generated,
  // dated timeline prose must not be flattened into this block; deterministic
  // engine timing facts above remain the authoritative chat context.
  expect(
    promptText,
    `the natal reading must not carry the stubbed timeline window ` +
      `("${STUB_PERIOD_TITLE}") without an explicit timeline action.`,
  ).not.toContain(STUB_PERIOD_TITLE);
  expect(promptText).toContain('ENGINE TIMING CONTEXT');
  expect(promptText).toContain('Current transits (Gochara)');

  // Isolate the second turn's complete tool protocol below.
  agentRequestBodies.length = 0;

  // 5) A dated question runs the complete browser tool protocol: advertised
  //    allowlist -> local read_period on the real engine -> role:tool result ->
  //    an answer checked against that reading. No live provider or wall-clock
  //    assertion is involved, so this remains deterministic in CI.
  await chatInput.fill(NEXT_MONTH_QUESTION);
  await page.getByTestId('chat-send-button').click();
  await expect(page.getByTestId('chat-agent-status')).toContainText('Reading ', { timeout: 60_000 });
  await expect(chatPanel.getByText('A steady stretch for work.', { exact: false })).toBeVisible({ timeout: 240_000 });

  expect(agentRequestBodies).toHaveLength(2);
  const [firstAgentRequest, secondAgentRequest] = agentRequestBodies as [ChatToolBody, ChatToolBody];
  expect(firstAgentRequest.stream).toBe(true);
  expect(firstAgentRequest.tool_choice).toBe('required');
  // The live turn offers the two tools and the answer (chat tool layer redesign, 2026-10-14).
  expect(toolNames(firstAgentRequest)).toEqual(['read_period', 'travel', 'answer']);
  const [reading] = toolResults(secondAgentRequest);
  expect(reading?.name).toBe('read_period');
  expect(reading?.content).toContain(`"start":"${nextMonth}-01"`);
  expect(reading?.content).toContain('"dashas"');
  await expect(page.locator('[data-testid="chat-tool-call"][data-tool-name="read_period"]')).toHaveAttribute('data-status', 'complete');

  await page.screenshot({
    path: 'test-results/chat-grounding.png',
    fullPage: true,
  });
});

// The text useChatThread appends when an answer was streamed across a chart
// change and discarded (locales/en/chat.json errors.chart_changed).
const CHART_CHANGED = 'Your chart changed while this answer was being written';
const REANCHOR_STATUS = 'Updating your chart for today…';
const WAITED_ANSWER = 'An answer about today’s chart.';

test('[contract/stubbed] a message sent while today’s re-anchor is pending waits, and its answer is kept', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.addInitScript(
    ([key, cfg]) => {
      window.localStorage.setItem(key as string, cfg as string);
    },
    [LLM_SETTINGS_KEY, JSON.stringify(LLM_CONFIG)] as const,
  );
  // Hold every chart computation on the dashboard until the test releases it.
  // The seeded chart is days behind, so the first one there is the day's
  // re-anchor: holding it reproduces a slow recompute deterministically.
  await page.addInitScript(() => {
    if (!window.location.pathname.startsWith('/dashboard')) return;
    const post = Worker.prototype.postMessage;
    const held: Array<[Worker, Parameters<Worker['postMessage']>]> = [];
    let released = false;
    const w = window as unknown as { __releaseReanchor: () => void };
    w.__releaseReanchor = () => {
      released = true;
      for (const [worker, args] of held.splice(0)) post.apply(worker, args);
    };
    Worker.prototype.postMessage = function (
      this: Worker,
      ...args: Parameters<Worker['postMessage']>
    ) {
      const message = args[0] as { kind?: string } | null;
      if (!released && message?.kind === 'generateChart') {
        held.push([this, args]);
        return;
      }
      return post.apply(this, args);
    } as Worker['postMessage'];
  });

  // The stubbed answer is held until the re-anchor has landed, so any question
  // that slipped out during the pending window would be answered across the
  // chart change, exactly the race a returning user hits at midnight.
  let reanchorLanded!: () => void;
  const landed = new Promise<void>((resolve) => {
    reanchorLanded = resolve;
  });
  let agentRequestsBeforeLanding = 0;
  let reanchorDone = false;
  await page.route('**/chat/completions', async (route) => {
    if (!chatToolBody(route.request().postData())) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ choices: [{ message: { content: '{}' } }] }),
      });
    }
    if (!reanchorDone) agentRequestsBeforeLanding += 1;
    await landed;
    return fulfillToolCall(route, { name: 'answer', args: generalAnswer(WAITED_ANSWER) });
  });

  await bootEngine(page);
  await seedChart(page);
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });

  // The returning user opens chat right away and asks, while the recompute runs.
  await page.getByTestId('floating-chat-button').click({ timeout: 60_000 });
  const chatPanel = page.getByTestId('chat-panel');
  const chatInput = page.getByTestId('chat-input');
  const send = page.getByTestId('chat-send-button');
  await expect(page.getByTestId('chat-reanchor-status')).toHaveText(REANCHOR_STATUS, {
    timeout: 120_000,
  });
  await chatInput.fill('What matters for me today?');
  await chatInput.press('Enter');

  // Let the recompute land and wait until the dashboard shows today's chart.
  await page.evaluate(() =>
    (window as unknown as { __releaseReanchor: () => void }).__releaseReanchor(),
  );
  const today = await page.evaluate(() =>
    new Intl.DateTimeFormat('en', { year: 'numeric', month: 'short', day: 'numeric' }).format(
      new Date(),
    ),
  );
  await expect(page.getByTestId('provenance-footer')).toContainText(`As of ${today}`, {
    timeout: 60_000,
  });
  reanchorDone = true;
  reanchorLanded();

  // Chat comes back on its own; the question goes out now and its answer stays.
  await expect(page.getByTestId('chat-reanchor-status')).toHaveCount(0);
  await chatInput.fill('What matters for me today?');
  await expect(send).toBeEnabled();
  await send.click();
  await expect(chatPanel.getByText(WAITED_ANSWER)).toBeVisible({ timeout: 60_000 });
  await expect(chatPanel).not.toContainText(CHART_CHANGED);
  expect(agentRequestsBeforeLanding, 'no question may leave while the re-anchor is pending').toBe(0);
  expect(pageErrors).toEqual([]);
  await page.screenshot({ path: 'test-results/chat-reanchor-wait.png', fullPage: true });
});
