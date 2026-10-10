// Structured seven-section Vedic interpretation generator, ported to run entirely
// client-side against any OpenAI-compatible endpoint (no backend).
//
// This is the in-browser port of the predecessor's multi-call orchestrator
// (vedic_core/llm/orchestrator.py) + its Jinja section prompts. The explicit APIs
// split five stable natal sections from two time-sensitive timeline sections;
// the compatibility API still fans out all seven JSON completions. Each response
// must match its slice of the `VedicInterpretation` shared type. Any single
// section that fails degrades to its safe default (empty), emitting an `error`
// event, while the requested interpretation still completes — one bad section
// never sinks the reading.
//
// The chart is sanitized via `sanitizeChartForLlm` BEFORE any prompt is built,
// so the privacy boundary cannot be skipped. Every call also runs the fail-closed
// `ensurePrivacy` gate inside `chatCompletionJson`.

import type {
  CareerGuidance,
  EducationGuidance,
  FamilyGuidance,
  FinanceGuidance,
  HealthGuidance,
  IntegratedYogaNarrative,
  LifeEvolutionGuidance,
  Persona,
  RelationshipGuidance,
  RemedialMeasures,
  SpiritualGuidance,
  TitledPersona,
  VedicInterpretation,
} from "@almamesh/shared-types";
import type { SiderealChart } from "@almamesh/browser/types";

import { estimateTokens } from "./budget";
import { chatCompletionJson, LlmRequestError, type ChatMessage } from "./client";
import { createJsonProseExtractor, createWordCounter } from "./json-prose";
import { streamChatCompletionJson } from "./json-stream";
import { LAYMAN_JARGON_TERMS } from "./layman-jargon";
import { asPersona, asRecord, parsePersona, parseTitledPersonas } from "./persona-parse";
import { REPORT_SECTION_REASONING_MAX_TOKENS, SECTION_REASONING_MAX_TOKENS } from "./reasoning";
import { ensurePrivacy, isLocalEndpoint, type ProviderConfig } from "./config";
import { withLanguage, type PromptLanguage } from "./language";
import { buildPredictiveFactsBlock, buildReportFactsBlock } from "./predictive-facts";
import { OUTPUT_DISCIPLINE_RULES, PRIVACY_RULE, type ViewMode } from "./prompt";
import { monthsIn, validateTimelineDates } from "./date-guard";
import { computeQuarters } from "./quarters";
import {
  currentPeriodSlice,
  isReportTimelineSection,
  LIFE_OUTLOOK_GROUPS,
  lifeOutlookSlice,
  parseCurrentPeriod,
  parseLifeOutlook,
  parseYearAhead,
  REPORT_TIMELINE_SECTIONS,
  reportAsOfMonth,
  reportSlice,
  yearAheadSlice,
  type CurrentPeriodSection,
  type LifeOutlookSection,
  type ReportTimelineContent,
  type ReportTimelineSectionKey,
  type YearAheadSection,
} from "./report-sections";
import {
  REPORT_FIELD_TARGETS,
  REPORT_PROMPT_SET,
  type ReportPromptSet,
  type ReportSectionKey,
} from "./report-targets";
import {
  chartAnalysisInstant,
  sanitizeChartForLlm,
  type AnalysisInstant,
  type SanitizedChart,
} from "./sanitize";

// =============================================================================
// Public API
// =============================================================================

export type InterpretationSectionKey =
  | "core"
  | "yoga"
  | "guidance1"
  | "guidance2"
  | "remedial"
  | "upcoming_periods"
  | "current_sky";

export type NatalInterpretationSectionKey = Exclude<
  InterpretationSectionKey,
  "upcoming_periods" | "current_sky"
>;

export type CurrentTimelineSectionKey = Extract<
  InterpretationSectionKey,
  "upcoming_periods" | "current_sky"
>;

export type NatalInterpretation = Omit<
  VedicInterpretation,
  "upcoming_periods" | "current_sky" | "current_period_guidance"
>;

export interface CurrentTimelineContent {
  readonly upcoming_periods: TitledPersona[];
  readonly current_sky: TitledPersona[];
}

export type InterpretationEvent =
  | { type: "section_start"; section: InterpretationSectionKey }
  | { type: "section_complete"; section: InterpretationSectionKey }
  | { type: "complete"; interpretation: VedicInterpretation }
  | { type: "error"; section?: InterpretationSectionKey; message: string; status?: number };

export type NatalInterpretationEvent =
  | { type: "section_start"; section: NatalInterpretationSectionKey }
  | { type: "section_complete"; section: NatalInterpretationSectionKey }
  | { type: "complete"; interpretation: NatalInterpretation }
  | { type: "error"; section: NatalInterpretationSectionKey; message: string; status?: number };

export type CurrentTimelineEvent =
  | { type: "section_start"; section: CurrentTimelineSectionKey }
  | { type: "section_complete"; section: CurrentTimelineSectionKey }
  | { type: "complete"; timeline: CurrentTimelineContent }
  | { type: "error"; section: CurrentTimelineSectionKey; message: string; status?: number };

export interface StructuredInterpretationParams {
  /** The engine chart (same type `streamChartInterpretation` takes). */
  readonly chart: SiderealChart;
  readonly config: ProviderConfig;
  /** `layman` | `expert`; biases which mode the prompt foregrounds. */
  readonly mode?: ViewMode;
  /** UI/narration language for the reading (`en` default); engine is untouched. */
  readonly language?: PromptLanguage;
  readonly signal?: AbortSignal;
  /**
   * The instant "current" dasha statements are relative to. Defaults to the
   * chart's own snapshot instant (`chartAnalysisInstant`), never the wall
   * clock; a chart stored before snapshots must pass its stored instant.
   */
  readonly asOf?: AnalysisInstant;
  /** Injectable for tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /**
   * Runaway-reasoning cap for streamed sections, in ms (default
   * REASONING_TIMEOUT_MS). Injectable so tests need not wait three minutes.
   */
  readonly reasoningTimeoutMs?: number;
  /**
   * When set, each section STREAMS (`stream: true`) and this is called with
   * the section's live prose as it is written. The final JSON is still
   * validated before the section completes. Unset: one non-streaming call.
   */
  readonly onSectionProgress?: (
    section: InterpretationSectionKey,
    progress: SectionProgressSnapshot,
  ) => void;
  /**
   * `REPORT_PROMPT_SET` selects the report-v2 natal prompts (longer targets,
   * family_guidance) and the 6,000-token reasoning cap; absent = the legacy
   * prompts, byte-identical.
   */
  readonly promptSet?: ReportPromptSet;
}

type AnySectionKey = InterpretationSectionKey | ReportTimelineSectionKey;

/** The params the shared section runner takes, with progress keyed by its own section type. */
interface SectionRunParams<Section extends AnySectionKey>
  extends Omit<StructuredInterpretationParams, "onSectionProgress"> {
  readonly onSectionProgress?: (section: Section, progress: SectionProgressSnapshot) => void;
}

export interface ReportTimelineParams extends Omit<StructuredInterpretationParams, "onSectionProgress" | "promptSet"> {
  readonly onSectionProgress?: (section: ReportTimelineSectionKey, progress: SectionProgressSnapshot) => void;
}

export type ReportTimelineEvent =
  | { type: "section_start"; section: ReportTimelineSectionKey }
  | { type: "section_complete"; section: ReportTimelineSectionKey }
  | { type: "complete"; timeline: ReportTimelineContent; asOfMonth: string; dateGuardRemovals: number }
  | { type: "error"; section: ReportTimelineSectionKey; message: string; status?: number };

/** A section's live, still-unvalidated prose while it streams. */
export interface SectionProgressSnapshot {
  /** Words written so far (JSON string values only). */
  readonly words: number;
  /** The last few hundred characters of prose, for a live preview. */
  readonly preview: string;
  /** Reasoning ("thinking") words so far; the text itself is not kept. */
  readonly thinkingWords: number;
}

export type NatalInterpretationParams = StructuredInterpretationParams;
export type CurrentTimelineParams = StructuredInterpretationParams;

export const NATAL_SECTIONS = [
  "core",
  "yoga",
  "guidance1",
  "guidance2",
  "remedial",
] as const satisfies readonly NatalInterpretationSectionKey[];

export const CURRENT_TIMELINE_SECTIONS = [
  "upcoming_periods",
  "current_sky",
] as const satisfies readonly CurrentTimelineSectionKey[];

export const ALL_SECTIONS: readonly InterpretationSectionKey[] = [
  ...NATAL_SECTIONS,
  ...CURRENT_TIMELINE_SECTIONS,
];

// =============================================================================
// System prompt (ported, condensed) — the dual-mode + accuracy mandate
// =============================================================================

// Faithful port of vedic_core .../prompts/system_prompt.md to AlmaMesh's ACTUAL
// data contract (sanitize.ts + chart.ts). Every behavioral rule that protects
// correctness is kept — dual-mode layman/technical separation, the ABSOLUTE
// "only discuss yogas explicitly in the provided yoga list" constraint, privacy,
// anti-generic + anti-repetition discipline, strict-JSON output. The esoteric
// word-count minimums and "REJECTED/regenerate" coercion are dropped (they hurt
// in-browser JSON reliability without improving quality).
//
// CALCULATION-INTEGRITY: the esoteric prompt cited fields AlmaMesh does NOT emit
// (per-planet shadbala_ratio, birth date/age, transits, graha aspects/drishti,
// Neechabhanga, navamsa). Those instructions are REWRITTEN or DROPPED here, never
// copied — the LLM narrates only from fields that actually exist in the chart JSON.
// The layman voice is repaired against the shared banned list when accepted
// (asLayman below); naming the exact list to the model keeps that repair rare.
const LAYMAN_GUARD_RULE = [
  `    The layman text is checked word by word: any sentence using ${LAYMAN_JARGON_TERMS.join(", ")}`,
  "    is DELETED — even in an everyday sense (say 'a signal', not 'a sign'; 'stretching',",
  "    not 'yoga'; 'home', not 'house').",
].join("\n");

