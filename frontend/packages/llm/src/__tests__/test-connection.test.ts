import { describe, expect, it, vi } from "vitest";

import { LlmRequestError, testProviderConnection } from "../client";
import { PrivacyViolationError, type ProviderConfig } from "../config";

const OPENROUTER_CFG: ProviderConfig = {
  engine: "openai-http",
  model: "deepseek/deepseek-v4-pro",
  privacyMode: "cloud_premium",
  baseUrl: "https://openrouter.ai/api/v1",
  apiKey: "sk-or-123",
};

function jsonResponse(body: unknown, init: ResponseInit): Response {
  return new Response(JSON.stringify(body), init);
}

describe("testProviderConnection", () => {
  it("resolves on a 2xx and hits /chat/completions with a NO-max_tokens body + auth", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: "ok" } }] }, { status: 200 }),
    );
    await expect(
      testProviderConnection({ config: OPENROUTER_CFG, fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).resolves.toBeUndefined();

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-or-123");
    const sent = JSON.parse(init.body as string);
    expect(sent).toMatchObject({
      model: "deepseek/deepseek-v4-pro",
      stream: false,
      response_format: { type: "json_object" },
    });
    // A token cap is BELOW the min-output floor of reasoning models (GPT-5 family,
    // >= 16) → a `max_tokens: 1` probe 400s a model whose real reading would work.
    expect(sent).not.toHaveProperty("max_tokens");
    // OpenAI's json_object mode 400s unless a message contains "json" — the probe
    // must mirror that constraint, same as the real reading (chatCompletionJson).
    expect((sent.messages[0].content as string).toLowerCase()).toContain("json");
  });

  it("throws PrivacyViolationError BEFORE any fetch when local_only targets a cloud host", async () => {
    const fetchImpl = vi.fn();
    await expect(
      testProviderConnection({
        config: { ...OPENROUTER_CFG, privacyMode: "local_only" },
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(PrivacyViolationError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws LlmRequestError carrying .status for a 401 (bad key)", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { message: "No auth credentials found" } }, { status: 401, statusText: "Unauthorized" }),
    );
    const err = await testProviderConnection({
      config: OPENROUTER_CFG,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmRequestError);
    expect((err as LlmRequestError).status).toBe(401);
  });

  it("throws LlmRequestError carrying .status for a 400 bad model id", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        { error: { message: "bad/slug is not a valid model ID" } },
        { status: 400, statusText: "Bad Request" },
      ),
    );
    const err = await testProviderConnection({
      config: OPENROUTER_CFG,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmRequestError);
    expect((err as LlmRequestError).status).toBe(400);
    expect((err as LlmRequestError).message.toLowerCase()).toContain("not a valid model id");
  });

  it("propagates a fetch TypeError (unreachable endpoint) unchanged", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(
      testProviderConnection({ config: OPENROUTER_CFG, fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("rejects an HTTP 200 OpenRouter in-band error body (including string status codes)", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        { error: { code: "402", message: "Insufficient credits" } },
        { status: 200 },
      ),
    );
    const err = await testProviderConnection({
      config: OPENROUTER_CFG,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmRequestError);
    expect((err as LlmRequestError).status).toBe(402);
    expect((err as LlmRequestError).message).toContain("Insufficient credits");
  });
});
