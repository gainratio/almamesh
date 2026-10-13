import { test, expect, type Page, type Request } from '@playwright/test';
import { bootEngine, seedChart, DELHI_SEED, LLM_SETTINGS_KEY } from './interpretation.helpers';
import { E2E_REAL_MODEL, PRODUCT_CHAT_DEFAULT_MODEL } from './realModel';
import { parseSuccessfulToolResult } from './agenticToolResult.helpers';

/**
 * Dashboard LIVE validation against REAL OpenRouter — three headline changes:
 *
 *   A) Honest interpretation timer  — the generation panel shows
 *      `interpretation-elapsed` with a live `m:ss` timer + "1–3 minutes" copy,
 *      and NEVER the old "about 30 seconds" string.
 *   B) Life Phase card             — renders a real maha phase, not the
 *      "Life phase information not available" fallback.
 *   C) Always-agent chat (headline) — a natural "today" question first computes
 *      exact-day planetary context on-device, then a `cloud_premium` OpenRouter
 *      model receives that sanitized context and the local tool contract.
 *      Also proves the typing indicator (`chat-loading`) appears before output.
 *
 * This is a REAL integration test: real in-browser Pyodide engine, a real Delhi
 * sidereal chart generated in-tab, and a LIVE OpenRouter round-trip. The reading
 * uses the seeded `model` (E2E_REAL_MODEL, the cheapest); chat has no `chatModel`
 * saved, so it runs on the default chat tier (CHAT_CLOUD_MODEL,
 * PRODUCT_CHAT_DEFAULT_MODEL). The OpenRouter key is read ONLY from
 * process.env (never bundled).
 *
 * Run:  bun run test:e2e:dashboard:agentic:real   (from apps/web)
 *       (set OPENROUTER_API_KEY=... or the test self-skips.)
 */

/** Strings that signal a non-real / placeholder chat answer. */
const PLACEHOLDERS = ['pending', 'please retry', 'loading', 'no answer available'];

interface ProviderToolCall {
  id: string;
  function: { name: string; arguments: string };
}

interface ProviderMessage {
  role: string;
  content?: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ProviderToolCall[];
}

interface AgentRequestBody {
  model?: unknown;
  stream?: unknown;
  tool_choice?: unknown;
  tools?: Array<{ function?: { name?: string } }>;
  messages?: ProviderMessage[];
}

interface ObservedAgentRequest {
  body: AgentRequestBody;
  responseText?: Promise<string | null>;
}

/** Observe real traffic only; never read/log authorization headers or intercept inference. */
function observeAgentRequests(page: Page): ObservedAgentRequest[] {
  const requests: ObservedAgentRequest[] = [];
  const byRequest = new WeakMap<Request, ObservedAgentRequest>();
  page.on('request', (request) => {
    if (request.method() !== 'POST' || !request.url().endsWith('/chat/completions')) return;
    try {
      const body = request.postDataJSON() as AgentRequestBody;
      if (!body.tools?.some((tool) => tool.function?.name === 'get_current_datetime')) return;
      const observed = { body };
      requests.push(observed);
      byRequest.set(request, observed);
    } catch {
      // Non-JSON requests are outside the OpenAI-compatible agent loop.
    }
  });
  page.on('response', (response) => {
    const observed = byRequest.get(response.request());
    if (observed) observed.responseText = response.text().catch(() => null);
  });
  return requests;
}

interface DashaTimingResult {
  period: { start: string; end: string; basis: string };
  section: string;
  shown: string;
  data: { maha: Array<{ lord: string }>; antar: Array<{ lord: string }> };
}

/** A later real request carries the provider's calls AND the matching local results. */
async function successfulToolPairs(requests: ObservedAgentRequest[]) {
  const calls = new Map<string, ProviderToolCall>();
  const results = new Map<string, ProviderMessage>();
  const providerCallIds = new Set((await Promise.all(requests.map(providerMessages)))
    .flatMap((messages) => messages.flatMap((message) => message.tool_calls ?? []))
    .map((call) => call.id).filter(Boolean));
  for (const { body } of requests) {
    for (const message of body.messages ?? []) {
      if (message.role === 'assistant') {
        for (const call of message.tool_calls ?? []) calls.set(call.id, call);
      }
      // The first sighting is the full result: later rounds carry it compacted (context budget, 2026-10-13).
      if (message.role === 'tool' && message.tool_call_id && !results.has(message.tool_call_id)) results.set(message.tool_call_id, message);
    }
  }
  expect(calls.size, 'each turn stays inside the three-call agent budget').toBeLessThanOrEqual(3);
  expect(results.size, 'every actual assistant tool call has a matching local result').toBe(calls.size);
  return [...calls.values()].map((call) => {
    expect(providerCallIds.has(call.id), 'the call ID was emitted by the real provider').toBe(true);
    const message = results.get(call.id);
    expect(message?.name).toBe(call.function.name);
    const result = parseSuccessfulToolResult(message?.content);
    return { name: call.function.name, args: JSON.parse(call.function.arguments) as Record<string, unknown>, result };
  });
}