function systemPrompt(timelineNames: string): string {
  return [
    "You are a grand master Vedic Astrologer (Sidereal / Lahiri ayanamsa) and a",
    "positive, empowering life guide. You produce STRUCTURED interpretation data.",
    "You NARRATE the chart you are given; you never compute, recalculate, or invent",
    "astrological facts that are not already present in the chart JSON.",
    "",
    "DUAL-MODE OUTPUT (MANDATORY): every persona object has TWO fields with ZERO overlap:",
    '  - "layman": everyday language for someone who has NEVER heard of astrology.',
    "    FORBIDDEN here: planet names (Sun, Moon, Mars, …), house numbers, sign names,",
    "    conjunction, dasha, yoga, nakshatra, zodiac-sign names, Sanskrit terms. Speak",
    "    only of the LIVED THEMES (creativity, security, communication, partnership,",
    "    discipline, growth). Warm, practical, caring — a wise friend over coffee.",
    LAYMAN_GUARD_RULE,
    '  - "technical": for a practicing Jyotish scholar. Cite exact placements from the',
    "    data: degree-within-sign (sign + sign_degrees), nakshatra + nakshatra_pada +",
    "    nakshatra_lord, dignity, retrograde/combust flags, house-lord (dispositor)",
    "    chains, and dasha lord/status/sequence. Use Sanskrit terms with a short gloss.",
    "",
    "STRENGTH-SIGNAL HIERARCHY (this chart provides ONLY these signals — use no others):",
    "  - PER-PLANET strength comes ONLY from these fields: `dignity` (one of exactly four",
    "    values: exalted, own, neutral, debilitated), `is_retrograde`, `is_combust`, the",
    "    houses a graha rules (`houses_ruled`), and `is_yogakaraka`. There is NO numeric",
    "    planet strength (no shadbala field, no shadbala_ratio) — NEVER state a numeric",
    "    or percentage strength for a planet.",
    "  - PER-YOGA strength comes ONLY from each yoga's qualitative `grade` (exactly one",
    "    of strong, moderate, weak) and its `strength_factors[]` (each factor's `value`",
    "    and `basis` already phrase the 'why' in the engine's own words — QUOTE or",
    "    paraphrase them; never invent numbers). The engine DOES compute a numeric",
    "    yoga strength (`strength_pct`), and the report prints it — but it is",
    "    deliberately WITHHELD from the facts you are given, so that you can neither",
    "    re-weight it nor reason about a number you cannot verify. If no percentage",
    "    appears in your input, that is by design: narrate the grade, never a number.",
    "",
    "DIGNITY VOCABULARY FENCE (ABSOLUTE): the ONLY dignities that exist in this chart are",
    "  exalted, own, neutral, debilitated. NEVER assert moolatrikona, friendly, enemy,",
    "  great-friend, or 'cancelled / Neechabhanga' dignity — that data is NOT provided.",
    "  Use signs, houses, and dignities EXACTLY as given; if a value is absent, say nothing.",
    "  DEBILITY HONESTY: never call a debilitated, retrograde-strained, or combust planet",
    "  simply 'strong' — name the condition and the struggle/delay/effort theme it implies.",
    "",
    "ASPECT HONESTY (ABSOLUTE): this chart contains NO graha-aspect / drishti data. NEVER",
    "  say one planet 'aspects', 'casts a glance on', or 'sees' another. The ONLY relation",
    "  you may assert between two planets is CONJUNCTION — and only when they share the",
    "  same `house` value. State nothing about any other inter-planetary relationship.",
    "",
    "TIMING OWNERSHIP (ABSOLUTE): stable natal sections never discuss the current or next",
    "  dasha, months remaining, dated windows, transits, or 'this period'. Those belong",
    `  only to the separate ${timelineNames} timeline sections. Never infer age,`,
    "  dates, Saturn returns, or present-day timing from natal placements.",
    "",
    "YOGA CONSTRAINT (ZERO TOLERANCE — THE MOST IMPORTANT RULE):",
    "  You may ONLY discuss yogas that appear EXPLICITLY in the chart's yoga list.",
    "  If a yoga is not in that list, it DOES NOT EXIST in this chart — never invent,",
    "  fabricate, or name it (e.g. do not mention Gajakesari unless it is listed).",
    "  Achieve depth by analyzing the EXISTING yogas more deeply, never by adding new ones.",
    "",
    "ANTI-GENERIC MANDATE: every claim must be anchored to a NAMED placement from the data",
    "  (a specific planet's sign/house/dignity/nakshatra, a house-lord chain, or a listed",
    "  yoga). A sentence that could appear in any other person's reading must be rewritten",
    "  to cite this chart's specifics. No fortune-cookie generalities.",
    "",
    "ANTI-REPETITION: do not reuse the same yoga, placement, phrase, or metaphor across",
    "  sections — each section foregrounds different planets/houses and fresh vocabulary.",
    "",
    PRIVACY_RULE,
    "",
    OUTPUT_DISCIPLINE_RULES,
    "",
    "OUTPUT: respond with a SINGLE strict JSON object matching the requested schema for",
    "the section. No prose outside the JSON. No markdown fences. Escape quotes in strings.",
  ].join("\n");
}

const LEGACY_TIMELINE_NAMES = "Road Ahead / Current Sky";
const REPORT_TIMELINE_NAMES = "Current Period / Year Ahead / This Year";
const SYSTEM_PROMPT = systemPrompt(LEGACY_TIMELINE_NAMES);

// =============================================================================
// LITE system prompt — for SMALL LOCAL models (gemma3:4b, qwen2.5:3b, …)
// =============================================================================
//
// Small local models drown in the full prompt's heavy analytical mandates
// (unique-angle openings, mandatory dispositor chains, strength-ordering, karaka
// chains) and return empty/placeholder JSON → a blank dashboard. The LITE prompt
// KEEPS every hard correctness guard (zero yoga fabrication, privacy, strict
// single-JSON / no fences, dual-mode layman vs technical, and ALL the honesty
// fences: no graha aspects/drishti, no ages/dates/Saturn-returns, no invented
// shadbala numbers, dignity only exalted/own/neutral/debilitated) but DROPS the
// analytical-depth requirements and asks for SHORT, plain, concrete content.
function systemPromptLite(timelineNames: string): string {
  return [
    "You are a kind, encouraging Vedic Astrologer (Sidereal / Lahiri ayanamsa).",
    "You NARRATE the chart JSON you are given. You NEVER compute, recalculate, or",
    "invent any astrological fact that is not already in the chart JSON.",
    "",
    "WRITE SHORT, PLAIN, CONCRETE content. Do not pad. Do not write essays.",
    "",
    "DUAL-MODE (MANDATORY): every persona object has TWO fields, no overlap:",
    '  - "layman": everyday words for someone who has NEVER heard of astrology. NO',
    "    planet names, NO house numbers, NO sign names, NO Sanskrit, NO jargon — speak",
    "    only of lived themes (creativity, security, communication, partnership, growth).",
    LAYMAN_GUARD_RULE,
    '  - "technical": for an astrologer. Name the actual placements from the data',
    "    (planet, sign, house, dignity, nakshatra, dasha lord). One or two specifics is enough.",
    "",
    "HARD FACT FENCES (ABSOLUTE — these protect correctness, never relax them):",
    "  - DIGNITY: the ONLY dignity values are exalted, own, neutral, debilitated. NEVER",
    "    say moolatrikona, friendly, enemy, or 'cancelled / Neechabhanga'. A debilitated,",
    "    combust, or retrograde planet is NOT plainly 'strong' — name the effort it asks.",
    "  - STRENGTH NUMBERS: never state a numeric or percentage strength for any planet",
    "    or yoga. No such number is in your input — the report renders the engine's own",
    "    `strength_pct` directly from the chart, so anything YOU write would be a second,",
    "    unverifiable figure beside it. Use only the dignity/retrograde/combust flags,",
    "    each yoga's `grade`, and its `strength_factors[]` (value + basis).",
    "  - ASPECTS: this chart has NO aspect/drishti data. NEVER say a planet 'aspects',",
    "    'sees', or 'casts a glance on' another. The only relation you may state is",
    "    CONJUNCTION, and only when two planets share the same `house` value.",
    "  - TIMING OWNERSHIP: stable natal sections never discuss current/next periods,",
    `    dates, ages, or transits. Only ${timelineNames} may use timing fields,`,
    "    and they must use only values explicitly present in their input.",
    "  - YOGAS (ZERO TOLERANCE): discuss ONLY yogas that appear in the chart's yoga list.",
    "    If a yoga is not listed it DOES NOT EXIST here — never invent or name one.",
    "",
    PRIVACY_RULE,
    "",
    OUTPUT_DISCIPLINE_RULES,
    "",
    "OUTPUT: respond with ONE strict JSON object matching the requested schema. No prose",
    "outside the JSON. No markdown code fences. Escape any quotes inside strings. Fill in",
    "every requested field with real content — never leave a field blank, null, or a",
    "placeholder like 'N/A' or 'pending'.",
  ].join("\n");
}

const SYSTEM_PROMPT_LITE = systemPromptLite(LEGACY_TIMELINE_NAMES);

// =============================================================================
// Per-section task prompts (ported from the .j2 section templates)
// =============================================================================

