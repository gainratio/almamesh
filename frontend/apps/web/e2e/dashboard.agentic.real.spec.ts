import { test, expect } from '@playwright/test';
import { bootEngine, seedChart, LLM_SETTINGS_KEY } from './interpretation.helpers';

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
 *      model receives that sanitized context and the three read-only tools.
 *      Also proves the typing indicator (`chat-loading`) appears before output.
 *
 * This is a REAL integration test: real in-browser Pyodide engine, a real Delhi
 * sidereal chart generated in-tab, and a LIVE OpenRouter round-trip. The reading
 * uses the seeded `model` (deepseek/deepseek-v4-pro); chat has no `chatModel`
 * saved, so it runs on the default chat tier (CHAT_CLOUD_MODEL,
 * deepseek/deepseek-v4.1-flash). The OpenRouter key is read ONLY from
 * process.env (never bundled).
 *
 * Run:  bun run test:e2e:dashboard:agentic:real   (from apps/web)
 *       (set OPENROUTER_API_KEY=... or the test self-skips.)
 */

/** Strings that signal a non-real / placeholder chat answer. */
const PLACEHOLDERS = ['pending', 'please retry', 'loading', 'no answer available'];

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
  const agentRequestBodies: Array<Record<string, unknown>> = [];
  page.on('request', (request) => {
    if (request.method() !== 'POST' || !request.url().endsWith('/chat/completions')) return;
    try {
      const body = request.postDataJSON() as Record<string, unknown>;
      const tools = Array.isArray(body.tools) ? body.tools : [];
      const names = tools.flatMap((tool) => {
        if (typeof tool !== 'object' || tool === null) return [];
        const fn = (tool as { function?: unknown }).function;
        if (typeof fn !== 'object' || fn === null) return [];
        const name = (fn as { name?: unknown }).name;
        return typeof name === 'string' ? [name] : [];
      });
      if (names.includes('get_current_datetime')) agentRequestBodies.push(body);
    } catch {
      // Non-JSON requests cannot be part of the OpenAI-compatible agent loop.
    }
  });

  // Cloud OpenRouter, tool-capable model, cloud_premium so the agentic loop runs
  // and the fail-closed gate permits the off-device call. Key from env only.
  const config = JSON.stringify({
    apiBase: 'https://openrouter.ai/api/v1',
    apiKey: KEY,
    model: 'deepseek/deepseek-v4-pro',
    privacyMode: 'cloud_premium',
    engine: 'openai-http',
  });
  await page.addInitScript(
    ([key, cfg]) => {
      window.localStorage.setItem(key as string, cfg as string);
    },
    [LLM_SETTINGS_KEY, config] as const,
  );

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
    .poll(() => agentRequestBodies.length, {
      timeout: 480_000,
      intervals: [1_000],
    })
    .toBeGreaterThanOrEqual(1);

  const firstAgentRequest = agentRequestBodies[0] as {
    model?: unknown;
    stream?: unknown;
    tool_choice?: unknown;
    tools?: Array<{ function?: { name?: string } }>;
    messages?: unknown[];
  };
  // Chat runs on the default chat tier, not the seeded reading model.
  expect(firstAgentRequest.model).toBe('deepseek/deepseek-v4.1-flash');
  // Inverted 2026-10: this asserted `stream: false`. Since 5c99027 the
  // tool-decision round streams so a no-tool answer shows token by token
  // (agent.test.ts and chat.grounding.spec.ts already pin `stream: true`).
  expect(firstAgentRequest.stream).toBe(true);
  expect(firstAgentRequest.tool_choice).toBe('auto');
  expect(firstAgentRequest.tools?.map((tool) => tool.function?.name)).toEqual([
    'get_current_datetime',
    'get_chart_facts',
    'get_timing',
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
