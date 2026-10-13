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
  PeriodReadingContext,
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

export interface ReadingPlace {
  /** The trip's place label; null for today (the viewer's own place has no label). */
  readonly label: string | null;
  readonly timezone: string;
}

export interface ReadingFrame {
  readonly period: ReadingPeriod;
  readonly place: ReadingPlace;
}

export interface ReadingSpan {
  readonly lord: string;
  readonly start: string;
  readonly end: string;
}

export interface ReadingDashas {
  readonly maha: readonly ReadingSpan[];
  readonly antar: readonly ReadingSpan[];
  readonly pratyantar: readonly ReadingSpan[];
  readonly sookshma?: ReadingSpan;
  readonly sandhi?: { readonly level: 'maha' | 'antar'; readonly date: string };
  readonly yogini_maha: (ReadingSpan & { readonly name: string }) | null;
}

export type ReadingLordLevel = PeriodDashaLevel | 'sookshma';

export interface ReadingLord {
  readonly lord: string;
  readonly level: readonly ReadingLordLevel[];
  readonly rules?: readonly number[];
  readonly natal?: { readonly house: number; readonly sign: string; readonly dignity: string; readonly combust: boolean };
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
  readonly strength: PeriodTheme['strength'];
  readonly strength_pct: number;
  readonly confidence: ThemeConfidence;
  readonly agreement: PeriodTheme['agreement'];
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
  readonly vara: string;
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
  /** What was cut to stay under 4 KB; get_period_detail returns the rest. */
  readonly trimmed?: readonly string[];
}

/** A typed reason the reading could not be computed (get_timing's PeriodSkyUnavailableError reasons, plus the reading's own). */
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

