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
  "Write in the Latin script: give a mantra in IAST transliteration (Om Namah Shivaya); its Devanagari is optional, beside it.",
].join("\n");


export type ReflectionLanguage = "en" | "es" | "pt";

const LANGUAGES: readonly ReflectionLanguage[] = ["en", "es", "pt"];

/** A whole word (or word prefix, when `open`) with Unicode-aware edges. */
function word(source: string, open = false): RegExp {
  const end = open ? "" : "(?![\\p{L}\\p{N}])";
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${source})${end}`, "iu");
}

// Life events a reading may name as a theme ("a job or career change") but never foretell.
const EVENTS_EN =
  "promotion|raise|(?:new|next|dream)\\s+job|job\\s+(?:offer|loss|change)|career\\s+change|offer|layoff|marriage|wedding|engagement|" +
  "divorce|break-?up|separation|baby|pregnancy|windfall|inheritance|lawsuit|legal\\s+trouble|court\\s+case|accident|illness|" +
  "surgery|relocation|move\\s+abroad|success|fame|fortune|romance|(?:new\\s+)?partner";
const EVENTS_ES =
  "ascenso|aumento|(?:nuevo\\s+)?(?:trabajo|empleo)|cambio\\s+de\\s+(?:trabajo|empleo|casa|carrera)|boda|matrimonio|compromiso|divorcio|" +
  "ruptura|separaci[oó]n|beb[eé]|embarazo|herencia|demanda|juicio|accidente|enfermedad|mudanza|pareja|oferta|promoci[oó]n|[eé]xito|fortuna";
const EVENTS_PT =
  "promo[cç][aã]o|aumento|(?:novo\\s+)?emprego|mudan[cç]a\\s+de\\s+(?:emprego|casa|carreira)|casamento|noivado|div[oó]rcio|" +
  "separa[cç][aã]o|beb[eê]|gravidez|heran[cç]a|processo|acidente|doen[cç]a|mudan[cç]a|parceir[oa]|namor\\p{L}*|sucesso|fortuna|oferta|demiss[aã]o";
const GRAHAS_ES = "sol|luna|marte|mercurio|j[uú]piter|venus|saturno|rahu|ketu";
const GRAHAS_PT = "sol|lua|marte|merc[uú]rio|j[uú]piter|v[eê]nus|saturno|rahu|ketu";

// Life areas: the subject of a future clause that foretells ("your career will take off"), unlike a
// graha, dasha, transit, sign, house or date, which may carry the future tense.
const LIFE_EN =
  "career|job|work|business|finances|money|income|health|love\\s+life|relationships?|family|home|life|children|child|kids|son|daughter|luck|fortunes?";
const LIFE_ES = "carrera|vida|salud|dinero|finanzas|familia|hogar|hijos?|hijas?|cosas|suerte|amor|relaci[oó]n|negocios?";
const LIFE_PT = "carreira|vida|sa[uú]de|dinheiro|finan[cç]as|fam[ií]lia|lar|filhos?|filhas?|coisas|sorte|amor|relacionamento|neg[oó]cios?";
// A clause about the page ("you'll find the dates below", "podrás revisar la tabla"), not the person's life.
const PAGE_EN = "below|above|table|list|section|tab|page";
const PAGE_ES = "abajo|arriba|tabla|lista|secci[oó]n|detalles|p[aá]gina";
const PAGE_PT = "abaixo|acima|tabela|lista|se[cç][aã]o|detalhes|p[aá]gina";
/** A perception verb whose object is the page, within the clause. */
const aboutThePage = (verbs: string, nouns: string): string => `(?:${verbs})\\s+[^.!?\\n]{0,60}?(?:${nouns})(?![\\p{L}])`;
// A future set on a life area: not when it follows "of"/"house" ("the 10th house of career will host Jupiter").
const NOT_A_HOUSE_EN = "(?<!(?:of|in|for|through|on|about|house|houses|bhava)\\s)";
const NOT_A_HOUSE_ES = "(?<!(?:de|del|en|para)\\s)";
const NOT_A_HOUSE_PT = "(?<!(?:de|do|da|dos|das|no|na|para)\\s)";
// Hindi futures (मिलेगा, होगी, आएंगे): a future suffix after a vowel sign, where a mantra's "गंगे" or "दुर्गा" has none.
const HINDI_FUTURE = /(?:[\u0947\u094B\u0948\u094C]|[\u0947\u094B\u0942]\u0902|\u0942\u0901|[\u090F\u0913\u090A]\u0902?|\u090A\u0901)\u0917[\u093E\u0940\u0947](?![\p{L}\p{M}])|\u0939\u094B\u0928\u0947\s+\u0935\u093E\u0932[\u093E\u0940\u0947]/u;

/**
 * Words that claim or imply prediction or predictive accuracy, per language.
 * en: predict*, forecast*, accurate/accuracy, likely, "will happen", "what happened".
 * es/pt: the same claims. Their words for accuracy (precis-, exat-) are left out on
 * purpose: they also mean "exact birth time", "date precision" and "to need" (pt
 * "preciso"), which are not claims about readings. "An accurate birth time" is not a
 * claim either, and the es/pt stems stop short of "predicament" and "predecessor":
 * answers are read with every language's patterns.
 */
export const PREDICTION_CLAIM_PATTERNS: Readonly<Record<ReflectionLanguage, readonly RegExp[]>> = {
  en: [
    word("predict", true),
    word("forecast", true),
    word("accura(?:te|tely|cy)(?![\\s-]+(?:birth|time|date))"),
    // "the likely birth-time range" describes; "likely to happen", "will likely" and "a likely promotion" put odds on an outcome
    word(`(?<!(?:the|a|an|this|that|its|their|these|those)\\s)likely(?!-)|likely\\s+(?:${EVENTS_EN})`),
    word("will happen"),
    word("what happened"),
  ],
  es: [
    word("predec(?:ir|ido|ida|imos|ible|ibles)|predic(?:e|en|ci[oó]n|ciones|tiv\\p{L}*)|predij\\p{L}*|predir[aá]n?"),
    word("pron[oó]stic", true),
    word("previsi[oó]n(?:es)?"),
    word("probable(?:s|mente)?"),
    word("acertad", true),
    word("ocurrir[aá]n?|suceder[aá]n?|pasar[aá]n?"),
    word("lo que (?:pas[oó]|ocurri[oó]|sucedi[oó])"),
  ],
  pt: [
    word("predi(?:z\\p{L}*|[cç][aã]o|[cç][oõ]es|t\\p{L}*)"),
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
  return scan(PREDICTION_CLAIM_PATTERNS[language], text);
}

/**
 * Text that foretells: a person-directed future ("you will get married", "expect a promotion",
 * "vas a conseguir", "você vai conseguir"), a life event set to come ("a breakup may well occur"),
 * or odds put on it ("chances are", "almost certain"). A sky fact in the future tense ("Saturn will
 * station direct on 17 September", "the Jupiter antardasha will begin in March 2027") is not one:
 * its subject is a graha or a dasha, never the person or a life event.
 */
export const FORETELLING_PATTERNS: Readonly<Record<ReflectionLanguage | "fr" | "hi", readonly RegExp[]>> = {
  en: [
    word(
      "you(?:'ll|\\s+will|\\s+shall|\\s+are\\s+going\\s+to|'re\\s+going\\s+to|\\s+are\\s+gonna)\\s+" +
        `(?!(?:see|notice|find)\\s+(?:below|above|in\\s+the|that|how)(?![\\p{L}])|${aboutThePage("see|notice|find|want", PAGE_EN)})\\p{L}+`,
      true,
    ),
    word("you(?:\\s+are|'re)\\s+(?:likely|bound|set|destined|due|about|expected|sure|certain)\\s+to"),
    word(
      "you\\s+(?:may|might|could|should|can|would)\\s+(?:well\\s+|also\\s+|soon\\s+)?(?:get|receive|land|meet|marry|wed|win|lose|face|experience|" +
        "go\\s+through|relocate|become|fall|suffer|gain|earn|inherit|conceive|divorce|break\\s+up|be\\s+(?:promoted|married|offered|fired|laid\\s+off|sued))",
    ),
    word("expect(?:s|ing)?\\s+(?:a|an|the|some|more|new|big|major|good|great|news|to|your)"),
    word(
      "(?:lies?|lay|lying)\\s+ahead|in\\s+store\\s+for|awaits?\\s+you|on\\s+the\\s+horizon|coming\\s+your\\s+way|come\\s+to\\s+pass|destined|fated|" +
        "bound\\s+to\\s+(?:happen|occur|come|arrive|bring)|set\\s+to\\s+(?:arrive|happen|occur|come|bring|unfold)|foretell\\p{L}*|foretold|foresee\\p{L}*",
    ),
    word("(?<!at\\s)odds|chances\\s+are|(?:strong|good|high|real|fair|slim|low)\\s+chance|almost\\s+certain(?:ly)?|(?:it\\s+is|it's)\\s+certain|(?:is|are|it's)\\s+guaranteed|probab(?:le|ly|ility)"),
    word(
      `${NOT_A_HOUSE_EN}(?:${EVENTS_EN}|${LIFE_EN})(?:'ll|\\s+(?:will|(?:is|are)\\s+(?:set|bound|going|due|likely|about|expected)\\s+to|` +
        "(?:is|are)\\s+(?:coming|on\\s+(?:the|its)\\s+way|around\\s+the\\s+corner|in\\s+the\\s+cards)|" +
        "(?:could|may|might|should|can)\\s+(?:well\\s+)?(?:happen|occur|come|arrive|follow|take\\s+place|be\\s+(?:filed|offered|announced))))",
    ),
    word("things\\s+will\\s+(?:get|be|improve|change|turn|look|work|go|start|fall|settle|pick|move|ease)"),
    word("your\\s+(?:next|new|future)\\s+\\p{L}+\\s+will"),
    word(`there\\s+(?:will|may|might|could|should)\\s+be\\s+(?:a|an|some)\\s+(?:\\p{L}+\\s+){0,2}?(?:${EVENTS_EN})`),
    word(`(?:brings?|will\\s+bring)\\s+(?:you\\s+)?(?:a|an)\\s+(?:\\p{L}+\\s+){0,2}?(?:${EVENTS_EN})`),
  ],
  es: [
    word("vas\\s+a\\s+\\p{L}+", true),
    word("te\\s+espera(?:n|r[aá]n?)?"),
    word(`(?!(?:a|de)?tr[aá]s|${aboutThePage("podr[aá]s|ver[aá]s|notar[aá]s|encontrar[aá]s|querr[aá]s", PAGE_ES)})\\p{L}+rás`),
    word(`${NOT_A_HOUSE_ES}(?:${EVENTS_ES}|${LIFE_ES})\\s+(?:se\\s+)?\\p{L}+rán?(?![\\p{L}])`),
    word(
      `(?:llegar|vendr|habr|ocurrir|suceder|surgir|aparecer)[aá]n?\\s+(?:un|una|unos|unas|el|la|los|las|tu|tus|su|sus)\\s+(?:\\p{L}+\\s+)?(?:${EVENTS_ES}|${LIFE_ES})`,
    ),
    word("va\\s+a\\s+haber"),
    word(`habr[aá]\\s+(?:un|una|unos|unas)\\s+(?:\\p{L}+\\s+)?(?:${EVENTS_ES})`),
    word(`(?:trae|traer[aá]|traen)\\s+(?:un|una)\\s+(?:\\p{L}+\\s+)?(?:${EVENTS_ES})`),
    word("seguramente|es\\s+(?:muy\\s+)?(?:posible|seguro)\\s+que|con\\s+(?:toda\\s+)?seguridad|sin\\s+duda"),
    word(`(?<!(?:${GRAHAS_ES})\\s)(?:conseguir|encontrar|recibir|ganar|perder|lograr|sufrir|obtendr)á|se\\s+(?:casar|mudar|divorciar)á`),
  ],
  pt: [
    word("voc[eê]\\s+(?:vai|ir[aá])\\s+\\p{L}+", true),
    word(`(?<!(?:${GRAHAS_PT}|dasha|antardasha)\\s)vai\\s+(?:conseguir|ter|encontrar|casar|mudar|receber|ganhar|perder|acontecer|chegar|vir|passar|enfrentar)`),
    word(`voc[eê]\\s+(?:n[aã]o\\s+)?(?!${aboutThePage("poder[aá]|ver[aá]|notar[aá]|encontrar[aá]", PAGE_PT)})\\p{L}+r[aá](?![\\p{L}])`),
    word(`${NOT_A_HOUSE_PT}(?:${EVENTS_PT}|${LIFE_PT})\\s+(?:se\\s+)?\\p{L}+r(?:á|ão)(?![\\p{L}])`),
    word(
      `(?:vir|chegar|haver|acontecer|surgir|aparecer)(?:[aá]|[aã]o)\\s+(?:um|uma|uns|umas|o|a|os|as|seu|sua)\\s+(?:\\p{L}+\\s+)?(?:${EVENTS_PT}|${LIFE_PT})`,
    ),
    word(`(?:ter|haver)[aá]\\s+(?:um|uma|uns|umas)\\s+(?:\\p{L}+\\s+)?(?:${EVENTS_PT})`),
    word(`(?<!(?:${GRAHAS_PT})\\s)(?:conseguir|encontrar|receber|ganhar|perder|enfrentar|sofrer|obter)á`),
    word("te\\s+espera|espera\\s+por\\s+voc[eê]|aguarda\\s+voc[eê]|reservad[oa]\\s+para\\s+voc[eê]"),
    word("com\\s+certeza|certamente|sem\\s+d[uú]vida|[eé]\\s+(?:muito\\s+)?(?:poss[ií]vel|prov[aá]vel)\\s+que"),
  ],
  // Not an app language: a model that drifts into French still meets the check.
  fr: [word("(?:tu\\s+vas|vous\\s+allez|tu\\s+auras|vous\\s+aurez)\\s+\\p{L}+", true)],
  // Not an app language either: a Hindi future verb, alone or inside an English line.
  hi: [HINDI_FUTURE],
};

