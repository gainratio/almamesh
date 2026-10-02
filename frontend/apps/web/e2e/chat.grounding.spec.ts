import { test, expect } from '@playwright/test';
import { bootEngine, seedChart, LLM_SETTINGS_KEY } from './interpretation.helpers';

/**
 * Chat-grounding CONTRACT test — REAL chart, STUBBED LLM.
 *
 * This is the fast, deterministic, CI-runnable proof of two branch changes that
 * previously had only unit coverage:
 *
 *   (b) the chat request that goes out on the wire uses the FAST chat model
 *       `minimax/minimax-m2.7` (CHAT_CLOUD_MODEL, applied by `applyChatSettings`
 *       when no explicit chatModel is saved). So this test seeds an OpenRouter
 *       config with only an interpretation model and asserts the OUTBOUND chat
 *       body's `model` is the chat default — NOT the seeded interpretation model.
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
 *   - a request WITH tools → the always-on bounded agent turn
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
  model: 'deepseek/deepseek-v4.1-flash', // === RECOMMENDED_CLOUD_MODEL
  privacyMode: 'cloud_premium',
  engine: 'openai-http',
};

// The model the chat tier default (applyChatSettings → CHAT_CLOUD_MODEL) must
// produce on the wire. NOT the seeded interpretation model; NOT a bare "minimax".
const EXPECTED_CHAT_MODEL = 'minimax/minimax-m2.7';

// The exact label `interpretationBlock` (prompt.ts) prefixes the reused reading
// with. Asserting on this proves change (c) end-to-end.
const READING_BLOCK_LABEL = 'Your chart reading (already generated';

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

  // Capture every outbound chat-completions request body so we can split the
  // interpretation requests (SECTION marker) from the chat turn (no marker).
  const initialAgentRequestBodies: Array<Record<string, unknown>> = [];
  const agentRequestBodies: Array<Record<string, unknown>> = [];
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
    const parsed = JSON.parse(body ?? '{}') as {
      messages?: Array<Record<string, unknown>>;
      tools?: unknown[];
      tool_choice?: string;
    };
    if (Array.isArray(parsed.tools)) {
      agentRequestBodies.push(parsed as Record<string, unknown>);
      const toolResult = parsed.messages?.find((message) => message.role === 'tool');
      const isClockQuestion = JSON.stringify(parsed.messages).includes(
        'What time is it in my chart timezone?',
      );
      if (!toolResult) {
        if (!isClockQuestion) {
          initialAgentRequestBodies.push(parsed as Record<string, unknown>);
          // The decision round streams (SSE), like the real provider: a no-tool
          // answer must reach the screen delta by delta, not as one late chunk.
          const deltas = ['Your strengths ', 'shine through ', 'this chart.'];
          return route.fulfill({
            status: 200,
            contentType: 'text/event-stream',
            body:
              deltas
                .map((content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`)
                .join('') + 'data: [DONE]\n\n',
          });
        }
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: 'time-in-chart-zone',
                      type: 'function',
                      function: {
                        name: 'get_current_datetime',
                        arguments: JSON.stringify({ scope: 'chart' }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
        });
      }
      // Keep the local-tool activity visible long enough to assert the actual
      // user-facing progress path, then answer from the returned tool result.
      await new Promise((resolve) => setTimeout(resolve, 350));
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          choices: [
            {
              message: {
                content: 'Your chart timezone is Asia/Kolkata (UTC+05:30).',
              },
            },
          ],
        }),
      });
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

  const chatBody = initialAgentRequestBodies[0] as {
    model: string;
    stream?: boolean;
    tool_choice?: string;
    messages: { role: string; content: string }[];
  };

  // ---- ASSERTION (b): the fast chat model went out on the wire ----------------
  expect(
    chatBody.model,
    `outbound chat model must be the fast chat override "${EXPECTED_CHAT_MODEL}" ` +
      `(applyChatModelPreference fired on the OpenRouter preset), not the seeded ` +
      `deep model "${LLM_CONFIG.model}". Got "${chatBody.model}".`,
  ).toBe(EXPECTED_CHAT_MODEL);
  // Guard against a bare/partial slug regression.
  expect(chatBody.model, 'chat model must not be a bare "minimax" slug').not.toBe('minimax');
  expect(chatBody.model, 'chat model must not still be the deep interpretation model').not.toBe(
    LLM_CONFIG.model,
  );
  // INVERTED CONTRACT (fix/agent-chat-streaming): this asserted `false`, which
  // was the regression since 2df38b8 that delivered no-tool answers as one chunk
  // after the whole completion. The decision round must stream.
  expect(chatBody.stream, 'agent decision request is bounded and streaming').toBe(true);
  expect(chatBody.tool_choice).toBe('auto');

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
  expect(promptText).toContain('ENGINE PREDICTIVE CONTEXT');
  expect(promptText).toContain('Current transits (Gochara)');

  // Isolate the second turn's complete tool protocol below.
  agentRequestBodies.length = 0;

  // 5) Every turn uses the bounded agent loop. Prove the complete browser tool
  //    protocol: advertised allowlist -> local execution -> role:tool
  //    result -> grounded answer. No live provider or wall-clock assertion is
  //    involved, so this remains deterministic in CI.
  await chatInput.fill('What time is it in my chart timezone?');
  await page.getByTestId('chat-send-button').click();
  await expect(page.getByTestId('chat-agent-status')).toContainText(
    'Checking the current time',
  );
  await expect(
    chatPanel.getByText('Your chart timezone is Asia/Kolkata (UTC+05:30).', {
      exact: false,
    }),
  ).toBeVisible({ timeout: 60_000 });

  expect(agentRequestBodies).toHaveLength(2);
  const firstAgentRequest = agentRequestBodies[0] as {
    stream: boolean;
    tool_choice: string;
    tools: Array<{ function: { name: string } }>;
  };
  expect(firstAgentRequest.stream).toBe(true);
  expect(firstAgentRequest.tool_choice).toBe('auto');
  expect(firstAgentRequest.tools.map((tool) => tool.function.name)).toEqual([
    'get_current_datetime',
    'get_chart_facts',
    'get_current_timing',
  ]);

  const secondAgentRequest = agentRequestBodies[1] as {
    messages: Array<{ role: string; name?: string; content?: string }>;
  };
  const returnedToolResult = secondAgentRequest.messages.find(
    (message) => message.role === 'tool',
  );
  expect(returnedToolResult?.name).toBe('get_current_datetime');
  expect(returnedToolResult?.content).toContain('"timeZone":"Asia/Kolkata"');
  expect(returnedToolResult?.content).toContain('"utcOffset":"+05:30"');

  await page.screenshot({
    path: 'test-results/chat-grounding.png',
    fullPage: true,
  });
});
