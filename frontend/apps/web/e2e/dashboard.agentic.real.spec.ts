import { test, expect, type Page, type Request } from '@playwright/test';
import { bootEngine, seedChart, DELHI_SEED, LLM_SETTINGS_KEY } from './interpretation.helpers';
import { E2E_REAL_MODEL, PRODUCT_CHAT_DEFAULT_MODEL } from './realModel';
import { parseCompletedToolResult } from './agenticToolResult.helpers';

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
      if (!body.tools?.some((tool) => tool.function?.name === 'read_period')) return;
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
      // A tool message carries no name since the tool layer redesign (2026-10-14): the call names it.
      if (message.role === 'tool' && message.tool_call_id && !results.has(message.tool_call_id)) results.set(message.tool_call_id, message);
    }
  }
  expect(calls.size, 'each turn stays inside the three-call agent budget').toBeLessThanOrEqual(3);
  expect(results.size, 'every actual assistant tool call has a matching local result').toBe(calls.size);
  return [...calls.values()].map((call) => {
    expect(providerCallIds.has(call.id), 'the call ID was emitted by the real provider').toBe(true);
    const message = results.get(call.id);
    const result = parseCompletedToolResult(message?.content);
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

/** One streamed tool-call delta (OpenAI-compatible): the name arrives once, the arguments in pieces. */
interface ProviderToolCallDelta {
  readonly index?: number;
  readonly function?: { readonly name?: string; readonly arguments?: string };
}

/** The typed answer the turn ends with (the `answer` tool call, packages/llm/src/answer.ts). */
interface TypedAnswer {
  readonly kind: string;
  readonly markdown: string | null;
  readonly period: string | null;
  readonly opening: string | null;
  readonly dashas: { readonly maha: { readonly lord: string }; readonly antar: { readonly lord: string } } | null;
}

/**
 * The turn's final answer: since the tool layer redesign (2026-10-14) it is the last round's
 * `answer` tool call, not prose. Assembled from the streamed deltas of the last response.
 */
async function finalAnswer(requests: ObservedAgentRequest[]): Promise<TypedAnswer> {
  const calls = new Map<number, { name: string; args: string }>();
  for (const message of await providerMessages(requests[requests.length - 1]!)) {
    ((message.tool_calls ?? []) as ProviderToolCallDelta[]).forEach((delta, position) => {
      const index = delta.index ?? position;
      const call = calls.get(index) ?? { name: '', args: '' };
      calls.set(index, { name: call.name + (delta.function?.name ?? ''), args: call.args + (delta.function?.arguments ?? '') });
    });
  }
  const answer = [...calls.values()].find((call) => call.name === 'answer');
  expect(answer, 'the turn ends in the typed answer call').toBeDefined();
  return JSON.parse(answer!.args) as TypedAnswer;
}

const FACT_SUMMARY_REQUEST = 'Answer with kind "period": restate the calculated maha and antar dasha lords covering that period exactly as read_period gave them, then explain the active calculated timing in two short sentences.';

/** The calculated dashas an answer must restate: from the turn's read_period reading. */
interface CalculatedDashas {
  readonly period: { readonly start: string; readonly end: string };
  readonly maha: ReadonlyArray<{ readonly lord: string }>;
  readonly antar: ReadonlyArray<{ readonly lord: string }>;
}

/** The turn's first completed read_period reading (a result with a period and dashas). */
function readPeriodDashas(pairs: ReadonlyArray<{ readonly name: string; readonly result: Record<string, unknown> }>): CalculatedDashas {
  const reading = pairs.find((pair) => pair.name === 'read_period' && 'period' in pair.result && 'dashas' in pair.result)?.result;
  expect(reading, 'the turn read its period with read_period').toBeDefined();
  const { period, dashas } = reading as unknown as { period: CalculatedDashas['period']; dashas: Omit<CalculatedDashas, 'period'> };
  return { period, maha: dashas.maha, antar: dashas.antar };
}

/**
 * The typed answer restates the calculated dashas: a "period" answer whose one maha and one antar
 * lord are among the reading's lords for that span (the typed answer holds one lord per level; the
 * old prose JSON listed every lord), names the period it read, explains them, and the rendered
 * answer names both lords on screen.
 */
async function expectCalculatedSummary(page: Page, answer: TypedAnswer, timing: CalculatedDashas, period: RegExp): Promise<void> {
  expect(timing.maha.length).toBeGreaterThan(0);
  expect(timing.antar.length).toBeGreaterThan(0);
  expect(answer.kind, 'a read period is answered with its facts').toBe('period');
  expect(answer.dashas, 'a factual summary accompanies any legitimate life-event caveat').not.toBeNull();
  const lords = (rows: ReadonlyArray<{ readonly lord: string }>) => rows.map((row) => row.lord.trim().toLowerCase());
  const maha = answer.dashas!.maha.lord.trim().toLowerCase();
  const antar = answer.dashas!.antar.lord.trim().toLowerCase();
  expect(lords(timing.maha), 'the answer restates a calculated maha lord').toContain(maha);
  expect(lords(timing.antar), 'the answer restates a calculated antar lord').toContain(antar);
  expect(answer.period ?? '', 'the answer names the period it read').toMatch(period);
  expect((answer.opening ?? '').replace(/\s/g, '').length, 'the answer includes an explanation beside its factual summary').toBeGreaterThan(40);
  const shown = (await page.getByTestId('chat-message-assistant').last().textContent()) ?? '';
  expect(shown, 'the rendered answer names the maha lord').toMatch(new RegExp(`\\b${maha}\\b`, 'i'));
  expect(shown, 'the rendered answer names the antar lord').toMatch(new RegExp(`\\b${antar}\\b`, 'i'));
}

/** "14 October 2026", "October 14, 2026", "Oct 14" or "2026-10-14": the viewer's day as a person writes it. */
function dayPattern(isoDay: string): RegExp {
  const date = new Date(`${isoDay}T12:00:00Z`);
  const day = date.getUTCDate();
  const month = new Intl.DateTimeFormat('en', { month: 'long', timeZone: 'UTC' }).format(date);
  const short = month.slice(0, 3);
  return new RegExp(`\\b${day}(?:st|nd|rd|th)?\\s+(?:${month}|${short})|(?:${month}|${short})\\.?\\s+${day}\\b|${isoDay}`, 'i');
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
  // Contract changed (chat tool layer redesign, Task 6): every round calls a tool; a today turn
  // offers the one read tool, the deferred move and the final answer.
  expect(firstAgentRequest.tool_choice).toBe('required');
  expect(firstAgentRequest.tools?.map((tool) => tool.function?.name)).toEqual(['read_period', 'travel', 'answer']);
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

  // Tool layer redesign (2026-10-14): the move is travel(to, place), the read is read_period(start, end, ...).
  const september = await send('Take me to September 2017. Call travel with to "2017-09" for this requested month, and call read_period for the same whole calendar month. These two tools are sufficient. ' + FACT_SUMMARY_REQUEST);
  const septemberPairs = await successfulToolPairs(september);
  const movement = septemberPairs.find((pair) => pair.name === 'travel');
  expect(movement?.args).toMatchObject({ to: '2017-09' });
  expect(movement?.result).toMatchObject({ status: 'queued', action: 'travel', period_label: 'September 2017' });
  const septemberTiming = readPeriodDashas(septemberPairs);
  expect(septemberTiming.period).toMatchObject({ start: '2017-09-01', end: '2017-09-30', granularity: 'month' });
  await expectCalculatedSummary(page, await finalAnswer(september), septemberTiming, /September 2017|Sept?\.? 2017|2017-09/i);
  await expect(page.getByTestId('time-travel-title')).toHaveText('Time travel · September 2017');
  await expect(page.getByTestId('dashboard-time-travel-title')).toHaveText(/September 2017/);
  await expect(page.getByTestId('time-travel-moment-dasha')).toBeVisible();

  const viewerDay = await page.evaluate(() => new Intl.DateTimeFormat('en-CA').format(new Date()));
  const today = await send('outlook today? ' + FACT_SUMMARY_REQUEST);
  const todaySystem = today[0].body.messages?.find((message) => message.role === 'system')?.content ?? '';
  // Contract reversed 2026-10-13 (period reading, spec 2026-10-13): today's dashas and transits were
  // pre-run into a VERIFIED LOCAL TIMING block of the prompt. Now nothing is pre-computed: the first
  // round is tool_choice "required" and grounds itself through read_period, bound to today.
  expect(todaySystem).not.toContain('VERIFIED LOCAL TIMING');
  expect(todaySystem).not.toContain('PINNED PERIOD:');
  expect(today[0].body.tool_choice, 'a today question grounds itself before it answers').toBe('required');
  const reading = readPeriodDashas(await successfulToolPairs(today));
  expect(reading.period).toMatchObject({ start: viewerDay, end: viewerDay });
  await expectCalculatedSummary(page, await finalAnswer(today), reading, dayPattern(viewerDay));
  await expect(page.getByTestId('time-travel-title')).toHaveText('Time travel · September 2017');
  await expect(page.getByTestId('dashboard-time-travel-title')).toHaveText(/September 2017/);

  const back = await send('Back to today. Call travel with to "today" and place null, then briefly confirm the return after the tool succeeds.');
  const returnPair = (await successfulToolPairs(back)).find((pair) => pair.name === 'travel');
  expect(returnPair?.args).toEqual({ to: 'today', place: null });
  expect(returnPair?.result).toMatchObject({ status: 'queued', action: 'back_to_today' });
  const confirmation = await finalAnswer(back);
  expect((confirmation.markdown ?? confirmation.opening ?? '').trim().length).toBeGreaterThan(12);
  await expect(page.getByTestId('time-travel-banner')).toHaveCount(0);
  await expect(page.getByTestId('dashboard-time-travel-banner')).toHaveCount(0);
  await expect(page.getByTestId('time-travel-moment-card')).toHaveCount(0);
  await expect(page.getByTestId('life-atlas').getByText(/^As of /)).toBeVisible();
  expect(errors, 'the real three-turn journey keeps a clean console').toEqual([]);
});