/**
 * Answer text that narrates the tools or what a reading lacks ("the reading supplies no specific
 * life-area interpretation", gpt-sol, 2026-10-15). For the answer check only: prompts name tools.
 */
export const TOOL_NARRATION_PATTERNS: Readonly<Record<ReflectionLanguage, readonly RegExp[]>> = {
  en: [
    word(
      "(?:reading|readings|data|tool|tools|output|result)\\s+(?:does not|doesn't|did not|didn't|do not|don't|cannot|can't)\\s+" +
        "(?:give|provide|supply|include|say|show|specify|offer|list|name|contain|tell|indicate|assign|attach|return|mention|cover)",
    ),
    word("(?:supplies|supplied|provides|provided|gives|offers|includes|contains|returned|returns)\\s+no\\s+(?:specific|particular|detailed|further|explicit|separate|life-area|themes?)"),
    word("no\\s+(?:[\\p{L}-]+\\s+){0,3}interpretation"),
    word("not\\s+(?:included|available|provided|given|specified|listed|covered|shown)\\s+(?:in|by)\\s+(?:the|this)\\s+(?:reading|data|tool)"),
    word("(?:reading|data|tool|output)s?\\s+(?:of\\s+[^.!?\\n]{0,40}?)?(?:shows?|says?|has|gives?|returns?|lists?)\\s+nothing"),
    word("(?:reading|data|tool|output)s?\\s+(?:is|was|are|were)\\s+silent|(?:reading|data|tool|output)s?\\s+(?:lacks|lacked|omits|omitted|skips|skipped)"),
    word("(?:was|were)\\s+(?:not\\s+)?returned"),
    word("read_?period|tool\\s+(?:call|result|output)s?"),
  ],
  es: [
    word(
      "(?:la lectura|los datos|la herramienta|el resultado)\\s+no\\s+(?:da|ofrece|incluye|indica|especifica|asigna|muestra|dice|menciona|cubre|trae|habla|devuelve|devolvi[oó])",
    ),
    word("(?:la lectura|los datos)\\s+(?:guarda silencio|calla|omite)"),
    word("read_?period"),
  ],
  pt: [
    word(
      "(?:a leitura|os dados|a ferramenta|o resultado)\\s+n[aã]o\\s+(?:d[aá]|oferece|inclui|indica|especifica|atribui|mostra|diz|traz|menciona|cobre|fala|retorna|devolve)",
    ),
    word("(?:a leitura|os dados)\\s+(?:silencia|omite)"),
    word("read_?period"),
  ],
};

