import type { MoonWindow } from '@almamesh/browser';
import {
  BIRTH_YEAR_SKY_NOTE,
  NEEDS_PLACE_ERROR,
  PLACE_REF_ERROR,
  SEGMENT_GAP_NOTE,
  TIME_NEEDS_PLACE_ERROR,
} from '@almamesh/llm';
import { describe, expect, it, vi } from 'vitest';

import { moonWindowInput, type MoonWindowRequest } from '../moonWindow';
import {
  createTimingTool,
  DASHAS_STATUS_LABEL,
  DEVICE_DASHAS_ONLY_NOTE,
  NEEDS_PLACE_STATUS_LABEL,
  PLACE_DOES_NOT_CHANGE_NOTE,
  PLACE_MOON_UNAVAILABLE_NOTE,
} from '../timingTool';
import { CHART, SKY_CHART } from './timingFixtures';

const NOW = new Date('2026-06-20T09:30:00.000Z');
const context = () => ({ now: NOW, signal: new AbortController().signal });
const MARK = { sign: 'taurus', nakshatra: 'Rohini', tithi: 3, paksha: 'shukla' } as const;
const NEXT = { sign: 'gemini', nakshatra: 'Mrigashira', tithi: 5, paksha: 'shukla' } as const;
const WINDOW: MoonWindow = { at_place: { at_start: MARK, at_end: NEXT }, event: null };
const BOGOTA = {
  summary: { place_ref: 'city:202', label: 'Bogotá, Colombia', timezone: 'America/Bogota' },
  latitude: 4.711,
  longitude: -74.0721,
};
const LA = {
  summary: { place_ref: 'city:101', label: 'Los Angeles, United States', timezone: 'America/Los_Angeles' },
  latitude: 34.05,
  longitude: -118.24,
};
const PLACES: Record<string, typeof BOGOTA> = { 'city:202': BOGOTA, 'city:101': LA };
const NEEDS_PLACE = { error: NEEDS_PLACE_ERROR };

function tool(overrides: Partial<Parameters<typeof createTimingTool>[0]> = {}) {
  return createTimingTool({
    chart: CHART,
    birthYear: 1990,
    todayDay: () => '2026-06-20',
    loadPeriodChart: vi.fn(async () => SKY_CHART),
    periodSkyAllowed: true,
    loadMoonWindow: vi.fn(async () => WINDOW),
    placeFromRef: vi.fn(async (ref: string) => PLACES[ref]),
    ...overrides,
  });
}

const notesOf = (result: unknown) => (result as { notes: string[] }).notes;

describe('get_timing needs a place below a week', () => {
  it('refuses a single day of transits with no place, before any engine work', async () => {
    const loadPeriodChart = vi.fn(async () => SKY_CHART);
    const load = vi.fn(async () => WINDOW);
    const result = await tool({ loadPeriodChart, loadMoonWindow: load }).execute(
      { section: 'transits', start: '2026-06-15' },
      context(),
    );
    expect(result).toEqual(NEEDS_PLACE);
    expect(NEEDS_PLACE_ERROR).toBe('needs_place');
    expect(loadPeriodChart).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });

  it.each(['transits', 'domains', 'strength'])('refuses %s for 6 days and answers 7 days, with no place', async (section) => {
    expect(await tool().execute({ section, start: '2027-02-01', end: '2027-02-06' }, context())).toEqual(NEEDS_PLACE);
    expect(await tool().execute({ section, start: '2027-02-01', end: '2027-02-07' }, context())).not.toEqual(NEEDS_PLACE);
  });

  it('refuses segments under a week when any segment has no place', async () => {
    const segments = [
      { start: '2026-06-01', end: '2026-06-02', place_ref: 'city:101' },
      { start: '2026-06-03', end: '2026-06-05' },
    ];
    expect(await tool().execute({ section: 'transits', segments }, context())).toEqual(NEEDS_PLACE);
  });

  it('never asks for dashas, for today, on a weak device, or in the birth year', async () => {
    expect(await tool().execute({ section: 'dashas', start: '2026-06-15' }, context())).not.toEqual(NEEDS_PLACE);
    const today = tool({ loadCurrentChart: vi.fn(async () => SKY_CHART) });
    expect(await today.execute({ section: 'transits' }, context())).not.toEqual(NEEDS_PLACE);
    const weak = await tool({ periodSkyAllowed: false }).execute({ section: 'transits', start: '2026-06-15' }, context());
    expect(weak).toMatchObject({ shown: 'dashas' });
    expect(notesOf(weak)[0]).toBe(DEVICE_DASHAS_ONLY_NOTE);
    const birthYear = await tool().execute({ section: 'transits', start: '1990-06-15' }, context());
    expect(birthYear).toMatchObject({ shown: 'dashas' });
    expect(notesOf(birthYear)[0]).toBe(BIRTH_YEAR_SKY_NOTE);
  });

  it('a time without a place is still the time error', async () => {
    const result = await tool().execute({ section: 'transits', start: '2026-06-15', time: '15:00' }, context());
    expect(result).toEqual({ error: TIME_NEEDS_PLACE_ERROR });
  });

  it('says "checking where you were" instead of promising a 30 s sky for a call it will refuse', () => {
    const timing = tool();
    expect(NEEDS_PLACE_STATUS_LABEL).toBe('Checking where you were');
    expect(timing.statusLabelFor?.({ section: 'transits', start: '2026-06-15' })).toBe(NEEDS_PLACE_STATUS_LABEL);
    expect(timing.statusLabelFor?.({ section: 'transits', start: '2026-06-15', place_ref: 'city:202' })).toBeUndefined();
    expect(timing.statusLabelFor?.({ section: 'dashas', start: '2026-06-15' })).toBe(DASHAS_STATUS_LABEL);
  });
});

