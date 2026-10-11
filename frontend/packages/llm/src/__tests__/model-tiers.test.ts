import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CHAT_CLOUD_MODEL, openRouterPreset, RECOMMENDED_CLOUD_MODEL, type LlmEnv } from "../config";
import {
  applyChatSettings,
  applyInterpretationSettings,
  configureLlmSettingsPersistence,
  hydrateLlmSettings,
  readLlmSettings,
  writeLlmSettings,
} from "../settings";

describe("tiered model settings — interpretationModel + chatModel", () => {
  beforeEach(() => hydrateLlmSettings(null));
  afterEach(() => configureLlmSettingsPersistence(undefined));

  it("round-trips the two explicit model fields", () => {
    writeLlmSettings({ interpretationModel: "deepseek/deepseek-v4-pro", chatModel: "minimax/minimax-m2.7" });
    const out = readLlmSettings();
    expect(out.interpretationModel).toBe("deepseek/deepseek-v4-pro");
    expect(out.chatModel).toBe("minimax/minimax-m2.7");
  });

  it("migrates a legacy single `model` into `interpretationModel` on read (and persists)", () => {
    const persisted: string[] = [];
    configureLlmSettingsPersistence((serialized) => void persisted.push(serialized));
    hydrateLlmSettings(
      JSON.stringify({
        apiBase: "https://openrouter.ai/api/v1",
        apiKey: "sk-or-123",
        model: "openai/gpt-4o",
        privacyMode: "cloud_premium",
      }),
    );
    const out = readLlmSettings();
    // The deliberately-chosen legacy model becomes the interpretation model.
    expect(out.interpretationModel).toBe("openai/gpt-4o");
    // Legacy `model` is preserved for back-compat (no destructive rewrite).
    expect(out.model).toBe("openai/gpt-4o");
    // Persisted so a reload / other callers see the migrated shape.
    expect(JSON.parse(persisted.at(-1)!).interpretationModel).toBe("openai/gpt-4o");
  });

  it("does not overwrite an existing interpretationModel from the legacy model", () => {
    hydrateLlmSettings(
      JSON.stringify({
        apiBase: "https://openrouter.ai/api/v1",
        model: "legacy/old-model",
        interpretationModel: "user/explicit-model",
        privacyMode: "cloud_premium",
      }),
    );
    expect(readLlmSettings().interpretationModel).toBe("user/explicit-model");
  });

  it("does not invent an interpretationModel when there is no legacy model", () => {
    writeLlmSettings({ apiBase: "http://localhost:11434/v1", chatModel: "phi3" });
    const out = readLlmSettings();
    expect(out.interpretationModel).toBeUndefined();
  });
});

describe("applyInterpretationSettings / applyChatSettings — explicit env resolution", () => {
  const ENV: LlmEnv = {
    VITE_LLM_API_BASE: "https://openrouter.ai/api/v1",
    VITE_LLM_API_KEY: "sk-or-x",
    VITE_LLM_PRIVACY_MODE: "cloud_premium",
  };

  it("interpretation puts the resolved interpretation model on VITE_LLM_MODEL", () => {
    const out = applyInterpretationSettings(ENV, {});
    expect(out.VITE_LLM_MODEL).toBe(RECOMMENDED_CLOUD_MODEL);
    expect(out.VITE_LLM_API_BASE).toBe("https://openrouter.ai/api/v1");
    expect(out.VITE_LLM_API_KEY).toBe("sk-or-x");
  });

  it("chat puts the resolved chat model on VITE_LLM_MODEL (explicit, not a silent swap)", () => {
    const out = applyChatSettings(ENV, {});
    expect(out.VITE_LLM_MODEL).toBe(CHAT_CLOUD_MODEL);
  });

  it("chat on the OpenRouter preset defaults to deepseek-v4.1-flash, the literal id sent on the wire", () => {
    // Pinned as a literal on purpose: asserting CHAT_CLOUD_MODEL against itself
    // passes for any value. The previous default (minimax/minimax-m2.7) measured
    // 26.7 s to first token on the live site (2026-10-02).
    expect(applyChatSettings(ENV, {}).VITE_LLM_MODEL).toBe("deepseek/deepseek-v4.1-flash");
  });

  it("the one-click OpenRouter preset seeds chat with deepseek-v4.1-flash", () => {
    expect(openRouterPreset("sk-or-x", "any/interp").chatModel).toBe("deepseek/deepseek-v4.1-flash");
  });

  it("interpretation defaults to openai/gpt-6-luna (literal)", () => {
    expect(RECOMMENDED_CLOUD_MODEL).toBe("openai/gpt-6-luna");
  });

  it("chat and interpretation defaults differ on purpose: chat stays on deepseek-v4.1-flash until tool calling on Luna is measured", () => {
    expect(CHAT_CLOUD_MODEL).toBe("deepseek/deepseek-v4.1-flash");
    expect(CHAT_CLOUD_MODEL).not.toBe(RECOMMENDED_CLOUD_MODEL);
  });

  it("each path uses the user's explicit per-tier override", () => {
    const settings = { interpretationModel: "openai/gpt-4o", chatModel: "groq/fast" };
    expect(applyInterpretationSettings(ENV, settings).VITE_LLM_MODEL).toBe("openai/gpt-4o");
    expect(applyChatSettings(ENV, settings).VITE_LLM_MODEL).toBe("groq/fast");
  });

  it("preserves the existing default behavior: a default OpenRouter user gets frontier for interpretation, fast for chat", () => {
    // This is the invariant that REPLACES applyChatModelPreference: the same
    // effective split (frontier interpretation, fast chat) with NO silent swap.
    const defaultUser: LlmEnv = {
      VITE_LLM_API_BASE: "https://openrouter.ai/api/v1",
      VITE_LLM_API_KEY: "sk-or-x",
      VITE_LLM_PRIVACY_MODE: "cloud_premium",
    };
    expect(applyInterpretationSettings(defaultUser, {}).VITE_LLM_MODEL).toBe(RECOMMENDED_CLOUD_MODEL);
    expect(applyChatSettings(defaultUser, {}).VITE_LLM_MODEL).toBe(CHAT_CLOUD_MODEL);
  });

  it("NEVER forces a cloud slug onto a local endpoint — a local Ollama keeps its env model (regression guard)", () => {
    // Old behavior: applyChatModelPreference returned a local env unchanged, and
    // applyLlmSettings left a local model as-is. The explicit helpers must do the
    // same — no cloud default pushed at localhost.
    const localUser: LlmEnv = {
      VITE_LLM_API_BASE: "http://localhost:11434/v1",
      VITE_LLM_MODEL: "llama3.1",
      VITE_LLM_PRIVACY_MODE: "local_only",
    };
    expect(applyInterpretationSettings(localUser, {}).VITE_LLM_MODEL).toBe("llama3.1");
    expect(applyChatSettings(localUser, {}).VITE_LLM_MODEL).toBe("llama3.1");
  });

  it("honors a local user's explicit per-tier override even on a local endpoint", () => {
    const localUser: LlmEnv = {
      VITE_LLM_API_BASE: "http://localhost:11434/v1",
      VITE_LLM_MODEL: "llama3.1",
      VITE_LLM_PRIVACY_MODE: "local_only",
    };
    const settings = { interpretationModel: "qwen2.5:7b", chatModel: "gemma3:4b" };
    expect(applyInterpretationSettings(localUser, settings).VITE_LLM_MODEL).toBe("qwen2.5:7b");
    expect(applyChatSettings(localUser, settings).VITE_LLM_MODEL).toBe("gemma3:4b");
  });
});
