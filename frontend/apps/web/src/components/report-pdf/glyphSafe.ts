/**
 * glyphSafe — map the few non-Latin typographic glyphs that the report's
 * SELF-HOSTED .ttf faces (a latin subset of Fraunces / Hanken Grotesk / Spline
 * Sans Mono) do not contain onto visually-equivalent Latin glyphs they DO
 * contain. @react-pdf embeds (and subsets) the registered font and cannot fall
 * back to a system font for a missing glyph the way a browser does, so an
 * unmapped glyph (e.g. the arcminute ′ or approx ≈) would abort rendering.
 *
 * This is a PRESENTATION-ONLY substitution at the PDF boundary — the engine and
 * i18n source strings are untouched. The mapped forms are typographically close:
 *   ′ → '   ″ → "   ≈ → ~   ✦/★ → *   • stays (present in all faces).
 */

const GLYPH_MAP: ReadonlyArray<readonly [RegExp, string]> = [
  [/′/g, "'"], // PRIME (arcminute) → apostrophe
  [/″/g, '"'], // DOUBLE PRIME (arcsecond) → quote
  [/≈/g, '~'], // ALMOST EQUAL TO → tilde
  // RIGHTWARDS ARROW (U+2192, outside the latin subset). Mapped to ASCII "->",
  // NOT to an em dash: an em dash silently turns a MOVEMENT into a RANGE.
  // Caught by reading a real export — "Mercury: house 1 — house 12" reads as
  // "houses 1 to 12" when it means "moves from the 1st to the 12th", and the
  // whole point of that line is which direction the second chart moves in.
  [/→/g, '->'],
  [/[✦★✧]/g, '*'], // decorative stars → asterisk
  [/[‘’]/g, "'"], // curly single quotes → apostrophe
  [/[“”]/g, '"'], // curly double quotes → quote
  // IAST / Indic transliteration diacritics absent from the latin-subset faces.
  // The captions ("Rāśi", "Navāṁśa") and any Sanskrit term would otherwise render
  // as overlapping tofu. These map to the nearest plain-Latin form (display only).
  [/[āăà]/g, 'a'],
  [/[ĀĂÀ]/g, 'A'],
  [/[īĭ]/g, 'i'],
  [/[ĪĬ]/g, 'I'],
  [/[ūŭ]/g, 'u'],
  [/[ŪŬ]/g, 'U'],
  [/[ṛṝ]/g, 'r'],
  [/[ṚṜ]/g, 'R'],
  [/[ṅṇṉñ]/g, 'n'],
  [/[ṄṆṈÑ]/g, 'N'],
  [/[śṣ]/g, 's'],
  [/[ŚṢ]/g, 'S'],
  [/[ṭ]/g, 't'],
  [/[Ṭ]/g, 'T'],
  [/[ḍ]/g, 'd'],
  [/[Ḍ]/g, 'D'],
  [/[ṁṃ]/g, 'm'],
  [/[ṀṂ]/g, 'M'],
  [/[ḥ]/g, 'h'],
  [/[Ḥ]/g, 'H'],
  [/[ḷ]/g, 'l'],
  [/[Ḷ]/g, 'L'],
];

const DEVANAGARI_RE = /[\u0900-\u097F]/;

/** True when `text` contains any Devanagari Unicode code point (Hindi/Sanskrit). */
export function containsDevanagari(text: string): boolean {
  return DEVANAGARI_RE.test(text);
}

/** Replace glyphs absent from the report fonts with safe Latin equivalents. */
export function glyphSafe(text: string): string {
  return GLYPH_MAP.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), text);
}
