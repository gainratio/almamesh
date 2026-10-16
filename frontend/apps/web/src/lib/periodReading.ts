/**
 * The period reading the chat tools return (spec 2026-10-13, "The tool" and
 * "Drill-down"). Pure: it clips the engine's `period_reading` to the thread's
 * period, joins the natal lords for the running lords, selects and caps. Every
 * Vedic rule (lordships, functional nature, tags, themes) was applied by the
 * Python engine; nothing here computes astrology.
 *
 * Privacy: every output field is copied by name, never spread, so no engine
 * field the model was not meant to see (a birth instant, coordinates) can ride
 * along. Clipping keeps dasha boundaries from before the period (a first maha
 * starts at birth) out of the result.
 */
import type {
  PeriodDashaLevel,
  PeriodDashaSpan,
  PeriodLordSpan,
  PeriodNatalLord,
  PeriodPlacement,
  PeriodReadingContext,
  PeriodRelation,
  PeriodSegment,
  PeriodSkySpan,
  PeriodTheme,
  PeriodTransitLord,
  PeriodWindow,
  StrengthContext,
  ThemeConfidence,
  ThemeDirection,
  TransitSeverity,
} from '@almamesh/browser/types';
import type { ToolSummarizer, ToolSummary as AgentToolSummary } from '@almamesh/llm';
import type { ChatThreadAsOf } from '@almamesh/shared-types';

/** Each tool result's JSON stays under this many UTF-8 bytes (spec: "under 4 KB"). */
export const MAX_PERIOD_RESULT_BYTES = 4096;

export type ReadingTense = 'past' | 'present' | 'future';

export interface ReadingPeriod {
  readonly start: string;
  /** Inclusive. */
  readonly end: string;
  readonly granularity: ChatThreadAsOf['granularity'];
  readonly label: string;
  readonly tense: ReadingTense;
}

/** Today only: the user's own clock, so the model never reads the birth zone as theirs. */
export interface ReadingCurrent {
  /** e.g. "your current zone (America/Los_Angeles)". */
  readonly zone: string;
  readonly local_date: string;
  /** HH:MM in that zone. */
  readonly local_time: string;
}

export interface ReadingPlace {
  /**
   * The trip's place label. Today: the profile's current place label when one is set,
   * else absent (never null or empty: the model then says nothing about a city).
   */
  readonly label?: string;
  readonly timezone: string;
  readonly current?: ReadingCurrent;
}

export interface ReadingFrame {
  readonly period: ReadingPeriod;
  readonly place: ReadingPlace;
}

export interface ReadingSpan {
  readonly lord: string;
  readonly start: string;
  readonly end: string;
  /** A sub-lord's whole-sign house from its parent lord (antar from maha, and so on). */
  readonly from_parent?: number;
  readonly relation?: PeriodRelation;
}

export interface ReadingDashas {
  readonly maha: readonly ReadingSpan[];
  readonly antar: readonly ReadingSpan[];
  readonly pratyantar: readonly ReadingSpan[];
  readonly sookshma?: ReadingSpan;
  readonly sandhi?: { readonly level: 'maha' | 'antar'; readonly date: string };
  readonly yogini_maha: (ReadingSpan & { readonly name: string }) | null;
  readonly yogini_antar?: ReadingSpan & { readonly name: string };
}

export type ReadingLordLevel = PeriodDashaLevel | 'sookshma';

export interface ReadingLord {
  readonly lord: string;
  readonly level: readonly ReadingLordLevel[];
  readonly rules?: readonly number[];
  readonly natal?: {
    readonly house: number;
    readonly sign: string;
    readonly dignity: string;
    readonly strength?: PeriodNatalLord['strength'];
    readonly combust: boolean;
  };
  readonly functional?: PeriodNatalLord['functional'];
  readonly d9_sign?: string;
  readonly d10_sign?: string;
  readonly yogas?: readonly string[];
  readonly transit?: PeriodTransitLord;
}

export interface ReadingSegment {
  readonly start: string;
  readonly end: string;
  readonly maha: string;
  readonly antar: string;
  readonly pratyantar: string;
  readonly events: readonly string[];
}

export interface ReadingChange extends Omit<ReadingSegment, 'start' | 'end'> {
  readonly date: string;
}

export interface ReadingSky {
  readonly graha: string;
  readonly start: string;
  readonly end: string;
  readonly sign: string;
  readonly retro: boolean;
  readonly from_moon: number;
  readonly from_lagna: number;
  readonly sav: number;
  readonly bav: number | null;
  readonly tags: readonly string[];
}

export interface ReadingTheme {
  readonly domain: string;
  readonly houses: readonly number[];
  readonly direction: ThemeDirection;
  /** In words only: a bare strength_pct beside `confidence` was read as "75% confidence" (2026-10-14). */
  readonly strength: PeriodTheme['strength'];
  readonly confidence: ThemeConfidence;
  /** Cut first when the reading is over budget: `confidence` already counts the agreeing techniques. */
  readonly agreement?: PeriodTheme['agreement'];
  readonly factors: readonly string[];
}

