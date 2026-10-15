// Reflection, not prediction (product decision 2026-10-15).
//
// A retrodiction eval on licensed Astro-Databank events found no lift over
// chance: the engine's month scores do not pick the month of a recorded life
// event better than random months. So every reading is framed as what the chart
// highlights for a period, for reflection. Readings stay bold in detail: they
// name the indicators, compare periods and name hard themes when indicators
// converge. They never claim to foretell an event or say one occurred.
//
// One rule, two consumers: the prompts carry REFLECTION_RULE, and the copy +
// prompt tests scan with predictionClaims(). The rule text itself passes the scan.

/** The prompt rule every reading and chat system prompt carries. */
export const REFLECTION_RULE = [
  "REFLECTION, NOT FORETELLING (ABSOLUTE): a reading shows what this chart highlights for a",
  "period: themes to reflect on. Our own tests found that charts do not pick out the month of a",
  "real life event better than chance. So never claim the chart can tell what is going to occur,",
  "never say an event did occur or is bound to occur, and never put odds or certainty on a theme.",
  "Stay bold and specific: name the indicators behind every theme (dasha lords and the houses",
  "they rule, transits, Moon tags, dated windows), compare periods (for example: \"the strongest",
  "pressure window of 2019 was March to May, when Saturn ...\"), and when several indicators",
  "converge, name hard themes plainly: legal or official friction, losses and expenses, a job or",
  "career change. No fear language: no doom, curses or danger; say what the theme asks of the person.",
].join("\n");

export type ReflectionLanguage = "en" | "es" | "pt";

/** A whole word (or word prefix, when `open`) with Unicode-aware edges. */
function word(source: string, open = false): RegExp {
  const end = open ? "" : "(?![\\p{L}\\p{N}])";
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${source})${end}`, "iu");
}

/**
 * Words that claim or imply prediction or predictive accuracy, per language.
 * en: predict*, forecast*, accurate/accuracy, likely, "will happen", "what happened".
 * es/pt: the same claims. Their words for accuracy (precis-, exat-) are left out on
 * purpose: they also mean "exact birth time", "date precision" and "to need" (pt
 * "preciso"), which are not claims about readings.
 */
export const PREDICTION_CLAIM_PATTERNS: Readonly<Record<ReflectionLanguage, readonly RegExp[]>> = {
  en: [
    word("predict", true),
    word("forecast", true),
    word("accura(?:te|tely|cy)"),
    word("likely"),
    word("will happen"),
    word("what happened"),
  ],
  es: [
    word("predic", true),
    word("predec", true),
    word("pron[oó]stic", true),
    word("previsi[oó]n(?:es)?"),
    word("probable(?:s|mente)?"),
    word("acertad", true),
    word("ocurrir[aá]n?|suceder[aá]n?|pasar[aá]n?"),
    word("lo que (?:pas[oó]|ocurri[oó]|sucedi[oó])"),
  ],
  pt: [
    word("predi", true),
    word("prever|prev[eê]|preveem|prevej\\p{L}*"),
    word("previs(?:[aã]o|[oõ]es)"),
    word("progn[oó]stic", true),
    word("prov[aá]vel|prov[aá]veis|provavelmente"),
    word("acertad|certeir", true),
    word("acontecer[aá]o?|vai acontecer"),
    word("o que aconteceu"),
  ],
};

/** Every prediction claim found in `text`, as the matched words; [] when clean. */
export function predictionClaims(text: string, language: ReflectionLanguage): readonly string[] {
  return PREDICTION_CLAIM_PATTERNS[language].flatMap((pattern) => {
    const match = pattern.exec(text);
    return match ? [match[0]] : [];
  });
}
