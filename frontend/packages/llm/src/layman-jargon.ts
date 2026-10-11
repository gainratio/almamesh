/**
 * The "For You" (layman) voice promise: plain language, NO astrology jargon.
 *
 * This is the ONE list of banned terms. The interpretation prompt names them,
 * the reading is repaired against them when it is accepted
 * (`structured-interpretation.ts`), and the real dual-voice e2e gate asserts
 * against the same regex — so the product and its test cannot disagree.
 *
 * Some terms are also everyday English ("sign", "house", "yoga" the exercise).
 * They are banned anyway: in a Vedic reading each one reads as a chart term.
 * Text handling only — no astrology is computed here.
 */

export const LAYMAN_JARGON_TERMS = [
  "house", "lord", "dasha", "saturn", "jupiter", "rahu", "ketu", "nakshatra", "lagna",
  "exalted", "debilitated", "conjunct", "retrograde", "combust", "ascendant", "sign",
  "degree", "navamsa", "yoga",
] as const;

/** Whole-word, case-insensitive match of any banned term (non-global: safe for `.test`). */
export const LAYMAN_JARGON = new RegExp(`\\b(${LAYMAN_JARGON_TERMS.join("|")})\\b`, "i");

const LAYMAN_JARGON_ALL = new RegExp(LAYMAN_JARGON.source, "gi");

/** Every banned term in `text`, lower-cased, in order of appearance. */
export function findLaymanJargon(text: string): string[] {
  return (text.match(LAYMAN_JARGON_ALL) ?? []).map((term) => term.toLowerCase());
}

// A sentence (with its closing punctuation, quotes and trailing spaces) or a
// run of newlines. Concatenating every piece reproduces the input exactly.
const SENTENCE_OR_BREAK = /[^.!?…\n]+(?:[.!?…]+["'”’)\]]*)?[ \t]*|[.!?…]+[ \t]*|\n+/g;

/**
 * Drop every sentence for which `drop` is true; everything else is kept
 * byte-for-byte. Text with nothing dropped is returned unchanged. Shared by
 * the jargon guard and the date guard (date-guard.ts). `pieces` is the global
 * splitter; any replacement must also reproduce the input when concatenated.
 */
export function dropSentences(
  text: string,
  drop: (sentence: string) => boolean,
  pieces: RegExp = SENTENCE_OR_BREAK,
): { text: string; dropped: number } {
  const all = text.match(pieces) ?? [];
  const kept = all.filter((piece) => !drop(piece));
  const dropped = all.length - kept.length;
  if (dropped === 0) return { text, dropped: 0 };
  const joined = kept
    .join("")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text: joined, dropped };
}

/**
 * Drop every sentence of `text` that carries a banned term; everything else is
 * kept byte-for-byte. Clean text is returned unchanged. May return "" when
 * every sentence leaked — an empty layman field drops its section from view.
 */
export function stripLaymanJargon(text: string): string {
  if (!LAYMAN_JARGON.test(text)) return text;
  return dropSentences(text, (piece) => LAYMAN_JARGON.test(piece)).text;
}