/**
 * A dated window inside the period, once for every theme it belongs to. The
 * engine repeats one event per domain ("career.dasha.…", "family.dasha.…");
 * grouping it here keeps every window in the 4 KB a year needs.
 */
export interface ReadingWindow {
  readonly date: string;
  /** The engine descriptor without its domain prefix, e.g. "transit.jupiter.ingress.cancer". */
  readonly descriptor: string;
  readonly severity: TransitSeverity;
  readonly domains: readonly string[];
}

export interface ReadingPanchang {
  readonly tithi: number;
  readonly tithi_name: string;
  readonly paksha: string;
  readonly nakshatra: string;
  readonly karana: string;
  readonly yoga: string;
  /** The engine's vara: the UTC weekday of the reference instant, not the local day-lord. */
  readonly vara_utc: string;
}

export interface PeriodReading extends ReadingFrame {
  readonly dashas: ReadingDashas;
  readonly lords: readonly ReadingLord[];
  readonly segments: readonly ReadingSegment[];
  /** A Day only: the first change after the day. */
  readonly next_change?: ReadingChange;
  readonly sky: readonly ReadingSky[];
  readonly double_transit: readonly number[];
  readonly themes: readonly ReadingTheme[];
  /** Every theme window inside the period, by date. */
  readonly windows: readonly ReadingWindow[];
  readonly panchang?: ReadingPanchang;
  /** What was cut to stay under 4 KB; read_period with a focus returns the rest. */
  readonly trimmed?: readonly string[];
}

/** A typed reason the reading could not be computed (periodChart.ts's PeriodSkyUnavailableError reasons, plus the reading's own). */
export type PeriodReadingFailure =
  | 'engine_unavailable'
  | 'timeout'
  | 'incomplete_birth_data'
  | 'reading_unavailable'
  | 'device_limit'
  | 'birth_year';

export interface PeriodReadingUnavailable {
  readonly period?: ReadingPeriod;
  readonly place?: ReadingPlace;
  readonly available: false;
  readonly reason: PeriodReadingFailure;
  readonly notes?: readonly string[];
}

export interface PeriodToolError {
  readonly error: string;
}

export type PeriodReadingToolResult = PeriodReading | PeriodReadingUnavailable | PeriodToolError;

/** The agent loop's tool summary, with its factors always present (possibly empty). */
export interface ToolSummary extends AgentToolSummary {
  readonly factors: readonly string[];
}

// --- clipping (day strings compare lexically) ---

function day(value: string): string {
  return value.slice(0, 10);
}

/** A half-open engine span [start, end) against the inclusive period [start, end]. */
function overlaps(span: PeriodWindow, period: PeriodWindow): boolean {
  return day(span.start) <= period.end && day(span.end) > period.start;
}

function clipped(span: PeriodWindow, period: PeriodWindow): { readonly start: string; readonly end: string } {
  const start = day(span.start);
  const end = day(span.end);
  return { start: start < period.start ? period.start : start, end: end > period.end ? period.end : end };
}

function within(date: string, start: string, end: string): boolean {
  return day(date) >= start && day(date) <= end;
}

function lordSpan(span: PeriodLordSpan, period: PeriodWindow): ReadingSpan {
  return { lord: span.lord, ...clipped(span, period) };
}

/** A Day keeps a span's own end: when the span ends is the day's next change point. */
function startClipped(span: PeriodWindow, period: PeriodWindow): { readonly start: string; readonly end: string } {
  return { start: clipped(span, period).start, end: day(span.end) };
}

function placement(span: PeriodPlacement): Pick<ReadingSpan, 'from_parent' | 'relation'> {
  return typeof span.from_parent === 'number' && span.relation ? { from_parent: span.from_parent, relation: span.relation } : {};
}

function spansAt(spans: readonly PeriodDashaSpan[], level: PeriodDashaLevel, period: PeriodWindow): ReadingSpan[] {
  return spans.filter((span) => span.level === level && overlaps(span, period)).map((span) => ({ ...lordSpan(span, period), ...placement(span) }));
}

function dashasOf(source: PeriodReadingContext, period: ReadingPeriod): ReadingDashas {
  const sookshma = period.granularity === 'day' && source.sookshma && overlaps(source.sookshma, period) ? source.sookshma : undefined;
  const sandhi = source.sandhi && within(source.sandhi.date, period.start, period.end) ? source.sandhi : undefined;
  const yogini = source.yogini && overlaps(source.yogini, period) ? source.yogini : undefined;
  const yoginiAntar = source.yogini_antar && overlaps(source.yogini_antar, period) ? source.yogini_antar : undefined;
  return {
    maha: spansAt(source.dasha_spans, 'maha', period),
    antar: spansAt(source.dasha_spans, 'antar', period),
    pratyantar: spansAt(source.dasha_spans, 'pratyantar', period),
    ...(sookshma ? { sookshma: { lord: sookshma.lord, ...startClipped(sookshma, period), ...placement(sookshma) } } : {}),
    ...(sandhi ? { sandhi: { level: sandhi.level, date: day(sandhi.date) } } : {}),
    yogini_maha: yogini ? { name: yogini.name, ...lordSpan(yogini, period) } : null,
    ...(yoginiAntar ? { yogini_antar: { name: yoginiAntar.name, ...lordSpan(yoginiAntar, period) } } : {}),
  };
}

