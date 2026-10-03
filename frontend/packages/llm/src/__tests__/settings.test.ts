import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { LlmEnv } from "../config";
import {
  applyLlmSettings,
  configureLlmSettingsPersistence,
  describeLlmStatus,
  hydrateLlmSettings,
  readLlmSettings,
  writeLlmSettings,
} from "../settings";

describe("llm settings — boot-hydrated SQLite view", () => {
  beforeEach(() => hydrateLlmSettings(null));
  afterEach(() => {
    configureLlmSettingsPersistence(undefined);
  });

  it("returns {} when nothing is stored", () => {
    expect(readLlmSettings()).toEqual({});
  });

  it("round-trips written settings (merging over existing)", () => {
    writeLlmSettings({ apiBase: "http://localhost:1234/v1" });
    writeLlmSettings({ model: "phi3" });
    expect(readLlmSettings()).toEqual({
      apiBase: "http://localhost:1234/v1",
      model: "phi3",
    });
  });

  it("sends the complete merged settings, including the API key, to durable persistence", () => {
    const persisted: string[] = [];
    configureLlmSettingsPersistence((serialized) => void persisted.push(serialized));

    writeLlmSettings({ apiBase: "https://openrouter.ai/api/v1", apiKey: "sk-synthetic" });
    writeLlmSettings({ interpretationModel: "example/model", privacyMode: "cloud_premium" });

    expect(JSON.parse(persisted.at(-1)!)).toEqual({
      apiBase: "https://openrouter.ai/api/v1",
      apiKey: "sk-synthetic",
      interpretationModel: "example/model",
      privacyMode: "cloud_premium",
    });
  });

  it("tolerates corrupt JSON", () => {
    expect(hydrateLlmSettings("{not json")).toEqual({});
    expect(readLlmSettings()).toEqual({});
  });

  it("lets stored overrides win over env, falling back to env otherwise", () => {
    const env: LlmEnv = {
      VITE_LLM_API_BASE: "http://localhost:11434/v1",
      VITE_LLM_MODEL: "llama3.1",
    };
    const merged = applyLlmSettings(env, { model: "phi3", apiKey: "sk-local" });
    expect(merged.VITE_LLM_MODEL).toBe("phi3");
    expect(merged.VITE_LLM_API_KEY).toBe("sk-local");
    expect(merged.VITE_LLM_API_BASE).toBe("http://localhost:11434/v1");
  });

  it("does not depend on Web Storage in an SSR host", () => {
    expect(readLlmSettings()).toEqual({});
    expect(() => writeLlmSettings({ model: "x" })).not.toThrow();
  });
});

describe("readLlmSettings — self-heals AlmaMesh's retired default cloud model", () => {
  const persisted: string[] = [];
  beforeEach(() => {
    persisted.length = 0;
    hydrateLlmSettings(null);
    configureLlmSettingsPersistence((serialized) => void persisted.push(serialized));
  });
  afterEach(() => configureLlmSettingsPersistence(undefined));

  it("upgrades a saved dead anthropic/claude-3.5-sonnet OpenRouter preset to the recommended model AND persists it", () => {
    hydrateLlmSettings(
      JSON.stringify({
        apiBase: "https://openrouter.ai/api/v1",
        apiKey: "sk-or-123",
        model: "anthropic/claude-3.5-sonnet",
        privacyMode: "cloud_premium",
      }),
    );
    expect(readLlmSettings().model).toBe("deepseek/deepseek-v4.1-flash");
    const healed = JSON.parse(persisted.at(-1)!);
    expect(healed.model).toBe("deepseek/deepseek-v4.1-flash");
    expect(healed.apiKey).toBe("sk-or-123"); // key + base preserved
  });

  it("keeps a user on the previous default (deepseek-v4-pro): a default change never rewrites a saved model", () => {
    const saved = {
      apiBase: "https://openrouter.ai/api/v1",
      apiKey: "sk-or-123",
      model: "deepseek/deepseek-v4-pro",
      interpretationModel: "deepseek/deepseek-v4-pro",
      privacyMode: "cloud_premium",
    };
    hydrateLlmSettings(JSON.stringify(saved));
    expect(readLlmSettings().interpretationModel).toBe("deepseek/deepseek-v4-pro");
    expect(persisted).toEqual([]);
  });

  it("leaves a model the user deliberately chose untouched", () => {
    hydrateLlmSettings(
      JSON.stringify({
        apiBase: "https://openrouter.ai/api/v1",
        apiKey: "sk-or-123",
        model: "openai/gpt-4o",
        privacyMode: "cloud_premium",
      }),
    );
    expect(readLlmSettings().model).toBe("openai/gpt-4o");
  });

  it("does not rewrite the dead id on a non-OpenRouter base", () => {
    hydrateLlmSettings(
      JSON.stringify({ apiBase: "https://api.example.com/v1", model: "anthropic/claude-3.5-sonnet" }),
    );
    expect(readLlmSettings().model).toBe("anthropic/claude-3.5-sonnet");
  });
});

