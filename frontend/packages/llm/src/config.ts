// The client-side mirror of the backend privacy contract
// (`ProviderConfig` / `_resolve_provider_config` / `_is_local_endpoint` /
// `_is_private_ip` / `_ensure_privacy` in backend/src/almamesh/llm.py).
//
// In the OSS browser build the default is the SAFEST one: privacy mode
// `local_only`, pointed at a local Ollama-style endpoint. Cloud (e.g. OpenRouter)
// is strictly opt-in and a key is NEVER bundled — it is read from Vite env or the
// settings store at call time.

import type { LlmEngine } from "./provider";
import type { LlmSettings } from "./settings";

/** Mirror of the backend `PrivacyMode` enum (edgeproc.PrivacyMode). */
export type PrivacyMode = "local_only" | "cloud_premium";

/**
 * Resolved description of which chat backend + endpoint a call should use.
 *
 * There is a single engine — the OpenAI-compatible HTTP path — so a config
 * ALWAYS carries a `baseUrl` (a local Ollama-style URL by default, or the
 * opt-in cloud preset) plus an optional apiKey.
 */
export type ProviderConfig = HttpProviderConfig;

/**
 * OpenAI-compatible HTTP inference: a `baseUrl` endpoint is REQUIRED (a local
 * Ollama-style URL by default, or the opt-in cloud preset); the apiKey is
 * optional and NEVER bundled — read from Vite env or the settings store.
 */
export interface HttpProviderConfig {
  readonly engine: "openai-http";
  /** An endpoint model slug served by the OpenAI-compatible endpoint. */
  readonly model: string;
  readonly privacyMode: PrivacyMode;
  /** OpenAI-compatible base URL, e.g. `http://localhost:11434/v1` (Ollama). */
  readonly baseUrl: string;
  /** Optional API key. Never bundled; supplied by env or local settings. */
  readonly apiKey?: string;
}

/** Fail-closed: a local_only request that would leave the device is refused. */
export class PrivacyViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrivacyViolationError";
  }
}

// Default to Ollama's OpenAI-compatible local endpoint. Safe: loopback only.
const DEFAULT_BASE_URL = "http://localhost:11434/v1";
const DEFAULT_MODEL = "llama3.1";
const DEFAULT_PRIVACY_MODE: PrivacyMode = "local_only";
// OpenRouter / BYO OpenAI-compatible build: every resolution lands on the
// OpenAI-compatible HTTP engine — a local endpoint by default, an opt-in cloud
// preset (OpenRouter).
const DEFAULT_ENGINE: LlmEngine = "openai-http";

/** OpenRouter's OpenAI-compatible base URL — the one-click cloud preset target. */
export const OPENROUTER_API_BASE = "https://openrouter.ai/api/v1";

/** Best-effort hostname of a base URL, tolerating a missing scheme. */
function hostnameOf(base: string): string | null {
  for (const candidate of [base, `https://${base}`]) {
    try {
      return new URL(candidate).hostname.toLowerCase();
    } catch {
      // Try the next candidate (a scheme-less "openrouter.ai" only parses with one).
    }
  }
  return null;
}

/**
 * Canonicalize a hand-typed base URL for endpoints whose API path is a KNOWN
 * fixed value, so a common copy/paste mistake doesn't dead-end the probe, the
 * reading, and chat. Today that is OpenRouter: its OpenAI-compatible API always
 * lives at `/api/v1`, so any `openrouter.ai` host (the dashboard root, a bare
 * host, `/api`, a trailing slash) resolves to {@link OPENROUTER_API_BASE}.
 * Every other endpoint (local Ollama, OpenAI, a custom proxy) passes through
 * verbatim — only the host is inspected, never the path, so a proxy that merely
 * has "openrouter" in its path is untouched.
 */
function normalizeKnownBase(base: string | undefined): string | undefined {
  if (!base) {
    return base;
  }
  const host = hostnameOf(base);
  if (host === "openrouter.ai" || host === "www.openrouter.ai") {
    return OPENROUTER_API_BASE;
  }
  return base;
}

// IPv4 private ranges (RFC 1918) + loopback, mirroring Python's
// `ipaddress.is_private` / `is_loopback` for the host literals we care about.
const PRIVATE_IPV4 =
  /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[0-1])\.)/;

// A syntactic IPv4 literal: exactly four dotted 0-255 octets. This gate is what
// keeps the range checks from being fooled by a hostname that merely *starts*
// with a private prefix — e.g. `127.0.0.1.evil.com` is NOT four octets, so it is
// never treated as local (fail closed).
function isIpv4Literal(host: string): boolean {
  const octets = host.split(".");
  return octets.length === 4 && octets.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255);
}

function isPrivateIp(host: string): boolean {
  // RFC 1918 / loopback ranges apply ONLY to real IPv4 literals.
  if (isIpv4Literal(host)) {
    return PRIVATE_IPV4.test(host);
  }
  // IPv6 loopback / unique-local / link-local — a real domain never contains
  // ":", so only bracket-stripped IPv6 literals reach the prefix test (a plain
  // `fc2.com` / `fe80.example.com` hostname is correctly rejected).
  if (!host.includes(":")) {
    return false;
  }
  const h = host.toLowerCase();
  return h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80");
}

