import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LlmEnv } from "../config";
import {
  applyLlmSettings,
  describeLlmStatus,
  LLM_SETTINGS_KEY,
  readLlmSettings,
  writeLlmSettings,
} from "../settings";

// Minimal in-memory localStorage so the storage-backed settings are testable in
// the `node` environment (no DOM).
function installMemoryStorage(): void {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  });
}

describe("llm settings — localStorage override layer", () => {
  beforeEach(() => installMemoryStorage());
  afterEach(() => vi.unstubAllGlobals());

  it("returns {} when nothing is stored", () => {
    expect(readLlmSettings()).toEqual({});
  });

  it("round-trips written settings (merging over existing)", () => {
    writeLlmSettings({ apiBase: "http://localhost:1234/v1" });
    writeLlmSettings({ model: "phi3" });
    // A legacy single `model` is preserved AND migrated into the per-tier
    // `interpretationModel` on read (see migrateLegacyModel) — back-compat.
    expect(readLlmSettings()).toEqual({
      apiBase: "http://localhost:1234/v1",
      model: "phi3",
      interpretationModel: "phi3",
    });
  });

  it("tolerates corrupt JSON", () => {
    localStorage.setItem(LLM_SETTINGS_KEY, "{not json");
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

  it("is a no-op when an SSR host exposes only a partial localStorage global", () => {
    vi.stubGlobal("localStorage", {});
    expect(readLlmSettings()).toEqual({});
    expect(() => writeLlmSettings({ model: "x" })).not.toThrow();
  });
});

describe("readLlmSettings — self-heals AlmaMesh's retired default cloud model", () => {
  beforeEach(() => installMemoryStorage());
  afterEach(() => vi.unstubAllGlobals());

  it("upgrades a saved dead anthropic/claude-3.5-sonnet OpenRouter preset to the recommended model AND persists it", () => {
    localStorage.setItem(
      LLM_SETTINGS_KEY,
      JSON.stringify({
        apiBase: "https://openrouter.ai/api/v1",
        apiKey: "sk-or-123",
        model: "anthropic/claude-3.5-sonnet",
        privacyMode: "cloud_premium",
      }),
    );
    expect(readLlmSettings().model).toBe("deepseek/deepseek-v4.1-flash");
    // Persisted, so every other caller (and a reload) sees the healed value.
    const persisted = JSON.parse(localStorage.getItem(LLM_SETTINGS_KEY) as string);
    expect(persisted.model).toBe("deepseek/deepseek-v4.1-flash");
    expect(persisted.apiKey).toBe("sk-or-123"); // key + base preserved
  });

  it("keeps a user on the previous default (deepseek-v4-pro): a default change never rewrites a saved model", () => {
    const saved = {
      apiBase: "https://openrouter.ai/api/v1",
      apiKey: "sk-or-123",
      model: "deepseek/deepseek-v4-pro",
      interpretationModel: "deepseek/deepseek-v4-pro",
      privacyMode: "cloud_premium",
    };
    localStorage.setItem(LLM_SETTINGS_KEY, JSON.stringify(saved));
    expect(readLlmSettings().interpretationModel).toBe("deepseek/deepseek-v4-pro");
    expect(JSON.parse(localStorage.getItem(LLM_SETTINGS_KEY) as string)).toEqual(saved);
  });

  it("leaves a model the user deliberately chose untouched", () => {
    localStorage.setItem(
      LLM_SETTINGS_KEY,
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
    localStorage.setItem(
      LLM_SETTINGS_KEY,
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