const CORE_TASK = [
  "TASK: Core Analysis — WHO the person IS (identity, innate nature, personality).",
  "Return JSON: { summary, strengths[], challenges[], life_themes[] }.",
  "  - summary: a DUAL-MODE object { \"layman\": string, \"technical\": string } — REQUIRED,",
  "    both fields NON-EMPTY, written FIRST (before the arrays). It is the headline reading",
  "    shown at the top of the dashboard, toggled between two voices:",
  "      • layman = a 2-3 sentence executive summary in EVERYDAY words, with NO planet,",
  "        sign, house, dasha, yoga, or nakshatra names — just the lived essence.",
  "      • technical = the SAME essence in 2-3 sentences that NAME the actual placements",
  "        and dignities (the lagna + lord, the most decisive dignity, the defining yoga).",
  "  - strengths / challenges / life_themes: arrays (aim for 3 items each) of objects",
  '    { "title": string, "layman": string, "technical": string }.',
  "",
  "UNIQUE-ANGLE OPENING: open from a spine that could fit NO other chart — anchor it to",
  "  the lagna (rising sign + its lord's placement), the planet with the most decisive",
  "  `dignity` (an exalted or debilitated planet, or an own-sign one), and the single",
  "  defining yoga from the list. Name that spine in the summary, then let strengths,",
  "  challenges, and themes elaborate it.",
  "HOUSE-LORD CHAINS: trace AT LEAST ONE explicit dispositor chain — take a house cusp,",
  "  read its `sign_lord` (that is the house's lord), find WHERE that planet sits via its",
  "  `house` and `sign`, and read ITS dignity; narrate what the chain reveals about the",
  "  path to that area of life. (e.g. 'the lord of the rising sign sits in the Nth house",
  "  in <dignity>, so identity is expressed through <that house's themes>'.)",
  "DEGREE & NAKSHATRA DEPTH (technical fields): cite sign + sign_degrees, and weave in",
  "  nakshatra + nakshatra_pada + nakshatra_lord for defining planets — let the nakshatra",
  "  lord modify how that planet expresses. NAME any defining planet that is_retrograde",
  "  (an inward/revisiting quality) or is_combust (overshadowed by the Sun, expressed",
  "  through effort). Two planets sharing a `house` are conjunct — you may say so.",
  "DEBILITY HONESTY: a debilitated/combust/retrograde-strained planet is never plainly",
  "  'strong' — name the condition and the growth-through-effort theme.",
  "Every challenge MUST end with a BRIDGE sentence linking it to a NAMED strength or",
  "  yoga from this same reading (name the yoga only in the technical field; the layman",
  "  field says it in plain words). Give each item a distinct emotional flavor and fresh",
  "  vocabulary. Only reference yogas in the provided list.",
].join("\n");

const YOGA_TASK = [
  "TASK: Integrated Yoga Narrative — the life JOURNEY and its turning points, NOT",
  "  personality (that is the Core section). Tell one flowing life story.",
  'Return JSON: { "integrated_yoga_narrative": { "layman": string, "technical": string } }.',
  "  Both fields MUST be non-empty strings.",
  "",
  "ORDER BY GRADE: rank the yogas by their qualitative `grade` (strong > moderate >",
  "  weak). The STRONGEST-graded yoga is the CORE THEME the story is built around; the",
  "  moderate yogas are AMPLIFIERS that color it; the weak are NUANCE/undertone.",
  "  Group yogas that share the same planets into ONE composite theme (max 7-8 headline",
  "  themes), naming the dominant one and treating the rest as supporting facets.",
  "WHY (quote the data): justify each yoga's weight by QUOTING or paraphrasing its own",
  "  `strength_factors[]` entries (`value` + `basis`) and `formation_rules[].description`",
  "  — those already phrase the contributing reasons, with their classical `source`.",
  "  Never invent a percentage or a factor that is not in the data.",
  "DEBILITY HONESTY: if a yoga involves a debilitated, combust, or retrograde planet,",
  "  state the modification explicitly — the yoga's gift is earned through struggle, not",
  "  given freely. Do NOT claim any 'Neechabhanga / cancellation' (not in this data).",
  "TIME-INDEPENDENT: describe the journey from the listed yoga formations and natal",
  "  placements only. Do not mention current/next periods, dates, ages, or transits.",
  "ZERO TOLERANCE: never mention any yoga that is not in the provided list; reach depth",
  "  by analyzing the listed yogas more deeply, never by adding new ones.",
].join("\n");

const GUIDANCE1_TASK = [
  "TASK: Life Guidance Part 1 — practical application across four life areas.",
  "Return JSON with FOUR persona objects, each { layman, technical }:",
  "  health_guidance, education_guidance, career_guidance, relationship_guidance.",
  "",
  "PER-AREA HOUSE-LORD CHAIN (MANDATORY in the technical field): for each area, take its",
  "  house cusp, read the cusp's `sign_lord` (= that house's lord), find WHERE that lord",
  "  sits via its `house`/`sign`, and read ITS `dignity` — narrate the path that chain",
  "  reveals. Houses by area: Health = 1st & 6th; Education = 4th & 5th; Career = 10th;",
  "  Relationships = 7th.",
  "PER-AREA KARAKA CONDITION: also read the area's natural significator and report its",
  "  `dignity`, `is_combust`, `is_retrograde` — Health: Sun & Mars; Education: Mercury &",
  "  Jupiter; Career: Saturn & the Sun; Relationships: Venus & the Moon. If a karaka is",
  "  debilitated/combust, be honest that the area asks for more effort before it flowers.",
  "DISTINCT VOCABULARY PER AREA: Health = body-mind, vitality, stress response, rest.",
  "  Education = learning style, curiosity, which subjects flow vs. need effort.",
  "  Career = work environment and navigating authority. Relationships = attachment,",
  "  what makes them feel secure,",
  "  communication in partnership. Do NOT bleed one area's framing into another.",
  "DEBILITY HONESTY throughout; describe what success AND struggle FEEL like, not just",
  "  outcomes. Only reference yogas in the provided list.",
  "Speak only to stable natal placements. Current timing belongs to the separate timeline.",
].join("\n");

const GUIDANCE2_TASK = [
  "TASK: Life Guidance Part 2 — the inner and temporal dimensions.",
  "Return JSON with THREE persona objects, each { layman, technical }:",
  "  finances_guidance, spiritual_guidance, life_evolution_guidance.",
  "",
  "FINANCES: trace the 2nd-house and 11th-house lord chains (each cusp's `sign_lord` →",
  "  where that planet sits → its dignity) to show how earning and gains flow. If a",
  "  wealth lord is_retrograde, frame it as a revisiting pattern — money themes circled",
  "  back to, refined the second time — not a date. Be honest about any debilitated",
  "  wealth lord (abundance is cultivated patiently, after lessons).",
  "SPIRITUAL: trace the 9th- and 12th-house lord chains; read Ketu's `house`/`sign` as",
  "  the area of natural detachment and inward pull. Name the practices that resonate",
  "  from these placements. Do NOT invent transits or 'phases of life' from dates.",
  "LIFE EVOLUTION: describe the enduring developmental arc from the ascendant lord,",
  "  lunar nodes, and 9th/12th-house lord chains. Keep it time-independent: never name",
  "  a current/next period, dated window, age, transit, or months remaining.",
  "  Every challenge mentioned MUST end with a BRIDGE to a NAMED strength or yoga",
  "  (name the yoga only in the technical field; the layman field says it in plain words).",
  "DEBILITY HONESTY throughout; give each section a distinct voice. Convey how money",
  "  anxiety/abundance and inner seeking FEEL. Only reference yogas in the provided list.",
  "Speak only to stable natal placements. Current timing belongs to the separate timeline.",
].join("\n");

const REMEDIAL_TASK = [
  "TASK: Remedial Measures — universal & globally accessible, personalized to THIS chart.",
  'Return JSON: { "remedial_measures": { "layman": string, "technical": string } }.',
  "",
  "  - layman: UNIVERSAL-FIRST and culture-neutral ONLY — meditation & mindfulness,",
  "    breathing, gentle stretches by plain English name (warrior pose, tree pose), walking /",
  "    nature immersion, journaling & reflection, color/environment & decluttering,",
  "    sleep & general wellness, service & connection, creative expression. FORBIDDEN",
  "    here: Sanskrit mantras, pujas, temple/deity worship, gemstone prescriptions,",
  "    metals/fingers, hora/muhurta timing — any culture-specific religious practice.",
  "    For EACH practice say WHAT to do, WHY it helps (plain principle), HOW it FEELS",
  "    when it is working, and WHEN to do it. Honest framing only — practices help",
  "    MANAGE a challenge gradually over weeks/months; they do not erase it overnight.",
  "  - technical: gemstones and mantras MAY appear here, but ONLY as optional",
  "    alternatives alongside the universal practices, never as the primary solution.",
  "TARGETING (MANDATORY): every technical remedy must address a SPECIFIC named weak",
  "  placement actually present in the data — a planet whose `dignity` is debilitated,",
  "  or that is `is_combust`, or a yoga whose `grade` is weak. Name that placement as",
  "  the thing the remedy supports. NEVER invent an affliction, aspect, or dosha that",
  "  is not visible in the chart JSON.",
  "Ground each measure only in stable natal facts; never prescribe by a current period.",
].join("\n");

const UPCOMING_PERIODS_TASK = [
  "TASK: The Road Ahead — the person's UPCOMING dasha periods as a dated forward arc.",
  'Return JSON: { "upcoming_periods": [ { "title": string, "layman": string, "technical": string } ] }.',
  "",
  "WINDOWS (THE ONLY ONES THAT EXIST): one item PER upcoming window, in chronological",
  "  order — each REMAINING antardasha of the current mahadasha (the rows of the current",
  "  maha's `antar_sequence` AFTER the current antardasha), then ONE item for the NEXT",
  "  mahadasha transition (the sequence row after the current maha). If the chart carries",
  "  no dated `antar_sequence`, fall back to the maha rows with status 'future' and their",
  "  relative wording. NEVER invent a window, a period, or a date beyond those rows.",
  "TITLE: the period + its engine-stated window verbatim, month precision — e.g.",
  '  "Sun antardasha — 2027-01 to 2028-01" (or the relative status when undated).',
  "GROUNDING (MANDATORY): anchor EVERY window in that period lord's OWN chart facts —",
  "  its sign + house + `dignity`, the houses it rules (`houses_ruled`), its",
  "  `is_yogakaraka` / `is_combust` / `is_retrograde` flags, and any LISTED yoga it",
  "  participates in. Where natural, speak to the life domains of the houses that lord",
  "  rules or occupies (career for the 10th, partnership for the 7th, finances for the",
  "  2nd and 11th, home for the 4th, learning for the 5th).",
  "VOICE: concrete and dated — no hedging filler ('time will tell', 'anything is",
  "  possible'). The layman field renders each window as lived experience with no",
  "  jargon; the technical field cites the exact placements and the dated window.",
  "DEBILITY HONESTY: a debilitated, combust, or retrograde lord's window is a",
  "  growth-through-effort chapter — name the condition; never call it plainly easy.",
  "ZERO TOLERANCE: never invent a period, a date, a dignity, or a yoga not in the data.",
  "When the ENGINE PREDICTIVE CONTEXT block is present, ground this in the domain's",
  "  current emphasis (active daśā significator, Sade Sati, transit severity) and its",
  "  next month-precision windows; otherwise speak to the natal placements only.",
].join("\n");

