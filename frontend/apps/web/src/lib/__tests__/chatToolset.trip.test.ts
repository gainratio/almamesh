import type { SiderealChart } from '@almamesh/browser/types';
import type { ProcessedBirthData } from '@almamesh/shared-types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChartEngineContextValue } from '../../providers/chartEngineContext';
import { SPLIT_DAY_NOW } from '../../test/viewerToday';

const loadMock = vi.hoisted(() => vi.fn());
vi.mock('../periodSky', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../periodSky')>();
  return { ...actual, periodSkyCache: () => ({ load: loadMock, keys: () => [] }) };
});

import type { AgentTool } from '@almamesh/llm';

import { buildChatToolset, type BuildChatToolsetInput } from '../chatToolset';
import { periodReadingFixture } from './periodReadingFixtures';
import { CHART, SKY_CHART } from './timingFixtures';

const SINGAPORE = { label: 'Singapore', timezone: 'Asia/Singapore', latitude: 1.2897, longitude: 103.8501 };
const MAY_2019_SG = { start: '2019-05-01', end: '2019-05-31', granularity: 'month', place: SINGAPORE } as const;
const YEAR_2019_SG = { start: '2019-01-01', end: '2019-12-31', granularity: 'year', place: SINGAPORE } as const;
const BIRTH = {
  birth_datetime_utc: '1990-01-15T06:30:00Z',
  birth_datetime_local: '1990-01-15T12:00:00',
  birth_location_details: { city: 'Delhi', latitude: 28.6139, longitude: 77.209, timezone: 'Asia/Kolkata' },
} as unknown as ProcessedBirthData;
const NATAL = {
  ...CHART,
  lagna: { sign: 'scorpio', nakshatra: 'anuradha', nakshatra_pada: 1, sign_lord: 'mars', longitude: 215.25 },
  planets: { moon: { name: 'moon', sign: 'cancer', house: 9, nakshatra: 'pushya', nakshatra_pada: 2, sign_lord: 'moon', dignity: 'own', is_retrograde: false, longitude: 100.5 } },
} as unknown as SiderealChart;

/** Stands in for the period-reading tool (apps/web periodReadingTool.ts, its own agent's work). */
const READING_STUB: AgentTool = {
  name: 'get_period_reading', description: 'Read the period reading.',
  parameters: { type: 'object', properties: {}, additionalProperties: false }, execute: async () => ({ ok: true }),
};

function toolset(overrides: Partial<BuildChatToolsetInput> = {}) {
  return buildChatToolset({
    toolOverrides: [READING_STUB],
    chart: NATAL,
    chartAsOf: { basis: 'chart', instant: new Date('2025-01-01T00:00:00Z') },
    chartTimeZone: 'Asia/Kolkata',
    profileKey: 'p1',
    birth: BIRTH,
    engine: { engine: { computePredictive: vi.fn() }, startBootstrap: vi.fn(), whenReady: vi.fn() } as unknown as ChartEngineContextValue,
    viewerZone: () => 'America/Los_Angeles',
    periodSkyAllowed: true,
    language: 'en',
    ...overrides,
  });
}
const options = () => ({ now: SPLIT_DAY_NOW, signal: new AbortController().signal });
const toolOf = (built: ReturnType<typeof toolset>, name: string) => built.tools.find((tool) => tool.name === name)!;

beforeEach(() => loadMock.mockReset().mockResolvedValue({ transit_context: SKY_CHART.transit_context }));

describe('a trip thread registers its own context tools', () => {
  it('a trip has natal summary, trip context, timing, place lookup and travel; no today-only chart facts', () => {
    const names = toolset({ pinned: MAY_2019_SG, onTravel: vi.fn(), toolOverrides: undefined }).tools.map((tool) => tool.name);
    expect(names).toEqual(['get_natal_summary', 'get_trip_context', 'get_timing', 'get_period_reading', 'get_period_detail', 'resolve_place', 'time_travel']);
  });

  it('a today thread keeps its tools and has no trip tools', () => {
    const names = toolset().tools.map((tool) => tool.name);
    expect(names).not.toContain('get_trip_context');
    expect(names).toContain('get_chart_facts');
  });

  it('get_trip_context with no args answers for May 2019 in Singapore', async () => {
    const result = await toolOf(toolset({ pinned: MAY_2019_SG }), 'get_trip_context').execute({}, options());
    expect(result).toMatchObject({
      period: { start: '2019-05-01', end: '2019-05-31', granularity: 'month', tense: 'past', label: 'May 2019' },
      place: { label: 'Singapore', timezone: 'Asia/Singapore' },
      dashas: { maha: [{ lord: 'jupiter' }], antar: [{ lord: 'saturn' }] },
    });
  });

  it('get_natal_summary carries the natal chart and no raw birth data', async () => {
    const result = await toolOf(toolset({ pinned: MAY_2019_SG }), 'get_natal_summary').execute({}, options());
    expect(result).toMatchObject({ lagna: { sign: 'scorpio' }, moon: { sign: 'cancer', nakshatra: 'pushya' } });
    expect(JSON.stringify(result)).not.toMatch(/1990|06:30|28\.61|77\.20|215\.25|100\.5|latitude|longitude/);
  });
});

