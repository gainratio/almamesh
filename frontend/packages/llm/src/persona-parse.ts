// Shared lenient coercions from unknown model JSON to Persona shapes. Internal
// to the llm package (not exported from the index).

import type { Persona, TitledPersona } from "@almamesh/shared-types";

import { stripLaymanJargon } from "./layman-jargon";

export function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * The layman ("For You") voice as ACCEPTED: any sentence carrying a banned
 * astrology term is dropped, so the plain-language promise holds whatever the
 * model wrote. The prompt asks for plain words; this does not trust it to.
 */
export function asLayman(value: unknown): string {
  return stripLaymanJargon(asString(value));
}

/**
 * Coerce an unknown summary value into a dual-mode `Persona`. A `{ layman,
 * technical }` object is taken as-is; a BARE STRING (what LITE / small local
 * models often emit) is mapped to both voices so the summary never blanks; any
 * other shape yields both-empty.
 */
export function asPersona(value: unknown): Persona {
  if (typeof value === "string") {
    return { layman: stripLaymanJargon(value), technical: value };
  }
  const persona = parsePersona(value);
  return persona ?? { layman: "", technical: "" };
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** A persona { layman?, technical? } parsed from an unknown JSON value, or null. */
export function parsePersona(value: unknown): { layman: string; technical: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const rec = value as Record<string, unknown>;
  return { layman: asLayman(rec.layman), technical: asString(rec.technical) };
}

export function parseTitledPersonas(value: unknown): TitledPersona[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: TitledPersona[] = [];
  for (const item of value) {
    const rec = asRecord(item);
    out.push({
      title: asString(rec.title),
      layman: asLayman(rec.layman),
      technical: asString(rec.technical),
    });
  }
  return out;
}