// --- the running lords ---

function runningLevels(dashas: ReadingDashas): Map<string, ReadingLordLevel[]> {
  const levels = new Map<string, ReadingLordLevel[]>();
  const add = (lord: string, level: ReadingLordLevel) => {
    const list = levels.get(lord) ?? [];
    if (!list.includes(level)) list.push(level);
    levels.set(lord, list);
  };
  for (const level of ['maha', 'antar', 'pratyantar'] as const) for (const span of dashas[level]) add(span.lord, level);
  if (dashas.sookshma) add(dashas.sookshma.lord, 'sookshma');
  return levels;
}

function natalPart(natal: PeriodNatalLord | undefined): Omit<ReadingLord, 'lord' | 'level' | 'transit'> {
  if (!natal) return {};
  return {
    rules: natal.rules,
    natal: {
      house: natal.house, sign: natal.sign, dignity: natal.dignity,
      ...(natal.strength ? { strength: natal.strength } : {}), combust: natal.combust,
    },
    functional: natal.functional,
    d9_sign: natal.d9_sign,
    d10_sign: natal.d10_sign,
    yogas: natal.yogas,
  };
}

function transitOf(transit: PeriodTransitLord | undefined): PeriodTransitLord | undefined {
  if (!transit) return undefined;
  return { sign: transit.sign, from_moon: transit.from_moon, from_lagna: transit.from_lagna, sav: transit.sav, bav: transit.bav, retro: transit.retro };
}

function lordsOf(source: PeriodReadingContext, dashas: ReadingDashas): ReadingLord[] {
  return [...runningLevels(dashas)].map(([lord, level]) => {
    const transit = transitOf(source.transit_lords[lord]);
    return { lord, level, ...natalPart(source.natal_lords?.[lord]), ...(transit ? { transit } : {}) };
  });
}

// --- segments, sky, themes ---

function segmentOf(segment: PeriodSegment, period: ReadingPeriod): ReadingSegment {
  const bounds = period.granularity === 'day' ? startClipped(segment, period) : clipped(segment, period);
  return { ...bounds, maha: segment.maha, antar: segment.antar, pratyantar: segment.pratyantar, events: [...segment.events] };
}

function segmentsOf(source: PeriodReadingContext, period: ReadingPeriod): { segments: ReadingSegment[]; next?: ReadingChange } {
  const segments = source.segments.filter((segment) => overlaps(segment, period)).map((segment) => segmentOf(segment, period));
  if (period.granularity !== 'day') return { segments };
  const next = source.segments.find((segment) => day(segment.start) > period.end);
  return next
    ? { segments, next: { date: day(next.start), maha: next.maha, antar: next.antar, pratyantar: next.pratyantar, events: [...next.events] } }
    : { segments };
}

function skyOf(span: PeriodSkySpan, period: PeriodWindow): ReadingSky {
  return {
    graha: span.graha, ...clipped(span, period), sign: span.sign, retro: span.retro,
    from_moon: span.from_moon, from_lagna: span.from_lagna, sav: span.sav, bav: span.bav, tags: [...span.tags],
  };
}

function themeOf(theme: PeriodTheme): ReadingTheme {
  return {
    domain: theme.domain, houses: [...theme.houses], direction: theme.direction, strength: theme.strength,
    confidence: theme.confidence,
    agreement: { vimshottari: theme.agreement.vimshottari, yogini: theme.agreement.yogini, transit: theme.agreement.transit },
    factors: [...theme.factors],
  };
}