const CURRENT_SKY_TASK = [
  'TASK: "What\'s active now & next" — Return JSON:',
  '{ "current_sky": [ { "title": string, "layman": string, "technical": string } ] }.',
  "",
  'Write "What\'s active now & next" — the native\'s CURRENT sky + near timing,',
  "grounded ENTIRELY in the ENGINE PREDICTIVE CONTEXT block. Return 2–4",
  "TitledPersona entries, most salient first: (1) the running period — the",
  "mahā/antar/pratyantar lords and what they activate; (2) current transits that",
  "matter — planets by house from Lagna and/or Moon, flag Sade Sati phase if",
  "active; (3) the next dated windows — cite the engine's month-precision windows",
  "per life area (career/relationships/health/…): what opens or intensifies and",
  'roughly when. Each entry: title = a plain, specific label; content.layman =',
  'jargon-free "what this means for you and when"; content.technical = the',
  "placement/period named precisely. If the ENGINE PREDICTIVE CONTEXT block is",
  "ABSENT, return an EMPTY array (never invent timing).",
].join("\n");

const SECTION_TASKS: Record<InterpretationSectionKey, string> = {
  core: CORE_TASK,
  yoga: YOGA_TASK,
  guidance1: GUIDANCE1_TASK,
  guidance2: GUIDANCE2_TASK,
  remedial: REMEDIAL_TASK,
  upcoming_periods: UPCOMING_PERIODS_TASK,
  current_sky: CURRENT_SKY_TASK,
};

// =============================================================================
// LITE per-section tasks — SAME JSON keys/schema as the full tasks, but SHORT,
// plain, concrete asks (no dispositor-chain / karaka-chain / strength-ordering
// mandates). Used for small local models so they reliably fill every field.
// =============================================================================

const CORE_TASK_LITE = [
  "TASK: Core Analysis — WHO this person is (their nature and personality).",
  "Fill in this EXACT JSON shape (replace the ... with real content; keep these keys):",
  '{',
  '  "summary":     { "layman": "...", "technical": "..." },',
  '  "strengths":   [ { "title": "...", "layman": "...", "technical": "..." } ],',
  '  "challenges":  [ { "title": "...", "layman": "...", "technical": "..." } ],',
  '  "life_themes": [ { "title": "...", "layman": "...", "technical": "..." } ]',
  '}',
  "  - summary: a dual-mode object — BOTH fields NON-EMPTY, REQUIRED, written FIRST. It is",
  "    the headline shown at the top of the dashboard. Do NOT collapse it into a string.",
  "      • layman: ~2 sentences in plain words — NO planet/sign/house/dasha/yoga names.",
  "      • technical: ~2 sentences naming the actual placements (a planet's sign/house/",
  "        dignity, or a listed yoga) for this same essence.",
  "  - strengths, challenges, life_themes: 2-3 items each; keep layman and technical to",
  "    1-2 short sentences. Anchor each technical field to a real placement from the chart",
  "    (a planet's sign/house/dignity, or a listed yoga). Be honest about any",
  "    debilitated/combust/retrograde planet — name the effort it asks for.",
  "  DO NOT echo the chart, the birth data, a name, or a location — write the analysis.",
].join("\n");

const YOGA_TASK_LITE = [
  "TASK: Integrated Yoga Narrative — this person's life journey (NOT personality).",
  "Fill in this EXACT JSON shape (replace the ... with real content; keep these keys):",
  '{ "integrated_yoga_narrative": { "layman": "...", "technical": "..." } }',
  "  Both fields MUST be non-empty. Keep each to ONE short paragraph (2-4 sentences).",
  "  - layman: the lived shape of the journey, in plain words, no jargon.",
  "  - technical: name 1-3 yogas FROM THE PROVIDED LIST and what they bring. If a yoga's",
  "    planet is debilitated/combust/retrograde, say its gift is earned through effort.",
  "ZERO TOLERANCE: never mention any yoga that is not in the provided list.",
].join("\n");

const GUIDANCE1_TASK_LITE = [
  "TASK: Life Guidance Part 1 — four life areas. Return JSON with EXACTLY these FOUR",
  "top-level keys, each a persona object with its own layman + technical fields. Copy",
  "this skeleton EXACTLY — do NOT collapse it into a single { layman, technical }:",
  '{',
  '  "health_guidance":       { "layman": "...", "technical": "..." },',
  '  "education_guidance":    { "layman": "...", "technical": "..." },',
  '  "career_guidance":       { "layman": "...", "technical": "..." },',
  '  "relationship_guidance": { "layman": "...", "technical": "..." }',
  '}',
  "  Every field MUST be non-empty. Keep each layman and technical to 1-2 short sentences.",
  "  - layman: warm, practical advice for THAT area, in plain words (no jargon).",
  "  - technical: cite ONE relevant placement from the data for that area (a planet's",
  "    sign/house/dignity). Houses: Health = 1st/6th, Education = 4th/5th, Career = 10th,",
  "    Relationships = 7th. Be honest about any debilitated/combust significator.",
].join("\n");

const GUIDANCE2_TASK_LITE = [
  "TASK: Life Guidance Part 2 — inner and temporal areas. Return JSON with EXACTLY these",
  "THREE top-level keys, each a persona object with its own layman + technical fields.",
  "Copy this skeleton EXACTLY — do NOT collapse it into a single { layman, technical }:",
  '{',
  '  "finances_guidance":       { "layman": "...", "technical": "..." },',
  '  "spiritual_guidance":      { "layman": "...", "technical": "..." },',
  '  "life_evolution_guidance": { "layman": "...", "technical": "..." }',
  '}',
  "  Every field MUST be non-empty. Keep each layman and technical to 1-2 short sentences.",
  "  - layman: plain, encouraging guidance for money themes, inner life, and life phases.",
  "  - technical: cite ONE relevant stable placement (Finances = 2nd/11th house lord or",
  "    a wealth planet; Spiritual = 9th/12th house or Ketu; Life Evolution = ascendant",
  "    lord, lunar nodes, or 9th/12th-house lord chain). Never mention current/next",
  "    periods, dated windows, ages, or transits.",
].join("\n");

const REMEDIAL_TASK_LITE = [
  "TASK: Remedial Measures — simple, universal, personalized to THIS chart.",
  "Fill in this EXACT JSON shape (replace the ... with real content; keep these keys):",
  '{ "remedial_measures": { "layman": "...", "technical": "..." } }',
  "  Both fields MUST be non-empty. Keep each to 1-2 short sentences.",
  "  - layman: UNIVERSAL, culture-neutral practices ONLY — meditation, breathing, walking",
  "    in nature, journaling, rest, creative expression. NO mantras, pujas, temples,",
  "    deities, gemstones, or metals here. Say honestly these help gradually, over time.",
  "  - technical: name ONE specific weak placement actually in the data (a debilitated or",
  "    combust planet, or a low-strength listed yoga) and a supportive practice for it.",
  "    Gemstones/mantras MAY appear here as optional extras only. Invent no affliction.",
].join("\n");

const UPCOMING_PERIODS_TASK_LITE = [
  "TASK: The Road Ahead — this person's upcoming dasha periods, in order.",
  "Fill in this EXACT JSON shape (replace the ... with real content; keep these keys):",
  '{ "upcoming_periods": [ { "title": "...", "layman": "...", "technical": "..." } ] }',
  "  - One item per REMAINING antardasha of the current mahadasha (the rows of the",
  "    current maha's `antar_sequence` AFTER the current antardasha), then one item for",
  "    the NEXT mahadasha. Use ONLY periods listed in the dashas data — never invent a",
  "    period or a date.",
  '  - title: the period + its engine-stated window verbatim, e.g. "Sun antardasha —',
  '    2027-01 to 2028-01".',
  "  - layman: 1-2 plain sentences on how that chapter tends to feel (no jargon).",
  "  - technical: 1-2 sentences citing that lord's own sign/house/dignity from the",
  "    chart and the dated window. Be honest about a debilitated/combust lord.",
].join("\n");

const SECTION_TASKS_LITE: Record<InterpretationSectionKey, string> = {
  core: CORE_TASK_LITE,
  yoga: YOGA_TASK_LITE,
  guidance1: GUIDANCE1_TASK_LITE,
  guidance2: GUIDANCE2_TASK_LITE,
  remedial: REMEDIAL_TASK_LITE,
  upcoming_periods: UPCOMING_PERIODS_TASK_LITE,
  current_sky: CURRENT_SKY_TASK,
};

// =============================================================================
// Report-v2 tasks (promptSet "report-v2"): the five natal sections with guidance1
// widened to Family, plus the four timeline sections that read ONLY their
// engine report-facts slice. Without a promptSet the legacy tasks above apply.
// =============================================================================

const GUIDANCE1_TASK_LINES = GUIDANCE1_TASK.split("\n");
const GUIDANCE1_TASK_LITE_LINES = GUIDANCE1_TASK_LITE.split("\n");

const GUIDANCE1_TASK_V2 = [
  "TASK: Life Guidance Part 1 — practical application across five life areas.",
  "Return JSON with FIVE persona objects, each { layman, technical }:",
  "  health_guidance, education_guidance, career_guidance, relationship_guidance, family_guidance.",
  // The blank line and the house-lord chain rule, through "Relationships = 7th."
  ...GUIDANCE1_TASK_LINES.slice(3, 9),
  "  Family = 2nd, 4th, 5th & 9th (home, lineage, children, elders).",
  "PER-AREA KARAKA CONDITION: also read the area's natural significator and report its",
  "  `dignity`, `is_combust`, `is_retrograde` — Health: Sun & Mars; Education: Mercury &",
  "  Jupiter; Career: Saturn & the Sun; Relationships: Venus & the Moon; Family: Jupiter.",
  "  If a karaka is debilitated/combust, be honest that the area asks for more effort before it flowers.",
  // DISTINCT VOCABULARY through "what makes them feel secure,"
  ...GUIDANCE1_TASK_LINES.slice(13, 17),
  "  communication in partnership. Family = belonging, home life, children, parents and elders.",
  "  Do NOT bleed one area's framing into another.",
  // DEBILITY HONESTY through the closing stable-natal line.
  ...GUIDANCE1_TASK_LINES.slice(18),
].join("\n");

