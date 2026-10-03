// Reading provenance — WHICH resolved provider config produced a reading.
//
// A stored `VedicInterpretation` carries a small, display-friendly
// `ReadingProvenance` object so the app can (a) caption the reading with the
// model that wrote it and (b) tell "the reading on screen came from a
// different engine/model/endpoint than the one now configured" and regenerate.
// It deliberately covers only the identity of the producer (engine, model,
// base URL) — NEVER the apiKey or any other secret, since it is persisted
// alongside the reading in canonical SQLite.

import type { ProviderConfig } from "./config";

/**
 * The persisted, display-friendly identity of the config that produced a
 * reading, mirroring `ProviderConfig`: the engine + endpoint model slug + the
 * base URL it ran against. Safe to render verbatim and to persist — it never
 * carries the apiKey or any other secret.
 */
export type ReadingProvenance = HttpReadingProvenance;

/** HTTP provenance: engine + endpoint model slug + the base URL it ran against. */
export interface HttpReadingProvenance {
  readonly engine: "openai-http";
  /** The endpoint model slug that wrote the reading. */
  readonly model: string;
  /** The OpenAI-compatible endpoint the reading was produced against. */
  readonly baseUrl?: string;
  /** Was the full predictive superset composed into this reading? Additive;
   *  ignored by configFingerprint (not a producer-identity field). */
  readonly predictiveAware?: boolean;
}

/**
 * Endpoint identity, slash-insensitive: `https://host/v1` and `https://host/v1/`
 * are the same endpoint (users type base URLs by hand). Absent when the reading
 * carried no endpoint.
 */
function normalizeBaseUrl(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) {
    return undefined;
  }
  return baseUrl.replace(/\/+$/, "");
}

/**
 * The secret-free provenance of a resolved config: what would produce a
 * reading right now. Two configs differing only by apiKey are identical here.
 */
export function configProvenance(config: ProviderConfig): ReadingProvenance {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  return {
    engine: "openai-http",
    model: config.model,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
  };
}

/**
 * A stable comparison string for a producer identity — accepts either a live
 * `ProviderConfig` or a persisted `ReadingProvenance` (both carry the same
 * three identity fields), so "did the config change since this reading was
 * generated?" is a single equality check.
 *
 * JSON-encoded so model slugs / URLs containing delimiter characters can never
 * make two distinct configs collide.
 */
export function configFingerprint(source: ProviderConfig | ReadingProvenance): string {
  // A single HTTP engine: the fingerprint is engine + model + normalized
  // endpoint (null when none), so a persisted provenance still matches the
  // live config identically.
  return JSON.stringify({
    engine: source.engine,
    model: source.model,
    baseUrl: normalizeBaseUrl(source.baseUrl) ?? null,
  });
}
