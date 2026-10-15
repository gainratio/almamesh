// The chat answer as a typed object. The model fills it through the tool
// loop's `answer` tool; the schema checks it against the readings this turn
// produced (each rejection is worded as the fix the model should make, since
// that text is what the model sees on a retry); the renderer turns it into
// short plain-language markdown in the reader's voice and language.
//
// Wire shape: one flat object at the root. OpenAI strict mode refuses a root
// `oneOf`, so `kind` picks which nullable keys must be filled and the
// refinement enforces it; the parsed value is then exactly a `ChatAnswer`
// (plus null keys of the other kind).
import { lifeGuesses, predictionClaims, toolNarration } from "./reflection";
import { z, type AnswerSpec } from "./toolLoop";

export const GRAHAS = ["sun", "moon", "mars", "mercury", "jupiter", "venus", "saturn", "rahu", "ketu"] as const;
export type Graha = (typeof GRAHAS)[number];

export interface GroundingReading {
  readonly period: { readonly start: string; readonly end: string; readonly label: string };
  readonly place: { readonly label: string };
  readonly maha: readonly string[];
  readonly antar: readonly string[];
  /** The pratyantar lords running in the period ([] when the reading gives none). */
  readonly pratyantar: readonly string[];
  /** House lordships by graha, e.g. { saturn: [1, 12] }. */
  readonly rules: Readonly<Record<string, readonly number[]>>;
  /** Moon-based sky tags, e.g. sade_sati_phase_1, jupiter_from_moon_11. */
  readonly tags: readonly string[];
  /**
   * Every dated fact inside the period (theme windows, segment events, dasha changes, a sandhi),
   * with a short label of what happens that day, e.g. { date: "2026-11-12", what: "Mars enters Leo" }.
   */
  readonly windows: readonly DatedFact[];
  /** The reading's themes by domain (e.g. career, obstacles): the direction and confidence it gives. */
  readonly themes: Readonly<Record<string, ThemeFact>>;
}

/** What a reading says of one life area. */
export interface ThemeFact {
  readonly direction: ThemeLine["direction"];
  readonly confidence: ThemeLine["confidence"];
}

/** A dated fact from a reading: its day (YYYY-MM-DD) and a short label of what happens. */
export interface DatedFact {
  readonly date: string;
  readonly what: string;
}

/** The readings completed this turn (read_period results, projected flat). */
export interface AnswerGrounding {
  readonly readings: readonly GroundingReading[];
}

export interface DashaLine {
  lord: Graha;
  rules: number[];
  note: string;
}

export interface MoonLine {
  tag: string;
  meaning: string;
}

export interface ThemeLine {
  area: string;
  direction: "supportive" | "mixed" | "challenging";
  confidence: "high" | "medium" | "low";
  text: string;
  obstacle: string | null;
}

export interface WindowLine {
  date: string;
  what: string;
}

export interface PeriodAnswer {
  kind: "period";
  period: string;
  /** null or blank: the reading's own place (the renderer names it from the grounding). */
  place: string | null;
  opening: string;
  dashas: { maha: DashaLine; antar: DashaLine; pratyantar: DashaLine | null };
  moon: MoonLine[];
  themes: ThemeLine[];
  windows: WindowLine[];
  advice: string | null;
}

export interface GeneralAnswer {
  kind: "general";
  markdown: string;
}

export type ChatAnswer = PeriodAnswer | GeneralAnswer;

export type DeepPartial<T> = T extends readonly (infer U)[]
  ? DeepPartial<U>[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> | null }
    : T;

export interface RenderOptions {
  readonly voice: "layman" | "expert";
  readonly language: "en" | "es" | "pt";
}

type Language = RenderOptions["language"];

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const dashaLineSchema = z.object({
  lord: z.enum(GRAHAS),
  rules: z.array(z.number().int().min(1).max(12)).describe("the houses this graha rules in this chart, from the reading"),
  note: z.string().describe("one plain sentence on what this chapter brings now"),
});

const dashasSchema = z.object({ maha: dashaLineSchema, antar: dashaLineSchema, pratyantar: dashaLineSchema.nullable() });

const moonLineSchema = z.object({
  tag: z.string().describe("a Moon tag from the reading, e.g. sade_sati_phase_1"),
  meaning: z.string().describe("one plain sentence on what it means for the person"),
});

const themeLineSchema = z.object({
  area: z.string().describe("the life area, e.g. Career"),
  direction: z.enum(["supportive", "mixed", "challenging"]),
  confidence: z.enum(["high", "medium", "low"]),
  text: z.string().describe("one or two plain sentences"),
  obstacle: z.string().nullable().describe("what blocks and why, for an obstacles theme; else null"),
});

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

const windowLineSchema = z.object({
  date: z.string().regex(ISO_DAY, "date must be YYYY-MM-DD"),
  what: z.string().describe("one plain sentence on what to watch that day"),
});

/** The wire description of each key a period answer must fill (short: it rides in every request). */
const PERIOD_KEY_TEXT = {
  period: 'e.g. "September 2019"',
  opening: "2-3 sentences answering the question",
  dashas: "copy lords and houses from the reading's cite",
  moon: "copy from the reading's cite.moon; [] if none",
  themes: "at least one",
  windows: "copy from the reading's cite.windows; [] if none",
} as const;

const required = (key: keyof typeof PERIOD_KEY_TEXT): string => `kind "period": required, ${PERIOD_KEY_TEXT[key]}`;