const GUIDANCE1_TASK_LITE_V2 = [
  "TASK: Life Guidance Part 1 — five life areas. Return JSON with EXACTLY these FIVE",
  "top-level keys, each a persona object with its own layman + technical fields. Copy",
  "this skeleton EXACTLY — do NOT collapse it into a single { layman, technical }:",
  "{",
  '  "health_guidance":       { "layman": "...", "technical": "..." },',
  '  "education_guidance":    { "layman": "...", "technical": "..." },',
  '  "career_guidance":       { "layman": "...", "technical": "..." },',
  '  "relationship_guidance": { "layman": "...", "technical": "..." },',
  '  "family_guidance":       { "layman": "...", "technical": "..." }',
  "}",
  // "Every field MUST be non-empty" through the houses list up to Career.
  ...GUIDANCE1_TASK_LITE_LINES.slice(9, 13),
  "    Relationships = 7th, Family = 2nd/4th/5th/9th. Be honest about any debilitated/combust",
  "    significator.",
].join("\n");

const REPORT_NATAL_TASKS: Record<NatalInterpretationSectionKey, string> = {
  core: CORE_TASK,
  yoga: YOGA_TASK,
  guidance1: GUIDANCE1_TASK_V2,
  guidance2: GUIDANCE2_TASK,
  remedial: REMEDIAL_TASK,
};

const REPORT_NATAL_TASKS_LITE: Record<NatalInterpretationSectionKey, string> = {
  core: CORE_TASK_LITE,
  yoga: YOGA_TASK_LITE,
  guidance1: GUIDANCE1_TASK_LITE_V2,
  guidance2: GUIDANCE2_TASK_LITE,
  remedial: REMEDIAL_TASK_LITE,
};

const REPORT_DATES_RULE =
  "DATES: cite only months that appear in the ENGINE REPORT FACTS block, verbatim as YYYY-MM. Never write a day. A sentence with any other date is deleted before it reaches the screen.";

const CURRENT_PERIOD_TASK = [
  "TASK: Your Current Period — the chapter the person is living in NOW.",
  'Return JSON: { "maha": {layman, technical}, "antar": {layman, technical}, "activates": [ {title, layman, technical} ], "next_change": {layman, technical} }.',
  "  - maha: the running mahadasha. What its lord's OWN facts in lord_facts (sign, house, dignity, houses_ruled,",
  "    yogakaraka/combust/retrograde flags, listed yogas) make this long chapter about, and how the fusion",
  "    row (reinforcing / afflicting, severity) colors it now.",
  "  - antar: the running antardasha inside it: the sub-theme, and how its lord's facts combine with the maha lord's.",
  "  - activates: 2-3 items, one per life area this period switches on, chosen from the houses the maha and antar",
  "    lords rule or occupy (career for the 10th, partnership for the 7th, money for the 2nd and 11th, home for",
  "    the 4th, learning for the 5th, health for the 6th). title = the plain area name.",
  "  - next_change: the next change in the facts: the current antar's end_month and the antar after it in",
  "    antar_sequence, or next_maha when the maha ends first. The app draws every window; do not list the",
  "    remaining antardashas one by one.",
  "DEBILITY HONESTY: a debilitated, combust, or retrograde lord's period is a growth-through-effort chapter; name the condition.",
  REPORT_DATES_RULE,
].join("\n");

const YEAR_AHEAD_TASK = [
  "TASK: The Year Ahead — the next twelve months in four quarters.",
  'Return JSON: { "headline": {layman, technical}, "quarters": [ { "key": "Q1", "layman": string, "technical": string } ], "focus": {layman, technical} }.',
  "  - quarters: EXACTLY one entry for each quarter in the facts (Q1, Q2, Q3, Q4), in that order, key verbatim.",
  "    Never add, rename, or skip a key.",
  "  - Each quarter speaks to the events listed under it (dasha changes, transit windows, slow-planet hits,",
  "    Sade Sati) and what they ask of the person. A quarter with no events is a consolidation season: say so",
  "    plainly; never invent an event.",
  "  - headline: the shape of the whole year. focus: the one practical focus the events point to.",
  REPORT_DATES_RULE,
].join("\n");

function lifeOutlookTask(domains: readonly string[]): string {
  return [
    `TASK: This Year, by life area — ${domains.join(", ")}.`,
    'Return JSON: { "domains": [ { "domain": string, "outlook": {layman, technical}, "lean_into": string, "watch_for": string } ] }.',
    `  - EXACTLY one entry per area in the facts, in that order; "domain" is the key verbatim (${domains.join(", ")}).`,
    "    Never add another area.",
    "  - outlook: this year for that area from ITS facts only: band, key graha and whether it meets its minimum,",
    "    SAV bindus, active dasha significator (levels, lords), Sade Sati, transit severity, its windows, and its",
    "    house_lords rows. The band is the engine's convention, not a verdict.",
    "  - lean_into / watch_for: one plain sentence each, no astrology terms.",
    REPORT_DATES_RULE,
  ].join("\n");
}

const CURRENT_PERIOD_TASK_LITE = [
  "TASK: Your Current Period — the chapter the person is living in now.",
  "Fill in this EXACT JSON shape (replace the ... with real content; keep these keys):",
  '{ "maha": { "layman": "...", "technical": "..." }, "antar": { "layman": "...", "technical": "..." }, "next_change": { "layman": "...", "technical": "..." } }',
  "  Keep each layman and technical to 1-2 short sentences.",
  "  - technical: name the period lord and one of its facts (sign, house, or dignity) from the facts block.",
  "  - next_change: the next change month exactly as written in the facts (YYYY-MM).",
].join("\n");

const YEAR_AHEAD_TASK_LITE = [
  "TASK: The Year Ahead — four quarters.",
  "Fill in this EXACT JSON shape (replace the ... with real content; keep these keys):",
  '{ "headline": { "layman": "...", "technical": "..." }, "quarters": [ { "key": "Q1", "layman": "...", "technical": "..." } ] }',
  "  One quarters entry per key in the facts (Q1-Q4), key verbatim. 1-2 short sentences each.",
  "  Use only months written in the facts (YYYY-MM).",
].join("\n");

function lifeOutlookTaskLite(domains: readonly string[]): string {
  return [
    `TASK: This Year, by life area — ${domains.join(", ")}.`,
    "Fill in this EXACT JSON shape (replace the ... with real content; keep these keys):",
    '{ "domains": [ { "domain": "...", "outlook": { "layman": "...", "technical": "..." } } ] }',
    `  One entry per area (${domains.join(", ")}), domain key verbatim. 1-2 short sentences per field.`,
  ].join("\n");
}

const REPORT_TIMELINE_TASKS: Record<ReportTimelineSectionKey, string> = {
  current_period: CURRENT_PERIOD_TASK,
  year_ahead: YEAR_AHEAD_TASK,
  life_outlook_1: lifeOutlookTask(LIFE_OUTLOOK_GROUPS.life_outlook_1),
  life_outlook_2: lifeOutlookTask(LIFE_OUTLOOK_GROUPS.life_outlook_2),
};

const REPORT_TIMELINE_TASKS_LITE: Record<ReportTimelineSectionKey, string> = {
  current_period: CURRENT_PERIOD_TASK_LITE,
  year_ahead: YEAR_AHEAD_TASK_LITE,
  life_outlook_1: lifeOutlookTaskLite(LIFE_OUTLOOK_GROUPS.life_outlook_1),
  life_outlook_2: lifeOutlookTaskLite(LIFE_OUTLOOK_GROUPS.life_outlook_2),
};

const REPORT_FACTS_EXCEPTION = [
  "",
  "ENGINE REPORT FACTS — USE THEM (REQUIRED):",
  "The block below is this section's slice of the deterministic engine's timing output. It is the",
  "ONLY timing that exists. Ground every statement in it; quote months verbatim as YYYY-MM; never",
  "write a day, an age, or a month that is not in the block. Bands and severities are the engine's",
  "convention, not a verdict.",
].join("\n");

function audienceHint(mode: ViewMode): string {
  return mode === "expert"
    ? "The reader is an astrologer; make the technical fields especially rigorous."
    : "The reader is a layperson; make the layman fields especially warm and clear.";
}

function modeHint(mode: ViewMode, lite: boolean): string {
  const lengthGuidance = lite
    ? "Keep every field SHORT and concrete: ~2 sentences for the summary, 1-2 short sentences per persona field, 2-3 items per array. Never pad, never leave a field blank."
    : "Write 2-4 substantive paragraphs per persona field — depth over length; never pad.";
  return `${audienceHint(mode)} ${lengthGuidance}`;
}

/** Lite timeline schemas have no summary and no arrays, so their hint names neither. */
const TIMELINE_LITE_LENGTH =
  "Keep every field SHORT and concrete: 1-2 short sentences per persona field. Never pad, never leave a field blank.";

/**
 * Report-v2 length hint. Lite: the legacy lite hint for natal sections, a
 * timeline-shaped one for timeline sections. Full: the per-field word targets.
 */
function reportLengthHint(section: ReportSectionKey, mode: ViewMode, lite: boolean): string {
  if (lite) {
    return isReportTimelineSection(section) ? `${audienceHint(mode)} ${TIMELINE_LITE_LENGTH}` : modeHint(mode, true);
  }
  return `${audienceHint(mode)} Word targets PER VOICE (layman and technical each): ${REPORT_FIELD_TARGETS[section]}. Depth over length; never pad to reach a target.`;
}

// Stable sections always receive the natal-only fence, regardless of what a
// compatibility caller placed on the chart. Timeline sections receive the
// timing fence below (and the stronger predictive fence when available).
const STABLE_NATAL_HONESTY = [
  "",
  "STABLE NATAL ONLY: this section carries no current timeline. Ignore any timing",
  "snapshot and do not discuss current/next periods, transits, ages, or dates. Speak",
  "only to enduring natal placements and listed yoga formations.",
].join("\n");

const TIMELINE_INPUT_HONESTY = [
  "",
  "TIMELINE HONESTY: use only timing values explicitly present in the chart. Never",
  "invent an age, period, transit, or date; preserve the engine's month precision.",
].join("\n");

