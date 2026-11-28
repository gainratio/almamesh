// Plain-language ("For You") clarity rule and pre-strip reword helpers.
//
// `stripLaymanJargon` in `persona-parse.ts` is the un-bypassable final backstop,
// but deleting a sentence mid-paragraph leaves choppy transitions when a model
// uses an ordinary English homograph ("sign", "house", "degree", "yoga") or
// forgets and names a planet. `jsonLaymanJargon` detects those leaks on raw
// layman JSON leaves so `reflectedSection` can ask the model once to rewrite
// the whole field smoothly in plain everyday words before `stripLaymanJargon`
// runs at acceptance.

import { findLaymanJargon, stripLaymanJargon } from "./layman-jargon";
import {
  reflectionCorrection,
  reflectionIssues,
  type ReflectionIssue,
} from "./reflection";

/**
 * Appended right below `REFLECTION_RULE` in dual-voice structured prompts so
 * the indicator-citation mandate never collides with the jargon-free `"layman"`
 * ("For You") voice. Passes `predictionClaims`, `toolNarration`, and `lifeGuesses`.
 */
export const VOICE_CLARITY_RULE = [
  "VOICE CLARITY & HOW REFLECTION APPLIES PER VOICE (MANDATORY):",
  '  - In "technical" ("For Astrologer"): name the exact chart indicators behind every',
  "    theme (planets, signs, house numbers, lordships, dasha lords, Moon tags, yogas).",
  '  - In "layman" ("For You"): NEVER name astrological indicators, and NEVER replace',
  "    them with coded riddles, stiff abstractions, or bureaucratic filler.",
  "    Translate each factor directly into CRYSTAL-CLEAR 8th-grade everyday English:",
  "    • Write short, direct sentences (12-20 words on average; one clear idea per sentence).",
  "    • Use active voice and concrete everyday words: work, money, savings, home, family,",
  "      health, energy, rest, routines, patience, boundaries, and honest conversations.",
  "    • Avoid astrology homographs even in ordinary English: write 'signal' or 'clue'",
  "      (never 'sign'), 'home' or 'household' (never 'house'), 'level' or 'extent'",
  "      (never 'degree'), 'stretching' or 'breathwork' (never 'yoga'), 'focus' or",
  "      'chapter' (never 'lord' or 'dasha').",
  '    • BAD ("For You"): "Elevated domestic resource friction asks you to calibrate',
  '      interpersonal boundaries across this cycle."',
  '    • GOOD ("For You"): "Close relationships ask for patience and plain speaking.',
  '      Slow down, listen first, and keep home and money routines simple."',
].join("\n");

const LAYMAN_LEAF_KEYS: ReadonlySet<string> = new Set(["layman", "lean_into", "watch_for"]);

function parseJsonOrUndefined(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function collectLaymanTerms(value: unknown, key: string | undefined, out: Set<string>): void {
  if (typeof value === "string") {
    if (key !== undefined && LAYMAN_LEAF_KEYS.has(key)) {
      for (const term of findLaymanJargon(value)) out.add(term);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectLaymanTerms(item, undefined, out);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [childKey, child] of Object.entries(value)) collectLaymanTerms(child, childKey, out);
  }
}

/** Every banned term found across raw `layman` / `lean_into` / `watch_for` JSON leaves. */
export function jsonLaymanJargon(raw: string): readonly string[] {
  const out = new Set<string>();
  collectLaymanTerms(parseJsonOrUndefined(raw), undefined, out);
  return [...out];
}

/** Plain-language reword prompt naming the banned/homograph words that leaked. */
export function laymanJargonCorrection(terms: readonly string[]): string {
  const quoted = [...new Set(terms.map((term) => `"${term}"`))].join(", ");
  return (
    `Your last reply used forbidden astrology or homograph words in plain-language fields (${quoted}). ` +
    "Rewrite each offending 'layman', 'lean_into', or 'watch_for' field as smooth, crystal-clear everyday " +
    "language without dropping its meaning (use 'signal' not 'sign', 'home' not 'house', 'level' not 'degree', " +
    "'stretching' not 'yoga', and translate planets or periods into work, money, home, relationships, or rest)."
  );
}

/** Combined single-turn retry message covering reflection issues and layman jargon leaks. */
export function sectionRewordRetry(
  raw: string,
  issues: readonly ReflectionIssue[],
  jargonTerms: readonly string[],
): readonly { readonly role: "assistant" | "user"; readonly content: string }[] {
  const parts = [
    ...(issues.length > 0 ? [reflectionCorrection(issues)] : []),
    ...(jargonTerms.length > 0 ? [laymanJargonCorrection(jargonTerms)] : []),
    "Return the same JSON shape, rewriting the offending value(s) while keeping already-clean values intact.",
  ];
  return [
    { role: "assistant", content: raw },
    { role: "user", content: parts.join(" ") },
  ];
}

function isCleanSectionLeaf(value: unknown, key: string | undefined): value is string {
  if (typeof value !== "string" || value.trim().length === 0) return false;
  if (reflectionIssues(value).length > 0) return false;
  return key === undefined || !LAYMAN_LEAF_KEYS.has(key) || findLaymanJargon(value).length === 0;
}

function survivesLaymanGuard(value: string, key: string | undefined): boolean {
  const text = key !== undefined && LAYMAN_LEAF_KEYS.has(key) ? stripLaymanJargon(value) : value;
  return text.trim().length > 0;
}

function chooseMergedString(firstVal: string, retriedVal: unknown, key: string | undefined): string {
  if (isCleanSectionLeaf(firstVal, key)) return firstVal;
  if (isCleanSectionLeaf(retriedVal, key)) return retriedVal;
  if (typeof retriedVal !== "string" || reflectionIssues(retriedVal).length > 0 || !survivesLaymanGuard(retriedVal, key)) {
    return firstVal;
  }
  return reflectionIssues(firstVal).length > 0 || !survivesLaymanGuard(firstVal, key) ? retriedVal : firstVal;
}

function ownProperty(obj: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

function mergeSectionNode(firstVal: unknown, retriedVal: unknown, key?: string): unknown {
  if (typeof firstVal === "string") return chooseMergedString(firstVal, retriedVal, key);
  if (Array.isArray(firstVal)) {
    const retriedArr = Array.isArray(retriedVal) ? retriedVal : [];
    return firstVal.map((item, idx) => mergeSectionNode(item, retriedArr[idx]));
  }
  if (firstVal !== null && typeof firstVal === "object") {
    const retriedObj = retriedVal !== null && typeof retriedVal === "object" && !Array.isArray(retriedVal) ? (retriedVal as Record<string, unknown>) : {};
    return Object.fromEntries(Object.entries(firstVal).map(([k, inner]) => [k, mergeSectionNode(inner, ownProperty(retriedObj, k), k)]));
  }
  return firstVal;
}

/** Merge a section reword retry leaf-by-leaf, preserving clean leaves and adopting clean plain-language rewrites. */
export function mergeCleanSectionLeaves(firstRaw: string, retriedRaw: string): string {
  const firstParsed = parseJsonOrUndefined(firstRaw);
  const retriedParsed = parseJsonOrUndefined(retriedRaw);
  if (firstParsed === undefined || retriedParsed === undefined) return firstRaw;
  return JSON.stringify(mergeSectionNode(firstParsed, retriedParsed));
}
