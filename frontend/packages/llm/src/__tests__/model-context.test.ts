import { describe, expect, it, vi } from "vitest";

import { fetchOpenRouterModels, resolveModelContextTokens } from "../index";
import type { ProviderConfig } from "../config";

const OPENROUTER: ProviderConfig = {
  engine: "openai-http",
  model: "mock/ctx-8k",
  privacyMode: "cloud_premium",
  baseUrl: "https://openrouter.ai/api/v1",
  apiKey: "secret-key",
};

function catalog(rows: ReadonlyArray<Record<string, unknown>>) {
  return vi.fn(async () => Response.json({ data: rows }));
}

describe("model context window", () => {
  it("the OpenRouter catalog carries each model's context_length", async () => {
    const models = await fetchOpenRouterModels({
      config: OPENROUTER,
      fetchImpl: catalog([{ id: "a", context_length: 8_192 }, { id: "b", context_length: "big" }, { id: "c" }]) as typeof fetch,
    });
    expect(models.map((model) => model.contextLength)).toEqual([8_192, undefined, undefined]);
  });

  it("a configured value wins and needs no network", async () => {
    const fetchImpl = catalog([]);
    await expect(resolveModelContextTokens({ config: OPENROUTER, configured: 32_000, fetchImpl: fetchImpl as typeof fetch })).resolves.toBe(32_000);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("on OpenRouter, reads the chat model's context_length from the public catalog without the key", async () => {
    const fetchImpl = catalog([{ id: "mock/ctx-8k", context_length: 8_192 }, { id: "mock/ctx-1m", context_length: 1_000_000 }]);
    const config = { ...OPENROUTER, baseUrl: "https://openrouter.ai/api/v1/?fresh=1" };
    await expect(resolveModelContextTokens({ config, fetchImpl: fetchImpl as typeof fetch })).resolves.toBe(8_192);
    await expect(resolveModelContextTokens({ config: { ...config, model: "mock/ctx-1m" }, fetchImpl: fetchImpl as typeof fetch })).resolves.toBe(1_000_000);
    // One catalog read per endpoint, and never with the Authorization header.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.stringify(init.headers)).not.toContain("secret-key");
  });

  it("an unknown model, a failed catalog read, or a custom endpoint resolve to undefined (the loop assumes 8k)", async () => {
    const config = { ...OPENROUTER, baseUrl: "https://openrouter.ai/api/v1/?unknown=1" };
    await expect(resolveModelContextTokens({ config: { ...config, model: "nope" }, fetchImpl: catalog([{ id: "x", context_length: 1 }]) as typeof fetch })).resolves.toBeUndefined();
    const failing = vi.fn(async () => new Response("down", { status: 503 }));
    const failed = { ...OPENROUTER, baseUrl: "https://openrouter.ai/api/v1/?failing=1" };
    await expect(resolveModelContextTokens({ config: failed, fetchImpl: failing as typeof fetch })).resolves.toBeUndefined();
    // A failed read is not cached: the next turn tries again.
    await expect(resolveModelContextTokens({ config: failed, fetchImpl: catalog([{ id: "mock/ctx-8k", context_length: 8_192 }]) as typeof fetch })).resolves.toBe(8_192);
    const local = { ...OPENROUTER, baseUrl: "http://localhost:11434/v1", privacyMode: "local_only" } as ProviderConfig;
    const never = catalog([]);
    await expect(resolveModelContextTokens({ config: local, fetchImpl: never as typeof fetch })).resolves.toBeUndefined();
    expect(never).not.toHaveBeenCalled();
  });
});