// Appended to BOTH system prompts ONLY when the chart carries the engine
// predictive block, and timeline prompts WITH the block REQUIRE grounding in
// the engine's own current sky + timing rather than merely permitting it.
const PREDICTIVE_CONTEXT_EXCEPTION = [
  "",
  "ENGINE PREDICTIVE CONTEXT — USE IT (REQUIRED):",
  "The block below carries THIS chart's CURRENT sky + timing, computed by the",
  "deterministic engine: the running daśā stack (mahā/antar/pratyantar) with dated",
  "windows, current Gochara (transits) by house from Lagna AND the Moon, Sade Sati",
  "phase + rough end, the daśā-lord × transit fusion, and per-life-area forecast",
  "windows. Ground EVERY forward-looking or life-area statement in these specifics:",
  "name the running daśā lords and phase; cite transits by house; state Sade Sati",
  "status when active; cite upcoming windows using the engine's MONTH precision",
  "verbatim (e.g. 2026-05). HONESTY (unchanged): month precision ONLY — never invent",
  "a day or a degree; bands/strength labels are the engine's convention, not a",
  "verdict; never fabricate a value absent from the block.",
].join("\n");

// --- Chart-JSON budget (Spec 062, LLM delta 6) ------------------------------
//
// The parallel section calls used to each carry the FULL chart pretty-printed.
// Now every section embeds COMPACT JSON, and when even the compact full chart exceeds the token
// budget below (estimateTokens guard, chars/4), the two sections whose tasks
// only read planet/dasha/yoga facts — remedial + upcoming_periods — get just
// those slices. The narrative sections (core/yoga/guidance) always keep the
// full chart: their tasks trace house-lord chains through `houses` and `lagna`.

/** Sections that may run on a slimmed chart when the full JSON is oversized. */
const SLIM_CHART_SECTIONS: ReadonlySet<InterpretationSectionKey> = new Set([
  "remedial",
  "upcoming_periods",
]);

/**
 * Estimated-token ceiling for a section's chart JSON before the slim-eligible
 * sections drop to planets + dashas + yogas. Under the ceiling nothing is
 * slimmed, so small charts lose no information.
 */
export const SECTION_CHART_TOKEN_BUDGET = 4096;

/** The chart JSON one section embeds: compact always; slimmed when oversized. */
function chartJsonForSection(
  section: InterpretationSectionKey,
  chart: Omit<SanitizedChart, "predictive" | "as_of">,
): string {
  const full = JSON.stringify(chart);
  if (!SLIM_CHART_SECTIONS.has(section) || estimateTokens(full) <= SECTION_CHART_TOKEN_BUDGET) {
    return full;
  }
  const slim = {
    planets: chart.planets,
    yogas: chart.yogas,
    ...(chart.dashas ? { dashas: chart.dashas } : {}),
  };
  return JSON.stringify(slim);
}

/**
 * Build the system+user chat messages for one section from a SANITIZED chart.
 *
 * `lite` selects the lighter prompt variant for small LOCAL models (callers pass
 * `isLocalEndpoint(config.baseUrl)`); it defaults to the full cloud-grade prompt.
 * Either way the user message embeds the same `SECTION:<key>` marker and the
 * system+user roles — only the INSTRUCTION TEXT changes — and
 * `chatCompletionJson` still requests `response_format: json_object`.
 *
 * `promptSet` "report-v2" selects the report prompts for the five natal
 * sections (stated word targets, Family in guidance1, no as-of date). The four
 * report timeline sections always use the report prompts and see only their
 * engine report-facts slice. Without a `promptSet` the natal and legacy
 * timeline prompts are unchanged.
 */
export function buildSectionMessages(
  section: InterpretationSectionKey | ReportTimelineSectionKey,
  chart: SanitizedChart,
  mode: ViewMode,
  lite = false,
  language: PromptLanguage = "en",
  promptSet?: ReportPromptSet,
): ChatMessage[] {
  if (isReportTimelineSection(section)) return buildReportTimelineMessages(section, chart, mode, lite, language);
  if (promptSet === REPORT_PROMPT_SET && isNatalSection(section)) {
    return buildReportNatalMessages(section, chart, mode, lite, language);
  }
  const timelineSection = section === "upcoming_periods" || section === "current_sky";
  // Timing is a hard section boundary, not merely a prompt instruction. Stable
  // natal sections never receive dasha or predictive fields, even through the
  // legacy combined API or a direct compatibility call.
  const { predictive, ...chartWithoutPredictive } = chart;
  const chartForJson = timelineSection
    ? chartWithoutPredictive
    : (({ dashas: _dashas, ...natalChart }) => natalChart)(chartWithoutPredictive);
  const chartJson = chartJsonForSection(section, chartForJson);
  const predictiveBlock = timelineSection ? buildPredictiveFactsBlock(predictive) : "";
  const reference = predictiveBlock === "" ? chartJson : `${chartJson}\n${predictiveBlock}`;
  const userContent = lite
    ? liteUser(section, reference, SECTION_TASKS_LITE[section], modeHint(mode, true))
    : fullUser(section, reference, SECTION_TASKS[section], modeHint(mode, false));
  const basePrompt = lite ? SYSTEM_PROMPT_LITE : SYSTEM_PROMPT;
  const exception = timelineSection
    ? predictiveBlock === ""
      ? TIMELINE_INPUT_HONESTY
      : PREDICTIVE_CONTEXT_EXCEPTION
    : STABLE_NATAL_HONESTY;

  return [
    { role: "system", content: withLanguage(basePrompt + exception, language) },
    { role: "user", content: userContent },
  ];
}

function isNatalSection(section: InterpretationSectionKey): section is NatalInterpretationSectionKey {
  return (NATAL_SECTIONS as readonly string[]).includes(section);
}

function buildReportNatalMessages(
  section: NatalInterpretationSectionKey,
  chart: SanitizedChart,
  mode: ViewMode,
  lite: boolean,
  language: PromptLanguage,
): ChatMessage[] {
  // Natal report prompts carry no timing at all: no dashas, no predictive, and
  // no as-of date (the only day-precision value the sanitized chart has).
  const { predictive: _predictive, dashas: _dashas, as_of: _asOf, ...natal } = chart;
  const chartJson = chartJsonForSection(section, natal);
  const task = (lite ? REPORT_NATAL_TASKS_LITE : REPORT_NATAL_TASKS)[section];
  const hint = reportLengthHint(section, mode, lite);
  const base = lite ? systemPromptLite(REPORT_TIMELINE_NAMES) : systemPrompt(REPORT_TIMELINE_NAMES);
  return [
    { role: "system", content: withLanguage(base + STABLE_NATAL_HONESTY, language) },
    {
      role: "user",
      content: lite ? liteUser(section, chartJson, task, hint) : fullUser(section, chartJson, task, hint),
    },
  ];
}

function buildReportTimelineMessages(
  section: ReportTimelineSectionKey,
  chart: SanitizedChart,
  mode: ViewMode,
  lite: boolean,
  language: PromptLanguage,
): ChatMessage[] {
  const facts = buildReportFactsBlock(reportSlice(section, chart));
  const task = (lite ? REPORT_TIMELINE_TASKS_LITE : REPORT_TIMELINE_TASKS)[section];
  const hint = reportLengthHint(section, mode, lite);
  const base = lite ? systemPromptLite(REPORT_TIMELINE_NAMES) : systemPrompt(REPORT_TIMELINE_NAMES);
  return [
    { role: "system", content: withLanguage(base + REPORT_FACTS_EXCEPTION, language) },
    {
      role: "user",
      content: lite
        ? liteUser(section, facts, task, hint, FACTS_LEAD_LITE)
        : fullUser(section, facts, task, hint, FACTS_LEAD),
    },
  ];
}

/** The legacy lead-in before the chart JSON in the full user message. */
const CHART_LEAD: readonly string[] = [
  "Chart Data (sanitized; no identifying information). The 'yogas' field is the",
  "EXHAUSTIVE list of yogas in this chart — discuss no others. Fields that are",
  "null or absent are simply UNKNOWN — omit them silently, never guess a value:",
];

/** The lead-in before a timeline report section's facts block (no chart JSON). */
const FACTS_LEAD: readonly string[] = ["Engine facts for this section (sanitized; month precision):"];

/** Full cloud-grade user message: task, hint, then the reference (task leads, as ported). */
function fullUser(
  section: InterpretationSectionKey | ReportTimelineSectionKey,
  reference: string,
  task: string,
  hint: string,
  lead: readonly string[] = CHART_LEAD,
): string {
  return [
    // A stable marker so tests (and logs) can identify the section; harmless to the model.
    `SECTION:${section}`,
    "",
    task,
    "",
    hint,
    "",
    ...lead,
    reference,
  ].join("\n");
}

/** The legacy lite lead-in, ending in the label right above the chart JSON. */
const CHART_LEAD_LITE: readonly string[] = [
  "Below is this person's sanitized chart (no identifying info). It is REFERENCE",
  "ONLY — read it, do NOT copy it back. The 'yogas' field is the EXHAUSTIVE list of",
  "yogas; discuss no others. Null/absent fields are simply UNKNOWN — never guess them.",
  "",
  "CHART (reference):",
];

/** The lite lead-in before a timeline report section's facts block. */
const FACTS_LEAD_LITE: readonly string[] = [
  "Below are the engine facts for this section (sanitized; month precision). They are",
  "REFERENCE ONLY — read them, do NOT copy them back.",
  "",
  "FACTS (reference):",
];

/**
 * LITE user message for small local models. The reference is given FIRST as
 * read-only, then the task + literal JSON skeleton come LAST so the schema is the
 * final thing the model sees (recency bias dramatically improves schema-adherence
 * on 3-4B models, which otherwise collapse to `{}` or echo the chart). Still
 * carries the `SECTION:<key>` marker.
 */
function liteUser(
  section: InterpretationSectionKey | ReportTimelineSectionKey,
  reference: string,
  task: string,
  hint: string,
  lead: readonly string[] = CHART_LEAD_LITE,
): string {
  return [
    `SECTION:${section}`,
    "",
    ...lead,
    reference,
    "",
    "------------------------------------------------------------------",
    task,
    "",
    hint,
    "",
    "Now output ONLY the filled-in JSON object described above — nothing else. Do not",
    "repeat the chart, the birth data, any name, or any place. Every requested field",
    "must contain real, specific content (never blank, null, or a placeholder).",
  ].join("\n");
}