describe('the period reading tools are bound to the trip', () => {
  it('get_period_reading with no args reads the trip period through the period-sky queue, at the trip place', async () => {
    loadMock.mockResolvedValue({ transit_context: SKY_CHART.transit_context, period_reading: periodReadingFixture('delhi-2019-05') });
    const result = await toolOf(toolset({ pinned: MAY_2019_SG, toolOverrides: undefined }), 'get_period_reading').execute({}, options());
    expect(loadMock).toHaveBeenCalledTimes(1);
    expect(loadMock.mock.calls[0]?.[0]).toMatchObject({ profileKey: 'p1', referenceInstant: '2019-05-01T00:00:00Z' });
    expect(result).toMatchObject({
      period: { start: '2019-05-01', end: '2019-05-31', granularity: 'month', label: 'May 2019', tense: 'past' },
      place: { label: 'Singapore', timezone: 'Asia/Singapore' },
      dashas: { pratyantar: [{ lord: 'venus' }] },
    });
    expect(JSON.stringify(result)).not.toMatch(/Delhi|Kolkata|1\.2897|103\.85|1990|28\.61|77\.20/);
  });

  it('an explicit question period inside a trip rebinds the reading to that period', async () => {
    loadMock.mockResolvedValue({ transit_context: SKY_CHART.transit_context, period_reading: periodReadingFixture('delhi-2019-year') });
    const built = toolset({ pinned: MAY_2019_SG, toolOverrides: undefined });
    await built.prepare('What about 2019?', options());
    const result = await toolOf(built, 'get_period_reading').execute({}, options());
    expect(result).toMatchObject({ period: { start: '2019-01-01', end: '2019-12-31', granularity: 'year' } });
  });

  it('a reading-less cache row (an older engine) answers reading_unavailable, not an invented reading', async () => {
    const result = await toolOf(toolset({ pinned: MAY_2019_SG, toolOverrides: undefined }), 'get_period_detail').execute({ section: 'dashas' }, options());
    expect(result).toMatchObject({ available: false, reason: 'reading_unavailable', place: { label: 'Singapore' } });
  });
});

describe('trip-bound get_timing reads the trip place for every granularity', () => {
  it.each([['Month', MAY_2019_SG], ['Year', YEAR_2019_SG]] as const)('%s: no args → the trip period at Singapore, not the birth place', async (_label, pin) => {
    const result = await toolOf(toolset({ pinned: pin }), 'get_timing').execute({ section: 'transits' }, options()) as {
      period: { start: string }; places?: Array<{ label: string; timezone: string }>;
    };
    expect(result.period.start).toBe(pin.start);
    expect(result.places?.map((place) => place.label)).toEqual(['Singapore']);
    expect(JSON.stringify(result)).not.toMatch(/Delhi|Kolkata|1\.2897|103\.85/);
  });

  it('an old trip with no place reads the birth place by its label and zone, with no marker', async () => {
    const old = { start: '2019-05-01', end: '2019-05-31', granularity: 'month' } as const;
    const result = await toolOf(toolset({ pinned: old }), 'get_timing').execute({ section: 'transits' }, options()) as {
      places?: Array<{ label: string; timezone: string }>;
    };
    // Contract reversed (twice) 2026-10-13: every trip's place reaches the model by label and zone, unmarked.
    expect(result.places).toEqual([expect.objectContaining({ label: 'Delhi', timezone: 'Asia/Kolkata' })]);
    expect(JSON.stringify(result)).not.toMatch(/birth.?place|28\.61|77\.20/i);
  });
});

