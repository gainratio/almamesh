import { describe, expect, it, vi } from "vitest";

import { fetchOpenRouterModels, LlmRequestError, testProviderConnection } from "./client";
import { OPENROUTER_API_BASE, type ProviderConfig } from "./config";

// Minimal fetch stub: a Response-shaped object is enough for the models reader,
// which only touches `ok`, `status`, `json()`, and (on failure) `text()`.
function stubFetch(
  body: unknown,
  { ok = true, status = 200, nonJson = false }: { ok?: boolean; status?: number; nonJson?: boolean } = {},
): typeof fetch {
  const response = {
    ok,
    status,
    json: nonJson
      ? () => Promise.reject(new SyntaxError("not json"))
      : () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
  return vi.fn(() => Promise.resolve(response)) as unknown as typeof fetch;
}

const openRouterConfig: ProviderConfig = {
  engine: "openai-http",
  model: "openai/gpt-4o",
  privacyMode: "cloud_premium",
  baseUrl: OPENROUTER_API_BASE,
  apiKey: "sk-or-test",
};

describe("testProviderConnection", () => {
  function okFetch(): { mock: ReturnType<typeof vi.fn>; impl: typeof fetch } {
    const mock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ choices: [{ message: { content: "ok" } }] }),
        text: () => Promise.resolve("ok"),
      } as unknown as Response),
    );
    return { mock, impl: mock as unknown as typeof fetch };
  }

  it("probes with NO max_tokens — a token cap wrongly rejects reasoning models (GPT-5 floor is 16)", async () => {
    const { mock, impl } = okFetch();
    await testProviderConnection({ config: openRouterConfig, fetchImpl: impl });
    const init = mock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    // The real reading sends no token cap; the probe must not add one, or a model
    // with a minimum-output floor (OpenAI reasoning / GPT-5 family) 400s the probe
    // while the actual reading would succeed.
    expect(body).not.toHaveProperty("max_tokens");
  });

  it("probes the exact configured model, non-streaming, with a message", async () => {
    const { mock, impl } = okFetch();
    await testProviderConnection({ config: openRouterConfig, fetchImpl: impl });
    const body = JSON.parse(String((mock.mock.calls[0][1] as RequestInit).body)) as Record<
      string,
      unknown
    >;
    expect(body.model).toBe(openRouterConfig.model);
    expect(body.stream).toBe(false);
    expect(Array.isArray(body.messages)).toBe(true);
  });

  it("mirrors chatCompletionJson's JSON mode — response_format json_object and a message containing 'json'", async () => {
    const { mock, impl } = okFetch();
    await testProviderConnection({ config: openRouterConfig, fetchImpl: impl });
    const body = JSON.parse(String((mock.mock.calls[0][1] as RequestInit).body)) as {
      readonly response_format?: { readonly type: string };
      readonly messages: ReadonlyArray<{ readonly content: string }>;
    };
    // OpenAI's json_object mode 400s unless a message contains the word "json" —
    // the probe must satisfy that constraint just like the real reading does.
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages[0].content.toLowerCase()).toContain("json");
    expect(body).not.toHaveProperty("max_tokens");
  });

  it("throws a typed LlmRequestError carrying the status + body on a non-2xx (so it's classifiable)", async () => {
    const mock = vi.fn(() =>
      Promise.resolve({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        json: () => Promise.reject(new Error("no json")),
        text: () =>
          Promise.resolve(
            '{"error":{"message":"Invalid \'max_output_tokens\': Expected a value >= 16, but got 1 instead."}}',
          ),
      } as unknown as Response),
    );
    const err = await testProviderConnection({
      config: openRouterConfig,
      fetchImpl: mock as unknown as typeof fetch,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmRequestError);
    expect((err as LlmRequestError).status).toBe(400);
    expect((err as LlmRequestError).body).toContain("Expected a value >= 16");
  });
});

describe("fetchOpenRouterModels", () => {
  it("maps the catalog to sorted {id,name} and hits {base}/models", async () => {
    const fetchImpl = stubFetch({
      data: [
        { id: "openai/gpt-4o", name: "GPT-4o" },
        { id: "anthropic/claude-3", name: "Claude 3" },
      ],
    });
    const models = await fetchOpenRouterModels({ config: openRouterConfig, fetchImpl });

    expect(models).toEqual([
      { id: "anthropic/claude-3", name: "Claude 3" },
      { id: "openai/gpt-4o", name: "GPT-4o" },
    ]);
    expect(fetchImpl).toHaveBeenCalledWith(
      `${OPENROUTER_API_BASE}/models`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("falls back name → id when the catalog omits a name, and skips id-less rows", async () => {
    const fetchImpl = stubFetch({
      data: [
        { id: "x/only-id" },
        { name: "no id here" },
        { id: "" },
        { id: "y/named", name: "Named" },
      ],
    });
    const models = await fetchOpenRouterModels({ config: openRouterConfig, fetchImpl });
    expect(models).toEqual([
      { id: "x/only-id", name: "x/only-id" },
      { id: "y/named", name: "Named" },
    ]);
  });

  it("parses per-token USD pricing from the catalog row", async () => {
    const fetchImpl = stubFetch({
      data: [
        { id: "deepseek/deepseek-v4.1-flash", name: "Flash", pricing: { prompt: "0.0000003", completion: "0.0000012" } },
        { id: "meta/free", name: "Free", pricing: { prompt: "0", completion: "0" } },
        { id: "openrouter/auto", name: "Auto", pricing: { prompt: "-1", completion: "-1" } },
        { id: "odd/model", name: "Odd", pricing: { prompt: "abc", completion: "0.000001" } },
        { id: "no/pricing", name: "None" },
      ],
    });
    const models = await fetchOpenRouterModels({ config: openRouterConfig, fetchImpl });
    const byId = Object.fromEntries(models.map((m) => [m.id, m]));
    expect(byId["deepseek/deepseek-v4.1-flash"].pricing).toEqual({
      promptUsdPerToken: 0.0000003,
      completionUsdPerToken: 0.0000012,
    });
    expect(byId["meta/free"].pricing).toEqual({ promptUsdPerToken: 0, completionUsdPerToken: 0 });
    expect(byId["openrouter/auto"].pricing).toBeUndefined();
    expect(byId["odd/model"].pricing).toBeUndefined();
    expect(byId["no/pricing"]).not.toHaveProperty("pricing");
  });

  it("refuses fail-closed for a non-OpenRouter endpoint (no key leaves the host)", async () => {
    const local: ProviderConfig = { ...openRouterConfig, baseUrl: "http://localhost:11434/v1" };
    const fetchImpl = stubFetch({ data: [] });
    await expect(fetchOpenRouterModels({ config: local, fetchImpl })).rejects.toBeInstanceOf(
      LlmRequestError,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws a typed LlmRequestError on a non-2xx (classifiable by the UI)", async () => {
    const fetchImpl = stubFetch("Unauthorized", { ok: false, status: 401 });
    await expect(
      fetchOpenRouterModels({ config: openRouterConfig, fetchImpl }),
    ).rejects.toBeInstanceOf(LlmRequestError);
  });

  it("throws a typed error on a 2xx non-JSON body", async () => {
    const fetchImpl = stubFetch("<html>", { nonJson: true });
    await expect(
      fetchOpenRouterModels({ config: openRouterConfig, fetchImpl }),
    ).rejects.toBeInstanceOf(LlmRequestError);
  });

  it("returns [] for an empty or missing data array", async () => {
    await expect(
      fetchOpenRouterModels({ config: openRouterConfig, fetchImpl: stubFetch({}) }),
    ).resolves.toEqual([]);
  });
});
