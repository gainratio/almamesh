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
  "real life event better than chance; the app explains this, so do not repeat it in every answer.",
  "Never claim the chart can tell what is going to occur, never say an event did occur or is bound to occur,",
  "never guess how a period felt or what the person did, and never put odds or certainty on a theme.",
  "Do not write about foretelling at all, not even to deny it.",
  "Stay bold and specific: name the indicators behind every theme (dasha lords and the houses",
  "they rule, transits, Moon tags, dated windows), compare periods (for example: \"the strongest",
  "pressure window of 2019 was March to May, when Saturn ...\"; for a single month, compare its parts,",
  "such as the weeks before and after a station or a sign change in the reading, or set it against the",
  "dasha chapter it sits in; never invent another period's facts), and when several indicators",
  "converge, name hard themes plainly: legal or official friction, losses and expenses, a job or",
  "career change. No fear language: no doom, curses or danger; say what the theme asks of the person.",
  "Never narrate the tools or what a reading leaves out: when a dated change has no theme beside it,",
  "say what that planet and house highlight, or leave the line out. And never describe what the person",
  "went through or how things went for them (what was stuck, what moved forward, what they may have",
  "sensed): say what the indicators highlight and how the period compares.",
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

/**
 * Answer text that narrates the tools or what a reading lacks ("the reading supplies no specific
 * life-area interpretation", gpt-sol, 2026-10-15). For the answer check only: prompts name tools.
 */
export const TOOL_NARRATION_PATTERNS: Readonly<Record<ReflectionLanguage, readonly RegExp[]>> = {
  en: [
    word("(?:reading|readings|data|tool|tools)\\s+(?:does not|doesn't|did not|didn't|do not|don't|cannot|can't)\\s+(?:give|provide|supply|include|say|show|specify|offer|list|name|contain|tell|indicate|assign|attach)"),
    word("(?:supplies|supplied|provides|provided|gives|offers|includes|contains)\\s+no\\s+(?:specific|particular|detailed|further|explicit|separate|life-area)"),
    word("no\\s+(?:specific\\s+)?(?:life-area\\s+)?interpretation"),
    word("not\\s+(?:included|available|provided|given|specified|listed|covered|shown)\\s+(?:in|by)\\s+(?:the|this)\\s+(?:reading|data|tool)"),
    word("read_period|tool\\s+(?:call|result|output)s?"),
  ],
  es: [
    word("(?:la lectura|los datos|la herramienta)\\s+no\\s+(?:da|ofrece|incluye|indica|especifica|asigna|muestra|dice)"),
    word("read_period"),
  ],
  pt: [
    word("(?:a leitura|os dados|a ferramenta)\\s+n[aã]o\\s+(?:d[aá]|oferece|inclui|indica|especifica|atribui|mostra|diz)"),
    word("read_period"),
  ],
};

/**
 * Answer text that guesses what the person lived through ("something stalled began to find forward
 * motion", "you may have felt", deepseek, 2026-10-15). Subjects are people and life matters, never a
 * planet: "Jupiter began its transit" is an indicator.
 */
export const LIFE_GUESS_PATTERNS: Readonly<Record<ReflectionLanguage, readonly RegExp[]>> = {
  en: [
    word("you\\s+(?:may|might|must|probably|could)\\s+(?:well\\s+)?have\\s+(?:felt|noticed|experienced|found|seen|faced|had|sensed)"),
    word("(?<!(?:sun|moon|mars|mercury|jupiter|venus|saturn|rahu|ketu)\\s)(?:began|started)\\s+to\\s+(?:find|gain|move|pick up|ease|lift|loosen|improve|inch|settle|unstick)"),
    word("felt\\s+(?:like|as if|as though|stuck|stalled|delayed|blocked|busier|heavier|lighter|slower|faster|easier|harder)"),
  ],
  es: [word("(?:hayas|habr[aá]s|pudiste|puedes haber)\\s+sentido|te sentiste|sentiste")],
  pt: [word("(?:pode ter|deve ter|possa ter)\\s+sentido|voc[eê] sentiu|sentiu-se")],
};

function scan(patterns: readonly RegExp[], text: string): readonly string[] {
  return patterns.flatMap((pattern) => {
    const match = pattern.exec(text);
    return match ? [match[0]] : [];
  });
}

/** Every phrase in `text` that narrates the tools or what a reading lacks; [] when clean. */
export function toolNarration(text: string, language: ReflectionLanguage): readonly string[] {
  return scan(TOOL_NARRATION_PATTERNS[language], text);
}

/** Every phrase in `text` that guesses what the person lived through; [] when clean. */
export function lifeGuesses(text: string, language: ReflectionLanguage): readonly string[] {
  return scan(LIFE_GUESS_PATTERNS[language], text);
}