/** True if `baseUrl` points at a loopback or private-network host. */
export function isLocalEndpoint(baseUrl: string | undefined): boolean {
  if (!baseUrl) {
    return false;
  }
  let host: string;
  try {
    host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  return host === "localhost" || host.endsWith(".local") || isPrivateIp(host);
}

/** Fail closed: local_only must resolve to a local endpoint, else throw. */
export function ensurePrivacy(config: ProviderConfig): void {
  if (config.privacyMode === "local_only" && !isLocalEndpoint(config.baseUrl)) {
    throw new PrivacyViolationError(
      `PrivacyMode 'local_only' requires a local OpenAI-compatible endpoint ` +
        `(set VITE_LLM_API_BASE to a loopback/private host); refusing to send ` +
        `chart data to non-local endpoint ${config.baseUrl}.`,
    );
  }
}

function asPrivacyMode(value: string | undefined): PrivacyMode {
  return value === "cloud_premium" ? "cloud_premium" : DEFAULT_PRIVACY_MODE;
}

/** Raw env values a host app supplies (Vite `import.meta.env`, or settings). */
export interface LlmEnv {
  readonly VITE_LLM_API_BASE?: string;
  readonly VITE_LLM_API_KEY?: string;
  readonly VITE_LLM_MODEL?: string;
  readonly VITE_LLM_PRIVACY_MODE?: string;
  /** Engine selector; resolves to `"openai-http"` (the only engine). */
  readonly VITE_LLM_ENGINE?: string;
}

/**
 * Resolve a `ProviderConfig` from env-shaped values, applying safe OSS defaults.
 * Pure and injectable so callers can pass `import.meta.env` or settings-store
 * values without this module reaching for globals.
 */
export function resolveProviderConfig(env: LlmEnv = {}): ProviderConfig {
  const engine = DEFAULT_ENGINE;
  const explicitBase = env.VITE_LLM_API_BASE?.trim();
  // Only attach a key when an endpoint was EXPLICITLY configured. Without one the
  // config falls back to the local Ollama default — a leftover key (e.g. lingering
  // after "Turn AI off" cleared the endpoint) must never ride along as a Bearer
  // header to loopback. No explicit endpoint ⇒ no key.
  const apiKey = explicitBase ? env.VITE_LLM_API_KEY?.trim() : undefined;
  return {
    engine,
    model: env.VITE_LLM_MODEL?.trim() || DEFAULT_MODEL,
    privacyMode: asPrivacyMode(env.VITE_LLM_PRIVACY_MODE?.trim()),
    baseUrl: normalizeKnownBase(explicitBase) || DEFAULT_BASE_URL,
    ...(apiKey ? { apiKey } : {}),
  };
}

/**
 * The recommended OpenRouter cloud model — the SINGLE source of truth for the
 * one-click preset, the settings UI default, and the "switch to recommended"
 * self-heal. A real OpenRouter slug (verified against the live models catalog).
 *
 * openai/gpt-6-luna since 2026-10-10: in the live nine-section report benchmark
 * (e2e/report.real.spec.ts, 3 runs) it finished all 3 in 39-43 s for $0.013
 * billed each, with every voice inside its word band. deepseek-v4-pro billed
 * $0.019-0.025 per report. Pinned, never the `~openai/gpt-luna-latest` alias, so
 * quality, latency and cost cannot move without a code change. deepseek-v4.1-flash
 * (the default from 2026-10-01) stays selectable. Changing this never rewrites a
 * model a user saved.
 */
export const RECOMMENDED_CLOUD_MODEL = "openai/gpt-6-luna";

/**
 * The default cloud model the CHAT panel uses. Deliberately the SAME id as
 * {@link RECOMMENDED_CLOUD_MODEL} — an alias, not a second literal — so the two
 * defaults cannot drift apart.
 *
 * Chat used to default to `minimax/minimax-m2.7` for first-token latency. On the
 * live site (2026-10-02) that model took 26.7 s to produce a first token, so chat
 * now takes the same fast default as readings.
 *
 * Used as the chat-tier default by `applyChatSettings` (applied on the OpenRouter
 * cloud preset only when the user has set no explicit `chatModel`) and as the
 * `chatModel` default in {@link openRouterPreset}. A `chatModel` already saved in
 * a user's settings — including one an earlier preset wrote — and a local/custom
 * endpoint's own model are never overridden.
 */
export const CHAT_CLOUD_MODEL = RECOMMENDED_CLOUD_MODEL;

/**
 * Model ids AlmaMesh itself once shipped as a DEFAULT OpenRouter preset and that
 * are now retired/dead (they 404 "No endpoints found"). A saved blob still
 * pinning one of these is healed to {@link RECOMMENDED_CLOUD_MODEL} on read — see
 * `healRetiredModel` in settings.ts. Narrow on purpose: only OUR broken defaults,
 * never a model the user deliberately chose.
 */
export const RETIRED_CLOUD_MODELS: readonly string[] = ["anthropic/claude-3.5-sonnet"];

/**
 * One-click OpenRouter settings: a cloud OpenAI-compatible endpoint + key.
 * `cloud_premium` is REQUIRED — the fail-closed `ensurePrivacy` gate refuses a
 * cloud host under `local_only`. Returns an `LlmSettings` ready for
 * `writeLlmSettings`; the key lives only in the browser, never bundled.
 *
 * `model` seeds the INTERPRETATION tier (and the legacy `model` field for
 * back-compat); `chatModel` (default the fast {@link CHAT_CLOUD_MODEL}) seeds the
 * chat tier, so the one-click preset lands the recommended interpretation/chat pair.
 */
export function openRouterPreset(
  apiKey: string,
  model: string,
  chatModel: string = CHAT_CLOUD_MODEL,
): LlmSettings {
  return {
    apiBase: OPENROUTER_API_BASE,
    apiKey,
    // Legacy single field kept so back-compat readers (and the e2e contract) see
    // the chosen interpretation model; the per-tier fields are the new source.
    model,
    interpretationModel: model,
    chatModel,
    privacyMode: "cloud_premium",
    engine: "openai-http",
  };
}