const wireAnswer = z.object({
  kind: z.enum(["period", "general"]).describe('"period" after read_period; "general" otherwise'),
  markdown: z.string().nullable().describe('kind "general" only: the answer as plain prose'),
  period: z.string().nullable().describe(required("period")),
  place: z.string().nullable().describe("the place as the reading names it, or null for the reading's own place"),
  opening: z.string().nullable().describe(required("opening")),
  dashas: dashasSchema.nullable().describe(required("dashas")),
  moon: z.array(moonLineSchema).nullable().describe(required("moon")),
  themes: z.array(themeLineSchema).nullable().describe(required("themes")),
  windows: z.array(windowLineSchema).nullable().describe(required("windows")),
  advice: z.string().nullable().describe("one practical sentence, or null"),
});

type Wire = z.infer<typeof wireAnswer>;
type Issue = (message: string, path: (string | number)[]) => void;

/** Keys a period answer must fill; a null place means the reading's own place. */
const PERIOD_KEYS = ["period", "opening", "dashas", "moon", "themes", "windows"] as const;

const unique = (values: readonly string[]): string[] => [...new Set(values)];
const lower = (value: string): string => value.toLowerCase();
/** Lowercase without accents, so "Sao Paulo" names "São Paulo". */
const plain = (value: string): string => lower(value.normalize("NFD").replace(/\p{M}/gu, ""));

function checkLord(level: "maha" | "antar" | "pratyantar", lord: Graha, readings: readonly GroundingReading[], issue: Issue): void {
  const allowed = unique(readings.flatMap((reading) => reading[level].map(lower)));
  // A reading without lords of this level cannot ground (or refuse) one.
  if (allowed.length > 0 && !allowed.includes(lord)) issue(`${level} lord must be one of: ${allowed.join(", ")} (from the reading)`, ["dashas", level, "lord"]);
}

function chartRules(lord: Graha, readings: readonly GroundingReading[]): readonly number[] | undefined {
  for (const reading of readings) {
    const key = Object.keys(reading.rules).find((name) => lower(name) === lord);
    if (key !== undefined) return reading.rules[key];
  }
  return undefined;
}

const sameHouses = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && [...a].sort((x, y) => x - y).every((house, index) => house === [...b].sort((x, y) => x - y)[index]);

function checkRules(level: string, line: DashaLine, readings: readonly GroundingReading[], issue: Issue): void {
  const houses = chartRules(line.lord, readings);
  if (houses === undefined || sameHouses(houses, line.rules)) return;
  const fix = houses.length === 0 ? "no houses" : `houses ${[...houses].sort((x, y) => x - y).join(", ")}`;
  issue(`${line.lord} rules ${fix} in this chart`, ["dashas", level, "rules"]);
}

function checkDashas(value: PeriodAnswer["dashas"], readings: readonly GroundingReading[], issue: Issue): void {
  checkLord("maha", value.maha.lord, readings, issue);
  checkLord("antar", value.antar.lord, readings, issue);
  checkRules("maha", value.maha, readings, issue);
  checkRules("antar", value.antar, readings, issue);
  if (!value.pratyantar) return;
  checkLord("pratyantar", value.pratyantar.lord, readings, issue);
  checkRules("pratyantar", value.pratyantar, readings, issue);
}

const wordIn = (text: string, word: string): boolean => new RegExp(`(?<![\\p{L}\\p{N}_])${word}(?![\\p{L}\\p{N}_])`, "iu").test(text);

/** A graha as the answer's language names it ("Mercúrio" in pt); a name that is not a graha, as is. */
const grahaLabel = (lord: string, language: Language): string => (isGraha(lord) ? LABELS[language].grahas[lord] : lord);

/** The text names the lord in English or in the answer's language, any case, with or without accents. */
function namesLord(text: string, lord: string, language: Language): boolean {
  const said = plain(text);
  return [lord, grahaLabel(lord, language)].some((name) => wordIn(said, plain(name)));
}

/**
 * A span across a dasha change has several running lords; the typed answer holds one per level,
 * so the rest must be named in the text. The rule: every lord of every reading that crosses a
 * change (a comparison of two such periods names the lords of both).
 */
function checkCrossings(value: PeriodAnswer, readings: readonly GroundingReading[], language: Language, issue: Issue): void {
  const { maha, antar, pratyantar } = value.dashas;
  const text = [value.opening, ...[maha, antar, pratyantar].flatMap((line) => (line ? [line.lord, line.note] : []))].join("\n");
  const crossing = readings.flatMap((reading) =>
    (["maha", "antar"] as const).flatMap((level) => {
      const lords = unique(reading[level].map(lower));
      return lords.length > 1 ? lords : [];
    }),
  );
  const missing = unique(crossing).filter((lord) => !namesLord(text, lord, language));
  if (missing.length === 0) return;
  issue(`This period crosses a dasha change: also name ${missing.map((lord) => grahaLabel(lord, language)).join(", ")} in the dasha note.`, ["dashas"]);
}

const allTags = (readings: readonly GroundingReading[]): string[] => unique(readings.flatMap((reading) => reading.tags));

/** The fix for an empty or missing Moon section: the tags to name, or [] when there are none. */
function moonFix(readings: readonly GroundingReading[]): string {
  const tags = allTags(readings);
  return tags.length > 0 ? `name at least one Moon tag: ${tags.join(", ")}` : "the reading has no Moon tags, so send []";
}