export interface ToolSummary {
  readonly line: string;
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

function spansAt(spans: readonly PeriodDashaSpan[], level: PeriodDashaLevel, period: PeriodWindow): ReadingSpan[] {
  return spans.filter((span) => span.level === level && overlaps(span, period)).map((span) => lordSpan(span, period));
}

function dashasOf(source: PeriodReadingContext, period: ReadingPeriod): ReadingDashas {
  const sookshma = period.granularity === 'day' && source.sookshma && overlaps(source.sookshma, period) ? source.sookshma : undefined;
  const sandhi = source.sandhi && within(source.sandhi.date, period.start, period.end) ? source.sandhi : undefined;
  const yogini = source.yogini && overlaps(source.yogini, period) ? source.yogini : undefined;
  return {
    maha: spansAt(source.dasha_spans, 'maha', period),
    antar: spansAt(source.dasha_spans, 'antar', period),
    pratyantar: spansAt(source.dasha_spans, 'pratyantar', period),
    ...(sookshma ? { sookshma: { lord: sookshma.lord, ...startClipped(sookshma, period) } } : {}),
    ...(sandhi ? { sandhi: { level: sandhi.level, date: day(sandhi.date) } } : {}),
    yogini_maha: yogini ? { name: yogini.name, ...lordSpan(yogini, period) } : null,
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
    natal: { house: natal.house, sign: natal.sign, dignity: natal.dignity, combust: natal.combust },
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
    strength_pct: theme.strength_pct, confidence: theme.confidence,
    agreement: { vimshottari: theme.agreement.vimshottari, yogini: theme.agreement.yogini, transit: theme.agreement.transit },
    factors: [...theme.factors],
  };
}

/** Theme windows inside the period, grouped by (date, descriptor, severity) across domains, by date. */
function windowsOf(themes: readonly PeriodTheme[], period: PeriodWindow): ReadingWindow[] {
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
    karana: panchang.karana, yoga: panchang.yoga, vara: panchang.vara,
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

const lordBrief = ({ lord, level, rules, functional }: ReadingLord): ReadingLord =>
  ({ lord, level, ...(rules ? { rules } : {}), ...(functional ? { functional } : {}) });

/**
 * Applied in order until the reading fits, cheapest loss first; each cut that
 * changed something is named in `trimmed`, and get_period_detail returns it.
 * Segments go first: they restate the dasha changes and the sky's ingresses.
 */
const TRIMS: readonly Trim[] = [
  { note: 'segment events', apply: (r) => ({ ...r, segments: r.segments.map((s) => ({ ...s, events: [] })) }) },
  { note: 'segments', apply: (r) => (r.period.granularity === 'day' ? r : { ...r, segments: [] }) },
  { note: 'windows beyond 6', apply: (r) => ({ ...r, windows: r.windows.slice(0, 6) }) },
  { note: 'pratyantar-only lord natal detail', apply: (r) => ({ ...r, lords: r.lords.map((l) => (l.level.some((v) => v === 'maha' || v === 'antar') ? l : lordBrief(l))) }) },
  { note: 'theme factors beyond 2', apply: (r) => capThemes(r, (t) => ({ ...t, factors: t.factors.slice(0, 2) })) },
  { note: 'sky spans beyond 3 per graha', apply: (r) => ({ ...r, sky: firstPerGraha(r.sky, 3) }) },
  { note: 'themes beyond the first 4', apply: (r) => ({ ...r, themes: r.themes.slice(0, 4) }) },
  { note: 'lord natal detail', apply: (r) => ({ ...r, lords: r.lords.map(lordBrief) }) },
  { note: 'windows beyond 3', apply: (r) => ({ ...r, windows: r.windows.slice(0, 3) }) },
  { note: 'sky spans beyond 2 per graha', apply: (r) => ({ ...r, sky: firstPerGraha(r.sky, 2) }) },
  { note: 'themes beyond the first 3', apply: (r) => ({ ...r, themes: r.themes.slice(0, 3) }) },
  { note: 'theme factors beyond 1', apply: (r) => capThemes(r, (t) => ({ ...t, factors: t.factors.slice(0, 1) })) },
];

function withTrimmed(reading: PeriodReading, trimmed: readonly string[]): PeriodReading {
  return trimmed.length > 0 ? { ...reading, trimmed } : reading;
}

/** The last resort: the frame, the dashas, brief lords and the themes' verdicts. Always fits. */
function minimal(reading: PeriodReading): PeriodReading {
  return {
    period: reading.period, place: reading.place,
    dashas: { maha: reading.dashas.maha, antar: reading.dashas.antar, pratyantar: reading.dashas.pratyantar.slice(0, 6), yogini_maha: reading.dashas.yogini_maha },
    lords: reading.lords.map(lordBrief), segments: [], sky: [], double_transit: reading.double_transit,
    themes: reading.themes.slice(0, 3).map((theme) => ({ ...theme, factors: [] })), windows: [],
    trimmed: ['everything but the dashas, lords and theme verdicts'],
  };
}

function fitBudget(reading: PeriodReading): PeriodReading {
  let current = reading;
  const trimmed: string[] = [];
  for (const trim of TRIMS) {
    if (jsonBytes(withTrimmed(current, trimmed)) < MAX_PERIOD_RESULT_BYTES) return withTrimmed(current, trimmed);
    const next = trim.apply(current);
    if (JSON.stringify(next) === JSON.stringify(current)) continue;
    current = next;
    trimmed.push(trim.note);
  }
  const fitted = withTrimmed(current, trimmed);
  return jsonBytes(fitted) < MAX_PERIOD_RESULT_BYTES ? fitted : minimal(reading);
}

export function buildPeriodReading(source: PeriodReadingContext, frame: ReadingFrame): PeriodReading {
  const { period } = frame;
  const dashas = dashasOf(source, period);
  const { segments, next } = segmentsOf(source, period);
  const panchang = panchangOf(source, period);
  return fitBudget({
    period: { ...frame.period },
    place: { label: frame.place.label, timezone: frame.place.timezone },
    dashas,
    lords: lordsOf(source, dashas),
    segments,
    ...(next ? { next_change: next } : {}),
    sky: source.sky.filter((span) => overlaps(span, period)).map((span) => skyOf(span, period)),
    double_transit: [...source.double_transit],
    themes: source.themes.map(themeOf),
    windows: windowsOf(source.themes, period),
    ...(panchang ? { panchang } : {}),
  });
}

// --- summaries (the collapsed row and the agent's compaction note) ---

const title = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

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
  const factors = [...new Set(result.themes.map((theme) => theme.factors[0]).filter((factor) => factor !== undefined))].slice(0, 5);
  return { line, factors };
}

// --- get_period_detail: deterministic digests ---

export const DETAIL_SECTIONS = ['lord', 'segment', 'bindus', 'panchang', 'dashas'] as const;
export type DetailSection = (typeof DETAIL_SECTIONS)[number];
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

export type PeriodDetailToolResult = PeriodDetail | PeriodReadingUnavailable | PeriodToolError;

type Digest = { readonly facts: Readonly<Record<string, unknown>>; readonly factors: readonly string[] } | PeriodToolError;

const SECTION_ERROR = `section must be one of: ${DETAIL_SECTIONS.join(', ')}`;
const GRAHA_ERROR = `key must be one of: ${GRAHAS.join(', ')}`;
const MAX_FACTORS = 8;

function isGraha(key: string | undefined): key is (typeof GRAHAS)[number] {
  return GRAHAS.some((graha) => graha === key);
}

function citing(source: PeriodReadingContext, graha: string): string[] {
  const name = title(graha);
  return [...new Set(source.themes.flatMap((theme) => theme.factors).filter((factor) => factor.includes(name)))].slice(0, MAX_FACTORS);
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

function segmentDigest(source: PeriodReadingContext, period: ReadingPeriod, key: string | undefined): Digest {
  const inPeriod = source.segments.filter((segment) => overlaps(segment, period));
  const found = inPeriod.find((segment) => key !== undefined && (day(segment.start) === key || clipped(segment, period).start === key));
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
    factors: [`tithi ${panchang.tithi_name} (${panchang.paksha})`, `nakshatra ${panchang.nakshatra}`, `yoga ${panchang.yoga}`, `karana ${panchang.karana}`, `vara ${panchang.vara}`],
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
  const known = DETAIL_SECTIONS.find((value) => value === section);
  if (!known) return { error: SECTION_ERROR };
  const result = digest(source, frame.period, known, key);
  if ('error' in result) return result;
  return fitDetail({
    period: { ...frame.period },
    place: { label: frame.place.label, timezone: frame.place.timezone },
    section: known,
    ...(key === undefined ? {} : { key }),
    facts: result.facts,
    factors: result.factors,
  });
}

function detailLine(detail: PeriodDetail): string {
  const facts = detail.facts as Record<string, unknown>;
  if (detail.section === 'lord') return `${title(String(facts.lord))} in detail · ${(facts.runs as unknown[]).length} dasha spans`;
  if (detail.section === 'bindus') return `Ashtakavarga ${facts.key === 'sav' ? 'SAV' : title(String(facts.key))} · total ${String(facts.total)}`;
  if (detail.section === 'segment') {
    const segment = facts.segment as ReadingSegment;
    return `Segment ${segment.start} – ${segment.end} · ${[segment.maha, segment.antar, segment.pratyantar].map(title).join('–')}`;
  }
  if (detail.section === 'panchang') return `Panchang ${String(facts.tithi_name)} (${String(facts.paksha)}) · ${String(facts.nakshatra)} · ${String(facts.vara)}`;
  return `Dashas · ${(facts.spans as unknown[]).length} spans`;
}

export function periodDetailSummary(result: PeriodDetailToolResult): ToolSummary {
  if ('error' in result || 'available' in result) return failureLine(result, 'Period detail');
  return { line: detailLine(result), factors: result.factors.slice(0, 5) };
}
