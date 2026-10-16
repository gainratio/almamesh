import type { MoonWindow } from '@almamesh/browser';
import type { PeriodReadingContext, SiderealChart } from '@almamesh/browser/types';
import { answerSchema, fillFromReadings, GRAHAS, renderAnswer, type AnswerGrounding, type ChatAnswer } from '@almamesh/llm/answer';
import { z } from '@almamesh/llm/toolLoop';
import type { ProcessedBirthData } from '@almamesh/shared-types';
import { LocalTimeError } from '@almamesh/store';
import { describe, expect, it, vi } from 'vitest';

import type { PlaceLookup, ResolvedPlace } from '../geo/placeLookup';
import { MAX_PERIOD_RESULT_BYTES } from '../periodReading';
import { PeriodSkyTimeoutError } from '../periodSky';
import { PeriodSkyUnavailableError } from '../periodChart';
import { NO_PLACE_PICKER } from '../placePick';
import {
  createReadPeriodTool,
  isReadPeriodReading,
  MAX_RANGE_RESULT_BYTES,
  PICK_TIMEOUT_MS,
  readingCite,
  readPeriodGrounding,
  readPeriodStatusLabel,
  resolveChatPlace,
  type ReadPeriodArgs,
  type ReadPeriodInput,
  type ReadingCite,
  type ReadPeriodReading,
} from '../readPeriod';
import { DELHI_BIRTH_LEAKS, periodReadingFixture, type PeriodReadingFixture } from './periodReadingFixtures';
import { CHART } from './timingFixtures';

const BIRTH = {
  birth_datetime_utc: '1990-01-15T12:00:00Z',
  birth_datetime_local: '1990-01-15T17:30:00',
  birth_location_details: { city: 'Delhi', latitude: 28.6139, longitude: 77.209, timezone: 'Asia/Kolkata' },
} as unknown as ProcessedBirthData;
const STRENGTH = {
  sunrise_utc_iso: '1990-01-15T01:40:00Z',
  ashtakavarga: { bhinna: { saturn: { bindus: { aries: 4 }, total: 39 } }, sarva: { bindus: { aries: 28 }, total: 337 } },
  shadbala: { planets: {} },
};
/** 11:00 on Wednesday 14 October 2026 in Los Angeles (the viewer zone). */
const NOW = new Date('2026-10-14T18:00:00.000Z');
const TRIP = { label: 'Vadodara, India', timezone: 'Asia/Kolkata', latitude: 22.3072, longitude: 73.1812 };
const HOME = { label: 'Novato, California', timezone: 'America/Los_Angeles' };
const PUNE: ResolvedPlace = { summary: { place_ref: 'city:7', label: 'Pune, India', timezone: 'Asia/Kolkata' }, latitude: 18.5204, longitude: 73.8567 };
const SPRINGFIELD_IL: ResolvedPlace = { summary: { place_ref: 'city:8', label: 'Springfield, Illinois', timezone: 'America/Chicago' }, latitude: 39.7817, longitude: -89.6501 };
const SPRINGFIELD_MA: ResolvedPlace = { summary: { place_ref: 'city:9', label: 'Springfield, Massachusetts', timezone: 'America/New_York' }, latitude: 42.1015, longitude: -72.5898 };
const MARK = { sign: 'taurus', nakshatra: 'Rohini', tithi: 3, paksha: 'shukla' } as const;
/** placeEgress.test.ts's patterns, plus Pune's and the trip's coordinates. */
const COORDINATE_LIKE = [/28\.6/, /77\.2/, /18\.52/, /73\.85/, /22\.30/, /73\.18/, /"latitude"/, /"longitude"/, /"lat"/, /"lon"/, /birth_location/, /location_name/];

const chartWith = (source: PeriodReadingContext) =>
  ({ ...CHART, period_reading: source, strength_context: STRENGTH }) as unknown as SiderealChart;
const withReading = (name: PeriodReadingFixture) => chartWith(periodReadingFixture(name));

function lookupOf(text: string): Promise<PlaceLookup> {
  if (/^pune/i.test(text)) return Promise.resolve({ status: 'found', place: PUNE });
  if (/^springfield/i.test(text)) return Promise.resolve({ status: 'ambiguous', candidates: [SPRINGFIELD_IL, SPRINGFIELD_MA] });
  return Promise.resolve({ status: 'not_found' });
}

function setup(overrides: Partial<ReadPeriodInput> = {}) {
  const loadPeriodChart = vi.fn(async () => withReading('delhi-2019-year'));
  const loadCurrentChart = vi.fn(async () => withReading('delhi-2019-09-15-day'));
  const loadMoonWindow = vi.fn(async (): Promise<MoonWindow> => ({ at_place: { at_start: MARK, at_end: MARK }, event: { lagna_sign: 'leo', moon: MARK } }));
  const lookup = vi.fn(lookupOf);
  const pick = vi.fn(async (): Promise<ResolvedPlace | undefined | typeof NO_PLACE_PICKER> => SPRINGFIELD_IL);
  const input: ReadPeriodInput = {
    birth: BIRTH, chart: CHART, language: 'en', viewerZone: () => 'America/Los_Angeles',
    threadPlace: TRIP, homePlace: HOME, loadPeriodChart, loadCurrentChart, loadMoonWindow, lookup, pick, ...overrides,
  };
  return { tool: createReadPeriodTool(input), loadPeriodChart, loadCurrentChart, loadMoonWindow, lookup, pick };
}

const context = (signal = new AbortController().signal) => ({ now: NOW, signal });
const args = (partial: Partial<ReadPeriodArgs> & { start: string }): ReadPeriodArgs =>
  ({ end: null, place: null, time: null, focus: null, ...partial });
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

type Grounding = AnswerGrounding['readings'][number];