// =============================================================================
// Per-section parse helpers (each returns the slice it owns, with safe defaults)
// =============================================================================

interface CoreSlice {
  readonly summary: Persona;
  readonly strengths: TitledPersona[];
  readonly challenges: TitledPersona[];
  readonly life_themes: TitledPersona[];
}

function parseCore(json: unknown): CoreSlice {
  const rec = asRecord(json);
  return {
    summary: asPersona(rec.summary),
    strengths: parseTitledPersonas(rec.strengths),
    challenges: parseTitledPersonas(rec.challenges),
    life_themes: parseTitledPersonas(rec.life_themes),
  };
}

function parseYoga(json: unknown): IntegratedYogaNarrative {
  const rec = asRecord(json);
  const persona = parsePersona(rec.integrated_yoga_narrative) ?? { layman: "", technical: "" };
  return persona;
}

interface Guidance1Slice {
  readonly health_guidance: HealthGuidance | null;
  readonly education_guidance: EducationGuidance | null;
  readonly career_guidance: CareerGuidance | null;
  readonly relationship_guidance: RelationshipGuidance | null;
  readonly family_guidance: FamilyGuidance | null;
}

function parseGuidance1(json: unknown): Guidance1Slice {
  const rec = asRecord(json);
  return {
    health_guidance: parsePersona(rec.health_guidance),
    education_guidance: parsePersona(rec.education_guidance),
    career_guidance: parsePersona(rec.career_guidance),
    relationship_guidance: parsePersona(rec.relationship_guidance),
    family_guidance: parsePersona(rec.family_guidance),
  };
}

interface Guidance2Slice {
  readonly finances_guidance: FinanceGuidance | null;
  readonly spiritual_guidance: SpiritualGuidance | null;
  readonly life_evolution_guidance: LifeEvolutionGuidance | null;
}

function parseGuidance2(json: unknown): Guidance2Slice {
  const rec = asRecord(json);
  return {
    finances_guidance: parsePersona(rec.finances_guidance),
    spiritual_guidance: parsePersona(rec.spiritual_guidance),
    life_evolution_guidance: parsePersona(rec.life_evolution_guidance),
  };
}

function parseRemedial(json: unknown): RemedialMeasures | null {
  const rec = asRecord(json);
  return parsePersona(rec.remedial_measures);
}

function parseUpcomingPeriods(json: unknown): TitledPersona[] {
  const rec = asRecord(json);
  return parseTitledPersonas(rec.upcoming_periods);
}

function parseCurrentSky(json: unknown): TitledPersona[] {
  const rec = asRecord(json);
  return parseTitledPersonas(rec.current_sky);
}

// =============================================================================
// Section results container (filled in parallel; merged at the end)
// =============================================================================

interface SectionResults {
  core: CoreSlice;
  yoga: IntegratedYogaNarrative;
  guidance1: Guidance1Slice;
  guidance2: Guidance2Slice;
  remedial: RemedialMeasures | null;
  upcoming_periods: TitledPersona[];
  current_sky: TitledPersona[];
  current_period: CurrentPeriodSection | null;
  year_ahead: YearAheadSection | null;
  life_outlook_1: LifeOutlookSection | null;
  life_outlook_2: LifeOutlookSection | null;
  /** Sentences the date guard removed across the report timeline sections. */
  dateGuardRemovals: number;
  /** The report's as-of month (`YYYY-MM`), set once the chart is sanitized. */
  asOfMonth: string;
}

function emptyResults(): SectionResults {
  return {
    core: {
      summary: { layman: "", technical: "" },
      strengths: [],
      challenges: [],
      life_themes: [],
    },
    yoga: { layman: "", technical: "" },
    guidance1: {
      health_guidance: null,
      education_guidance: null,
      career_guidance: null,
      relationship_guidance: null,
      family_guidance: null,
    },
    guidance2: {
      finances_guidance: null,
      spiritual_guidance: null,
      life_evolution_guidance: null,
    },
    remedial: null,
    upcoming_periods: [],
    current_sky: [],
    current_period: null,
    year_ahead: null,
    life_outlook_1: null,
    life_outlook_2: null,
    dateGuardRemovals: 0,
    asOfMonth: "",
  };
}

/** Run the date guard against the months the engine put in this section's input. */
function guarded<T>(results: SectionResults, parsed: T, slice: object): T {
  const { section, removals } = validateTimelineDates(parsed, monthsIn(slice));
  results.dateGuardRemovals += removals;
  return section;
}

/** Parse one section's raw JSON string into the results container in place. */
function applySection(
  results: SectionResults,
  section: AnySectionKey,
  raw: string,
  chart: SanitizedChart,
): void {
  const json: unknown = JSON.parse(raw);
  switch (section) {
    case "core":
      results.core = parseCore(json);
      return;
    case "yoga":
      results.yoga = parseYoga(json);
      return;
    case "guidance1":
      results.guidance1 = parseGuidance1(json);
      return;
    case "guidance2":
      results.guidance2 = parseGuidance2(json);
      return;
    case "remedial":
      results.remedial = parseRemedial(json);
      return;
    case "upcoming_periods":
      results.upcoming_periods = parseUpcomingPeriods(json);
      return;
    case "current_sky":
      results.current_sky = parseCurrentSky(json);
      return;
    case "current_period":
      results.current_period = guarded(results, parseCurrentPeriod(json), currentPeriodSlice(chart));
      return;
    case "year_ahead": {
      const sent = computeQuarters(reportAsOfMonth(chart)).map((q) => q.key);
      results.year_ahead = guarded(results, parseYearAhead(json, sent), yearAheadSlice(chart));
      return;
    }
    case "life_outlook_1":
    case "life_outlook_2":
      results[section] = {
        domains: guarded(results, parseLifeOutlook(json, LIFE_OUTLOOK_GROUPS[section]), lifeOutlookSlice(chart, section)),
      };
      return;
  }
}

/** Merge the populated section results into one VedicInterpretation. */
function mergeResults(results: SectionResults): VedicInterpretation {
  return {
    summary: results.core.summary,
    strengths: results.core.strengths,
    challenges: results.core.challenges,
    life_themes: results.core.life_themes,
    integrated_yoga_narrative: results.yoga,
    health_guidance: results.guidance1.health_guidance,
    education_guidance: results.guidance1.education_guidance,
    career_guidance: results.guidance1.career_guidance,
    relationship_guidance: results.guidance1.relationship_guidance,
    ...(results.guidance1.family_guidance
      ? { family_guidance: results.guidance1.family_guidance }
      : {}),
    finances_guidance: results.guidance2.finances_guidance,
    spiritual_guidance: results.guidance2.spiritual_guidance,
    life_evolution_guidance: results.guidance2.life_evolution_guidance,
    remedial_measures: results.remedial,
    upcoming_periods: results.upcoming_periods,
    // Degrades gracefully: an empty array (predictive absent, or the section
    // failed) becomes null/absent so the UI never renders an empty block.
    current_sky: results.current_sky.length > 0 ? results.current_sky : null,
  };
}

/** Build the stable natal reading without either time-sensitive section. */
function mergeNatalResults(results: SectionResults): NatalInterpretation {
  return {
    summary: results.core.summary,
    strengths: results.core.strengths,
    challenges: results.core.challenges,
    life_themes: results.core.life_themes,
    integrated_yoga_narrative: results.yoga,
    health_guidance: results.guidance1.health_guidance,
    education_guidance: results.guidance1.education_guidance,
    career_guidance: results.guidance1.career_guidance,
    relationship_guidance: results.guidance1.relationship_guidance,
    ...(results.guidance1.family_guidance
      ? { family_guidance: results.guidance1.family_guidance }
      : {}),
    finances_guidance: results.guidance2.finances_guidance,
    spiritual_guidance: results.guidance2.spiritual_guidance,
    life_evolution_guidance: results.guidance2.life_evolution_guidance,
    remedial_measures: results.remedial,
  };
}

/** Build the narrow time-sensitive payload owned by the timeline generator. */
function mergeTimelineResults(results: SectionResults): CurrentTimelineContent {
  return {
    upcoming_periods: results.upcoming_periods,
    current_sky: results.current_sky,
  };
}

// =============================================================================
// Orchestration: 7 parallel JSON calls -> stream of events -> merged complete
// =============================================================================

/** Internal per-section outcome reported back to the event loop. */
type SectionOutcome<Section extends AnySectionKey = InterpretationSectionKey> =
  | { section: Section; ok: true; raw: string }
  | { section: Section; ok: false; error: unknown };

type SectionLifecycleEvent<Section extends AnySectionKey> =
  | { type: "section_start"; section: Section }
  | { type: "section_complete"; section: Section }
  | { type: "error"; section: Section; message: string; status?: number };

/**
 * The LITE-prompt gate: a local OpenAI-compatible endpoint (Ollama et al.) means
 * a small model that needs the LITE prompt; a cloud endpoint gets the full one.
 */
export function usesLitePrompt(config: ProviderConfig): boolean {
  return isLocalEndpoint(config.baseUrl);
}

/**
 * A failure worth one more attempt: the provider dropped the generation
 * (in-band error / 5xx), rate-limited us (429), timed out (408), or the
 * connection died (a fetch TypeError, no status). A rejected key, missing
 * credits, or a bad model would fail the same way again, so those are final.
 */
function isTransientFailure(err: unknown): boolean {
  if (err instanceof LlmRequestError) {
    const status = err.status;
    return status === undefined || status === 408 || status === 429 || status >= 500;
  }
  return err instanceof TypeError;
}

/** HTTP status of a section failure, when the endpoint reported one. */
function outcomeStatus(err: unknown): number | undefined {
  return err instanceof LlmRequestError ? err.status : undefined;
}

/**
 * One section completion. With a progress listener it streams and reports the
 * decoded prose per delta (a fresh extractor per attempt, so a retry restarts
 * the count); otherwise it is the single non-streaming JSON call.
 */