describe("describeLlmStatus — human-readable provider state", () => {
  it("reports 'none' / not configured for empty settings", () => {
    expect(describeLlmStatus({})).toEqual({
      kind: "none",
      label: "Not set",
      configured: false,
    });
  });

  it("recognizes a configured OpenRouter endpoint (needs a key)", () => {
    const status = describeLlmStatus({
      apiBase: "https://openrouter.ai/api/v1",
      apiKey: "sk-or-123",
      model: "anthropic/claude-3.5-sonnet",
      privacyMode: "cloud_premium",
    });
    expect(status.kind).toBe("openrouter");
    expect(status.label).toBe("OpenRouter");
    expect(status.configured).toBe(true);
  });

  it("flags OpenRouter selected-but-keyless as not yet configured", () => {
    const status = describeLlmStatus({
      apiBase: "https://openrouter.ai/api/v1",
      model: "anthropic/claude-3.5-sonnet",
      privacyMode: "cloud_premium",
    });
    expect(status.kind).toBe("openrouter");
    expect(status.configured).toBe(false);
  });

  it("recognizes a local endpoint (no key required)", () => {
    const status = describeLlmStatus({
      apiBase: "http://localhost:11434/v1",
      model: "llama3.1",
    });
    expect(status.kind).toBe("local");
    expect(status.label).toBe("Local");
    expect(status.configured).toBe(true);
  });

  it("labels a non-local custom cloud endpoint as 'Cloud'", () => {
    const status = describeLlmStatus({
      apiBase: "https://api.example.com/v1",
      apiKey: "sk-x",
      model: "gpt-4o",
      privacyMode: "cloud_premium",
    });
    expect(status.kind).toBe("cloud");
    expect(status.label).toBe("Cloud");
    expect(status.configured).toBe(true);
  });

  // Regression: the manual endpoint form writes `interpretationModel` (the tiered
  // field), NOT the legacy `model`. A valid hand-typed OpenRouter config must
  // count as configured, or every downstream gate (Active badge, header, chat,
  // dashboard reading) stays silently off — the "nothing happens on save" bug.
  it("counts a tiered-model-only config (interpretationModel, no legacy model) as configured", () => {
    const status = describeLlmStatus({
      apiBase: "https://openrouter.ai/api/v1",
      apiKey: "sk-or-123",
      interpretationModel: "deepseek/deepseek-v4-pro",
      privacyMode: "cloud_premium",
    });
    expect(status.kind).toBe("openrouter");
    expect(status.configured).toBe(true);
  });

  it("counts a chatModel-only local config as configured", () => {
    const status = describeLlmStatus({
      apiBase: "http://localhost:11434/v1",
      chatModel: "llama3.1",
    });
    expect(status.kind).toBe("local");
    expect(status.configured).toBe(true);
  });
});