/** The answer a model writes by copying a reading's cite and nothing else (the lords from each line's name). */
function answerFromCite(cite: ReadingCite, grounding: Grounding) {
  const lordOf = (line: string | undefined) => (line?.split(',')[0] ?? '').toLowerCase() as (typeof GRAHAS)[number];
  const line = (text: string | undefined) => ({ lord: lordOf(text), rules: [...(grounding.rules[lordOf(text)] ?? [])], note: 'This chapter sets the tone.' });
  const lords = [...cite.maha, ...cite.antar].map(lordOf);
  const themes = Object.entries(cite.themes).map(([area, fact]) => ({ area, ...fact, text: 'As the reading says.', obstacle: 'What the reading names.' }));
  return {
    kind: 'period' as const, markdown: null, period: cite.period, place: cite.place, advice: null,
    opening: `This span runs under ${lords.join(', ')}.`,
    dashas: { maha: line(cite.maha[0]), antar: line(cite.antar[0]), pratyantar: cite.pratyantar[0] ? line(cite.pratyantar[0]) : null },
    moon: cite.moon.map(({ tag, says }) => ({ tag, meaning: says })),
    themes: themes.length > 0 ? themes : [{ area: 'Overall', direction: 'mixed' as const, confidence: 'low' as const, text: 'x', obstacle: null }],
    windows: cite.windows.map(({ date, what }) => ({ date, what })),
  };
}

function checkIssues(answer: unknown, grounding: Grounding): string[] {
  const parsed = answerSchema(() => ({ readings: [grounding] })).safeParse(answer);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
}

async function read(partial: Partial<ReadPeriodArgs> & { start: string }, overrides: Partial<ReadPeriodInput> = {}) {
  const harness = setup(overrides);
  const result = await harness.tool.execute(harness.tool.input.parse(args(partial)), context());
  return { ...harness, result };
}

function schemaMessage(value: object): string {
  const parsed = setup().tool.input.safeParse(value);
  if (parsed.success) throw new Error(`expected ${JSON.stringify(value)} to be refused`);
  return z.prettifyError(parsed.error);
}

describe('read_period: the tool', () => {
  it('is read_period, waits up to 150 s and says what it reads', () => {
    const { tool } = setup();
    expect(tool.name).toBe('read_period');
    expect(tool.timeoutMs).toBe(150_000);
    expect(tool.statusLabel).toBe('Reading the period…');
    expect(readPeriodStatusLabel(args({ start: '2019-06', end: '2019-12' }), 'en')).toBe('Reading Jun – Dec 2019…');
    expect(readPeriodStatusLabel(args({ start: '2019-03-12' }), 'en')).toBe('Reading March 12, 2019…');
  });

  it('sends a strict schema: every key required, no extra keys', () => {
    const schema = z.toJSONSchema(setup().tool.input) as { required: string[]; additionalProperties: boolean };
    expect([...schema.required].sort()).toEqual(['end', 'focus', 'place', 'start', 'time']);
    expect(schema.additionalProperties).toBe(false);
  });

  it('every example in the description is a valid call, written with its null keys', () => {
    const { tool } = setup();
    const examples = [...tool.description.matchAll(/-> (\{[^}]*\})/g)].map((match) => JSON.parse(match[1] as string) as Record<string, unknown>);
    expect(examples).toHaveLength(5);
    for (const example of examples) {
      expect(Object.keys(example).sort()).toEqual(['end', 'focus', 'place', 'start', 'time']);
      expect(tool.input.safeParse(example).success).toBe(true);
    }
    expect(tool.description).toContain('"the rest of 2019", asked in a May 2019 trip -> {"start":"2019-06","end":"2019-12"');
    expect(tool.description).toContain('"How was Saturn for me in 2019?" -> {"start":"2019",');
  });
});

describe('read_period: the description points at the cite', () => {
  it('says in one short line that the cite lists the facts the answer must state', () => {
    expect(setup().tool.description).toContain('The result\'s "cite" lists the facts your answer must state; copy them.');
  });
});

describe('read_period: the argument rules come back as the fix', () => {
  it.each([
    [{ start: '2019-13' }, 'start must be YYYY, YYYY-MM or YYYY-MM-DD'],
    [{ start: '2019', time: '3pm' }, 'time must be HH:MM (24-hour)'],
    [{ start: '2019-06', end: '2021-11' }, 'start to end is 30 months; read at most 24 months, or ask which part matters most.'],
    [{ start: '2019-12', end: '2019-06' }, 'end (2019-06) is before start (2019-12); send the earlier date as start.'],
    [{ start: '2019-06', focus: 'panchang' }, 'focus panchang needs a single day: send start as YYYY-MM-DD with end null, or another focus.'],
    [{ start: '2019-02-30' }, '2019-02-30 is not a calendar day.'],
    [{ start: '2053-01' }, 'The sky is computed through 2052; ask about a period that ends by 2052-12-31.'],
  ])('%j', (partial, message) => {
    expect(schemaMessage(args(partial as { start: string }))).toContain(message);
  });

  it('refuses an unknown key', () => {
    expect(setup().tool.input.safeParse({ ...args({ start: '2019' }), month: '2019-05' }).success).toBe(false);
  });

  // dashboard.agentic.real 2026-10-15 (Sept 2017): a model sent `"end": 2017`, a bare year as a
  // JSON number. A whole year number is that year; any other number is still refused.
  it('reads a bare four-digit year number as that year', () => {
    const parsed = setup().tool.input.parse({ ...args({ start: '2017' }), start: 2017, end: 2018 });
    expect(parsed).toMatchObject({ start: '2017', end: '2018' });
  });

  it.each([17, 2017.5, -2017, 20170, Number.NaN])('refuses the number %s as a date', (value) => {
    expect(setup().tool.input.safeParse({ ...args({ start: '2017' }), end: value }).success).toBe(false);
  });

  it('still tells the model the dates are strings', () => {
    const { properties } = z.toJSONSchema(setup().tool.input, { target: 'draft-7', unrepresentable: 'any' }) as { properties: Record<string, unknown> };
    expect(properties.start).toMatchObject({ type: 'string' });
    expect(properties.end).toMatchObject({ anyOf: [{ type: 'string' }, { type: 'null' }] });
  });

  it('24 months is one valid call', () => {
    expect(setup().tool.input.safeParse(args({ start: '2019-01', end: '2020-12' })).success).toBe(true);
  });
});