/**
 * Answer text that guesses what the person lived through ("something stalled began to find forward
 * motion", "you may have felt", deepseek, 2026-10-15), or says a life event occurred ("you got the
 * new job in 2019"). Subjects are people and life matters, never a planet: "Jupiter began its
 * transit" is an indicator.
 */
export const LIFE_GUESS_PATTERNS: Readonly<Record<ReflectionLanguage, readonly RegExp[]>> = {
  en: [
    word("you\\s+(?:may|might|must|probably|likely|surely|could)\\s+(?:well\\s+)?(?:have\\s+)?(?:felt|noticed|experienced|found|seen|faced|had|sensed|went|got|lost)"),
    word("(?<!(?:sun|moon|mars|mercury|jupiter|venus|saturn|rahu|ketu)\\s)(?:began|started)\\s+to\\s+(?:find|gain|move|pick up|ease|lift|loosen|improve|inch|settle|unstick)"),
    word("felt\\s+(?:like|as if|as though|stuck|stalled|delayed|blocked|busier|heavier|lighter|slower|faster|easier|harder)"),
    word(
      "you\\s+(?:got|received|landed|met|married|lost|won|faced|experienced|went\\s+through|relocated|quit|suffered|" +
        "were\\s+(?:promoted|married|fired|laid\\s+off|sued|offered))",
    ),
    word(
      "your\\s+(?:health|career|job|work|marriage|relationship|finances|income|business|love\\s+life)\\s+" +
        "(?:declined|improved|suffered|took\\s+off|collapsed|ended|flourished|struggled|stalled|grew|picked\\s+up)",
    ),
    word("(?:was|were)\\s+(?:a|an)\\s+[^.!?\\n]{0,40}?(?:time|period|month|year|stretch|phase|season)\\s+for\\s+you(?!\\s+to)"),
  ],
  es: [word("(?:hayas|habr[aá]s|pudiste|puedes haber)\\s+sentido|te sentiste|sentiste")],
  pt: [word("(?:pode|deve|possa)\\s+ter\\s+(?:se\\s+)?sentido|voc[eê]\\s+(?:se\\s+)?sentiu|sentiu-se")],
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

// ---------------------------------------------------------------------------
// The one check every user-facing text passes
// ---------------------------------------------------------------------------

export type ReflectionIssueKind = "prediction" | "foretelling" | "narration" | "life_guess" | "unreadable_script";

export interface ReflectionIssue {
  readonly kind: ReflectionIssueKind;
  /** The words that tripped the check, as normalized. */
  readonly phrase: string;
}

/** What the user sees instead of a text that still fails the check after its retries. */
export const REFLECTION_WITHHELD: Readonly<Record<ReflectionLanguage, string>> = {
  en: "I couldn't word this as a reflection. Try asking again.",
  es: "No pude expresar esto como una reflexión. Vuelve a preguntar.",
  pt: "Não consegui formular isto como uma reflexão. Tente perguntar de novo.",
};

/** Characters that render as nothing (zero-width spaces and joiners, soft hyphen, bidi controls, variation selectors). */
const INVISIBLE = /\p{Default_Ignorable_Code_Point}/gu;
const SPACES = /\s+/gu; // with the u flag, \s covers NBSP, thin and ideographic spaces
const APOSTROPHES = /[\u2018\u2019\u02BC\u2032\uFF07]/gu;
const MARKDOWN_LINK = /\[([^\]]*)\]\([^)]*\)/gu;
const MARKDOWN_INLINE = /[*_~`]/gu;
const MARKDOWN_BLOCK = /[#>|]/gu;
const IN_WORD_HYPHEN = /(?<=\p{L})[-‐‑](?=\p{L})/gu;

/** Cyrillic and Greek letters drawn like Latin ones. */
const LOOKALIKES: Readonly<Record<string, string>> = {
  а: "a", е: "e", о: "o", р: "p", с: "c", у: "y", х: "x", і: "i", ј: "j", ѕ: "s", ԁ: "d", ӏ: "l", һ: "h", ԛ: "q", ԝ: "w",
  А: "A", В: "B", Е: "E", К: "K", М: "M", Н: "H", О: "O", Р: "P", С: "C", Т: "T", Х: "X", І: "I", Ј: "J", Ѕ: "S",
  ο: "o", α: "a", ε: "e", ι: "i", κ: "k", ν: "v", ρ: "p", τ: "t", υ: "u", χ: "x",
  Ο: "O", Α: "A", Β: "B", Ε: "E", Ζ: "Z", Η: "H", Ι: "I", Κ: "K", Μ: "M", Ν: "N", Ρ: "P", Τ: "T", Υ: "Y", Χ: "X",
};
const LOOKALIKE = new RegExp(`[${Object.keys(LOOKALIKES).join("")}]`, "gu");

/** The text as the check reads it: compatibility forms folded, invisibles and markdown gone. */
export function normalizeForReflection(text: string): string {
  return text
    .normalize("NFKC")
    .replace(MARKDOWN_LINK, "$1")
    .replace(INVISIBLE, "")
    .replace(LOOKALIKE, (letter) => LOOKALIKES[letter] ?? letter)
    .replace(APOSTROPHES, "'")
    .replace(MARKDOWN_INLINE, "")
    .replace(MARKDOWN_BLOCK, " ")
    .replace(SPACES, " ")
    .normalize("NFC");
}

const SENTENCES = /[^.!?…。！？।\n]+/gu;
const LETTER = /\p{L}/gu;
const LATIN = /\p{Script=Latin}/u;

const MANTRA_MAX_CHARS = 60;
const NON_DEVANAGARI_LETTER = /[^\p{Script=Devanagari}\P{L}]/u;
const DIGIT = /\p{N}/u;

/** A short line in Devanagari alone, with no number in it: a mantra ("ॐ नमः शिवाय") or a graha's name. */
function isShortMantra(sentence: string): boolean {
  const line = sentence.trim();
  return line.length <= MANTRA_MAX_CHARS && !DIGIT.test(line) && !NON_DEVANAGARI_LETTER.test(line);
}

/**
 * A sentence written mostly outside the Latin script: no app language's patterns can read it. A
 * short mantra line is exempt; a Hindi future in it is still caught by its verb ending.
 */
function unreadableSentences(text: string): readonly string[] {
  return (text.match(SENTENCES) ?? []).filter((sentence) => {
    if (isShortMantra(sentence)) return false;
    const letters = sentence.match(LETTER) ?? [];
    const foreign = letters.filter((letter) => !LATIN.test(letter)).length;
    return foreign >= 2 && foreign * 2 > letters.length;
  });
}

const PATTERN_SETS: readonly (readonly [ReflectionIssueKind, readonly RegExp[]])[] = [
  ...LANGUAGES.map((language) => ["prediction", PREDICTION_CLAIM_PATTERNS[language]] as const),
  ...[...LANGUAGES, "fr" as const, "hi" as const].map((language) => ["foretelling", FORETELLING_PATTERNS[language]] as const),
  ...LANGUAGES.map((language) => ["narration", TOOL_NARRATION_PATTERNS[language]] as const),
  ...LANGUAGES.map((language) => ["life_guess", LIFE_GUESS_PATTERNS[language]] as const),
];

/**
 * Every way `text` breaks the reflection rule; [] when it may be shown. Reads every app language's
 * patterns whatever the page language is (a Spanish claim on an English page is still a claim),
 * over the normalized text and over it with in-word hyphens dropped ("pre-dicts").
 */
export function reflectionIssues(text: string): readonly ReflectionIssue[] {
  const normal = normalizeForReflection(text);
  const dehyphenated = normal.replace(IN_WORD_HYPHEN, "");
  const seen = new Set<string>();
  const issues: ReflectionIssue[] = [];
  const add = (kind: ReflectionIssueKind, phrase: string) => {
    const key = `${kind}:${phrase.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    issues.push({ kind, phrase });
  };
  for (const [kind, patterns] of PATTERN_SETS) {
    for (const pattern of patterns) {
      const match = pattern.exec(normal) ?? (dehyphenated === normal ? null : pattern.exec(dehyphenated));
      if (match) add(kind, match[0]);
    }
  }
  for (const sentence of unreadableSentences(normal)) add("unreadable_script", sentence.trim());
  return issues;
}