/** Theme windows inside the period, grouped by (date, descriptor, severity) across domains, by date. */
export function windowsOf(themes: readonly PeriodTheme[], period: PeriodWindow): ReadingWindow[] {
  const grouped = new Map<string, { date: string; descriptor: string; severity: TransitSeverity; domains: string[] }>();
  for (const theme of themes) {
    for (const window of theme.windows.filter((item) => within(item.date, period.start, period.end))) {
      const prefix = `${theme.domain}.`;
      const descriptor = window.descriptor.startsWith(prefix) ? window.descriptor.slice(prefix.length) : window.descriptor;
      const key = JSON.stringify([day(window.date), descriptor, window.severity]);
      const entry = grouped.get(key) ?? { date: day(window.date), descriptor, severity: window.severity, domains: [] };
      if (!entry.domains.includes(theme.domain)) entry.domains.push(theme.domain);
      grouped.set(key, entry);
    }
  }
  return [...grouped.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

function panchangOf(source: PeriodReadingContext, period: ReadingPeriod): ReadingPanchang | undefined {
  const panchang = source.panchang;
  if (period.granularity !== 'day' || !panchang) return undefined;
  return {
    tithi: panchang.tithi, tithi_name: panchang.tithi_name, paksha: panchang.paksha, nakshatra: panchang.nakshatra,
    karana: panchang.karana, yoga: panchang.yoga, vara_utc: panchang.vara,
  };
}

// --- the 4 KB budget ---

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

interface Trim {
  readonly note: string;
  readonly apply: (reading: PeriodReading) => PeriodReading;
}

const capThemes = (reading: PeriodReading, edit: (theme: ReadingTheme) => ReadingTheme): PeriodReading =>
  ({ ...reading, themes: reading.themes.map(edit) });

/** The first `limit` spans of each graha, in the engine's order. */
function firstPerGraha(sky: readonly ReadingSky[], limit: number): ReadingSky[] {
  const seen = new Map<string, number>();
  return sky.filter((span) => {
    const count = (seen.get(span.graha) ?? 0) + 1;
    seen.set(span.graha, count);
    return count <= limit;
  });
}

/**
 * One span per sign: a graha's consecutive spans in the same sign (split by a station) become one,
 * retrograde when any part was. Every ingress survives; only the station dates go.
 */
function bySign(sky: readonly ReadingSky[]): ReadingSky[] {
  const merged: ReadingSky[] = [];
  for (const span of sky) {
    const last = merged.at(-1);
    if (last?.graha !== span.graha || last.sign !== span.sign) {
      merged.push(span);
      continue;
    }
    merged[merged.length - 1] = { ...last, end: span.end, retro: last.retro || span.retro, tags: [...new Set([...last.tags, ...span.tags])] };
  }
  return merged;
}

/** Whole months from the period's first month to its last, both counted. */
const monthsSpanned = ({ start, end }: PeriodWindow): number =>
  (Number(end.slice(0, 4)) - Number(start.slice(0, 4))) * 12 + Number(end.slice(5, 7)) - Number(start.slice(5, 7)) + 1;

/** A read longer than a year keeps two signs per graha: its sign changes are what it is about. */
const skyFloor = (period: PeriodWindow): number => (monthsSpanned(period) > 12 ? 2 : 1);

const lordBrief = ({ lord, level, rules, functional }: ReadingLord): ReadingLord =>
  ({ lord, level, ...(rules ? { rules } : {}), ...(functional ? { functional } : {}) });

const pratyantarOnly = (lord: ReadingLord): boolean => !lord.level.some((v) => v === 'maha' || v === 'antar');

/** A pratyantar-only lord without its D9/D10 signs and yogas: its houses, dignity and transit stay. */
const withoutVargas = (lord: ReadingLord): ReadingLord => {
  if (!pratyantarOnly(lord)) return lord;
  const { d9_sign: _d9, d10_sign: _d10, yogas: _yogas, ...rest } = lord;
  return rest;
};

/** A pratyantar span without its placement from the antar lord (spec 2026-10-15): the antar's stays. */
const unplaced = ({ from_parent: _house, relation: _relation, ...span }: ReadingSpan): ReadingSpan => span;

const withoutYoginiAntar = ({ yogini_antar: _antar, ...dashas }: ReadingDashas): ReadingDashas => dashas;

/** A theme without its per-technique agreement booleans: its confidence already counts them. */
const withoutAgreement = ({ agreement: _agreement, ...theme }: ReadingTheme): ReadingTheme => theme;

/**
 * Applied in order until the reading fits, cheapest loss first; each cut that
 * changed something is named in `trimmed`, and read_period with a focus returns it.
 * Dated change points (segment events: stations, ingresses, each with its day)
 * outrank secondary detail: they are how the model says when a period shifts.
 * Every theme's verdict and first factor outrank sky detail: a Year once lost
 * its obstacles theme while three Jupiter spans survived (2026-10-14). A
 * low-confidence theme (0-1 agreeing techniques) is the exception: it goes
 * before the sky thins further (T3 A/B, deepseek: 0/3 with it, 2/3 without).
 */
const TRIMS: readonly Trim[] = [
  { note: 'windows beyond 6', apply: (r) => ({ ...r, windows: r.windows.slice(0, 6) }) },
  { note: 'theme agreement per technique', apply: (r) => capThemes(r, withoutAgreement) },
  { note: 'pratyantar-only lord vargas and yogas', apply: (r) => ({ ...r, lords: r.lords.map(withoutVargas) }) },
  { note: 'theme factors beyond 2', apply: (r) => capThemes(r, (t) => ({ ...t, factors: t.factors.slice(0, 2) })) },
  { note: 'sky station splits (one span per sign)', apply: (r) => ({ ...r, sky: bySign(r.sky) }) },
  { note: 'sky spans beyond 3 per graha', apply: (r) => ({ ...r, sky: firstPerGraha(r.sky, 3) }) },
  { note: 'pratyantar-only lord natal detail', apply: (r) => ({ ...r, lords: r.lords.map((l) => (pratyantarOnly(l) ? lordBrief(l) : l)) }) },
  { note: 'pratyantar placements', apply: (r) => ({ ...r, dashas: { ...r.dashas, pratyantar: r.dashas.pratyantar.map(unplaced) } }) },
  { note: 'theme factors beyond 1', apply: (r) => capThemes(r, (t) => ({ ...t, factors: t.factors.slice(0, 1) })) },
  { note: 'low-confidence themes', apply: (r) => ({ ...r, themes: r.themes.filter((t) => t.confidence !== 'low') }) },
  { note: 'sky spans beyond 2 per graha', apply: (r) => ({ ...r, sky: firstPerGraha(r.sky, 2) }) },
  { note: 'segment events', apply: (r) => ({ ...r, segments: r.segments.map((s) => ({ ...s, events: [] })) }) },
  { note: 'Yogini antar', apply: (r) => ({ ...r, dashas: withoutYoginiAntar(r.dashas) }) },
  { note: 'segments', apply: (r) => (r.period.granularity === 'day' ? r : { ...r, segments: [] }) },
  { note: 'lord natal detail', apply: (r) => ({ ...r, lords: r.lords.map(lordBrief) }) },
  { note: 'windows beyond 3', apply: (r) => ({ ...r, windows: r.windows.slice(0, 3) }) },
  { note: 'sky spans beyond 1 per graha', apply: (r) => ({ ...r, sky: firstPerGraha(r.sky, skyFloor(r.period)) }) },
  { note: 'themes beyond the first 4', apply: (r) => ({ ...r, themes: r.themes.slice(0, 4) }) },
  { note: 'themes beyond the first 3', apply: (r) => ({ ...r, themes: r.themes.slice(0, 3) }) },
];

function withTrimmed(reading: PeriodReading, trimmed: readonly string[]): PeriodReading {
  return trimmed.length > 0 ? { ...reading, trimmed } : reading;
}

export const LAST_RESORT_NOTE = 'everything but the dashas, lords, theme verdicts and the sky by sign';

/** The sky a last resort keeps: two signs per graha, else one, else the first spans that fit. Never none. */
function coarseSky(sky: readonly ReadingSky[], fits: (sky: readonly ReadingSky[]) => boolean): ReadingSky[] {
  const signs = bySign(sky);
  const two = firstPerGraha(signs, 2);
  if (fits(two)) return two;
  let one = firstPerGraha(signs, 1);
  while (one.length > 1 && !fits(one)) one = one.slice(0, -1);
  return one;
}

/**
 * The last resort: the frame, the dashas, brief lords, the themes' verdicts and the sky read by
 * sign (coarser, never dropped: an 18-month read once lost its whole sky here, 2026-10-15).
 */
function minimal(reading: PeriodReading, budget: number): PeriodReading {
  const base: PeriodReading = {
    period: reading.period, place: reading.place,
    dashas: {
      maha: reading.dashas.maha, antar: reading.dashas.antar, pratyantar: reading.dashas.pratyantar.slice(0, 6),
      yogini_maha: reading.dashas.yogini_maha, ...(reading.dashas.yogini_antar ? { yogini_antar: reading.dashas.yogini_antar } : {}),
    },
    lords: reading.lords.map(lordBrief), segments: [], sky: [], double_transit: reading.double_transit,
    themes: reading.themes.slice(0, 3).map((theme) => ({ ...theme, factors: [] })), windows: [],
    trimmed: [LAST_RESORT_NOTE],
  };
  return { ...base, sky: coarseSky(reading.sky, (sky) => jsonBytes({ ...base, sky }) < budget) };
}

function fitBudget(reading: PeriodReading, budget: number): PeriodReading {
  let current = reading;
  const trimmed: string[] = [];
  for (const trim of TRIMS) {
    if (jsonBytes(withTrimmed(current, trimmed)) < budget) return withTrimmed(current, trimmed);
    const next = trim.apply(current);
    if (JSON.stringify(next) === JSON.stringify(current)) continue;
    current = next;
    trimmed.push(trim.note);
  }
  const fitted = withTrimmed(current, trimmed);
  return jsonBytes(fitted) < budget ? fitted : minimal(reading, budget);
}

export interface ReadingFitOptions {
  /** The bytes the reading may use (default {@link MAX_PERIOD_RESULT_BYTES}); a caller adding month rows or a close-up passes what is left. */
  readonly budgetBytes?: number;
  /** 'severity' (a range): the most severe windows first, at most {@link MAX_RANGE_WINDOWS}. Default: every window, by date. */
  readonly windowOrder?: 'date' | 'severity';
}

export const MAX_RANGE_WINDOWS = 6;
const SEVERITY_RANK: Readonly<Record<TransitSeverity, number>> = { challenging: 0, supportive: 1, neutral: 2 };

function bySeverity(windows: readonly ReadingWindow[]): ReadingWindow[] {
  const ranked = [...windows].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return ranked.slice(0, MAX_RANGE_WINDOWS);
}

export function buildPeriodReading(source: PeriodReadingContext, frame: ReadingFrame, options: ReadingFitOptions = {}): PeriodReading {
  const { period } = frame;
  const dashas = dashasOf(source, period);
  const { segments, next } = segmentsOf(source, period);
  const panchang = panchangOf(source, period);
  return fitBudget({
    period: { ...frame.period },
    place: { ...frame.place },
    dashas,
    lords: lordsOf(source, dashas),
    segments,
    ...(next ? { next_change: next } : {}),
    sky: source.sky.filter((span) => overlaps(span, period)).map((span) => skyOf(span, period)),
    double_transit: [...source.double_transit],
    themes: source.themes.map(themeOf),
    windows: options.windowOrder === 'severity' ? bySeverity(windowsOf(source.themes, period)) : windowsOf(source.themes, period),
    ...(panchang ? { panchang } : {}),
  }, options.budgetBytes ?? MAX_PERIOD_RESULT_BYTES);
}

// --- summaries (the next turn's facts note) ---

const title = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/**
 * Distinct factors, in order. The engine cites one fact twice when a house carries a
 * plain-language meaning ("… rules the 12th" and "… rules the 12th: losses and expenses");
 * those are one factor, shown once, as the one that says more.
 */
export function distinctFactors(factors: readonly string[]): string[] {
  const kept = new Map<string, string>();
  for (const factor of factors) {
    const fact = factor.split(': ')[0]!;
    const seen = kept.get(fact);
    if (seen === undefined || (seen === fact && factor !== fact)) kept.set(fact, factor);
  }
  return [...kept.values()];
}

/** Human words for the engine's Saturn tags; other tags stay in the payload only. */
const SATURN_TAGS: Readonly<Record<string, string>> = {
  sade_sati_phase_1: 'Sade Sati phase 1',
  sade_sati_phase_2: 'Sade Sati phase 2',
  sade_sati_phase_3: 'Sade Sati phase 3',
  kantaka_shani: 'Kantaka Shani',
  ashtama_shani: 'Ashtama Shani',
};

function failureLine(result: PeriodReadingUnavailable | PeriodToolError, what: string): ToolSummary {
  return 'error' in result
    ? { line: `${what} failed: ${result.error}`, factors: [] }
    : { line: `${what} unavailable (${result.reason})`, factors: [] };
}

function dashaLine(dashas: ReadingDashas): string {
  const chain = [dashas.maha[0], dashas.antar[0], dashas.pratyantar[0]].filter((span) => span !== undefined).map((span) => title(span.lord));
  const starts = new Set([...dashas.maha, ...dashas.antar, ...dashas.pratyantar].map((span) => span.start));
  const changes = starts.size - 1;
  return changes > 0 ? `${chain.join('–')}, ${changes} dasha change${changes === 1 ? '' : 's'}` : chain.join('–');
}

export function periodReadingSummary(result: PeriodReadingToolResult): ToolSummary {
  if ('error' in result || 'available' in result) return failureLine(result, 'Period reading');
  const tags = [...new Set(result.sky.flatMap((span) => span.tags.flatMap((tag) => SATURN_TAGS[tag] ?? [])))];
  const themes = `${result.themes.length} theme${result.themes.length === 1 ? '' : 's'}`;
  const line = [dashaLine(result.dashas), ...tags, themes].filter((part) => part.length > 0).join(' · ');
  const factors = distinctFactors(result.themes.flatMap((theme) => theme.factors.slice(0, 1))).slice(0, 5);
  return { line, factors };
}

// --- read_period's close-ups (focus): deterministic digests ---

export const DETAIL_SECTIONS = ['lord', 'segment', 'bindus', 'panchang', 'dashas'] as const;
export type DetailSection = (typeof DETAIL_SECTIONS)[number];

/** The other number a model sends for a section ("segments", "lords"): it names that section. */
const SECTION_ALIASES: Readonly<Record<string, DetailSection>> = { segments: 'segment', lords: 'lord', bindu: 'bindus', dasha: 'dashas' };

/** The section a model's `section` names, or undefined. */
export function detailSection(value: unknown): DetailSection | undefined {
  if (typeof value !== 'string') return undefined;
  return DETAIL_SECTIONS.find((section) => section === value) ?? SECTION_ALIASES[value];
}
const GRAHAS = ['sun', 'moon', 'mars', 'mercury', 'jupiter', 'venus', 'saturn', 'rahu', 'ketu'] as const;

export interface DetailSource {
  readonly reading: PeriodReadingContext;
  /** Natal ashtakavarga, for section=bindus. */
  readonly strength?: StrengthContext | null;
}

export interface PeriodDetail extends ReadingFrame {
  readonly section: DetailSection;
  readonly key?: string;
  /** The facts, by name; never a raw engine table. */
  readonly facts: Readonly<Record<string, unknown>>;
  /** Cited factor strings, each generated from an engine fact. */
  readonly factors: readonly string[];
  readonly trimmed?: readonly string[];
}

type Digest = { readonly facts: Readonly<Record<string, unknown>>; readonly factors: readonly string[] } | PeriodToolError;

const SECTION_ERROR = `section must be one of: ${DETAIL_SECTIONS.join(', ')}`;
const GRAHA_ERROR = `key must be one of: ${GRAHAS.join(', ')}`;
const MAX_FACTORS = 8;

function isGraha(key: string | undefined): key is (typeof GRAHAS)[number] {
  return GRAHAS.some((graha) => graha === key);
}

function citing(source: PeriodReadingContext, graha: string): string[] {
  const name = title(graha);
  return distinctFactors(source.themes.flatMap((theme) => theme.factors).filter((factor) => factor.includes(name))).slice(0, MAX_FACTORS);
}

function lordDigest(source: PeriodReadingContext, period: ReadingPeriod, key: string | undefined): Digest {
  if (!isGraha(key)) return { error: GRAHA_ERROR };
  const natal = source.natal_lords?.[key];
  const runs = source.dasha_spans.filter((span) => span.lord === key && overlaps(span, period))
    .map((span) => ({ level: span.level, ...clipped(span, period) }));
  const sky = source.sky.filter((span) => span.graha === key && overlaps(span, period)).map((span) => skyOf(span, period));
  const transit = transitOf(source.transit_lords[key]);
  const natalFacts = natal ? {
    rules: natal.rules, functional: natal.functional, yogas: natal.yogas, d9_sign: natal.d9_sign, d10_sign: natal.d10_sign,
    natal: { house: natal.house, sign: natal.sign, dignity: natal.dignity, combust: natal.combust, retro: natal.retro, vargottama: natal.vargottama },
  } : {};
  return { facts: { lord: key, ...natalFacts, ...(transit ? { transit } : {}), runs, sky }, factors: citing(source, key) };
}

/** A real calendar day (YYYY-MM-DD) inside the period: it names exactly one segment. */
function periodDay(key: string | undefined, period: ReadingPeriod): key is string {
  if (key === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(key) || key < period.start || key > period.end) return false;
  const parsed = new Date(`${key}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === key;
}

/** No key: every segment in the period, so the model can pick one (its windows are the factors). */
function allSegments(source: PeriodReadingContext, period: ReadingPeriod): Digest {
  const segments = source.segments.filter((segment) => overlaps(segment, period)).map((segment) => segmentOf(segment, period));
  const windows = windowsOf(source.themes, period).map((window) => `${window.date} ${window.descriptor} (${window.severity})`);
  return { facts: { segments }, factors: windows.slice(0, MAX_FACTORS) };
}

function segmentDigest(source: PeriodReadingContext, period: ReadingPeriod, key: string | undefined): Digest {
  if (key === undefined) return allSegments(source, period);
  const inPeriod = source.segments.filter((segment) => overlaps(segment, period));
  const starts = (segment: (typeof inPeriod)[number]) => key !== undefined && (day(segment.start) === key || clipped(segment, period).start === key);
  const contains = (segment: (typeof inPeriod)[number]) => periodDay(key, period) && day(segment.start) <= key && key < day(segment.end);
  const found = inPeriod.find(starts) ?? inPeriod.find(contains);
  if (!found) return { error: `key must be a segment start date (YYYY-MM-DD), one of: ${inPeriod.map((s) => clipped(s, period).start).join(', ')}` };
  const span = clipped(found, period);
  const sky = source.sky.filter((item) => overlaps(item, span)).map((item) => skyOf(item, span));
  const windows = source.themes.flatMap((theme) => theme.windows
    .filter((window) => day(window.date) >= day(found.start) && day(window.date) < day(found.end) && within(window.date, period.start, period.end))
    .map((window) => `${day(window.date)} ${window.descriptor} (${window.severity})`));
  return { facts: { segment: segmentOf(found, period), sky }, factors: windows.slice(0, MAX_FACTORS) };
}

function bindusDigest(source: PeriodReadingContext, strength: StrengthContext | null | undefined, period: ReadingPeriod, key: string | undefined): Digest {
  const ashtakavarga = strength?.ashtakavarga;
  if (!ashtakavarga) return { error: 'ashtakavarga is unavailable for this chart.' };
  if (key !== 'sav' && !isGraha(key)) return { error: `key must be sav or one of: ${GRAHAS.join(', ')}` };
  const row = key === 'sav' ? ashtakavarga.sarva : ashtakavarga.bhinna[key];
  if (!row) return { error: `no ashtakavarga row for ${key}.` };
  const factors = source.sky.filter((span) => overlaps(span, period) && (key === 'sav' || span.graha === key))
    .map((span) => `${title(span.graha)} in ${span.sign}: SAV ${span.sav}${span.bav === null ? '' : `, BAV ${span.bav}`}`);
  return { facts: { key, bindus: { ...row.bindus }, total: row.total }, factors: [...new Set(factors)].slice(0, MAX_FACTORS) };
}

function panchangDigest(source: PeriodReadingContext, period: ReadingPeriod): Digest {
  const panchang = panchangOf(source, period);
  if (period.granularity !== 'day') return { error: `panchang is computed for a single day; this period is ${period.label}.` };
  if (!panchang) return { error: 'panchang is unavailable for this day.' };
  return {
    facts: { ...panchang },
    factors: [`tithi ${panchang.tithi_name} (${panchang.paksha})`, `nakshatra ${panchang.nakshatra}`, `yoga ${panchang.yoga}`, `karana ${panchang.karana}`, `vara (UTC weekday, not the local day-lord) ${panchang.vara_utc}`],
  };
}

function dashasDigest(source: PeriodReadingContext, period: ReadingPeriod): Digest {
  const dashas = dashasOf(source, period);
  const spans = source.dasha_spans.filter((span) => overlaps(span, period)).map((span) => ({ level: span.level, lord: span.lord, ...clipped(span, period) }));
  const factors = spans.map((span) => `${title(span.lord)} ${span.level} ${span.start} – ${span.end}`);
  return {
    facts: { spans, ...(dashas.sookshma ? { sookshma: dashas.sookshma } : {}), ...(dashas.sandhi ? { sandhi: dashas.sandhi } : {}), yogini_maha: dashas.yogini_maha },
    factors: factors.slice(0, MAX_FACTORS),
  };
}

function digest(source: DetailSource, period: ReadingPeriod, section: DetailSection, key: string | undefined): Digest {
  if (section === 'lord') return lordDigest(source.reading, period, key);
  if (section === 'segment') return segmentDigest(source.reading, period, key);
  if (section === 'bindus') return bindusDigest(source.reading, source.strength, period, key);
  if (section === 'panchang') return panchangDigest(source.reading, period);
  return dashasDigest(source.reading, period);
}

/** Keep a detail under the budget: cut its longest list facts, then its factors, and say so. */
function fitDetail(detail: PeriodDetail): PeriodDetail {
  let current = detail;
  const trimmed: string[] = [];
  while (jsonBytes(current) >= MAX_PERIOD_RESULT_BYTES) {
    const lists = Object.entries(current.facts).filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1]) && entry[1].length > 1);
    const longest = lists.sort((a, b) => jsonBytes(b[1]) - jsonBytes(a[1]))[0];
    if (!longest && current.factors.length === 0) break;
    current = longest
      ? { ...current, facts: { ...current.facts, [longest[0]]: longest[1].slice(0, Math.ceil(longest[1].length / 2)) } }
      : { ...current, factors: current.factors.slice(0, Math.floor(current.factors.length / 2)) };
    trimmed.push(longest ? longest[0] : 'factors');
    current = { ...current, trimmed: [...new Set(trimmed)] };
  }
  return current;
}

export function buildPeriodDetail(source: DetailSource, frame: ReadingFrame, section: string, key?: string): PeriodDetail | PeriodToolError {
  const known = detailSection(section);
  if (!known) return { error: SECTION_ERROR };
  const result = digest(source, frame.period, known, key);
  if ('error' in result) return result;
  return fitDetail({
    period: { ...frame.period },
    place: { ...frame.place },
    section: known,
    ...(key === undefined ? {} : { key }),
    facts: result.facts,
    factors: result.factors,
  });
}

/** read_period's name; readPeriod.ts registers the tool under it (named here so the eager chat hook can key its summary). */
export const READ_PERIOD_TOOL_NAME = 'read_period';

/** A question read_period put back to the user (a place to pick, a day with no place). */
interface ReadPeriodAskLike {
  readonly status: string;
  readonly ask: string;
}

/** One read_period result as a line: the period and place, then the reading; an ask says what it asked. */
function readPeriodSummary(result: PeriodReadingToolResult | ReadPeriodAskLike): ToolSummary {
  if ('ask' in result) return { line: `Asked the user (${result.status})`, factors: [] };
  const summary = periodReadingSummary(result);
  if ('error' in result || 'available' in result) return summary;
  const frame = [result.period.label, result.place.label].filter((part): part is string => part !== undefined && part.length > 0);
  return { ...summary, line: [...frame, summary.line].join(' · ') };
}

// The chat hook hands a summarizer the persisted result (the next turn's facts note).
// A malformed one throws here and toolFactsNote falls back to its default summary.
/** The chat tools' own one-line summaries, by tool name (useChatThread's history facts note). */
export const PERIOD_TOOL_SUMMARIZERS: Readonly<Record<string, ToolSummarizer>> = {
  [READ_PERIOD_TOOL_NAME]: (result) => readPeriodSummary(result as PeriodReadingToolResult | ReadPeriodAskLike),
};