describe('read_period: spans', () => {
  it('a year reads 1 January to 31 December in one engine load', async () => {
    const { result, loadPeriodChart } = await read({ start: '2019' });
    expect(loadPeriodChart).toHaveBeenCalledTimes(1);
    expect(loadPeriodChart).toHaveBeenCalledWith({ start: '2019-01-01', end: '2019-12-31' }, expect.anything());
    expect((result as ReadPeriodReading).period).toEqual({ start: '2019-01-01', end: '2019-12-31', granularity: 'year', label: '2019', tense: 'past' });
  });

  it('a month range expands to its calendar bounds and is still one load', async () => {
    const { result, loadPeriodChart } = await read({ start: '2019-06', end: '2019-12' });
    expect(loadPeriodChart).toHaveBeenCalledTimes(1);
    expect(loadPeriodChart).toHaveBeenCalledWith({ start: '2019-06-01', end: '2019-12-31' }, expect.anything());
    expect((result as ReadPeriodReading).period).toMatchObject({ start: '2019-06-01', end: '2019-12-31', label: 'Jun – Dec 2019', tense: 'past' });
  });

  it('24 months is one load over the whole span', async () => {
    const { loadPeriodChart } = await read({ start: '2019-01', end: '2020-12' });
    expect(loadPeriodChart).toHaveBeenCalledTimes(1);
    expect(loadPeriodChart).toHaveBeenCalledWith({ start: '2019-01-01', end: '2020-12-31' }, expect.anything());
  });

  // Contract reversed 2026-10-14 (Task 5 fix round): the ask used to name the birth year. No tool result
  // carries any part of the birth date, so it says only that the period is before the chart begins.
  it('a period before birth is a normal result asking for a later one, naming no birth year', async () => {
    const { result, loadPeriodChart } = await read({ start: '1985', end: '1986' });
    expect(result).toEqual({ status: 'outside_range', ask: 'This is before the chart begins; ask about a later period.' });
    expect(JSON.stringify(result)).not.toContain('1990');
    expect(loadPeriodChart).not.toHaveBeenCalled();
  });

  it('keeps the acceptance paths: period, place, dashas maha/antar lords, sky tags', async () => {
    const result = (await read({ start: '2019-06', end: '2019-12' })).result as ReadPeriodReading;
    expect(result.place).toEqual({ label: 'Vadodara, India', timezone: 'Asia/Kolkata' });
    expect(result.dashas.maha.map((span) => span.lord)).toEqual(['rahu']);
    expect(result.dashas.antar.map((span) => span.lord)).toEqual(['rahu']);
    expect(result.sky.some((span) => span.tags.length > 0)).toBe(true);
  });

  it('a range longer than a month carries one row per month', async () => {
    const result = (await read({ start: '2019-06', end: '2019-12' })).result as ReadPeriodReading;
    expect(result.months?.map((row) => row.month)).toEqual(['2019-06', '2019-07', '2019-08', '2019-09', '2019-10', '2019-11', '2019-12']);
    const row = (month: string) => result.months?.find((item) => item.month === month);
    // Compact: the dashas only where they change (the first row always), a theme and a count only when a window falls that month.
    expect(row('2019-06')).toEqual({ month: '2019-06', maha: 'rahu', antar: 'rahu' });
    expect(row('2019-07')).toEqual({ month: '2019-07' });
    expect(row('2019-11')).toEqual({ month: '2019-11', top_theme: { domain: 'education', direction: 'mixed', confidence: 'high' }, window_count: 1 });
  });

  it('a month row names the dashas again when they change', async () => {
    const source = periodReadingFixture('delhi-2019-year');
    const split = source.dasha_spans.flatMap((span) => (span.level === 'antar'
      ? [{ ...span, end: '2019-09-01T00:00:00Z' }, { ...span, lord: 'jupiter', start: '2019-09-01T00:00:00Z' }]
      : [span]));
    const loadPeriodChart = vi.fn(async () => chartWith({ ...source, dasha_spans: split }));
    const result = (await read({ start: '2019-06', end: '2019-12' }, { loadPeriodChart })).result as ReadPeriodReading;
    expect(result.months?.find((item) => item.month === '2019-08')).toEqual({ month: '2019-08' });
    expect(result.months?.find((item) => item.month === '2019-09')).toEqual({ month: '2019-09', antar: 'jupiter' });
  });

  it('a single month has no month rows', async () => {
    const result = (await read({ start: '2019-05' }, { loadPeriodChart: vi.fn(async () => withReading('delhi-2019-05')) })).result as ReadPeriodReading;
    expect(result.period.granularity).toBe('month');
    expect(result).not.toHaveProperty('months');
  });

  it('a range lists its windows most severe first, at most 6', async () => {
    const source = periodReadingFixture('delhi-2019-year');
    const severities = ['neutral', 'supportive', 'challenging'] as const;
    const themes = source.themes.map((theme, t) => ({
      ...theme,
      windows: theme.windows.map((window, w) => ({ ...window, descriptor: `${theme.domain}.event.${t}.${w}`, severity: severities[(t + w) % 3] as (typeof severities)[number] })),
    }));
    const loadPeriodChart = vi.fn(async () => chartWith({ ...source, themes }));
    const result = (await read({ start: '2019-01', end: '2019-12' }, { loadPeriodChart })).result as ReadPeriodReading;
    expect(result.windows.length).toBeLessThanOrEqual(6);
    expect(result.windows.map((window) => window.severity)).toEqual(Array(result.windows.length).fill('challenging'));
  });

  it.each([
    [{ start: '2019' }],
    [{ start: '2019-06', end: '2019-12', focus: 'saturn' as const }],
    [{ start: '2019-01', end: '2020-12' }],
  ])('month rows never cost the reading its sky tags and windows: %j', async (partial) => {
    const result = (await read(partial)).result as ReadPeriodReading;
    expect(result.sky.flatMap((span) => span.tags).length).toBeGreaterThan(0);
    expect(result.windows.length).toBeGreaterThan(0);
    expect(result.months?.length).toBeGreaterThan(0);
  });

  // Contract reversed (fix round 1): 24 months used to drop its month rows to keep the sky. Every
  // range now carries a compact per-month summary, in a range budget of 6 KB.
  it('24 months carry all 24 month rows', async () => {
    const result = (await read({ start: '2019-01', end: '2020-12' })).result as ReadPeriodReading;
    expect(result.months).toHaveLength(24);
    expect(result.months?.[12]).toMatchObject({ month: '2020-01' });
    expect(result.trimmed ?? []).not.toContain('month rows');
  });

  it('a year with a graha focus carries its month rows and the close-up', async () => {
    const result = (await read({ start: '2019', focus: 'saturn' })).result as ReadPeriodReading;
    expect(result.months).toHaveLength(12);
    expect(result.close_up).toMatchObject({ focus: 'saturn', lord: { lord: 'saturn' } });
    expect(bytes(result)).toBeLessThan(MAX_RANGE_RESULT_BYTES);
  });

  it.each([
    [{ start: '2019-01', end: '2020-12' }],
    [{ start: '2019-01', end: '2020-12', focus: 'saturn' as const }],
    [{ start: '2019-06', end: '2019-12', focus: 'dashas' as const }],
    [{ start: '2019' }],
  ])('a range stays under the 6 KB range budget, cite included: %j', async (partial) => {
    const { result } = await read(partial);
    expect(result).toHaveProperty('months');
    expect(result).toHaveProperty('cite');
    expect(bytes(result)).toBeLessThan(MAX_RANGE_RESULT_BYTES);
  });

  it.each([
    [{ start: '2019-05' }, 'delhi-2019-05' as const],
    [{ start: '2019-09-15', place: 'Pune', time: '15:00', focus: 'saturn' as const }, 'delhi-2019-09-15-day' as const],
    [{ start: '2019-09-15', focus: 'panchang' as const }, 'delhi-2019-09-15-day' as const],
  ])('a single month or day stays under 4 KB, cite included: %j', async (partial, fixture) => {
    const { result } = await read(partial, { loadPeriodChart: vi.fn(async () => withReading(fixture)) });
    expect(result).toHaveProperty('period');
    expect(result).toHaveProperty('cite');
    expect(bytes(result)).toBeLessThan(MAX_PERIOD_RESULT_BYTES);
  });

  // Matrix 2026-10-14 (D2/H2 "And next month?", November 2026): the 4 KB cut dropped the month's
  // segment events, so the cite had no dated window and every answer for that month failed.
  it('a budget cut that drops the segment events keeps their dates in the cite and the grounding', async () => {
    const { result } = await read({ start: '2027-01' }, { loadPeriodChart: vi.fn(async () => withReading('delhi-2027-01')) });
    const reading = result as ReadPeriodReading;
    expect(reading.trimmed).toContain('segment events');
    const station = { date: '2027-01-10', what: 'Mars stations retrograde' };
    expect(reading.cite?.windows).toContainEqual(station);
    expect(readPeriodGrounding(reading, 'en').windows).toContainEqual(station);
    expect(bytes(result)).toBeLessThan(MAX_PERIOD_RESULT_BYTES);
  });

  // Journey 2 (time-travel.spec.ts, 2026-10-15): the real 18-month read lost its whole sky to the
  // 6 KB range budget, so the model had no ingress to name. A long read coarsens its sky; it never
  // drops the section.
  it('an 18-month read keeps a non-empty sky, the nodes sign change included, within the range budget', async () => {
    const { result } = await read({ start: '2027-01', end: '2028-06' }, { loadPeriodChart: vi.fn(async () => withReading('delhi-2027-01-18m')) });
    const reading = result as ReadPeriodReading;
    expect(reading.months).toHaveLength(18);
    expect(reading.sky.length).toBeGreaterThan(0);
    expect(new Set(reading.sky.filter((span) => span.graha === 'rahu').map((span) => span.sign)).size).toBeGreaterThan(1);
    expect(reading.themes.length).toBeGreaterThan(0);
    expect(bytes(result)).toBeLessThan(MAX_RANGE_RESULT_BYTES);
  });

  it('pins the two budgets: 4096 bytes for a day or month, 6144 for a range', () => {
    expect([MAX_PERIOD_RESULT_BYTES, MAX_RANGE_RESULT_BYTES]).toEqual([4096, 6144]);
  });
});