function requestSection<Section extends AnySectionKey>(
  section: Section,
  messages: ChatMessage[],
  params: SectionRunParams<Section>,
): Promise<string> {
  const base = {
    config: params.config,
    messages,
    reasoningMaxTokens: reasoningBudget(section, params.promptSet),
    ...(params.signal ? { signal: params.signal } : {}),
    ...(params.fetchImpl ? { fetchImpl: params.fetchImpl } : {}),
  };
  const report = params.onSectionProgress;
  if (!report) return chatCompletionJson(base);
  const prose = createJsonProseExtractor();
  const thinking = createWordCounter();
  const snapshot = (): SectionProgressSnapshot => ({
    words: prose.words(),
    preview: prose.preview(),
    thinkingWords: thinking.words(),
  });
  return streamChatCompletionJson({
    ...base,
    ...(params.reasoningTimeoutMs === undefined ? {} : { reasoningTimeoutMs: params.reasoningTimeoutMs }),
    onDelta: (delta) => {
      prose.push(delta);
      report(section, snapshot());
    },
    onReasoning: (delta) => {
      thinking.push(delta);
      report(section, snapshot());
    },
  });
}

/** Report sections (the report-v2 natal set and every timeline section) get the smaller cap. */
function reasoningBudget(section: AnySectionKey, promptSet: ReportPromptSet | undefined): number {
  return promptSet === REPORT_PROMPT_SET || isReportTimelineSection(section)
    ? REPORT_SECTION_REASONING_MAX_TOKENS
    : SECTION_REASONING_MAX_TOKENS;
}

function runOneSection<Section extends AnySectionKey>(
  section: Section,
  chart: SanitizedChart,
  params: SectionRunParams<Section>,
): Promise<SectionOutcome<Section>> {
  const lite = usesLitePrompt(params.config);
  const messages = buildSectionMessages(
    section,
    chart,
    params.mode ?? "layman",
    lite,
    params.language ?? "en",
    params.promptSet,
  );
  const request = () => requestSection(section, messages, params);
  return request()
    .catch((err: unknown) => {
      if (params.signal?.aborted || !isTransientFailure(err)) throw err;
      return request();
    })
    .then((raw): SectionOutcome<Section> => ({ section, ok: true, raw }))
    // Keep the ORIGINAL error (not just its message) so the aggregation can
    // preserve the HTTP status/body of a representative failure — the caller
    // classifies a total failure by status, not by parsing prose.
    .catch((err: unknown): SectionOutcome<Section> => ({ section, ok: false, error: err }));
}

/** The message text a section failure contributes to the aggregate summary. */
function outcomeErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function abortError(): Error {
  const err = new Error("Structured interpretation aborted");
  err.name = "AbortError";
  return err;
}

/** Collapse the per-section failure messages (usually identical) into one line. */
function summarizeFailures(messages: readonly string[]): string {
  const unique = [...new Set(messages.map((m) => m.trim()).filter(Boolean))];
  if (unique.length === 0) {
    return "No further detail was reported by the endpoint.";
  }
  return unique.join(" / ");
}

async function* streamSections<Section extends AnySectionKey>(
  params: SectionRunParams<Section>,
  sections: readonly Section[],
): AsyncGenerator<SectionLifecycleEvent<Section>, SectionResults> {
  if (params.signal?.aborted) {
    throw abortError();
  }

  // Fail fast and CLEAN on the privacy mismatch (e.g. a cloud OpenRouter URL
  // left under the default `local_only`). Otherwise every section would throw
  // the same PrivacyViolationError, get swallowed per-section, and the run would
  // "complete" empty — a blank dashboard with no explanation.
  ensurePrivacy(params.config);

  const chart = sanitizeChartForLlm(params.chart, params.asOf ?? chartAnalysisInstant(params.chart));

  for (const section of sections) {
    yield { type: "section_start", section };
  }

  const results = emptyResults();
  results.asOfMonth = reportAsOfMonth(chart);

  // A local endpoint (Ollama) serves one request at a time; for report
  // timeline sections we run them in order so the two life-outlook calls are
  // last (owner ruling 7). Cloud runs stay fully parallel.
  const sequential = usesLitePrompt(params.config) && sections.some((s) => isReportTimelineSection(s));
  const queue = [...sections];
  const pending = new Map<Section, Promise<SectionOutcome<Section>>>();
  const launch = (): void => {
    while (queue.length > 0 && (!sequential || pending.size === 0)) {
      const next = queue.shift() as Section;
      pending.set(next, runOneSection(next, chart, params));
    }
  };
  launch();
  let applied = 0;
  const failures: string[] = [];
  let representative: LlmRequestError | undefined;

  while (pending.size > 0) {
    const outcome = await Promise.race(pending.values());
    pending.delete(outcome.section);
    // Check the abort first, so an aborted run never starts another section.
    if (params.signal?.aborted) throw abortError();
    launch();

    if (!outcome.ok) {
      if (representative === undefined && outcome.error instanceof LlmRequestError) {
        representative = outcome.error;
      }
      const message = outcomeErrorMessage(outcome.error);
      failures.push(message);
      const status = outcomeStatus(outcome.error);
      yield { type: "error", section: outcome.section, message, ...(status === undefined ? {} : { status }) };
      continue;
    }
    try {
      applySection(results, outcome.section, outcome.raw, chart);
      applied += 1;
      yield { type: "section_complete", section: outcome.section };
    } catch (error) {
      const message = outcomeErrorMessage(error);
      failures.push(message);
      yield { type: "error", section: outcome.section, message };
    }
  }

  if (applied === 0) {
    throw new LlmRequestError(
      `Interpretation failed: all ${sections.length} sections failed. ${summarizeFailures(failures)}`,
      representative ? { status: representative.status, body: representative.body } : undefined,
    );
  }

  return results;
}

/** Stream the stable natal reading without time-sensitive predictive sections. */
export async function* streamNatalInterpretation(
  params: NatalInterpretationParams,
): AsyncGenerator<NatalInterpretationEvent> {
  const results = yield* streamSections({ ...params, chart: stableNatalChart(params.chart) }, NATAL_SECTIONS);
  yield { type: "complete", interpretation: mergeNatalResults(results) };
}

/**
 * The engine chart without anything time-sensitive. Defense in depth: stable
 * natal calls never receive the reference-date-derived dasha snapshot, even if
 * a caller passes the full engine chart.
 */
export function stableNatalChart(chart: SiderealChart): SiderealChart {
  const fullChart = chart as SiderealChart & {
    transit_context?: unknown;
    varga_context_full?: unknown;
    strength_context?: unknown;
    domains_context?: unknown;
  };
  const {
    dashas: _timingSnapshot,
    transit_context: _transits,
    varga_context_full: _vargas,
    strength_context: _strength,
    domains_context: _domains,
    ...stableChart
  } = fullChart;
  return stableChart as SiderealChart;
}

/**
 * Stream only the Road Ahead and current-sky timeline sections.
 *
 * @deprecated Generation moves to streamReportTimeline (PR 3 switches the hook,
 * then removes this). CurrentTimelineContent stays as the reader type for
 * stored v1 timelines.
 */
export async function* streamCurrentTimeline(
  params: CurrentTimelineParams,
): AsyncGenerator<CurrentTimelineEvent> {
  const results = yield* streamSections(params, CURRENT_TIMELINE_SECTIONS);
  yield { type: "complete", timeline: mergeTimelineResults(results) };
}

/**
 * Compatibility API: stream all seven sections into one `VedicInterpretation`.
 * New callers that persist natal content separately from the current timeline
 * should use `streamNatalInterpretation` and `streamCurrentTimeline`.
 */
export async function* streamStructuredInterpretation(
  params: StructuredInterpretationParams,
): AsyncGenerator<InterpretationEvent> {
  const results = yield* streamSections(params, ALL_SECTIONS);

  yield { type: "complete", interpretation: mergeResults(results) };
}

function mergeReportTimeline(results: SectionResults): ReportTimelineContent {
  return {
    current_period: results.current_period,
    year_ahead: results.year_ahead,
    life_outlook: { life_outlook_1: results.life_outlook_1, life_outlook_2: results.life_outlook_2 },
  };
}

/**
 * Stream the four report-v2 timeline sections: current period, year ahead,
 * and the two life-area outlooks. Every section runs the date guard after
 * parse. Fails closed like the v1 timeline: callers send this only when the
 * predictive data is ready.
 */
export async function* streamReportTimeline(params: ReportTimelineParams): AsyncGenerator<ReportTimelineEvent> {
  const results = yield* streamSections({ ...params, promptSet: REPORT_PROMPT_SET }, REPORT_TIMELINE_SECTIONS);
  yield {
    type: "complete",
    timeline: mergeReportTimeline(results),
    asOfMonth: results.asOfMonth,
    dateGuardRemovals: results.dateGuardRemovals,
  };
}

export interface ReportMessagesInput {
  readonly chart: SiderealChart;
  readonly asOf?: AnalysisInstant;
}

export interface ReportMessagesOptions {
  readonly mode: ViewMode;
  readonly language: PromptLanguage;
  readonly lite: boolean;
}

export type ReportMessages = Readonly<Record<ReportSectionKey, readonly ChatMessage[]>>;

/**
 * The nine report-v2 message arrays, built exactly as the generators build
 * them, so the app can count input tokens (estimateReadingCost) before any
 * request is sent.
 */
export function buildReportMessages(input: ReportMessagesInput, opts: ReportMessagesOptions): ReportMessages {
  const asOf = input.asOf ?? chartAnalysisInstant(input.chart);
  const natal = sanitizeChartForLlm(stableNatalChart(input.chart), asOf);
  const timeline = sanitizeChartForLlm(input.chart, asOf);
  const n = (section: NatalInterpretationSectionKey) =>
    buildSectionMessages(section, natal, opts.mode, opts.lite, opts.language, REPORT_PROMPT_SET);
  const t = (section: ReportTimelineSectionKey) =>
    buildSectionMessages(section, timeline, opts.mode, opts.lite, opts.language, REPORT_PROMPT_SET);
  return {
    core: n("core"), yoga: n("yoga"), guidance1: n("guidance1"), guidance2: n("guidance2"), remedial: n("remedial"),
    current_period: t("current_period"), year_ahead: t("year_ahead"),
    life_outlook_1: t("life_outlook_1"), life_outlook_2: t("life_outlook_2"),
  };
}