async function providerMessages(request: ObservedAgentRequest): Promise<Array<Pick<ProviderMessage, 'content' | 'tool_calls'>>> {
  await expect.poll(() => Boolean(request.responseText)).toBe(true);
  const raw = await request.responseText!;
  expect(raw, 'the live provider response is readable').not.toBeNull();
  if (raw!.trim().startsWith('{')) {
    const json = JSON.parse(raw!) as { choices?: Array<{ message?: ProviderMessage }> };
    return json.choices?.[0]?.message ? [json.choices[0].message] : [];
  }
  return raw!.split('\n').flatMap((line) => {
    if (!line.startsWith('data:')) return [];
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return [];
    const chunk = JSON.parse(data) as { choices?: Array<{ delta?: ProviderMessage }> };
    return chunk.choices?.[0]?.delta ? [chunk.choices[0].delta] : [];
  });
}

/** Only the last response is the final answer; earlier decision rounds may contain prose too. */
async function finalResponseText(requests: ObservedAgentRequest[]): Promise<string> {
  return (await providerMessages(requests.at(-1)!)).map((message) => message.content ?? '').join('');
}

const FACT_SUMMARY_REQUEST = 'Start your answer with one compact JSON object containing period_start, period_end, maha_lords and antar_lords (arrays of the calculated lords covering that period). Use the supplied local timing data, then explain the active calculated timing in two short sentences.';

/** The calculated dashas an answer must restate: from get_timing's dashas section or get_period_reading. */
interface CalculatedDashas {
  readonly period: { readonly start: string; readonly end: string };
  readonly maha: ReadonlyArray<{ readonly lord: string }>;
  readonly antar: ReadonlyArray<{ readonly lord: string }>;
}

function timingDashas(timing: DashaTimingResult): CalculatedDashas {
  expect(timing.section).toBe('dashas');
  expect(timing.shown).toBe('dashas');
  return { period: timing.period, maha: timing.data.maha, antar: timing.data.antar };
}