describe('read_period: places', () => {
  it('no place reads at the thread place (the trip)', async () => {
    const result = (await read({ start: '2019-06' })).result as ReadPeriodReading;
    expect(result.place).toEqual({ label: 'Vadodara, India', timezone: 'Asia/Kolkata' });
  });

  it('no place and no trip reads at home; "home" and "trip" are keywords', async () => {
    expect(((await read({ start: '2019-06' }, { threadPlace: undefined })).result as ReadPeriodReading).place).toEqual(HOME);
    expect(((await read({ start: '2019-06', place: 'home' })).result as ReadPeriodReading).place).toEqual(HOME);
    expect(((await read({ start: '2019-06', place: 'Trip' })).result as ReadPeriodReading).place).toEqual({ label: TRIP.label, timezone: TRIP.timezone });
  });

  it('a city found offline reads there, label and zone only', async () => {
    const { result, lookup } = await read({ start: '2019-06', place: 'Pune' });
    expect(lookup).toHaveBeenCalledWith('Pune');
    expect((result as ReadPeriodReading).place).toEqual({ label: 'Pune, India', timezone: 'Asia/Kolkata' });
  });

  it('several cities: the person picks one and it reads there', async () => {
    const { result, pick } = await read({ start: '2019-06', place: 'Springfield' });
    expect(pick).toHaveBeenCalledWith('Springfield', [SPRINGFIELD_IL, SPRINGFIELD_MA], expect.any(AbortSignal));
    expect((result as ReadPeriodReading).place).toEqual({ label: 'Springfield, Illinois', timezone: 'America/Chicago' });
  });

  it.each([[undefined], [NO_PLACE_PICKER]])('several cities, none picked (%s): a neutral ask with the labels', async (answer) => {
    const { result, loadPeriodChart } = await read({ start: '2019-06', place: 'Springfield' }, { pick: vi.fn(async () => answer) });
    expect(result).toEqual({
      status: 'place_not_chosen',
      candidates: ['Springfield, Illinois', 'Springfield, Massachusetts'],
      ask: 'Ask the user which one they meant.',
    });
    expect(loadPeriodChart).not.toHaveBeenCalled();
  });

  it('several cities, never picked: after 60 s a neutral ask, not a tool timeout', async () => {
    vi.useFakeTimers();
    try {
      const pick = vi.fn((_query: string, _candidates: readonly ResolvedPlace[], signal: AbortSignal) =>
        new Promise<ResolvedPlace | undefined>((resolve) => signal.addEventListener('abort', () => resolve(undefined), { once: true })));
      const { tool, loadPeriodChart } = setup({ pick });
      const pending = tool.execute(args({ start: '2019-06', place: 'Springfield' }), context());
      await vi.advanceTimersByTimeAsync(PICK_TIMEOUT_MS - 1);
      expect(pick.mock.calls[0]?.[2].aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toEqual({ status: 'place_not_chosen', candidates: ['Springfield, Illinois', 'Springfield, Massachusetts'], ask: 'Ask the user which one they meant.' });
      expect(loadPeriodChart).not.toHaveBeenCalled();
      expect(PICK_TIMEOUT_MS).toBe(60_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a picker that ignores the deadline is still answered at 60 s', async () => {
    vi.useFakeTimers();
    try {
      const { tool } = setup({ pick: vi.fn(() => new Promise<undefined>(() => undefined)) });
      const pending = tool.execute(args({ start: '2019-06', place: 'Springfield' }), context());
      await vi.advanceTimersByTimeAsync(PICK_TIMEOUT_MS);
      expect(await pending).toMatchObject({ status: 'place_not_chosen' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('no city found: ask for the nearest larger city', async () => {
    const { result } = await read({ start: '2019-06', place: 'Atlantis' });
    expect(result).toEqual({ status: 'place_not_found', ask: 'Ask for the nearest larger city.' });
  });

  it('under 7 days with no place at all: ask where the user was', async () => {
    const { result, loadPeriodChart } = await read({ start: '2019-03-12', end: '2019-03-14' }, { threadPlace: undefined, homePlace: undefined });
    expect(result).toEqual({ status: 'needs_place', ask: 'Ask where the user was that day.' });
    expect(loadPeriodChart).not.toHaveBeenCalled();
  });

  it('a week or longer with no place at all reads in the viewer zone, unlabelled', async () => {
    const result = (await read({ start: '2019-06' }, { threadPlace: undefined, homePlace: undefined })).result as ReadPeriodReading;
    expect(result.place).toEqual({ timezone: 'America/Los_Angeles' });
  });

  // CONTRACT REVERSED (matrix 2, fix wave): a time on a span longer than a day was a retry
  // ("time needs a single day…"), deepseek's only read_period retry. It is meaningless there, not
  // wrong: the read goes ahead, the time is ignored, and the result says so.
  it('a time on a span longer than a day is ignored with a note, not a retry', async () => {
    expect(setup().tool.input.safeParse(args({ start: '2019-06', time: '15:00' })).success).toBe(true);
    const { result, loadMoonWindow } = await read({ start: '2019-06', time: '15:00' });
    expect(result).toHaveProperty('cite');
    expect((result as ReadPeriodReading).notes).toContain('time ignored: the span is longer than a day');
    expect(loadMoonWindow).not.toHaveBeenCalled();
  });

  it('a single-day read with a time carries no such note', async () => {
    const { result } = await read({ start: '2019-03-12', time: '15:00', place: 'Pune' });
    expect((result as ReadPeriodReading).notes ?? []).not.toContain('time ignored: the span is longer than a day');
  });

  it('a single day at a named city adds the Moon there and the event at the time', async () => {
    const { result, loadMoonWindow } = await read({ start: '2019-03-12', time: '15:00', place: 'Pune' });
    expect(loadMoonWindow).toHaveBeenCalledWith(
      { start: '2019-03-12', end: '2019-03-12', zone: 'Asia/Kolkata', place: { latitude: PUNE.latitude, longitude: PUNE.longitude }, time: '15:00' },
      expect.anything(),
    );
    expect(result).toMatchObject({ place_moon: { at_start: MARK, at_end: MARK }, event: { local_time: '15:00', lagna_sign: 'leo', moon: MARK } });
  });

  it('a Moon read that fails leaves the reading standing, with a note', async () => {
    const { result } = await read({ start: '2019-03-12', place: 'Pune' }, { loadMoonWindow: vi.fn(async () => { throw new Error('boom'); }) });
    expect(result).toHaveProperty('dashas');
    expect(result).not.toHaveProperty('place_moon');
    expect((result as ReadPeriodReading).notes).toContain("Couldn't read the Moon at that place on this device; the rest of the answer stands.");
  });

  it('no coordinate and no birth field in any result', async () => {
    const results = await Promise.all([
      read({ start: '2019-03-12', time: '15:00', place: 'Pune' }),
      read({ start: '2019-03-12', time: '15:00' }),
      read({ start: '2019-06', end: '2019-12', place: 'Springfield', focus: 'saturn' }),
      read({ start: '2019-06', place: 'Springfield' }, { pick: vi.fn(async () => undefined) }),
      read({ start: '2026-10-14', focus: 'panchang' }),
    ]);
    const wire = results.map(({ result }) => JSON.stringify(result)).join('\n');
    // The cite rides in these results too (all but the unanswered pick), so it is checked here.
    expect(results.filter(({ result }) => 'cite' in (result as object))).toHaveLength(4);
    for (const pattern of COORDINATE_LIKE) expect(wire).not.toMatch(pattern);
    for (const leak of DELHI_BIRTH_LEAKS) expect(wire).not.toContain(leak);
  });

  it('resolveChatPlace keeps coordinates on the device side for the Moon loader only', async () => {
    const outcome = await resolveChatPlace('Pune', { threadPlace: TRIP, homePlace: HOME, lookup: lookupOf }, new AbortController().signal);
    expect(outcome).toEqual({ kind: 'place', place: { label: 'Pune, India', timezone: 'Asia/Kolkata', latitude: PUNE.latitude, longitude: PUNE.longitude } });
  });
});

describe('read_period: today, focus, repeats, failures', () => {
  it("today as a single day reads through today's chart, not the period loader", async () => {
    const { loadCurrentChart, loadPeriodChart, result } = await read({ start: '2026-10-14' });
    expect(loadCurrentChart).toHaveBeenCalledTimes(1);
    expect(loadPeriodChart).not.toHaveBeenCalled();
    expect((result as ReadPeriodReading).period).toMatchObject({ start: '2026-10-14', end: '2026-10-14', granularity: 'day', tense: 'present' });
  });

  it('focus on a graha adds its lordships, placements and ashtakavarga row', async () => {
    const result = (await read({ start: '2019', focus: 'saturn' })).result as ReadPeriodReading;
    expect(result.close_up).toMatchObject({ focus: 'saturn', lord: { lord: 'saturn', rules: expect.any(Array) }, bindus: { key: 'saturn', total: 39 } });
  });

  it('focus dashas adds every dasha span in the period', async () => {
    const result = (await read({ start: '2019', focus: 'dashas' })).result as ReadPeriodReading;
    expect(result.close_up?.focus).toBe('dashas');
    expect((result.close_up?.dashas as { spans: unknown[] }).spans).toHaveLength(7);
  });

  it('focus panchang on a single day adds the panchang', async () => {
    const result = (await read({ start: '2026-10-14', focus: 'panchang' })).result as ReadPeriodReading;
    expect(result.close_up).toMatchObject({ focus: 'panchang', panchang: { tithi_name: expect.any(String) } });
  });

  it('an identical call in the same turn returns the same result object with no second load', async () => {
    const { tool, loadPeriodChart } = setup();
    const first = await tool.execute(args({ start: '2019-06', end: '2019-12' }), context());
    const second = await tool.execute(args({ start: '2019-06', end: '2019-12' }), context());
    const other = await tool.execute(args({ start: '2019-06', end: '2019-11' }), context());
    expect(second).toBe(first);
    expect(other).not.toBe(first);
    expect(loadPeriodChart).toHaveBeenCalledTimes(2);
  });

  it('an engine timeout is a typed unavailable result with the period and place', async () => {
    const { result } = await read({ start: '2019-06' }, { loadPeriodChart: vi.fn(async () => { throw new PeriodSkyTimeoutError(); }) });
    expect(result).toMatchObject({ available: false, reason: 'timeout', period: { start: '2019-06-01' }, place: { label: 'Vadodara, India' } });
  });

  it.each([
    [new PeriodSkyUnavailableError('incomplete_birth_data'), 'incomplete_birth_data'],
    [new Error('worker died'), 'engine_unavailable'],
  ])('an engine failure %s is the typed reason %s', async (error, reason) => {
    const { result } = await read({ start: '2019-06' }, { loadPeriodChart: vi.fn(async () => { throw error; }) });
    expect(result).toMatchObject({ available: false, reason });
  });

  it('an engine with no period reading is reading_unavailable, never a synthesized reading', async () => {
    const { result } = await read({ start: '2019-06' }, { loadPeriodChart: vi.fn(async () => CHART) });
    expect(result).toMatchObject({ available: false, reason: 'reading_unavailable' });
  });

  it('the birth year has no sky: periods only, said once', async () => {
    const { result, loadPeriodChart } = await read({ start: '1990-06' });
    expect(result).toMatchObject({ available: false, reason: 'birth_year' });
    expect(loadPeriodChart).not.toHaveBeenCalled();
  });

  it('a device that cannot compute a period sky still reads today', async () => {
    const limited = { periodSkyAllowed: false };
    expect((await read({ start: '2019-06' }, limited)).result).toMatchObject({ available: false, reason: 'device_limit' });
    expect((await read({ start: '2026-10-14' }, limited)).result).toHaveProperty('dashas');
  });

  it('a time that never happened at the place is said in the notes', async () => {
    const loadMoonWindow = vi.fn(async () => { throw new LocalTimeError('nonexistent', '02:30 did not happen on 2019-03-10 in America/Chicago.'); });
    const { result } = await read({ start: '2019-03-10', time: '02:30', place: 'Springfield' }, { loadMoonWindow });
    expect((result as ReadPeriodReading).notes).toEqual(['02:30 did not happen on 2019-03-10 in America/Chicago.']);
  });

  it('isReadPeriodReading tells a reading from an ask or an unavailable result', async () => {
    expect(isReadPeriodReading((await read({ start: '2019-06' })).result)).toBe(true);
    expect(isReadPeriodReading((await read({ start: '1985' })).result)).toBe(false);
    expect(isReadPeriodReading(null)).toBe(false);
  });

  it('a cancelled turn throws instead of answering', async () => {
    const controller = new AbortController();
    const { tool } = setup({ loadPeriodChart: vi.fn(async () => { controller.abort(new Error('stopped')); throw new Error('aborted'); }) });
    await expect(tool.execute(args({ start: '2019-06' }), context(controller.signal))).rejects.toThrow();
  });
});

describe('readPeriodGrounding', () => {
  it('projects a reading flat for the answer check', async () => {
    const result = (await read({ start: '2019-06', end: '2019-12' })).result as ReadPeriodReading;
    const grounding = readPeriodGrounding(result, 'en');
    expect(grounding.period).toEqual({ start: '2019-06-01', end: '2019-12-31', label: 'Jun – Dec 2019' });
    expect(grounding.place).toEqual({ label: 'Vadodara, India' });
    expect(grounding.maha).toEqual(['rahu']);
    expect(grounding.antar).toEqual(['rahu']);
    expect(grounding.rules.rahu).toEqual(result.lords.find((lord) => lord.lord === 'rahu')?.rules ?? []);
    expect(grounding.tags).toEqual([...new Set(result.sky.flatMap((span) => span.tags))]);
    expect(grounding.windows.map((fact) => fact.date)).toEqual(expect.arrayContaining(result.windows.map((window) => window.date)));
    expect(grounding.themes).toEqual(Object.fromEntries(result.themes.map((theme) => [theme.domain, { direction: theme.direction, confidence: theme.confidence }])));
    expect(grounding.pratyantar).toEqual([...new Set(result.dashas.pratyantar.map((span) => span.lord))]);
  });

  /** A November-like month: no theme window inside it, but a sign change and a pratyantar change. */
  const november = (base: ReadPeriodReading): ReadPeriodReading => ({
    ...base,
    period: { ...base.period, start: '2026-11-01', end: '2026-11-30', label: 'November 2026' },
    dashas: {
      ...base.dashas,
      maha: [{ lord: 'jupiter', start: '2026-11-01', end: '2026-11-30' }],
      antar: [{ lord: 'venus', start: '2026-11-01', end: '2026-11-30' }],
      pratyantar: [{ lord: 'moon', start: '2026-11-01', end: '2026-11-19' }, { lord: 'mars', start: '2026-11-20', end: '2026-11-30' }],
      sandhi: { level: 'antar', date: '2026-11-25' },
    },
    segments: [
      { start: '2026-11-01', end: '2026-11-19', maha: 'jupiter', antar: 'venus', pratyantar: 'moon', events: ['2026-11-12 mars.ingress.leo', '2026-12-02 venus.ingress.libra'] },
      { start: '2026-11-20', end: '2026-11-30', maha: 'jupiter', antar: 'venus', pratyantar: 'mars', events: ['2026-11-28 saturn.station.direct'] },
    ],
    windows: [],
  });

  it('every dated fact inside the period is a window: segment events, dasha changes and the sandhi, each labelled', async () => {
    const base = (await read({ start: '2019-06' })).result as ReadPeriodReading;
    expect(readPeriodGrounding(november(base), 'en').windows).toEqual([
      { date: '2026-11-12', what: 'Mars enters Leo' },
      { date: '2026-11-20', what: 'pratyantar Mars begins' },
      { date: '2026-11-25', what: 'antar dasha junction (sandhi)' },
      { date: '2026-11-28', what: 'Saturn stations direct' },
    ]);
  });

  it('theme windows keep their place, labelled from their descriptor', async () => {
    const base = november((await read({ start: '2019-06' })).result as ReadPeriodReading);
    const reading = { ...base, segments: [], windows: [{ date: '2026-11-05', descriptor: 'transit.jupiter.ingress.cancer', severity: 'supportive' as const, domains: ['career'] }] };
    expect(readPeriodGrounding(reading, 'en').windows).toEqual([
      { date: '2026-11-05', what: 'Jupiter enters Cancer' },
      { date: '2026-11-20', what: 'pratyantar Mars begins' },
      { date: '2026-11-25', what: 'antar dasha junction (sandhi)' },
    ]);
  });

  it('a reading with no events, no dasha change and no theme window grounds no windows', async () => {
    const base = november((await read({ start: '2019-06' })).result as ReadPeriodReading);
    const { sandhi: _sandhi, ...dashas } = base.dashas;
    const flat = { ...base, dashas: { ...dashas, pratyantar: [{ lord: 'moon', start: '2026-11-01', end: '2026-11-30' }] }, segments: [{ ...base.segments[0]!, events: [] }] };
    expect(readPeriodGrounding(flat, 'en').windows).toEqual([]);
  });

  it.each([
    ['es', ['Marte entra en Leo', 'comienza el pratyantar dasha de Marte', 'transición del antar dasha (sandhi)', 'Saturno pasa a directo']],
    ['pt', ['Marte entra em Leão', 'começa o pratyantar dasha de Marte', 'transição do antar dasha (sandhi)', 'Saturno fica direto']],
    ['en', ['Mars enters Leo', 'pratyantar Mars begins', 'antar dasha junction (sandhi)', 'Saturn stations direct']],
  ])('the dated facts speak the chat language: %s', async (language, labels) => {
    const base = (await read({ start: '2019-06' })).result as ReadPeriodReading;
    expect(readPeriodGrounding(november(base), language).windows.map((fact) => fact.what)).toEqual(labels);
  });

  it.each([
    ['es', 'Júpiter en la casa 4 desde tu Luna', 'Marte entra en Cáncer', '- **22 jun 2019**: Marte entra en Cáncer'],
    ['pt', 'Júpiter na casa 4 a partir da sua Lua', 'Marte entra em Câncer', '- **22 jun 2019**: Marte entra em Câncer'],
  ] as const)('the cite and a filled window speak the chat language: %s', async (language, says, what, rendered) => {
    const result = (await read({ start: '2019-06' }, { language })).result as ReadPeriodReading;
    expect(result.cite?.moon).toEqual([{ tag: 'jupiter_from_moon_4', says }]);
    expect(result.cite?.windows).toEqual([{ date: '2019-06-22', what }]);
    const grounding = readPeriodGrounding(result, language);
    const cited = answerFromCite(result.cite!, grounding);
    const filled = fillFromReadings({ ...cited, windows: [] }, [grounding], language) as ChatAnswer;
    expect(checkIssues(filled, grounding)).toEqual([]);
    expect(renderAnswer(filled, { voice: 'layman', language })).toContain(rendered);
  });

  it('an unlabelled place grounds as an empty label', async () => {
    const result = (await read({ start: '2019-06' }, { threadPlace: undefined, homePlace: undefined })).result as ReadPeriodReading;
    expect(readPeriodGrounding(result, 'en').place).toEqual({ label: '' });
  });
});

// Task 10e: the facts an answer must state, already phrased, so the model copies them instead of
// leaving moon or windows empty (deepseek's first answer was accepted 2/5 times without it).
describe('read_period: cite', () => {
  it('a month reading cites its period, place, lords, Moon tags, dated windows and each theme\'s direction and confidence', async () => {
    const result = (await read({ start: '2019-06' })).result as ReadPeriodReading;
    expect(result.cite).toEqual({
      period: result.period.label,
      place: 'Vadodara, India',
      maha: ['Rahu, rules no house'],
      antar: ['Rahu, rules no house'],
      pratyantar: [...new Set(result.dashas.pratyantar.map((span) => span.lord))].map((lord) => expect.stringMatching(new RegExp(`^${lord}`, 'i'))),
      moon: [{ tag: 'jupiter_from_moon_4', says: 'Jupiter 4th from your Moon' }],
      windows: [{ date: '2019-06-22', what: 'Mars enters Cancer' }],
      themes: Object.fromEntries(result.themes.map((theme) => [theme.domain, { direction: theme.direction, confidence: theme.confidence }])),
    });
    expect(result.cite?.themes).toMatchObject({ education: { confidence: 'high' }, obstacles: { confidence: 'medium' }, finances: { confidence: 'low' } });
  });

  /** A synthetic reading: two maha lords (a change inside it), lords with and without houses. */
  const crossing = (base: ReadPeriodReading): ReadPeriodReading => ({
    ...base,
    dashas: {
      ...base.dashas,
      maha: [{ lord: 'saturn', start: '2019-06-01', end: '2019-06-14' }, { lord: 'jupiter', start: '2019-06-15', end: '2019-06-30' }],
      antar: [{ lord: 'mars', start: '2019-06-01', end: '2019-06-30' }],
    },
    lords: [
      { lord: 'saturn', level: ['maha'], rules: [1, 12] },
      { lord: 'jupiter', level: ['maha'], rules: [11, 2] },
      { lord: 'mars', level: ['antar'], rules: [6] },
    ],
  });

  it('phrases each lord with the houses it rules, in house order, one entry per running lord', async () => {
    const cite = readingCite(crossing((await read({ start: '2019-06' })).result as ReadPeriodReading), 'en');
    expect(cite.maha).toEqual(['Saturn, rules your 1st and 12th houses', 'Jupiter, rules your 2nd and 11th houses']);
    expect(cite.antar).toEqual(['Mars, rules your 6th house']);
  });

  it('a lord the reading gives no lordship for is named alone', async () => {
    const base = crossing((await read({ start: '2019-06' })).result as ReadPeriodReading);
    expect(readingCite({ ...base, lords: [] }, 'en').maha).toEqual(['Saturn', 'Jupiter']);
  });

  it('an unlabelled place cites null (the answer sends place null)', async () => {
    const result = (await read({ start: '2019-06' }, { threadPlace: undefined, homePlace: undefined })).result as ReadPeriodReading;
    expect(result.cite?.place).toBeNull();
  });

  it.each([
    [{ start: '2019-06' }],
    [{ start: '2019-06', end: '2019-12' }],
    [{ start: '2019' }],
    [{ start: '2019-01', end: '2020-12', focus: 'saturn' as const }],
  ])('every cited fact passes the answer check: %j', async (partial) => {
    const result = (await read(partial)).result as ReadPeriodReading;
    const cite = result.cite;
    const grounding = readPeriodGrounding(result, 'en');
    expect(cite).toBeDefined();
    expect(cite?.moon.map((line) => line.tag)).toEqual(grounding.tags);
    expect(grounding.windows).toEqual(expect.arrayContaining([...(cite?.windows ?? [])]));
    expect(cite?.windows.length).toBe(Math.min(6, grounding.windows.length));
    expect(cite?.maha.map((line) => line.split(',')[0]?.toLowerCase())).toEqual(grounding.maha);
    expect(cite?.antar.map((line) => line.split(',')[0]?.toLowerCase())).toEqual(grounding.antar);
  });

  it.each([
    [{ start: '2019-06' }],
    [{ start: '2019-06', end: '2019-12' }],
    [{ start: '2019' }],
    [{ start: '2019-01', end: '2020-12', focus: 'saturn' as const }],
  ])('an answer that copies the cite passes the answer check as is: %j', async (partial) => {
    const result = (await read(partial)).result as ReadPeriodReading;
    const grounding = readPeriodGrounding(result, 'en');
    expect(checkIssues(answerFromCite(result.cite!, grounding), grounding)).toEqual([]);
  });

  it('a wrong confidence, an invented date or a wrong pratyantar lord retries, each with its fix', async () => {
    const result = (await read({ start: '2019-06', end: '2019-12' })).result as ReadPeriodReading;
    const grounding = readPeriodGrounding(result, 'en');
    const cited = answerFromCite(result.cite!, grounding);
    expect(grounding.pratyantar.length).toBeGreaterThan(0);
    expect(Object.keys(grounding.themes).length).toBeGreaterThan(0);
    const [theme] = cited.themes;
    const wrongLevel = theme!.confidence === 'low' ? 'high' : 'low';
    expect(checkIssues({ ...cited, themes: [{ ...theme!, confidence: wrongLevel }] }, grounding)).toEqual([
      `the reading gives ${theme!.area} as ${theme!.direction}, ${theme!.confidence} confidence: copy both`,
    ]);
    const invented = ['2019-06-02', '2019-06-03', '2019-06-04'].find((date) => !grounding.windows.some((fact) => fact.date === date))!;
    expect(checkIssues({ ...cited, windows: [{ date: invented, what: 'Venus enters Libra' }] }, grounding)[0]).toMatch(/^each window date must be a day the reading gives, e\.g\. /);
    const stranger = GRAHAS.find((graha) => !grounding.pratyantar.includes(graha))!;
    expect(checkIssues({ ...cited, dashas: { ...cited.dashas, pratyantar: { lord: stranger, rules: grounding.rules[stranger] ?? [], note: '' } } }, grounding)).toEqual([
      `pratyantar lord must be one of: ${grounding.pratyantar.join(', ')} (from the reading)`,
    ]);
  });

  it('a range cites at most 6 windows: its theme windows first, then other dated facts, listed by date', async () => {
    const result = (await read({ start: '2019-06', end: '2019-12' })).result as ReadPeriodReading;
    const dates = result.cite?.windows.map((fact) => fact.date) ?? [];
    expect(dates).toHaveLength(6);
    expect([...dates].sort()).toEqual(dates);
    expect(dates).toEqual(expect.arrayContaining(result.windows.slice(0, 6).map((window) => window.date)));
  });

  it('an ask or an unavailable reading carries no cite', async () => {
    const ask = (await read({ start: '2019-06', place: 'Atlantis' })).result;
    const unavailable = (await read({ start: '2019-06' }, { loadPeriodChart: vi.fn(async () => { throw new PeriodSkyTimeoutError(); }) })).result;
    expect(ask).toMatchObject({ status: 'place_not_found' });
    expect(unavailable).toMatchObject({ available: false });
    expect(ask).not.toHaveProperty('cite');
    expect(unavailable).not.toHaveProperty('cite');
  });
});