describe('get_timing with places', () => {
  it('a day at a resolved place reads the Moon there; label and zone echoed, coordinates only to the loader', async () => {
    const load = vi.fn(async () => WINDOW);
    const result = await tool({ loadMoonWindow: load }).execute(
      { section: 'transits', start: '2026-06-15', place_ref: 'city:202' },
      context(),
    );
    expect(result).toMatchObject({
      shown: 'transits',
      places: [
        { start: '2026-06-15', end: '2026-06-15', label: 'Bogotá, Colombia', timezone: 'America/Bogota', moon: WINDOW.at_place },
      ],
    });
    expect(load).toHaveBeenCalledWith(
      { start: '2026-06-15', end: '2026-06-15', zone: 'America/Bogota', place: { latitude: 4.711, longitude: -74.0721 } },
      expect.anything(),
    );
    expect(JSON.stringify(result)).not.toMatch(/latitude|longitude|4\.711|74\.07/);
  });

  it('a few days split across two places reads each place for its own days', async () => {
    const load = vi.fn(async (_request: MoonWindowRequest) => WINDOW);
    const segments = [
      { start: '2026-06-01', end: '2026-06-02', place_ref: 'city:101' },
      { start: '2026-06-03', end: '2026-06-05', place_ref: 'city:202' },
    ];
    const result = await tool({ loadMoonWindow: load }).execute({ section: 'transits', segments }, context());
    expect(load.mock.calls.map(([request]) => [request.start, request.end, request.zone])).toEqual([
      ['2026-06-01', '2026-06-02', 'America/Los_Angeles'],
      ['2026-06-03', '2026-06-05', 'America/Bogota'],
    ]);
    expect((result as { places: unknown[] }).places).toHaveLength(2);
    expect(JSON.stringify(result)).not.toMatch(/latitude|longitude|34\.05|118\.24|4\.711|74\.07/);
  });

  it('a time of day at a place returns the lagna sign and the Moon, no degrees', async () => {
    const event = { lagna_sign: 'scorpio', moon: MARK };
    const load = vi.fn(async () => ({ ...WINDOW, event }));
    const result = await tool({ loadMoonWindow: load }).execute(
      { section: 'transits', start: '2026-07-03', place_ref: 'city:202', time: '15:00' },
      context(),
    );
    expect(result).toMatchObject({ event: { local_time: '15:00', lagna_sign: 'scorpio', moon: MARK } });
    expect(load).toHaveBeenCalledWith(expect.objectContaining({ time: '15:00' }), expect.anything());
  });

  it('a time that never happened at the place is a tool error, before any engine work', async () => {
    const loadPeriodChart = vi.fn(async () => SKY_CHART);
    const load = vi.fn(async (request: MoonWindowRequest) => {
      moonWindowInput(request);
      return WINDOW;
    });
    const result = await tool({ loadPeriodChart, loadMoonWindow: load }).execute(
      { section: 'transits', start: '2026-03-08', place_ref: 'city:101', time: '02:30' },
      context(),
    );
    expect(result).toEqual({ error: expect.stringContaining('did not exist') });
    expect(loadPeriodChart).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });

  it('a time that happened twice at the place is a tool error too', async () => {
    const result = await tool().execute(
      { section: 'transits', start: '2026-11-01', place_ref: 'city:101', time: '01:30' },
      context(),
    );
    expect(result).toEqual({ error: expect.stringContaining('happened twice') });
  });

  it('an unknown place_ref is a tool error, checked before the engine runs', async () => {
    const loadPeriodChart = vi.fn(async () => SKY_CHART);
    const result = await tool({ loadPeriodChart }).execute(
      { section: 'transits', start: '2026-06-15', place_ref: 'city:999999' },
      context(),
    );
    expect(result).toEqual({ error: PLACE_REF_ERROR });
    expect(PLACE_REF_ERROR).toBe('unknown place_ref: call resolve_place first');
    expect(loadPeriodChart).not.toHaveBeenCalled();
  });

  it('a malformed place_ref is the same tool error, never a lookup', async () => {
    const placeFromRef = vi.fn(async () => BOGOTA);
    const result = await tool({ placeFromRef }).execute(
      { section: 'transits', start: '2026-06-15', place_ref: 'Bogotá' },
      context(),
    );
    expect(result).toEqual({ error: PLACE_REF_ERROR });
    expect(placeFromRef).not.toHaveBeenCalled();
  });

  it('an unknown place_ref in any segment is the tool error', async () => {
    const segments = [
      { start: '2026-06-01', end: '2026-06-02', place_ref: 'city:101' },
      { start: '2026-06-03', end: '2026-06-05', place_ref: 'city:7' },
    ];
    expect(await tool().execute({ section: 'transits', segments }, context())).toEqual({ error: PLACE_REF_ERROR });
  });

  it('a place whose zone the device cannot read fails loudly, never a guessed time', async () => {
    const nowhere = { ...BOGOTA, summary: { ...BOGOTA.summary, timezone: 'Mars/Olympus_Mons' } };
    const timing = tool({ placeFromRef: vi.fn(async () => nowhere) });
    await expect(
      timing.execute({ section: 'transits', start: '2026-06-15', place_ref: 'city:202', time: '15:00' }, context()),
    ).rejects.toThrow();
  });

  it('with no place lookup wired, every place_ref is unknown', async () => {
    const result = await tool({ placeFromRef: undefined }).execute(
      { section: 'transits', start: '2026-06-15', place_ref: 'city:202' },
      context(),
    );
    expect(result).toEqual({ error: PLACE_REF_ERROR });
  });

  it('split June (a week or longer): one merged period, labels echoed, a plain note, no Moon at a place', async () => {
    const load = vi.fn(async () => WINDOW);
    const segments = [
      { start: '2026-06-01', end: '2026-06-15', place_ref: 'city:101' },
      { start: '2026-06-16', end: '2026-06-30', place_ref: 'city:202' },
    ];
    const result = await tool({ loadMoonWindow: load }).execute({ section: 'transits', segments }, context());
    expect(result).toMatchObject({
      period: { start: '2026-06-01', end: '2026-06-30', days: 30, basis: 'period' },
      places: [
        { start: '2026-06-01', end: '2026-06-15', label: 'Los Angeles, United States', timezone: 'America/Los_Angeles' },
        { start: '2026-06-16', end: '2026-06-30', label: 'Bogotá, Colombia', timezone: 'America/Bogota' },
      ],
    });
    expect(notesOf(result)).toContain(PLACE_DOES_NOT_CHANGE_NOTE);
    expect(notesOf(result)).not.toContain(SEGMENT_GAP_NOTE);
    expect(load).not.toHaveBeenCalled();
    expect(JSON.stringify((result as { places: unknown }).places)).not.toMatch(/moon|\d+\.\d+/);
  });

  it('a week or longer with no place reads as before: no places, no place note', async () => {
    const result = await tool().execute({ section: 'transits', start: '2026-06-01', end: '2026-06-30' }, context());
    expect(result).not.toHaveProperty('places');
    expect(notesOf(result)).not.toContain(PLACE_DOES_NOT_CHANGE_NOTE);
  });

  it('a gap between week-or-longer segments is noted', async () => {
    const segments = [
      { start: '2026-06-01', end: '2026-06-10', place_ref: 'city:101' },
      { start: '2026-06-20', end: '2026-07-10', place_ref: 'city:202' },
    ];
    const result = await tool().execute({ section: 'transits', segments }, context());
    expect(notesOf(result)).toContain(SEGMENT_GAP_NOTE);
  });

  it('dashas for a week or longer echo the places and say place does not change them', async () => {
    const segments = [
      { start: '2026-06-01', end: '2026-06-15', place_ref: 'city:101' },
      { start: '2026-06-16', end: '2026-06-30', place_ref: 'city:202' },
    ];
    const load = vi.fn(async () => WINDOW);
    const result = await tool({ loadMoonWindow: load }).execute({ section: 'dashas', segments }, context());
    expect(result).toMatchObject({
      shown: 'dashas',
      places: [{ label: 'Los Angeles, United States' }, { label: 'Bogotá, Colombia' }],
    });
    expect(notesOf(result)).toContain(PLACE_DOES_NOT_CHANGE_NOTE);
    expect(load).not.toHaveBeenCalled();
  });

  it('dashas for a single day ignore the place: no lookup, no Moon read', async () => {
    const placeFromRef = vi.fn(async (ref: string) => PLACES[ref]);
    const load = vi.fn(async () => WINDOW);
    const result = await tool({ placeFromRef, loadMoonWindow: load }).execute(
      { section: 'dashas', start: '2026-06-15', place_ref: 'city:202' },
      context(),
    );
    expect(result).toMatchObject({ shown: 'dashas' });
    expect(result).not.toHaveProperty('places');
    expect(placeFromRef).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });

  it('a weak device never reads places', async () => {
    const placeFromRef = vi.fn();
    const load = vi.fn(async () => WINDOW);
    const result = await tool({ periodSkyAllowed: false, placeFromRef, loadMoonWindow: load }).execute(
      { section: 'transits', start: '2026-06-15', place_ref: 'city:202' },
      context(),
    );
    expect(result).toMatchObject({ shown: 'dashas' });
    expect(notesOf(result)[0]).toBe(DEVICE_DASHAS_ONLY_NOTE);
    expect(placeFromRef).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });

  it('a failed Moon read keeps the sky answer and says so', async () => {
    const load = vi.fn(async () => {
      throw new Error('worker died');
    });
    const result = await tool({ loadMoonWindow: load }).execute(
      { section: 'transits', start: '2026-06-15', place_ref: 'city:202' },
      context(),
    );
    expect(result).toMatchObject({
      shown: 'transits',
      places: [{ label: 'Bogotá, Colombia', timezone: 'America/Bogota' }],
    });
    expect((result as { places: object[] }).places[0]).not.toHaveProperty('moon');
    expect(notesOf(result)).toContain(PLACE_MOON_UNAVAILABLE_NOTE);
  });

  it('with no Moon loader wired, the sky answer stands and says the Moon is unavailable', async () => {
    const result = await tool({ loadMoonWindow: undefined }).execute(
      { section: 'domains', start: '2026-06-15', place_ref: 'city:202' },
      context(),
    );
    expect(result).toMatchObject({ shown: 'domains', places: [{ label: 'Bogotá, Colombia' }] });
    expect(notesOf(result)).toContain(PLACE_MOON_UNAVAILABLE_NOTE);
  });

  it('rethrows when the turn was cancelled during the Moon read', async () => {
    const controller = new AbortController();
    const load = vi.fn(async () => {
      controller.abort(new DOMException('cancelled', 'AbortError'));
      throw new Error('aborted');
    });
    await expect(
      tool({ loadMoonWindow: load }).execute(
        { section: 'transits', start: '2026-06-15', place_ref: 'city:202' },
        { now: NOW, signal: controller.signal },
      ),
    ).rejects.toThrow('aborted');
  });
});

describe('get_timing teaches the model about places', () => {
  it('accepts place_ref, time and up to four segments', () => {
    expect(tool().parameters).toMatchObject({
      properties: {
        place_ref: { type: 'string', pattern: '^city:\\d{1,6}$' },
        time: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' },
        segments: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          items: { required: ['start', 'end'], additionalProperties: false },
        },
      },
      additionalProperties: false,
    });
  });

  it('says resolve first when a place was named, ask otherwise, and skip places for a week or longer', () => {
    const { description } = tool();
    expect(description).toContain('call resolve_place first');
    expect(description).toContain('"Where were you (or will you be) that day?"');
    expect(description).toContain('A week or longer never needs a place');
    expect(description).toContain('Never assume a place');
  });
});