function expectCalculatedSummary(answer: string, timing: CalculatedDashas): void {
  expect(timing.maha.length).toBeGreaterThan(0);
  expect(timing.antar.length).toBeGreaterThan(0);
  const object = answer.match(/\{[^{}]*\}/)?.[0];
  expect(object, 'a factual summary accompanies any legitimate life-event caveat').toBeDefined();
  const summary = JSON.parse(object!) as {
    period_start?: unknown; period_end?: unknown; maha_lords?: unknown; antar_lords?: unknown;
  };
  expect(summary.period_start).toBe(timing.period.start);
  expect(summary.period_end).toBe(timing.period.end);
  const normalized = (lords: unknown) => {
    expect(Array.isArray(lords)).toBe(true);
    return [...new Set((lords as string[]).map((lord) => lord.trim().toLowerCase()))].sort();
  };
  expect(normalized(summary.maha_lords)).toEqual(normalized(timing.maha.map((row) => row.lord)));
  expect(normalized(summary.antar_lords)).toEqual(normalized(timing.antar.map((row) => row.lord)));
  expect(answer.slice(answer.indexOf(object!) + object!.length).replace(/[`\s]/g, '').length,
    'the answer includes an explanation after its factual summary').toBeGreaterThan(40);
}

test('[real] dashboard: timer + life phase + exact-day agentic chat', async ({
  page,
}) => {
  const KEY = process.env.OPENROUTER_API_KEY;
  test.skip(!KEY, 'OPENROUTER_API_KEY not set');
  // Cold engine boot + a live tool-loop round-trip; give it generous headroom.
  test.setTimeout(600_000);

  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));

  // Observe (but never intercept) the live provider traffic. Interpretation
  // requests use the same endpoint, so retain only requests carrying the agent
  // tool contract. Request bodies contain prompts/tool data, never the API key.
  const agentRequests = observeAgentRequests(page);

  // Cloud OpenRouter, tool-capable model, cloud_premium so the agentic loop runs
  // and the fail-closed gate permits the off-device call. Key from env only.
  const config = JSON.stringify({
    apiBase: 'https://openrouter.ai/api/v1',
    apiKey: KEY,
    model: E2E_REAL_MODEL,
    privacyMode: 'cloud_premium',
    engine: 'openai-http',
  });
  await page.addInitScript(
    ([key, cfg]) => {
      window.localStorage.setItem(key as string, cfg as string);
    },
    [LLM_SETTINGS_KEY, config] as const,
  );
  // Pin a full-tier device for this desktop journey. iPhone coverage proves
  // the same local tools on the minimal tier.
  await page.addInitScript((tier) => {
    for (const [name, value] of Object.entries(tier)) {
      Object.defineProperty(Navigator.prototype, name, { get: () => value, configurable: true });
    }
  }, { deviceMemory: 8, hardwareConcurrency: 8 });

  await bootEngine(page);
  // Restore the real engine chart through the same backup-import boundary a
  // user exercises, so canonical OPFS SQLite owns the dashboard state.
  const seeded = await seedChart(page);
  expect(String(seeded.lagna).toLowerCase()).toBe('gemini');

  console.log(
    `[engine] lagna=${seeded.lagna} maha=${seeded.mahaLord}`,
  );

  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });

  // ---------------------------------------------------------------------------
  // A) Honest interpretation timer — capture WHILE generation runs.
  // ---------------------------------------------------------------------------
  await page.getByRole('button', { name: 'Generate natal reading' }).click();
  const elapsed = page.getByTestId('interpretation-elapsed');
  await expect(elapsed).toBeVisible({ timeout: 120_000 });
  const timerText = (await elapsed.textContent()) ?? '';
   
  console.log(`[timer] interpretation-elapsed = "${timerText}"`);
  expect(timerText).toMatch(/\d:\d\d/); // live m:ss timer
  expect(timerText).toContain('1–3 minutes');
  expect(timerText.toLowerCase()).not.toContain('about 30 seconds');
  // Whole page must never contain the retired copy.
  await expect(page.getByText('about 30 seconds')).toHaveCount(0);
  await page.screenshot({ path: '/tmp/almamesh-verify/timer.png', fullPage: true });

  // ---------------------------------------------------------------------------
  // B) Identity strip — a real running daśā stack, not the unavailable fallback.
  // ---------------------------------------------------------------------------
  const identity = page.getByTestId('identity-strip');
  await expect(identity).toBeVisible({ timeout: 30_000 });
  const identityText = (await identity.textContent()) ?? '';

  console.log(`[identity] "${identityText.replace(/\s+/g, ' ').trim()}"`);
  // A real maha lord is on screen with its level label (engine-emitted).
  expect(identityText).toContain('Maha');
  expect(identityText).toMatch(/Sun|Moon|Mars|Mercury|Jupiter|Venus|Saturn|Rahu|Ketu/);
  expect(identityText).not.toContain('Not available');

  // ---------------------------------------------------------------------------
  // C) Always-agent chat (HEADLINE) — ask naturally about today. The app must
  //    compute exact-day engine context before provider inference.
  // ---------------------------------------------------------------------------
  await page.getByTestId('floating-chat-button').click();
  const chatInput = page.getByTestId('chat-input');
  await expect(chatInput).toBeVisible({ timeout: 15_000 });

  await expect(page.getByTestId('chat-agent-mode')).toHaveCount(0);
  await chatInput.fill('What planetary influences matter most for me today?');
  await page.getByTestId('chat-send-button').click();
  const sentAt = Date.now();

  // (i) The typing indicator (chat-loading dots) must show BEFORE any answer
  //     text streams in — this also covers the agentic tool-lookup pause.
  await expect(page.getByTestId('chat-loading')).toBeVisible({ timeout: 60_000 });
  await page.screenshot({
    path: '/tmp/almamesh-verify/chat-local-time.png',
    fullPage: true,
  });

  await expect(page.getByTestId('chat-agent-status')).toBeVisible({ timeout: 180_000 });

  // (ii) An answer then STREAMS into the chat panel. Wait for a substantive
  //      assistant message to appear (the tool loop + first-pass decision can
  //      take a while on a reasoning model).
  const assistantMessage = page.getByTestId('chat-message-assistant').last();
  await expect(assistantMessage).toBeVisible({ timeout: 480_000 });
  await expect(assistantMessage).toContainText(/Saturn|Jupiter|Mars|Mercury|Venus|Rahu|Ketu|Moon|Sun/i, {
    timeout: 480_000,
  });
  const answerText = (await assistantMessage.textContent()) ?? '';
  console.log(`[chat timing] send -> grounded answer ${Date.now() - sentAt} ms`);

  await page.screenshot({
    path: '/tmp/almamesh-verify/chat-local-time.png',
    fullPage: true,
  });

  const lower = answerText.toLowerCase();

  console.log(`[chat answer] ${answerText.replace(/\s+/g, ' ').trim().slice(0, 600)}`);

  // Not a placeholder / error bubble.
  for (const placeholder of PLACEHOLDERS) {
    expect(lower).not.toContain(placeholder);
  }

  // THE CONTEXT + TOOL-PROTOCOL ASSERTIONS: the first live request carries the
  // exact fixed allowlist and the deterministic predictive facts block. Model
  // tool choice remains auto; correctness does not depend on it electing a tool.
  await expect
    .poll(() => agentRequests.length, {
      timeout: 480_000,
      intervals: [1_000],
    })
    .toBeGreaterThanOrEqual(1);

  const firstAgentRequest = agentRequests[0].body as {
    model?: unknown;
    stream?: unknown;
    tool_choice?: unknown;
    tools?: Array<{ function?: { name?: string } }>;
    messages?: unknown[];
  };
  // Chat runs on the default chat tier, not the seeded reading model.
  expect(firstAgentRequest.model).toBe(PRODUCT_CHAT_DEFAULT_MODEL);
  // Inverted 2026-10: this asserted `stream: false`. Since 5c99027 the
  // tool-decision round streams so a no-tool answer shows token by token
  // (agent.test.ts and chat.grounding.spec.ts already pin `stream: true`).
  expect(firstAgentRequest.stream).toBe(true);
  expect(firstAgentRequest.tool_choice).toBe('auto');
  // Every live turn offers the local read tools and deferred movement tool.
  expect(firstAgentRequest.tools?.map((tool) => tool.function?.name)).toEqual([
    'get_current_datetime',
    'get_chart_facts',
    'get_timing',
    'resolve_place',
    'time_travel',
  ]);
  const firstMessages = Array.isArray(firstAgentRequest.messages)
    ? firstAgentRequest.messages
    : [];
  expect(JSON.stringify(firstMessages)).toContain('ENGINE PREDICTIVE CONTEXT');
  expect(JSON.stringify(firstMessages)).toContain('Current transits (Gochara)');

  // No hard request failures during the flow.
  for (const fragment of ['LlmRequestError', 'CORS', 'Failed to fetch']) {
    expect(
      errors.some((e) => e.includes(fragment)),
      `console error contained "${fragment}": ${errors.join(' | ')}`,
    ).toBe(false);
  }
});

test('[real] dashboard: September 2017 tool movement, grounded outlook today, and tool return', async ({ page }) => {
  const key = process.env.OPENROUTER_API_KEY;
  test.skip(!key, 'OPENROUTER_API_KEY not set');
  test.setTimeout(600_000);
  const errors: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', (error) => errors.push(String(error)));
  const observed = observeAgentRequests(page);
  // Public demonstration birth only. Omit chatModel to exercise the product default.
  await page.addInitScript(([settingsKey, config]) => {
    window.localStorage.setItem(settingsKey, config);
  }, [LLM_SETTINGS_KEY, JSON.stringify({
    apiBase: 'https://openrouter.ai/api/v1', apiKey: key, model: E2E_REAL_MODEL,
    privacyMode: 'cloud_premium', engine: 'openai-http',
  })] as const);
  await page.addInitScript(() => {
    for (const [name, value] of Object.entries({ deviceMemory: 8, hardwareConcurrency: 8 })) {
      Object.defineProperty(Navigator.prototype, name, { get: () => value, configurable: true });
    }
  });
  await bootEngine(page);
  await seedChart(page, { birth: DELHI_SEED });
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('life-atlas').getByText(/^As of /)).toBeVisible({ timeout: 240_000 });
  await page.getByTestId('floating-chat-button').click();

  const send = async (question: string): Promise<ObservedAgentRequest[]> => {
    const before = observed.length;
    await page.getByTestId('chat-input').fill(question);
    await page.getByTestId('chat-send-button').click();
    await expect.poll(() => observed.length, { timeout: 180_000 }).toBeGreaterThan(before);
    // Disabled for the whole stream AND the final answer/pin persistence barrier.
    await expect(page.getByTestId('time-travel-button')).toBeEnabled({ timeout: 240_000 });
    const turn = observed.slice(before);
    for (const request of turn) expect(request.body.model).toBe(PRODUCT_CHAT_DEFAULT_MODEL);
    return turn;
  };

  const september = await send('Take me to September 2017. Call time_travel with action travel and period month for this requested month, and call get_timing with section dashas for the same whole calendar month. These two tools are sufficient. ' + FACT_SUMMARY_REQUEST);
  const septemberPairs = await successfulToolPairs(september);
  const movement = septemberPairs.find((pair) => pair.name === 'time_travel');
  expect(movement?.args).toMatchObject({ action: 'travel', period: 'month', date: '2017-09' });
  expect(movement?.result).toMatchObject({ status: 'queued', action: 'travel' });
  const septemberTiming = septemberPairs.find((pair) => pair.name === 'get_timing' && pair.args.section === 'dashas');
  expect(septemberTiming?.result).toMatchObject({ period: { start: '2017-09-01', end: '2017-09-30', basis: 'period' } });
  expectCalculatedSummary(await finalResponseText(september), timingDashas(septemberTiming!.result as unknown as DashaTimingResult));
  await expect(page.getByTestId('time-travel-title')).toHaveText('Time travel · September 2017');
  await expect(page.getByTestId('dashboard-time-travel-title')).toHaveText(/September 2017/);
  await expect(page.getByTestId('time-travel-moment-dasha')).toBeVisible();

  const viewerDay = await page.evaluate(() => new Intl.DateTimeFormat('en-CA').format(new Date()));
  const today = await send('outlook today? ' + FACT_SUMMARY_REQUEST);
  const todaySystem = today[0].body.messages?.find((message) => message.role === 'system')?.content ?? '';
  // Contract reversed 2026-10-13 (period reading, spec 2026-10-13): today's dashas and transits were
  // pre-run into a VERIFIED LOCAL TIMING block of the prompt. Now nothing is pre-computed: the first
  // round is tool_choice "required" and grounds itself through get_period_reading, bound to today.
  expect(todaySystem).not.toContain('VERIFIED LOCAL TIMING');
  expect(todaySystem).not.toContain('PINNED PERIOD:');
  expect(today[0].body.tool_choice, 'a today question grounds itself before it answers').toBe('required');
  // The model's own call, or the app's local grounding call when the model skipped it.
  const readingMessage = today.flatMap(({ body }) => body.messages ?? []).find((message) => message.role === 'tool' && message.name === 'get_period_reading');
  const reading = parseSuccessfulToolResult(readingMessage?.content) as unknown as { period: CalculatedDashas['period']; dashas: Omit<CalculatedDashas, 'period'> };
  expect(reading.period).toMatchObject({ start: viewerDay, end: viewerDay });
  expectCalculatedSummary(await finalResponseText(today), { period: reading.period, maha: reading.dashas.maha, antar: reading.dashas.antar });
  await expect(page.getByTestId('time-travel-title')).toHaveText('Time travel · September 2017');
  await expect(page.getByTestId('dashboard-time-travel-title')).toHaveText(/September 2017/);

  const back = await send('Back to today. Use time_travel with action back_to_today and no date or place, then briefly confirm the return after the tool succeeds.');
  const returnPair = (await successfulToolPairs(back)).find((pair) => pair.name === 'time_travel');
  expect(returnPair?.args).toEqual({ action: 'back_to_today' });
  expect(returnPair?.result).toMatchObject({ status: 'queued', action: 'back_to_today' });
  expect((await finalResponseText(back)).trim().length).toBeGreaterThan(12);
  await expect(page.getByTestId('time-travel-banner')).toHaveCount(0);
  await expect(page.getByTestId('dashboard-time-travel-banner')).toHaveCount(0);
  await expect(page.getByTestId('time-travel-moment-card')).toHaveCount(0);
  await expect(page.getByTestId('life-atlas').getByText(/^As of /)).toBeVisible();
  expect(errors, 'the real three-turn journey keeps a clean console').toEqual([]);
});