describe('prepare: a trip grounds through tools, not a facts blob', () => {
  it('returns the trip brief inputs, first-round tool_choice required, and no pre-computed timing', async () => {
    const prepared = await toolset({ pinned: MAY_2019_SG }).prepare('How was work?', options());
    expect(prepared.clarification).toBeUndefined();
    expect(loadMock).not.toHaveBeenCalled();
    expect(prepared.toolChoice).toBe('required');
    // Contract reversed 2026-10-13 (period reading): the reading carries the period and the place, so it and the
    // natal summary ground a trip; get_trip_context and get_timing stay registered but are no longer required.
    expect(prepared.groundingTool).toBe('get_period_reading');
    expect(prepared.requiredTools).toEqual(['get_period_reading', 'get_natal_summary']);
    // What the loop runs itself if a required round gets no tool call (2026-10-13: qwen, gpt-oss).
    expect(prepared.groundingCalls).toEqual([
      { name: 'get_period_reading', args: {} },
      { name: 'get_natal_summary', args: {} },
    ]);
    expect(prepared.pinned).toEqual({
      start: '2019-05-01', end: '2019-05-31', relative: 'past', granularity: 'month', label: 'May 2019',
      place: { label: 'Singapore', timezone: 'Asia/Singapore' },
    });
  });

  // Regression 2026-10-13: the question-period override dropped the trip's place and read the birth place.
  it('inside the May 2019 Singapore trip, "what about Sep 2019?" reads September 2019 in Singapore', async () => {
    const built = toolset({ pinned: MAY_2019_SG });
    const prepared = await built.prepare('what about Sep 2019?', options());
    expect(prepared.pinned).toEqual({
      start: '2019-09-01', end: '2019-09-30', relative: 'past', granularity: 'month', label: 'September 2019',
      place: { label: 'Singapore', timezone: 'Asia/Singapore' },
    });
    const trip = await toolOf(built, 'get_trip_context').execute({}, options());
    expect(trip).toMatchObject({ period: { start: '2019-09-01', end: '2019-09-30' }, place: { label: 'Singapore', timezone: 'Asia/Singapore' } });
    expect(JSON.stringify([prepared.pinned, trip])).not.toMatch(/Delhi|Kolkata|1\.2897|103\.85/);
  });

  it('a today question in a today thread is unchanged: auto tool choice', async () => {
    const prepared = await toolset().prepare('What are my career strengths?', options());
    expect(prepared.toolChoice).toBe('auto');
    expect(prepared.pinned).toBeUndefined();
  });
});

describe('time_travel from a trip keeps its place', () => {
  it('a month move from the Singapore trip records Singapore, not the birth place', async () => {
    const onTravel = vi.fn();
    await toolOf(toolset({ pinned: MAY_2019_SG, onTravel }), 'time_travel').execute({ action: 'travel', period: 'month', date: '2020-03' }, options());
    expect(onTravel.mock.calls[0]?.[0]?.asOf.place).toEqual(SINGAPORE);
  });
});

describe('trip-bound get_timing forgives redundant arguments (2026-10-13 regression)', () => {
  // Exactly what openai/gpt-sol-latest sent in a May 2019 trip; both calls failed before.
  const SENT = {
    start: '2019-05-01', end: '2019-05-31', place_ref: 'city:0', time: '12:00',
    segments: [{ start: '2019-05-01', end: '2019-05-31', place_ref: 'city:0' }],
  };

  it.each(['dashas', 'transits'])('%s: reads the trip period at the trip place, with a note, and no error', async (section) => {
    const result = await toolOf(toolset({ pinned: MAY_2019_SG }), 'get_timing').execute({ section, ...SENT }, options()) as {
      error?: string; period?: { start: string; end: string }; places?: Array<{ label: string }>; notes?: string[];
    };
    expect(result.error).toBeUndefined();
    expect(result.period).toMatchObject({ start: '2019-05-01', end: '2019-05-31' });
    if (section === 'transits') expect(result.places?.map((place) => place.label)).toEqual(['Singapore']);
    expect(result.notes).toEqual(expect.arrayContaining([expect.stringMatching(/this trip's place/i)]));
  });

  it('a real conflict in a trip says exactly how to retry', async () => {
    const result = await toolOf(toolset({ pinned: MAY_2019_SG }), 'get_timing')
      .execute({ section: 'transits', start: '2019-04-01', end: '2019-05-31', segments: [{ start: '2019-05-01', end: '2019-05-31' }] }, options()) as { error?: string };
    expect(result.error).toContain('send either start/end or segments, not both');
    expect(result.error).toContain('call get_timing with only {"section": "transits"}');
    expect(result.error).toContain("this trip's dates and place are already bound");
  });
});