function checkMoon(moon: readonly MoonLine[], readings: readonly GroundingReading[], issue: Issue): void {
  const tags = allTags(readings);
  if (tags.length === 0 && moon.length > 0) issue("the reading has no Moon tags: leave moon empty", ["moon"]);
  else if (tags.length > 0 && moon.length === 0) issue(moonFix(readings), ["moon"]);
  else if (moon.some((line) => !tags.map(lower).includes(lower(line.tag)))) issue(`moon tags must come from the reading: ${tags.join(", ")}`, ["moon"]);
}

const dayOf = (instant: string): string => instant.slice(0, 10);

const insideAny = (readings: readonly GroundingReading[]) => (date: string): boolean =>
  readings.some(({ period }) => date >= dayOf(period.start) && date <= dayOf(period.end));

/** The reading's dated facts inside a period read, one per day (the first label for a day), by date. */
function datedFacts(readings: readonly GroundingReading[]): DatedFact[] {
  const inside = insideAny(readings);
  const byDay = new Map<string, DatedFact>();
  for (const fact of readings.flatMap((reading) => reading.windows)) {
    if (inside(fact.date) && !byDay.has(fact.date)) byDay.set(fact.date, fact);
  }
  return [...byDay.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

const NO_DATED_DAYS = "the reading has no dated days, so send []";
const factList = (facts: readonly DatedFact[]): string => facts.slice(0, 6).map((fact) => `${fact.date}: ${fact.what}`).join("; ");

/** The fix for an empty or missing windows list: dated facts to cite, or [] when there are none. */
function windowsFix(readings: readonly GroundingReading[]): string {
  const facts = datedFacts(readings);
  if (facts.length === 0) return NO_DATED_DAYS;
  return `give at least one dated window from the reading, e.g. ${factList(facts)}`;
}

/** Every window's date is a day the reading gives (inside a period read); none at all when it gives none. */
function checkWindows(windows: readonly WindowLine[], readings: readonly GroundingReading[], issue: Issue): void {
  const facts = datedFacts(readings);
  if (windows.length === 0) {
    if (facts.length > 0) issue(windowsFix(readings), ["windows"]);
    return;
  }
  // A malformed date is already reported by its own pattern.
  const days = new Set(facts.map((fact) => fact.date));
  if (windows.every((line) => !ISO_DAY.test(line.date) || days.has(line.date))) return;
  issue(facts.length === 0 ? NO_DATED_DAYS : `each window date must be a day the reading gives, e.g. ${factList(facts)}`, ["windows"]);
}

/**
 * Only a place that is given is checked: null or blank is the reading's own place. When no
 * reading this turn has a place (a today thread reads at the viewer's zone only), a named place
 * can only be a guess, so it is refused.
 */
function checkPlace(place: string | null, readings: readonly GroundingReading[], issue: Issue): void {
  if (!place?.trim()) return;
  const labels = unique(readings.map((reading) => reading.place.label.trim()).filter(Boolean));
  if (labels.length === 0) {
    issue("This reading has no place; set place to null.", ["place"]);
    return;
  }
  const named = labels.some((label) => plain(place).includes(plain(label.split(",")[0]?.trim() ?? label)));
  if (!named) issue(`name the place as the reading does: ${labels.join(" or ")}`, ["place"]);
}

const OBSTACLE_FIX = "the reading has an obstacles theme: give one theme an obstacle that says what blocks and why";
const hasObstacles = (readings: readonly GroundingReading[]): boolean => readings.some((reading) => "obstacles" in reading.themes);

/** "supportive, high confidence": a domain's facts as the fix text names them. */
const themeFactText = (fact: ThemeFact): string => `${fact.direction}, ${fact.confidence} confidence`;

/** The reading's themes, "career: supportive, high confidence; …" (the first reading's, for a domain in several). */
function themesList(readings: readonly GroundingReading[]): string {
  const byDomain = new Map<string, ThemeFact>();
  for (const [domain, fact] of readings.flatMap((reading) => Object.entries(reading.themes))) if (!byDomain.has(domain)) byDomain.set(domain, fact);
  return [...byDomain].map(([domain, fact]) => `${domain}: ${themeFactText(fact)}`).join("; ");
}

function noThemeFix(readings: readonly GroundingReading[]): string {
  const listed = themesList(readings);
  return listed ? `give at least one theme with its confidence, e.g. ${listed}` : "give at least one theme with its confidence";
}

/** The reading's domains the theme's area names ("Career and money" names career). */
const namedDomains = (area: string, readings: readonly GroundingReading[]): string[] =>
  unique(readings.flatMap((reading) => Object.keys(reading.themes))).filter((domain) => wordIn(plain(area), plain(domain).replace(/_/g, " ")));

/** A theme whose area names a domain of the reading states that domain's direction and confidence (any reading's). */
function checkThemeFacts(theme: ThemeLine, index: number, readings: readonly GroundingReading[], issue: Issue): void {
  const domains = namedDomains(theme.area, readings);
  if (domains.length === 0) return;
  const facts = domains.flatMap((domain) => readings.flatMap((reading) => reading.themes[domain] ?? []));
  if (facts.some((fact) => fact.direction === theme.direction && fact.confidence === theme.confidence)) return;
  const [domain = "", fact] = [domains[0], facts[0]];
  if (fact) issue(`the reading gives ${domain} as ${themeFactText(fact)}: copy both`, ["themes", index]);
}

function checkThemes(themes: readonly ThemeLine[], readings: readonly GroundingReading[], issue: Issue): void {
  if (themes.length === 0) {
    issue(noThemeFix(readings), ["themes"]);
    return;
  }
  themes.forEach((theme, index) => checkThemeFacts(theme, index, readings, issue));
  if (hasObstacles(readings) && !themes.some((theme) => theme.obstacle?.trim())) issue(OBSTACLE_FIX, ["themes"]);
}

/** A level's allowed lords with the houses each rules, e.g. "jupiter (rules 2, 11)". */
function lordsFix(level: "maha" | "antar", readings: readonly GroundingReading[]): string | undefined {
  const lords = unique(readings.flatMap((reading) => reading[level].map(lower)));
  if (lords.length === 0) return undefined;
  const named = lords.map((lord) => {
    const houses = isGraha(lord) ? chartRules(lord, readings) : undefined;
    if (houses === undefined) return lord;
    return `${lord} (rules ${houses.length === 0 ? "no houses" : [...houses].sort((x, y) => x - y).join(", ")})`;
  });
  return `${level} lord one of: ${named.join(", ")}`;
}

/** What a missing period key needs, from this turn's readings. */
function missingFix(key: (typeof PERIOD_KEYS)[number], readings: readonly GroundingReading[]): string {
  switch (key) {
    case "period": {
      const labels = unique(readings.map((reading) => reading.period.label.trim()).filter(Boolean));
      return labels.length > 0 ? `the period as a person says it, e.g. ${labels.map((label) => `"${label}"`).join(" or ")}` : "the period as a person says it";
    }
    case "dashas": {
      const lords = [lordsFix("maha", readings), lordsFix("antar", readings)].filter((fix) => fix !== undefined);
      return lords.length > 0 ? lords.join("; ") : PERIOD_KEY_TEXT.dashas;
    }
    case "moon":
      return moonFix(readings);
    case "windows":
      return windowsFix(readings);
    case "themes":
      return hasObstacles(readings) ? `${noThemeFix(readings)}; ${OBSTACLE_FIX}` : noThemeFix(readings);
    case "opening":
      return "two or three plain sentences that answer the question";
  }
}

/** Every reader-facing text of the answer with its path, in reading order. */
function answerTexts(value: Wire): (readonly [string, (string | number)[]])[] {
  const texts: (readonly [string, (string | number)[]])[] = [];
  const add = (text: string | null | undefined, path: (string | number)[]) => {
    if (text) texts.push([text, path]);
  };
  add(value.markdown, ["markdown"]);
  add(value.opening, ["opening"]);
  for (const level of ["maha", "antar", "pratyantar"] as const) add(value.dashas?.[level]?.note, ["dashas", level, "note"]);
  value.moon?.forEach((line, index) => add(line.meaning, ["moon", index, "meaning"]));
  value.themes?.forEach((theme, index) => {
    add(theme.text, ["themes", index, "text"]);
    add(theme.obstacle, ["themes", index, "obstacle"]);
  });
  value.windows?.forEach((window, index) => add(window.what, ["windows", index, "what"]));
  add(value.advice, ["advice"]);
  return texts;
}

/** Reflection, not prediction (2026-10-15): no answer text claims to foretell or says what a period brought. */
function checkReflection(value: Wire, language: Language, issue: Issue): void {
  for (const [text, path] of answerTexts(value)) {
    const claims = predictionClaims(text, language);
    if (claims.length > 0) {
      issue(`Reflection, not prediction: say what the chart highlights, not what the period brought or will bring (remove "${claims.join('", "')}").`, path);
    }
    const narration = toolNarration(text, language);
    if (narration.length > 0) {
      issue(`Leave out what the reading does not cover: name the indicator and what it highlights, or drop the line (remove "${narration.join('", "')}").`, path);
    }
    const guesses = lifeGuesses(text, language);
    if (guesses.length > 0) {
      issue(`Do not describe what the person went through or felt: say what the indicators highlight (remove "${guesses.join('", "')}").`, path);
    }
  }
}

function checkGeneral(value: Wire, readings: readonly GroundingReading[], issue: Issue): void {
  if (readings.length > 0) issue('You read a period this turn: answer with kind "period" and its facts.', ["kind"]);
  else if (!value.markdown?.trim()) issue('kind "general" needs markdown: the answer as plain prose.', ["markdown"]);
}

function checkPeriod(value: Wire, readings: readonly GroundingReading[], language: Language, issue: Issue): void {
  if (readings.length === 0) {
    issue('Read the period with read_period before answering with kind "period", or answer with kind "general".', ["kind"]);
    return;
  }
  // Every issue in one round: a missing key says what goes in it, and the checks of the keys
  // that did arrive still run (a model fixes all of them in one retry, not one per round).
  for (const key of PERIOD_KEYS) if (value[key] === null) issue(`${key} is required when kind is "period": ${missingFix(key, readings)}`, [key]);
  const { dashas, moon, windows, themes } = value;
  if (dashas) {
    checkDashas(dashas, readings, issue);
    checkCrossings({ ...value, opening: value.opening ?? "", dashas } as PeriodAnswer, readings, language, issue);
  }
  if (moon) checkMoon(moon, readings, issue);
  if (windows) checkWindows(windows, readings, issue);
  checkPlace(value.place, readings, issue);
  if (themes) checkThemes(themes, readings, issue);
}

/**
 * The answer tool's schema, checked against the readings `grounding()` returns at validation time.
 * `language` is the answer's: its graha names count in the text, and fixes name grahas in it.
 */
export function answerSchema(grounding: () => AnswerGrounding, language: Language = "en"): z.ZodType<ChatAnswer> {
  const schema = wireAnswer.superRefine((value, ctx) => {
    const issue: Issue = (message, path) => ctx.addIssue({ code: "custom", message, path });
    const { readings } = grounding();
    if (value.kind === "general") checkGeneral(value, readings, issue);
    else checkPeriod(value, readings, language, issue);
    checkReflection(value, language, issue);
  });
  // The refinement guarantees the kind's keys are filled, so the parsed wire value is a ChatAnswer.
  return schema as unknown as z.ZodType<ChatAnswer>;
}

// ---------------------------------------------------------------------------
// Labels (every reader-facing string lives here)
// ---------------------------------------------------------------------------

interface VoiceLabels {
  readonly chapters: string;
  readonly moon: string;
  readonly themes: string;
  readonly windows: string;
}

interface LanguageLabels {
  readonly layman: VoiceLabels;
  readonly expert: VoiceLabels;
  /** "September 2019 in Vadodara" */
  readonly in: string;
  readonly grahas: Readonly<Record<Graha, string>>;
  readonly months: readonly string[];
  readonly and: string;
  readonly roles: Readonly<Record<DashaLevel, string>>;
  readonly lordOf: string;
  rules(graha: string, houses: readonly number[], list: (items: string[]) => string): string;
  readonly direction: Readonly<Record<ThemeLine["direction"], string>>;
  confidence(level: ThemeLine["confidence"]): string;
  /** Sade Sati's phases, first to third. */
  readonly phases: readonly string[];
  /** The word "phase". */
  readonly phase: string;
  fromMoon(graha: string, house: number): string;
  readonly signs: Readonly<Record<Sign, string>>;
  readonly motions: Readonly<Record<string, string>>;
  enters(graha: string, sign: string): string;
  stations(graha: string, motion: string): string;
  begins(level: DashaLevel, lord: string): string;
  sandhi(level: string): string;
}

const SIGNS = ["aries", "taurus", "gemini", "cancer", "leo", "virgo", "libra", "scorpio", "sagittarius", "capricorn", "aquarius", "pisces"] as const;
type Sign = (typeof SIGNS)[number];

type DashaLevel = "maha" | "antar" | "pratyantar";

const EXPERT_LEVEL: Readonly<Record<DashaLevel, string>> = { maha: "Mahadasha", antar: "Antardasha", pratyantar: "Pratyantardasha" };

function ordinal(n: number): string {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${suffix}`;
}

// The engine's theme confidence counts agreeing indicators (reading/themes.py), so the
// reader sees that count, never a confidence that could pass for a hit rate.
const EN_CONFIDENCE = { high: "most indicators agree", medium: "some indicators agree", low: "few indicators agree" } as const;
const ES_CONFIDENCE = { high: "coinciden casi todos los indicadores", medium: "coinciden algunos indicadores", low: "coinciden pocos indicadores" } as const;
const PT_CONFIDENCE = { high: "quase todos os indicadores concordam", medium: "alguns indicadores concordam", low: "poucos indicadores concordam" } as const;

const LABELS: Readonly<Record<Language, LanguageLabels>> = {
  en: {
    layman: { chapters: "Your chapters", moon: "The Moon's sky", themes: "What it means", windows: "Dates to watch" },
    expert: { chapters: "Dashas", moon: "Gochara from the Moon", themes: "Themes", windows: "Windows" },
    in: "in",
    grahas: { sun: "Sun", moon: "Moon", mars: "Mars", mercury: "Mercury", jupiter: "Jupiter", venus: "Venus", saturn: "Saturn", rahu: "Rahu", ketu: "Ketu" },
    months: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
    and: "and",
    roles: {
      maha: "is your main chapter (maha dasha)",
      antar: "is the sub-chapter inside it (antar dasha)",
      pratyantar: "is the short chapter inside that (pratyantar dasha)",
    },
    lordOf: "lord of",
    rules: (graha, houses, list) => `${graha} rules your ${list(houses.map(ordinal))} ${houses.length > 1 ? "houses" : "house"}.`,
    direction: { supportive: "supportive", mixed: "mixed", challenging: "challenging" },
    confidence: (level) => EN_CONFIDENCE[level],
    phases: ["first", "second", "third"],
    phase: "phase",
    fromMoon: (graha, house) => `${graha} ${ordinal(house)} from your Moon`,
    signs: {
      aries: "Aries", taurus: "Taurus", gemini: "Gemini", cancer: "Cancer", leo: "Leo", virgo: "Virgo",
      libra: "Libra", scorpio: "Scorpio", sagittarius: "Sagittarius", capricorn: "Capricorn", aquarius: "Aquarius", pisces: "Pisces",
    },
    motions: { direct: "direct", retrograde: "retrograde" },
    enters: (graha, sign) => `${graha} enters ${sign}`,
    stations: (graha, motion) => `${graha} stations ${motion}`,
    begins: (level, lord) => `${level} ${lord} begins`,
    sandhi: (level) => `${level} dasha junction (sandhi)`,
  },
  es: {
    layman: { chapters: "Tus capítulos", moon: "El cielo de la Luna", themes: "Qué significa", windows: "Fechas clave" },
    expert: { chapters: "Dashas", moon: "Gochara desde la Luna", themes: "Temas", windows: "Ventanas" },
    in: "en",
    grahas: { sun: "Sol", moon: "Luna", mars: "Marte", mercury: "Mercurio", jupiter: "Júpiter", venus: "Venus", saturn: "Saturno", rahu: "Rahu", ketu: "Ketu" },
    months: ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sept", "oct", "nov", "dic"],
    and: "y",
    roles: {
      maha: "es tu capítulo principal (maha dasha)",
      antar: "es el subcapítulo dentro de él (antar dasha)",
      pratyantar: "es el capítulo corto dentro de ese (pratyantar dasha)",
    },
    lordOf: "señor de",
    rules: (graha, houses, list) => `${graha} rige ${houses.length > 1 ? "tus casas" : "tu casa"} ${list(houses.map(String))}.`,
    direction: { supportive: "favorable", mixed: "mixto", challenging: "difícil" },
    confidence: (level) => ES_CONFIDENCE[level],
    phases: ["primera", "segunda", "tercera"],
    phase: "fase",
    fromMoon: (graha, house) => `${graha} en la casa ${house} desde tu Luna`,
    signs: {
      aries: "Aries", taurus: "Tauro", gemini: "Géminis", cancer: "Cáncer", leo: "Leo", virgo: "Virgo",
      libra: "Libra", scorpio: "Escorpio", sagittarius: "Sagitario", capricorn: "Capricornio", aquarius: "Acuario", pisces: "Piscis",
    },
    motions: { direct: "directo", retrograde: "retrógrado" },
    enters: (graha, sign) => `${graha} entra en ${sign}`,
    stations: (graha, motion) => `${graha} pasa a ${motion}`,
    begins: (level, lord) => `comienza el ${level} dasha de ${lord}`,
    sandhi: (level) => `transición del ${level} dasha (sandhi)`,
  },
  pt: {
    layman: { chapters: "Seus capítulos", moon: "O céu da Lua", themes: "O que significa", windows: "Datas para observar" },
    expert: { chapters: "Dashas", moon: "Gochara a partir da Lua", themes: "Temas", windows: "Janelas" },
    in: "em",
    grahas: { sun: "Sol", moon: "Lua", mars: "Marte", mercury: "Mercúrio", jupiter: "Júpiter", venus: "Vênus", saturn: "Saturno", rahu: "Rahu", ketu: "Ketu" },
    months: ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"],
    and: "e",
    roles: {
      maha: "é seu capítulo principal (maha dasha)",
      antar: "é o subcapítulo dentro dele (antar dasha)",
      pratyantar: "é o capítulo curto dentro desse (pratyantar dasha)",
    },
    lordOf: "senhor de",
    rules: (graha, houses, list) => `${graha} rege ${houses.length > 1 ? "suas casas" : "sua casa"} ${list(houses.map(String))}.`,
    direction: { supportive: "favorável", mixed: "misto", challenging: "desafiador" },
    confidence: (level) => PT_CONFIDENCE[level],
    phases: ["primeira", "segunda", "terceira"],
    phase: "fase",
    fromMoon: (graha, house) => `${graha} na casa ${house} a partir da sua Lua`,
    signs: {
      aries: "Áries", taurus: "Touro", gemini: "Gêmeos", cancer: "Câncer", leo: "Leão", virgo: "Virgem",
      libra: "Libra", scorpio: "Escorpião", sagittarius: "Sagitário", capricorn: "Capricórnio", aquarius: "Aquário", pisces: "Peixes",
    },
    motions: { direct: "direto", retrograde: "retrógrado" },
    enters: (graha, sign) => `${graha} entra em ${sign}`,
    stations: (graha, motion) => `${graha} fica ${motion}`,
    begins: (level, lord) => `começa o ${level} dasha de ${lord}`,
    sandhi: (level) => `transição do ${level} dasha (sandhi)`,
  },
};

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
const sentence = (...parts: (string | undefined)[]): string => parts.map((part) => part?.trim() ?? "").filter(Boolean).join(" ");

function isGraha(name: string): name is Graha {
  return (GRAHAS as readonly string[]).includes(name);
}

function joinList(items: string[], and: string): string {
  if (items.length < 2) return items.join("");
  return `${items.slice(0, -1).join(", ")} ${and} ${items.at(-1)}`;
}

/** A word of an unknown tag, in the reader's language where a label exists. */
function tagWord(word: string, L: LanguageLabels): string {
  if (isGraha(word)) return L.grahas[word];
  return word === "phase" ? L.phase : word;
}

/** sade_sati_phase_1 -> "Sade Sati, first phase"; jupiter_from_moon_11 -> "Jupiter 11th from your Moon". */
export function moonTagLabel(tag: string, language: Language): string {
  const L = LABELS[language];
  const phase = /^sade_sati_phase_([123])$/.exec(tag);
  if (phase) return `Sade Sati, ${L.phases[Number(phase[1]) - 1]} ${L.phase}`;
  const fromMoon = /^([a-z]+)_from_moon_(\d+)$/.exec(tag);
  if (fromMoon?.[1] && isGraha(fromMoon[1])) return L.fromMoon(L.grahas[fromMoon[1]], Number(fromMoon[2]));
  return tag.split("_").map((word) => capitalize(tagWord(word, L))).join(" ");
}

/** A dated fact before it is phrased: what the engine says happens that day. */
export type DatedEvent =
  | { readonly kind: "ingress"; readonly graha: string; readonly sign: string }
  | { readonly kind: "station"; readonly graha: string; readonly motion: string }
  | { readonly kind: "dasha"; readonly level: DashaLevel; readonly lord: string }
  | { readonly kind: "sandhi"; readonly level: string }
  | { readonly kind: "other"; readonly text: string };

const isSign = (name: string): name is Sign => (SIGNS as readonly string[]).includes(name);

/** A graha or sign as the language names it; an unknown name capitalized, as the engine wrote it. */
const grahaName = (name: string, L: LanguageLabels): string => (isGraha(name) ? L.grahas[name] : capitalize(name));
const signName = (name: string, L: LanguageLabels): string => (isSign(name) ? L.signs[name] : capitalize(name));

/** "Mars enters Leo" / "Marte entra en Leo" / "Marte entra em Leão": a dated fact in the answer's language. */
export function datedEventLabel(event: DatedEvent, language: Language): string {
  const L = LABELS[language];
  switch (event.kind) {
    case "ingress":
      return L.enters(grahaName(event.graha, L), signName(event.sign, L));
    case "station":
      return L.stations(grahaName(event.graha, L), L.motions[event.motion] ?? event.motion);
    case "dasha":
      return L.begins(event.level, grahaName(event.lord, L));
    case "sandhi":
      return L.sandhi(event.level);
    case "other":
      return event.text;
  }
}

/** A chat language tag ("es", "pt-BR") as the answer speaks it: es, pt, else en. */
export function answerLanguage(tag: string): Language {
  const base = tag.toLowerCase().split("-")[0];
  return base === "es" || base === "pt" ? base : "en";
}

function renderDate(date: string, language: Language): string {
  const [year, month, day] = date.split("-").map(Number);
  return `${day} ${LABELS[language].months[(month ?? 1) - 1]} ${year}`;
}

function dashaLine(level: DashaLevel, line: DashaLine, o: RenderOptions): string {
  const L = LABELS[o.language];
  const graha = L.grahas[line.lord];
  if (o.voice === "expert") {
    const lordship = line.rules.length > 0 ? ` (${L.lordOf} ${line.rules.join(", ")})` : "";
    return `- **${EXPERT_LEVEL[level]} ${graha}**${lordship}${line.note.trim() ? `: ${line.note.trim()}` : ""}`;
  }
  const rules = line.rules.length > 0 ? L.rules(graha, line.rules, (items) => joinList(items, L.and)) : undefined;
  return `- ${sentence(`**${graha}** ${L.roles[level]}.`, rules, line.note)}`;
}

/** A Moon line; a meaning that only repeats the tag's name (a line filled from the reading) is not said twice. */
function moonLineText(line: MoonLine, language: Language): string {
  const label = moonTagLabel(line.tag, language);
  const meaning = line.meaning.trim();
  return meaning && plain(meaning) !== plain(label) ? `- **${label}**: ${meaning}` : `- **${label}**`;
}

function themeLineText(theme: ThemeLine, language: Language): string {
  const L = LABELS[language];
  return `- **${capitalize(theme.area.trim())}** (${L.direction[theme.direction]}, ${L.confidence(theme.confidence)}): ${sentence(theme.text, theme.obstacle ?? undefined)}`;
}

function listBlock(title: string, lines: string[]): string | undefined {
  return lines.length > 0 ? `**${title}**\n${lines.join("\n")}` : undefined;
}

/** One section of a period answer: its block (if any) and whether everything it needs has arrived. */
interface Section {
  readonly block?: string;
  readonly complete: boolean;
}

type Done = (key: keyof Wire) => boolean;
type Value = Readonly<Record<string, unknown>>;

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

function headingSection(v: Value, done: Done, o: RenderOptions): Section {
  const period = text(v.period);
  // A null place (no reading to name it from) leaves the heading as just the period.
  const place = v.place === null ? "" : text(v.place);
  if (!done("period") || !done("place") || period === undefined || place === undefined) return { complete: false };
  const where = place.trim() ? ` ${LABELS[o.language].in} ${place.trim()}` : "";
  return { block: `**${period.trim()}${where}**`, complete: true };
}

function proseSection(key: "opening" | "advice", v: Value, done: Done): Section {
  if (!done(key)) return { complete: false };
  const value = text(v[key])?.trim();
  return { block: value || undefined, complete: true };
}

function dashasSection(v: Value, done: Done, o: RenderOptions): Section {
  const parsed = dashasSchema.safeParse(v.dashas);
  if (!done("dashas") || !parsed.success) return { complete: false };
  const { maha, antar, pratyantar } = parsed.data;
  const lines = [dashaLine("maha", maha, o), dashaLine("antar", antar, o)];
  if (pratyantar) lines.push(dashaLine("pratyantar", pratyantar, o));
  return { block: listBlock(LABELS[o.language][o.voice].chapters, lines), complete: true };
}

/** The items that have fully arrived: all of them once the key is done, else all but the one still streaming. */
function arrivedItems<T>(key: keyof Wire, item: z.ZodType<T>, v: Value, done: Done): { items: T[]; complete: boolean } {
  const raw = Array.isArray(v[key]) ? (v[key] as unknown[]) : [];
  const candidates = done(key) ? raw : raw.slice(0, -1);
  const items: T[] = [];
  for (const candidate of candidates) {
    const parsed = item.safeParse(candidate);
    if (!parsed.success) return { items, complete: false };
    items.push(parsed.data);
  }
  return { items, complete: done(key) };
}

function listSection<T>(key: "moon" | "themes" | "windows", item: z.ZodType<T>, line: (value: T) => string, v: Value, done: Done, o: RenderOptions): Section {
  const { items, complete } = arrivedItems(key, item, v, done);
  return { block: listBlock(LABELS[o.language][o.voice][key], items.map(line)), complete };
}

function periodSections(v: Value, done: Done, o: RenderOptions): Array<() => Section> {
  return [
    () => headingSection(v, done, o),
    () => proseSection("opening", v, done),
    () => dashasSection(v, done, o),
    () => listSection("moon", moonLineSchema, (m) => moonLineText(m, o.language), v, done, o),
    () => listSection("themes", themeLineSchema, (t) => themeLineText(t, o.language), v, done, o),
    () => listSection("windows", windowLineSchema, (w) => `- **${renderDate(w.date, o.language)}**: ${w.what.trim()}`, v, done, o),
    () => proseSection("advice", v, done),
  ];
}

/** Render leading sections in order, stopping at the first one still arriving. */
function renderPeriod(v: Value, done: Done, o: RenderOptions): string {
  const blocks: string[] = [];
  for (const section of periodSections(v, done, o)) {
    const { block, complete } = section();
    if (block) blocks.push(block);
    if (!complete) break;
  }
  return blocks.join("\n\n");
}

/** The final answer as markdown. */
export function renderAnswer(answer: ChatAnswer, o: RenderOptions): string {
  if (answer.kind === "general") return answer.markdown.trim();
  return renderPeriod(answer as unknown as Value, () => true, o);
}

/**
 * A streaming snapshot. A key is complete once a later key has started (JSON
 * streams in order), so only complete leading sections render and each
 * snapshot extends the one before it. A general answer's prose streams as is.
 */
export function renderPartialAnswer(partial: DeepPartial<ChatAnswer>, o: RenderOptions): string {
  const v = partial as Value;
  if (v.kind === "general") return (text(v.markdown) ?? "").trim();
  if (v.kind !== "period") return "";
  const keys = Object.keys(v);
  const done: Done = (key) => {
    const at = keys.indexOf(key);
    return at >= 0 && at < keys.length - 1;
  };
  return renderPeriod(v, done, o);
}

/** The reading a period answer speaks of: the one whose period label it names, else the first. */
function namedReading(period: unknown, readings: readonly GroundingReading[]): GroundingReading | undefined {
  const said = typeof period === "string" ? plain(period.trim()) : "";
  return readings.find((reading) => said !== "" && plain(reading.period.label.trim()) === said) ?? readings[0];
}

/**
 * A period answer whose place is null or blank, given the reading's place label. Only a place
 * key that has arrived is filled (so a streaming snapshot keeps its key order and stays a prefix).
 */
function withReadingPlace<T>(value: T, readings: readonly GroundingReading[]): T {
  const v = value as Value;
  if (v.kind !== "period" || !("place" in v) || text(v.place)?.trim()) return value;
  const label = namedReading(v.period, readings)?.place.label.trim();
  return label ? ({ ...v, place: label } as T) : value;
}

// ---------------------------------------------------------------------------
// Filling facts the reading already gave
// ---------------------------------------------------------------------------

/** At most this many dated windows are filled from the reading. */
export const FILLED_WINDOWS = 3;

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A list the model left out: null (or omitted), or empty. */
const leftOut = (value: unknown): boolean => value === null || value === undefined || (Array.isArray(value) && value.length === 0);

/**
 * A period answer with its left-out Moon and windows sections filled from this turn's readings:
 * each Moon tag, named in the answer's language, and the first {@link FILLED_WINDOWS} dated facts
 * inside the period, earliest first. These are facts the reading already states; the model's job
 * is to interpret them, not to copy them. A section the model gave is kept as it is (a wrong tag
 * or date is still rejected), and nothing else is filled: the dashas, themes and opening are the
 * model's interpretation. The input itself is returned when there is nothing to fill.
 */
export function fillFromReadings(input: unknown, readings: readonly GroundingReading[], language: Language): unknown {
  if (!isObject(input) || input.kind !== "period" || readings.length === 0) return input;
  const moon = leftOut(input.moon) ? allTags(readings).map((tag): MoonLine => ({ tag, meaning: moonTagLabel(tag, language) })) : input.moon;
  const windows = leftOut(input.windows) ? datedFacts(readings).slice(0, FILLED_WINDOWS).map(({ date, what }): WindowLine => ({ date, what })) : input.windows;
  if (JSON.stringify([moon, windows]) === JSON.stringify([input.moon, input.windows])) return input;
  return { ...input, moon, windows };
}

/** The answer tool's description: the loop's default, plus where the facts come from (each read_period result's cite). */
export const CHAT_ANSWER_DESCRIPTION =
  "Submit the final answer to the user. Call it once, last, after the readings you need. " +
  "Copy the facts from each reading's cite. If the arguments are rejected, fix the named fields and call it again.";

/**
 * The tool loop's answer spec: this schema, rendered in the reader's voice; a null place is the
 * reading's, and left-out Moon and windows sections are filled from the reading before validation.
 */
export function chatAnswerSpec(grounding: () => AnswerGrounding, o: RenderOptions): AnswerSpec<ChatAnswer> {
  const placed = <T>(value: T): T => withReadingPlace(value, grounding().readings);
  return {
    schema: answerSchema(grounding, o.language),
    description: CHAT_ANSWER_DESCRIPTION,
    prepare: (input) => fillFromReadings(input, grounding().readings, o.language),
    render: (value, final) => (final ? renderAnswer(placed(value as ChatAnswer), o) : renderPartialAnswer(placed(value as DeepPartial<ChatAnswer>), o)),
  };
}
