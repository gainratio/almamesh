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
import { z, type AnswerSpec } from "./toolLoop";

export const GRAHAS = ["sun", "moon", "mars", "mercury", "jupiter", "venus", "saturn", "rahu", "ketu"] as const;
export type Graha = (typeof GRAHAS)[number];

export interface GroundingReading {
  readonly period: { readonly start: string; readonly end: string; readonly label: string };
  readonly place: { readonly label: string };
  readonly maha: readonly string[];
  readonly antar: readonly string[];
  /** House lordships by graha, e.g. { saturn: [1, 12] }. */
  readonly rules: Readonly<Record<string, readonly number[]>>;
  /** Moon-based sky tags, e.g. sade_sati_phase_1, jupiter_from_moon_11. */
  readonly tags: readonly string[];
  /**
   * Every dated fact inside the period (theme windows, segment events, dasha changes, a sandhi),
   * with a short label of what happens that day, e.g. { date: "2026-11-12", what: "Mars enters Leo" }.
   */
  readonly windows: readonly DatedFact[];
  /** The reading's theme domains, e.g. career, obstacles. */
  readonly domains: readonly string[];
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
  dashas: "lords and the houses they rule",
  moon: "Moon tags from the reading; [] if none",
  themes: "at least one",
  windows: "dated days from the reading; [] if none",
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

function checkLord(level: "maha" | "antar", lord: Graha, readings: readonly GroundingReading[], issue: Issue): void {
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
  if (value.pratyantar) checkRules("pratyantar", value.pratyantar, readings, issue);
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

/** The fix for an empty or missing windows list: dated facts to cite, or [] when there are none. */
function windowsFix(readings: readonly GroundingReading[]): string {
  const facts = datedFacts(readings);
  if (facts.length === 0) return "the reading has no dated days, so send []";
  return `give at least one dated window from the reading, e.g. ${facts.slice(0, 6).map((fact) => `${fact.date}: ${fact.what}`).join("; ")}`;
}

function checkWindows(windows: readonly WindowLine[], readings: readonly GroundingReading[], issue: Issue): void {
  if (windows.length === 0 && datedFacts(readings).length > 0) {
    issue(windowsFix(readings), ["windows"]);
    return;
  }
  // A malformed date is already reported by its own pattern.
  const inside = insideAny(readings);
  if (windows.every((line) => !ISO_DAY.test(line.date) || inside(line.date))) return;
  const ranges = readings.map(({ period }) => `${dayOf(period.start)}..${dayOf(period.end)}`);
  issue(`dates must fall inside ${ranges.join(", ")}`, ["windows"]);
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

const NO_THEME = "give at least one theme with its confidence";
const OBSTACLE_FIX = "the reading has an obstacles theme: give one theme an obstacle that says what blocks and why";
const hasObstacles = (readings: readonly GroundingReading[]): boolean => readings.some((reading) => reading.domains.includes("obstacles"));

function checkThemes(themes: readonly ThemeLine[], readings: readonly GroundingReading[], issue: Issue): void {
  if (themes.length === 0) {
    issue(NO_THEME, ["themes"]);
    return;
  }
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
      return hasObstacles(readings) ? `${NO_THEME}; ${OBSTACLE_FIX}` : NO_THEME;
    case "opening":
      return "two or three plain sentences that answer the question";
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
}

type DashaLevel = "maha" | "antar" | "pratyantar";

const EXPERT_LEVEL: Readonly<Record<DashaLevel, string>> = { maha: "Mahadasha", antar: "Antardasha", pratyantar: "Pratyantardasha" };

function ordinal(n: number): string {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${suffix}`;
}

const EN_CONFIDENCE = { high: "high", medium: "medium", low: "low" } as const;
const ES_CONFIDENCE = { high: "alta", medium: "media", low: "baja" } as const;
const PT_CONFIDENCE = { high: "alta", medium: "média", low: "baixa" } as const;

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
    confidence: (level) => `${EN_CONFIDENCE[level]} confidence`,
    phases: ["first", "second", "third"],
    phase: "phase",
    fromMoon: (graha, house) => `${graha} ${ordinal(house)} from your Moon`,
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
    confidence: (level) => `confianza ${ES_CONFIDENCE[level]}`,
    phases: ["primera", "segunda", "tercera"],
    phase: "fase",
    fromMoon: (graha, house) => `${graha} en la casa ${house} desde tu Luna`,
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
    confidence: (level) => `confiança ${PT_CONFIDENCE[level]}`,
    phases: ["primeira", "segunda", "terceira"],
    phase: "fase",
    fromMoon: (graha, house) => `${graha} na casa ${house} a partir da sua Lua`,
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
    () => listSection("moon", moonLineSchema, (m) => `- **${moonTagLabel(m.tag, o.language)}**: ${m.meaning.trim()}`, v, done, o),
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

/** The tool loop's answer spec: this schema, rendered in the reader's voice; a null place is the reading's. */
export function chatAnswerSpec(grounding: () => AnswerGrounding, o: RenderOptions): AnswerSpec<ChatAnswer> {
  const placed = <T>(value: T): T => withReadingPlace(value, grounding().readings);
  return {
    schema: answerSchema(grounding, o.language),
    render: (value, final) => (final ? renderAnswer(placed(value as ChatAnswer), o) : renderPartialAnswer(placed(value as DeepPartial<ChatAnswer>), o)),
  };
}
