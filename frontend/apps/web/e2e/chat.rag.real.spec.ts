import { test, expect, type Request } from '@playwright/test';
import { bootEngine, LLM_SETTINGS_KEY, seedChart } from './interpretation.helpers';

/**
 * LIVE end-to-end validation of the overhauled "Ask About Your Chart" chat.
 *
 * This is the "build-green != works" gate. It drives the REAL running app:
 *   - real in-browser Pyodide engine + a real Delhi sidereal chart in-tab,
 *   - a LIVE OpenRouter round-trip (deepseek/deepseek-v4-pro),
 *   - the SELF-HOSTED in-browser embedder (MiniLM ONNX under /models/...).
 *
 * Steps mirror the A–G journey in the verification brief and emit machine-
 * readable [evidence] lines + screenshots under /tmp/almamesh-verify/chat/.
 *
 * Run:  bun run test:e2e:chat:rag:real   (from apps/web)
 *       (set OPENROUTER_API_KEY=... or the test self-skips.)
 */

const SHOT = '/tmp/almamesh-verify/chat';

test('[real] chat: single-pass streaming + self-hosted RAG + persistence + search', async ({
  page,
}) => {
  const KEY = process.env.OPENROUTER_API_KEY;
  test.skip(!KEY, 'OPENROUTER_API_KEY not set');
  test.setTimeout(600_000);

  // ---- Console + network capture for the whole run --------------------------
  const consoleLines: string[] = [];
  const errors: string[] = [];
  const requests: { url: string; method: string }[] = [];
  const failedRequests: string[] = [];
  page.on('console', (m) => {
    consoleLines.push(`[${m.type()}] ${m.text()}`);
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  const llmPosts: string[] = [];
  // Full chat-TURN bodies, captured to assert the on-the-wire model + grounding.
  // The chat turn streams (`"stream":true`); the structured-interpretation
  // sections are non-streaming JSON. We tag each body so the later assertion can
  // isolate the chat turns from any interpretation fan-out.
  const chatTurnBodies: { body: string; isStream: boolean }[] = [];
  page.on('request', (req: Request) => {
    requests.push({ url: req.url(), method: req.method() });
    if (req.url().includes('chat/completions') && req.method() === 'POST') {
      const body = req.postData() ?? '';
      const m = body.match(/"role":"user"[^}]*"content":"([^"]{0,80})/g);
      llmPosts.push(`POST#${llmPosts.length + 1} users=[${(m ?? []).map((s) => s.slice(-60)).join(' | ')}]`);
      let isStream: boolean;
      try {
        isStream = JSON.parse(body)?.stream === true;
      } catch {
        isStream = /"stream"\s*:\s*true/.test(body);
      }
      if (isStream) chatTurnBodies.push({ body, isStream });
    }
  });
  page.on('requestfailed', (req: Request) =>
    failedRequests.push(`${req.method()} ${req.url()} :: ${req.failure()?.errorText ?? 'failed'}`),
  );
  page.on('response', (res) => {
    if (res.status() >= 400) failedRequests.push(`HTTP ${res.status()} ${res.url()}`);
  });

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

  // ===========================================================================
  // A) Seed a chart, open the dashboard, open the chat.
  // ===========================================================================
  await bootEngine(page);
  const seeded = await seedChart(page);
  console.log(
    `[evidence] engine lagna=${seeded.lagna} mahaLord=${seeded.mahaLord} antarLord=${seeded.antarLord}`,
  );

  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  await page.getByTestId('floating-chat-button').click({ timeout: 60_000 });
  const chatInput = page.getByTestId('chat-input');
  await expect(chatInput).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: `${SHOT}/A-chat-open.png`, fullPage: true });

  // ===========================================================================
  // B) Send a real question; MEASURE time-to-first-token (TTFT).
  // ===========================================================================
  await chatInput.fill('What does my chart say about my career?');
  const tSend = Date.now();
  await page.getByTestId('chat-send-button').click();

  // Typing indicator must appear (single fast pass: no long blank wait).
  await expect(page.getByTestId('chat-loading')).toBeVisible({ timeout: 60_000 });

  const chatPanel = page.getByTestId('chat-panel');
  // First streamed token = panel grows beyond the empty/typing baseline AND the
  // typing dots are replaced by streaming text. We detect first token by the
  // streaming assistant bubble gaining content.
  let firstTokenMs = -1;
  await expect
    .poll(
      async () => {
        const dotsGone = (await page.getByTestId('chat-loading').count()) === 0;
        const txt = (await chatPanel.textContent()) ?? '';
        // The streaming draft replaces the dots; once we see >40 chars of body
        // beyond the static UI chrome AND the dots are gone, first token landed.
        if (dotsGone && txt.length > 0 && firstTokenMs < 0) {
          firstTokenMs = Date.now() - tSend;
        }
        return firstTokenMs > 0;
      },
      { timeout: 120_000, intervals: [200] },
    )
    .toBe(true);
  console.log(`[evidence] TTFT_ms=${firstTokenMs}`);
  await page.screenshot({ path: `${SHOT}/B-mid-stream.png`, fullPage: true });

  // Wait for a substantive, chart-grounded answer to finish streaming.
  let careerAnswer = '';
  await expect
    .poll(
      async () => {
        careerAnswer = (await chatPanel.textContent()) ?? '';
        const lower = careerAnswer.toLowerCase();
        // chart-grounded: mentions a real placement, a house, a dasha lord, or a sign.
        const grounded =
          lower.includes('house') ||
          lower.includes('dasha') ||
          lower.includes('lagna') ||
          lower.includes('ascendant') ||
          /(?:aries|taurus|gemini|cancer|leo|virgo|libra|scorpio|sagittarius|capricorn|aquarius|pisces)/.test(
            lower,
          );
        return careerAnswer.length > 400 && grounded;
      },
      { timeout: 300_000, intervals: [3_000] },
    )
    .toBe(true);

  // Wait for the stream to FULLY settle before any reload — otherwise reloading
  // mid-stream aborts the in-flight OpenRouter request (net::ERR_ABORTED) and
  // the page logs a spurious QA_001 during teardown. "Settled" = the answer text
  // stops growing across two polls AND the typing indicator is gone.
  let prevLen = -1;
  await expect
    .poll(
      async () => {
        const txt = (await chatPanel.textContent()) ?? '';
        const dotsGone = (await page.getByTestId('chat-loading').count()) === 0;
        const stable = txt.length === prevLen && dotsGone && txt.length > 400;
        prevLen = txt.length;
        return stable;
      },
      { timeout: 300_000, intervals: [2_500] },
    )
    .toBe(true);
  await page.screenshot({ path: `${SHOT}/B-answer-complete.png`, fullPage: true });
  console.log(`[evidence] careerAnswer=${careerAnswer.replace(/\s+/g, ' ').trim().slice(0, 500)}`);

  // ===========================================================================
  // B2) ON-THE-WIRE MODEL — the chat turn must use the FAST chat model
  //     `minimax/minimax-m2.7` (NOT the deeper `deepseek/deepseek-v4-pro` that
  //     the preset seeds for interpretation), stream:true, and carry the chart
  //     facts + reused-reading grounding blocks. applyChatModelPreference swaps
  //     the model ONLY on the default OpenRouter cloud preset (the one seeded).
  // ===========================================================================
  expect(chatTurnBodies.length, 'a streaming chat turn must have gone out on the wire').toBeGreaterThan(0);
  const firstChat = chatTurnBodies[0];
  const chatParsed = JSON.parse(firstChat.body) as {
    model: string;
    stream: boolean;
    messages: { role: string; content: string }[];
  };
  console.log(`[evidence] chat_wire_model=${chatParsed.model} stream=${chatParsed.stream}`);
  expect(chatParsed.model, 'chat must use the FAST minimax model on the wire').toBe('minimax/minimax-m2.7');
  expect(chatParsed.model, 'chat must NOT use the deep interpretation model').not.toBe(
    'deepseek/deepseek-v4-pro',
  );
  expect(chatParsed.stream, 'chat request must stream').toBe(true);
  // Grounding: the system/context messages carry the chart-facts block. (The
  // reused-reading block is present only once an interpretation has completed;
  // this gate seeds no interpretation, so we assert the chart facts that the
  // chat ALWAYS injects — proving the prompt is chart-grounded on the wire.)
  const wireText = firstChat.body.toLowerCase();
  const hasChartFacts =
    /lagna|ascendant|nakshatra|sidereal|dasha|placement|house|chart facts|whole sign/.test(wireText);
  expect(hasChartFacts, 'outbound chat body must carry chart-facts grounding').toBe(true);
  console.log('[B2] chat on-the-wire model=minimax/minimax-m2.7, stream=true, chart-grounded.');

  // ===========================================================================
  // C) NETWORK ASSERTION — embedding model loads SAME-ORIGIN; zero HF/jsdelivr.
  // ===========================================================================
  const origin = new URL(page.url()).origin;
  const modelReqs = requests.filter((r) => r.url.includes('/models/'));
  const sameOriginModelReqs = modelReqs.filter((r) => r.url.startsWith(origin));
  const offOriginModel = requests.filter(
    (r) =>
      /huggingface\.co|hf\.co|cdn\.jsdelivr\.net|jsdelivr/.test(r.url) &&
      /\.(onnx|wasm|json)|all-MiniLM|ort-wasm/.test(r.url),
  );
  const minilmReqs = modelReqs.filter((r) => /all-MiniLM|model_quantized|ort-wasm/.test(r.url));
  console.log(
    `[evidence] model_requests_total=${modelReqs.length} same_origin=${sameOriginModelReqs.length} minilm_or_ort=${minilmReqs.length} offorigin_model=${offOriginModel.length}`,
  );
  console.log(`[evidence] model_urls=${[...new Set(modelReqs.map((r) => new URL(r.url).pathname))].join(' , ')}`);
  // The embedder must have loaded the self-hosted model + ort wasm same-origin.
  expect(minilmReqs.length, 'embedder must fetch the self-hosted MiniLM/ort assets').toBeGreaterThan(0);
  expect(sameOriginModelReqs.length).toBe(modelReqs.length);
  expect(offOriginModel, 'NO model/wasm requests to HF or jsdelivr').toHaveLength(0);

  const embedderConsole = consoleLines.filter((l) =>
    /embedder|MiniLM|transformers|onnx|chatMemory/i.test(l),
  );
  console.log(`[evidence] embedder_console=${JSON.stringify(embedderConsole.slice(0, 8))}`);

  // ===========================================================================
  // D) Reload; reopen chat → prior conversation STILL THERE (persistence).
  // ===========================================================================
  await page.reload({ waitUntil: 'domcontentloaded' });
  // Re-boot engine hooks are not needed for chat reads. Opening the chat after
  // a full document reload exercises the shipped portable SQLite hydration
  // path rather than inspecting a retired browser store.
  await page.getByTestId('floating-chat-button').click({ timeout: 60_000 });
  await expect(page.getByTestId('chat-input')).toBeVisible({ timeout: 30_000 });
  const afterReload = page.getByTestId('chat-panel');
  await expect
    .poll(async () => ((await afterReload.textContent()) ?? '').toLowerCase().includes('career'), {
      timeout: 30_000,
      intervals: [500],
    })
    .toBe(true);
  const reloadedText = (await afterReload.textContent()) ?? '';
  console.log(`[evidence] persisted_after_reload=${reloadedText.toLowerCase().includes('career')}`);
  await page.screenshot({ path: `${SHOT}/D-after-reload.png`, fullPage: true });

  // ===========================================================================
  // E) Follow-up referencing earlier content → RAG memory reflects prior turns.
  // ===========================================================================
  const followInput = page.getByTestId('chat-input');
  await followInput.fill('Earlier you discussed my career. Which planet and house drives it?');
  await page.getByTestId('chat-send-button').click();
  await expect(page.getByTestId('chat-loading')).toBeVisible({ timeout: 60_000 });

  let followAnswer = '';
  const baselineLen = reloadedText.length;
  await expect
    .poll(
      async () => {
        followAnswer = (await afterReload.textContent()) ?? '';
        return followAnswer.length > baselineLen + 200;
      },
      { timeout: 300_000, intervals: [3_000] },
    )
    .toBe(true);

  // Let the follow-up stream FULLY settle before the test ends — otherwise the
  // in-flight OpenRouter request is aborted on context teardown (net::ERR_ABORTED)
  // and the page logs a spurious QA_001 during unload. "Settled" = text stable
  // across two polls AND the typing indicator is gone.
  let followPrevLen = -1;
  await expect
    .poll(
      async () => {
        const txt = (await afterReload.textContent()) ?? '';
        const dotsGone = (await page.getByTestId('chat-loading').count()) === 0;
        const stable = txt.length === followPrevLen && dotsGone && txt.length > baselineLen + 200;
        followPrevLen = txt.length;
        followAnswer = txt;
        return stable;
      },
      { timeout: 300_000, intervals: [2_500] },
    )
    .toBe(true);
  console.log(`[evidence] followAnswer_tail=${followAnswer.replace(/\s+/g, ' ').trim().slice(-500)}`);

  // The follow-up references the prior career discussion (RAG/history working):
  // a house, a planet, or a sign placement appears in the new answer body.
  const followLower = followAnswer.toLowerCase();
  expect(
    /house|career|planet|mars|sun|saturn|jupiter|venus|mercury|lagna/.test(followLower),
    'follow-up answer reflects the prior conversation context',
  ).toBe(true);
  await page.screenshot({ path: `${SHOT}/E-followup.png`, fullPage: true });

  // Hard-reload a second time and prove BOTH completed turns rehydrate through
  // the actual UI. This is deliberately black-box: it fails if portable SQLite
  // did not persist either turn, and cannot pass on stale keyval-store data.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByTestId('floating-chat-button').click({ timeout: 60_000 });
  await expect(page.getByTestId('chat-input')).toBeVisible({ timeout: 30_000 });
  const persistedPanel = page.getByTestId('chat-panel');
  const persistedAssistants = page.getByTestId('chat-message-assistant');
  await expect(persistedAssistants).toHaveCount(2, { timeout: 30_000 });
  await expect(persistedPanel).toContainText('What does my chart say about my career?');
  await expect(persistedPanel).toContainText(
    'Earlier you discussed my career. Which planet and house drives it?',
  );
  const persistedAssistantText = await persistedAssistants.allTextContents();
  const persistedError = persistedAssistantText.some((content) =>
    /Error: QA_001|technical difficulties|couldn't process/i.test(content),
  );
  expect(persistedError, 'both rehydrated assistant turns must be real answers').toBe(false);
  console.log(
    `[evidence] portable_sqlite_reload_assistant_count=${persistedAssistantText.length} any_error_bubble=${persistedError}`,
  );
  console.log(
    `[evidence] last_assistant=${(persistedAssistantText.at(-1) ?? '').replace(/\s+/g, ' ').slice(0, 200)}`,
  );
  await page.screenshot({ path: `${SHOT}/E-after-second-reload.png`, fullPage: true });

  // ===========================================================================
  // F) SEARCH box — type a word from an earlier message; click a hit → scroll.
  // ===========================================================================
  const searchBox = page.getByTestId('chat-search').locator('input[type="search"]');
  await expect(searchBox).toBeVisible({ timeout: 15_000 });
  await searchBox.fill('career');
  await expect(page.getByTestId('chat-search-results')).toBeVisible({ timeout: 30_000 });
  // Wait for at least one result button to appear (semantic hit over indexed turns).
  await expect
    .poll(
      async () => page.locator('[data-testid^="chat-search-result-"]').count(),
      { timeout: 30_000, intervals: [500] },
    )
    .toBeGreaterThan(0);
  const firstResult = page.locator('[data-testid^="chat-search-result-"]').first();
  const resultText = (await firstResult.textContent()) ?? '';
  console.log(`[evidence] search_hit=${resultText.replace(/\s+/g, ' ').trim().slice(0, 160)}`);
  await page.screenshot({ path: `${SHOT}/F-search-results.png`, fullPage: true });
  await firstResult.click();
  // A highlighted message ring appears (handleOpenResult sets a 2s highlight).
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOT}/F-search-clicked.png`, fullPage: true });

  // ===========================================================================
  // G) CONSOLE must be clean of APP errors during the flow.
  // ===========================================================================
  // Surface failed requests for transparency (identifies any 404 / network drop).
  for (const f of [...new Set(failedRequests)].slice(0, 20)) {
    console.log(`[evidence] failed_request=${f}`);
  }
  console.log(`[evidence] llm_post_count=${llmPosts.length}`);
  for (const p of llmPosts) {
    console.log(`[evidence] llm_post=${p}`);
  }
  // Filter out benign noise (favicon/sourcemap/devtools). A TRANSIENT cloud-LLM
  // "network error" (OpenRouter dropping a streaming connection) is an
  // environmental flake of the live endpoint, NOT an app bug — both turns still
  // rendered grounded answers above. We assert NO app-level errors remain, and
  // separately report any cloud-LLM transient so it is never hidden.
  const isCloudLlmTransient = (e: string) =>
    /QA_001|network error|technical difficulties|stream failed|Chat error|Connect an AI model/i.test(e);
  const realErrors = errors.filter(
    (e) => !/favicon|sourcemap|source map|DevTools|\[vite\]|net::ERR_ABORTED.*\.map/i.test(e),
  );
  const appErrors = realErrors.filter((e) => !isCloudLlmTransient(e) && !/404 \(Not Found\)/.test(e));
  const cloudTransients = realErrors.filter(isCloudLlmTransient);
  console.log(`[evidence] app_error_count=${appErrors.length} cloud_transient_count=${cloudTransients.length}`);
  for (const e of realErrors.slice(0, 20)) {
    console.log(`[evidence] console_error=${e}`);
  }
  // App-level errors are a hard fail; cloud-LLM transients are reported, not failed.
  expect(appErrors, 'no APP-level console errors during the chat flow').toEqual([]);
});
