import { describe, expect, it } from "vitest";

import {
  ensurePrivacy,
  isLocalEndpoint,
  PrivacyViolationError,
  resolveProviderConfig,
  type ProviderConfig,
} from "../config";

describe("isLocalEndpoint — mirrors backend _is_local_endpoint/_is_private_ip", () => {
  it.each([
    "http://localhost:11434/v1",
    "http://127.0.0.1:8080/v1",
    "http://10.0.0.5:1234/v1",
    "http://192.168.1.10/v1",
    "http://172.16.5.4/v1",
    "http://172.31.255.255/v1", // upper bound of the 172.16/12 private block
    "http://my-box.local/v1",
    "http://[::1]:11434/v1",
    "http://[fc00::1]:11434/v1", // IPv6 unique-local (fc00::/7)
    "http://[fe80::1]/v1", // IPv6 link-local
  ])("treats %s as local", (url) => {
    expect(isLocalEndpoint(url)).toBe(true);
  });

  it.each([
    "https://openrouter.ai/api/v1",
    "https://api.openai.com/v1",
    "http://8.8.8.8/v1",
    "http://172.32.0.1/v1", // just outside the 172.16/12 private block
    undefined,
    "not a url",
    // Spoofed "local-looking" hosts that must NOT bypass the local_only gate:
    // an unanchored IPv4 test or a hostname startsWith("fc"/"fd"/"fe80") would
    // wrongly pass and leak the (redacted) chart to the attacker origin.
    "http://127.0.0.1.evil.com/v1",
    "http://10.0.0.1.attacker.com/v1",
    "http://192.168.1.1.evil.com/v1",
    "http://169.254.169.254.evil.com/v1", // cloud-metadata-shaped label spoof
    "http://fc2.com/v1",
    "http://fd-cdn.com/v1",
    "http://fe80.example.com/v1",
  ])("treats %s as non-local", (url) => {
    expect(isLocalEndpoint(url)).toBe(false);
  });
});

describe("ensurePrivacy — fail-closed local_only contract", () => {
  it("throws PrivacyViolationError when local_only targets a cloud endpoint", () => {
    const cfg: ProviderConfig = {
      engine: "openai-http",
      model: "gpt-4o-mini",
      privacyMode: "local_only",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "sk-secret",
    };
    expect(() => ensurePrivacy(cfg)).toThrow(PrivacyViolationError);
  });

  it("carries the refused endpoint as data so the UI can localize the message", () => {
    const cfg: ProviderConfig = {
      engine: "openai-http",
      model: "gpt-4o-mini",
      privacyMode: "local_only",
      baseUrl: "https://openrouter.ai/api/v1",
    };
    let caught: unknown;
    try {
      ensurePrivacy(cfg);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PrivacyViolationError);
    expect((caught as PrivacyViolationError).endpoint).toBe("https://openrouter.ai/api/v1");
    // The English sentence stays on the error for logs.
    expect((caught as PrivacyViolationError).message).toContain("refusing to send chart data");
  });

  it("allows local_only when the endpoint is loopback", () => {
    const cfg: ProviderConfig = {
      engine: "openai-http",
      model: "llama3.1",
      privacyMode: "local_only",
      baseUrl: "http://localhost:11434/v1",
    };
    expect(() => ensurePrivacy(cfg)).not.toThrow();
  });

  it("allows cloud_premium against a remote endpoint (opt-in)", () => {
    const cfg: ProviderConfig = {
      engine: "openai-http",
      model: "gpt-4o-mini",
      privacyMode: "cloud_premium",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "sk-secret",
    };
    expect(() => ensurePrivacy(cfg)).not.toThrow();
  });
});

describe("resolveProviderConfig — safe OSS defaults, never a bundled key", () => {
  it("defaults to the openai-http engine in local_only mode with no key", () => {
    const cfg = resolveProviderConfig({});
    // OpenRouter / BYO build: the safe default is a local OpenAI-compatible
    // endpoint (Ollama) under local_only with no bundled key.
    expect(cfg.engine).toBe("openai-http");
    expect(cfg.privacyMode).toBe("local_only");
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.baseUrl).toBe("http://localhost:11434/v1");
    expect(isLocalEndpoint(cfg.baseUrl)).toBe(true);
  });

  it("infers the openai-http engine from a legacy local endpoint config", () => {
    const cfg = resolveProviderConfig({ VITE_LLM_API_BASE: "http://localhost:11434/v1" });
    expect(cfg.engine).toBe("openai-http");
    expect(cfg.baseUrl).toBe("http://localhost:11434/v1");
    expect(isLocalEndpoint(cfg.baseUrl)).toBe(true);
  });

  it("resolves to the openai-http engine for any VITE_LLM_ENGINE value", () => {
    // Single-engine world: any value a stale blob might pin still resolves to
    // the OpenAI-compatible HTTP engine.
    expect(resolveProviderConfig({ VITE_LLM_ENGINE: "mlc-llm" }).engine).toBe("openai-http");
    expect(resolveProviderConfig({ VITE_LLM_ENGINE: "" }).engine).toBe("openai-http");
  });

  it("honors an explicit cloud config from env", () => {
    const cfg = resolveProviderConfig({
      VITE_LLM_API_BASE: "https://openrouter.ai/api/v1",
      VITE_LLM_API_KEY: "sk-openrouter",
      VITE_LLM_MODEL: "deepseek/deepseek-chat",
      VITE_LLM_PRIVACY_MODE: "cloud_premium",
    });
    expect(cfg.privacyMode).toBe("cloud_premium");
    expect(cfg.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(cfg.apiKey).toBe("sk-openrouter");
    expect(cfg.model).toBe("deepseek/deepseek-chat");
  });

  it("drops a leftover key when no explicit endpoint is configured (never a Bearer to loopback)", () => {
    // Security: after "Turn AI off" the endpoint is cleared but a key can linger
    // in localStorage. With no explicit base the config falls back to the local
    // Ollama default — the leftover key must NOT be attached, so it can never be
    // sent as a Bearer header to whatever listens on loopback.
    const cfg = resolveProviderConfig({ VITE_LLM_API_KEY: "sk-leftover" });
    expect(cfg.baseUrl).toBe("http://localhost:11434/v1");
    expect(cfg.apiKey).toBeUndefined();
  });

  it("ignores an unknown privacy mode and falls back to local_only", () => {
    const cfg = resolveProviderConfig({ VITE_LLM_PRIVACY_MODE: "wide_open" });
    expect(cfg.privacyMode).toBe("local_only");
  });
});