/** One instruction that names every issue, for the retry that asks the model to reword. */
export function reflectionCorrection(issues: readonly ReflectionIssue[]): string {
  const phrases = [...new Set(issues.map((issue) => `"${issue.phrase}"`))].join(", ");
  return (
    `Your last text was not shown: it broke the reflection rule (${phrases}). Rewrite it as a reflection: ` +
    "say what the chart's indicators highlight for the period and how it compares, never what will or did " +
    "occur, never what the person felt or went through, never what the tools or the reading leave out, " +
    "and write in the language you were asked to use."
  );
}

/**
 * Where a sentence ends: closing punctuation and the space after it, or a line break that starts a
 * new block (a list item, heading, table row or paragraph). A bare line break is a soft wrap inside
 * a sentence ("It will\nhappen"), so it is not an end.
 */
const SENTENCE_END = /[.!?…。！？।]+["'”’)\]*_]*\s+|\n(?=[ \t]*(?:[-*+][ \t]|\d+[.)][ \t]|#|\||\n))/gu;

/** Releases streamed text sentence by sentence, each prefix only once the check passes it. */
export interface ReflectionGate {
  /**
   * The longest prefix of `text` that ends a sentence and passes the check. A sentence still
   * arriving is held; one that fails is held with everything after it. `final`: the text is
   * whole, so its last sentence ends at its end.
   */
  release(text: string, final: boolean): string;
}

function sentenceEnds(text: string, from: number, final: boolean): number[] {
  const ends = [...text.matchAll(SENTENCE_END)].map((match) => match.index + match[0].length).filter((end) => end > from);
  if (final && text.length > from && ends.at(-1) !== text.length) ends.push(text.length);
  return ends;
}

/** A gate for one stream: it remembers the last prefix it passed, so each sentence is checked once. */
export function reflectionGate(): ReflectionGate {
  let passed = "";
  return {
    release(text, final) {
      let released = text.startsWith(passed) ? passed.length : 0;
      for (const end of sentenceEnds(text, released, final)) {
        if (reflectionIssues(text.slice(0, end)).length > 0) break;
        released = end;
      }
      passed = text.slice(0, released);
      return passed;
    },
  };
}

/** {@link ReflectionGate.release} for one text, without a stream's memory. */
export function releasableReflection(text: string, final: boolean): string {
  return reflectionGate().release(text, final);
}

// ---------------------------------------------------------------------------
// Structured readings: every string value of a section's JSON
// ---------------------------------------------------------------------------

/** What a reading shows in place of a value that still fails the check after its retry. */
export const READING_WITHHELD: Readonly<Record<ReflectionLanguage, string>> = {
  en: "I couldn't word this part as a reflection. Generate the reading again to retry.",
  es: "No pude expresar esta parte como una reflexión. Vuelve a generar la lectura.",
  pt: "Não consegui formular esta parte como uma reflexão. Gere a leitura de novo.",
};

/** The JSON value with every string value mapped; keys are structure and stay as they are. */
function mapStrings(value: unknown, map: (text: string) => string): unknown {
  if (typeof value === "string") return map(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, map));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, mapStrings(inner, map)]));
  }
  return value;
}

function parsedOrUndefined(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined; // the section's own parser reports a document that is not JSON
  }
}

/** Every reflection issue in the string values of a JSON document; [] when clean or not JSON. */
export function jsonReflectionIssues(raw: string): readonly ReflectionIssue[] {
  const issues: ReflectionIssue[] = [];
  mapStrings(parsedOrUndefined(raw), (text) => {
    issues.push(...reflectionIssues(text));
    return text;
  });
  return issues;
}

/** The JSON document with each string value that fails the check replaced by `withheld`. */
export function withholdFailingValues(raw: string, withheld: string): string {
  const parsed = parsedOrUndefined(raw);
  if (parsed === undefined) return raw;
  return JSON.stringify(mapStrings(parsed, (text) => (reflectionIssues(text).length > 0 ? withheld : text)));
}

/** The messages that send a failing JSON reading back once: the model's text, then the fix. */
export function reflectionRetry(raw: string, issues: readonly ReflectionIssue[]): readonly { readonly role: "assistant" | "user"; readonly content: string }[] {
  return [
    { role: "assistant", content: raw },
    { role: "user", content: `${reflectionCorrection(issues)} Return the same JSON shape with every value reworded.` },
  ];
}
