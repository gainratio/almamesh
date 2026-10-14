import { describe, expect, it, vi } from 'vitest';
import type { PlaceLookup, ResolvedPlace } from '../geo/placeLookup';
import { NO_PLACE_PICKER } from '../placePick';
import { periodAsOfFromDraft } from '../timeTravelSheet';
import { createTravelTool, TRAVEL_TOOL_NAME, type TravelArgs, type TravelToolInput } from '../travelTool';

// ---------------------------------------------------------------------------
// travel(to, place?) — chat tool layer redesign, 2026-10-14
// ---------------------------------------------------------------------------

const TRIP = { label: 'Vadodara, India', timezone: 'Asia/Kolkata', latitude: 22.3072, longitude: 73.1812 };
const HOME = { label: 'Novato, California', timezone: 'America/Los_Angeles' };
const PUNE: ResolvedPlace = { summary: { place_ref: 'city:7', label: 'Pune, India', timezone: 'Asia/Kolkata' }, latitude: 18.5204, longitude: 73.8567 };
const SPRINGFIELD_IL: ResolvedPlace = { summary: { place_ref: 'city:8', label: 'Springfield, Illinois', timezone: 'America/Chicago' }, latitude: 39.7817, longitude: -89.6501 };
const SPRINGFIELD_MA: ResolvedPlace = { summary: { place_ref: 'city:9', label: 'Springfield, Massachusetts', timezone: 'America/New_York' }, latitude: 42.1015, longitude: -72.5898 };
/** placeEgress.test.ts's patterns, plus Pune's and the trip's coordinates. */
const COORDINATE_LIKE = [/18\.52/, /73\.85/, /22\.30/, /73\.18/, /"latitude"/, /"longitude"/, /"lat"/, /"lon"/, /birth_location/, /location_name/];

function lookupOf(text: string): Promise<PlaceLookup> {
  if (/^pune/i.test(text)) return Promise.resolve({ status: 'found', place: PUNE });
  if (/^springfield/i.test(text)) return Promise.resolve({ status: 'ambiguous', candidates: [SPRINGFIELD_IL, SPRINGFIELD_MA] });
  return Promise.resolve({ status: 'not_found' });
}

function travelSetup(overrides: Partial<TravelToolInput> = {}) {
  const record = vi.fn();
  const lookup = vi.fn(lookupOf);
  const pick = vi.fn(async (): Promise<ResolvedPlace | undefined | typeof NO_PLACE_PICKER> => SPRINGFIELD_IL);
  const tool = createTravelTool({ birthYear: 1990, language: 'en', record, threadPlace: undefined, homePlace: HOME, lookup, pick, ...overrides });
  return { tool, record, lookup, pick };
}
const go = (tool: ReturnType<typeof createTravelTool>, args: TravelArgs, signal = new AbortController().signal) =>
  tool.execute(args, { now: new Date('2026-10-14T12:00:00Z'), signal });
const issues = (tool: ReturnType<typeof createTravelTool>, args: unknown): string[] => {
  const parsed = tool.input.safeParse(args);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
};

describe('travel: the schema the model fills', () => {
  it('is named travel and describes when to move (audit 4.3)', () => {
    const { tool } = travelSetup();
    expect(tool.name).toBe(TRAVEL_TOOL_NAME);
    expect(TRAVEL_TOOL_NAME).toBe('travel');
    expect(tool.description).toContain('Move this conversation and the Dashboard to a day, month or year (a time-travel trip), or back to today.');
    expect(tool.description).toContain('Only when the user asks to go there; to answer a question about a time, use read_period.');
    expect(tool.description).toContain('"take me to May 2019 in Vadodara" -> {"to":"2019-05","place":"Vadodara"}');
  });

  it('a spelled-out month comes back as a retry the model can fix', () => {
    const { tool } = travelSetup();
    expect(issues(tool, { to: 'March 2019', place: null })).toEqual(['to must be "today", YYYY, YYYY-MM or YYYY-MM-DD']);
  });

  it.each([
    { to: '2019-03' },
    { to: '2019-03', place: null, period: 'month' },
    { to: '2019-03', place: 'P' },
  ])('every key, only these keys, and a real place name: %j is refused', (args) => {
    const { tool } = travelSetup();
    expect(issues(tool, args)).not.toEqual([]);
  });

  it.each(['2019-02-30', '1899', '2053-01'])('an impossible date %s is a retry that says the fix', (to) => {
    const { tool } = travelSetup();
    expect(issues(tool, { to, place: null })).toEqual(['Use a real date from 1900 through 2052: YYYY-MM-DD for a day, YYYY-MM for a month, YYYY for a year.']);
  });

  it('back to today takes no place', () => {
    const { tool } = travelSetup();
    expect(issues(tool, { to: 'today', place: 'Pune' })).toEqual(['to "today" takes no place: send place null']);
    expect(issues(tool, { to: 'today', place: null })).toEqual([]);
  });
});

describe('travel: what a call records', () => {
  it('to "today" records back to today and reads no place', async () => {
    const { tool, record, lookup } = travelSetup();
    expect(await go(tool, { to: 'today', place: null })).toEqual({ status: 'queued', action: 'back_to_today' });
    expect(record).toHaveBeenCalledWith({ kind: 'back_to_today' });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('a month at a named city records the trip with its coordinates and tells the model only label and zone', async () => {
    const { tool, record, lookup } = travelSetup();
    const result = await go(tool, { to: '2019-05', place: 'Pune' });
    expect(lookup).toHaveBeenCalledWith('Pune');
    expect(result).toEqual({ status: 'queued', action: 'travel', period_label: 'May 2019', place_label: 'Pune, India', time_zone: 'Asia/Kolkata' });
    for (const pattern of COORDINATE_LIKE) expect(JSON.stringify(result)).not.toMatch(pattern);
    const place = { label: 'Pune, India', timezone: 'Asia/Kolkata', latitude: PUNE.latitude, longitude: PUNE.longitude };
    expect(record).toHaveBeenCalledWith({ kind: 'travel', asOf: periodAsOfFromDraft({ granularity: 'month', day: '2019-05-01', month: '2019-05', year: 2019, place }) });
  });

  it('a year is read from the date precision', async () => {
    const { tool, record } = travelSetup();
    expect(await go(tool, { to: '2020', place: null })).toMatchObject({ status: 'queued', period_label: '2020' });
    expect(record.mock.calls[0]?.[0]?.asOf).toMatchObject({ start: '2020-01-01', end: '2020-12-31', granularity: 'year' });
  });

  it('a month with no place keeps the trip the user is on', async () => {
    const { tool, record } = travelSetup({ threadPlace: TRIP });
    expect(await go(tool, { to: '2019-09', place: null })).toMatchObject({ place_label: 'Vadodara, India', time_zone: 'Asia/Kolkata' });
    expect(record.mock.calls[0]?.[0]?.asOf.place).toEqual(TRIP);
  });

  it('from a today thread a month with no place has no place of its own (home has no coordinates to pin)', async () => {
    const { tool, record } = travelSetup();
    expect(await go(tool, { to: '2019-09', place: null })).toEqual({ status: 'queued', action: 'travel', period_label: 'September 2019' });
    expect(record.mock.calls[0]?.[0]?.asOf.place).toBeUndefined();
  });

  it('a day with no place in a today thread asks where, and records nothing', async () => {
    const { tool, record } = travelSetup();
    expect(await go(tool, { to: '2019-03-14', place: null })).toEqual({ status: 'needs_place', ask: 'Ask where the user was that day.' });
    expect(record).not.toHaveBeenCalled();
  });

  it('a day with no place on a trip goes to the trip place (the thread place counts)', async () => {
    const { tool, record } = travelSetup({ threadPlace: TRIP });
    expect(await go(tool, { to: '2019-05-14', place: null })).toMatchObject({ status: 'queued', place_label: 'Vadodara, India' });
    expect(record.mock.calls[0]?.[0]?.asOf).toMatchObject({ start: '2019-05-14', end: '2019-05-14', granularity: 'day', place: TRIP });
  });

  it('several cities: the person picks one and the trip goes there', async () => {
    const { tool, record, pick } = travelSetup();
    expect(await go(tool, { to: '2019-03-14', place: 'Springfield' })).toMatchObject({ place_label: 'Springfield, Illinois', time_zone: 'America/Chicago' });
    expect(pick).toHaveBeenCalledWith('Springfield', [SPRINGFIELD_IL, SPRINGFIELD_MA], expect.any(AbortSignal));
    expect(record.mock.calls[0]?.[0]?.asOf.place).toMatchObject({ label: 'Springfield, Illinois', latitude: SPRINGFIELD_IL.latitude });
  });

  it.each([[undefined], [NO_PLACE_PICKER]])('several cities, none picked (%s): a neutral ask, nothing recorded', async (answer) => {
    const { tool, record } = travelSetup({ pick: vi.fn(async () => answer) });
    expect(await go(tool, { to: '2019-03', place: 'Springfield' })).toEqual({
      status: 'place_not_chosen', candidates: ['Springfield, Illinois', 'Springfield, Massachusetts'], ask: 'Ask the user which one they meant.',
    });
    expect(record).not.toHaveBeenCalled();
  });

  it('an unknown city asks for a larger one, and records nothing', async () => {
    const { tool, record } = travelSetup();
    expect(await go(tool, { to: '2019-03', place: 'Atlantis' })).toEqual({ status: 'place_not_found', ask: 'Ask for the nearest larger city.' });
    expect(record).not.toHaveBeenCalled();
  });

  it('before birth is a neutral ask that names no birth year, and records nothing', async () => {
    const { tool, record } = travelSetup();
    const result = await go(tool, { to: '1989', place: null });
    expect(result).toEqual({ status: 'outside_range', ask: 'This is before the chart begins; ask about a later period.' });
    expect(JSON.stringify(result)).not.toContain('1990');
    expect(record).not.toHaveBeenCalled();
  });

  // The schema refuses these first; a direct call (no schema in front) still never records a bad trip.
  it('an impossible date that skips the schema throws the fix and records nothing', async () => {
    const { tool, record } = travelSetup();
    await expect(go(tool, { to: '2019-02-30', place: 'Pune' })).rejects.toThrow('Use a real date from 1900 through 2052');
    expect(record).not.toHaveBeenCalled();
  });

  it('a broken trip pin (latitude 999) is refused, not recorded', async () => {
    const { tool, record } = travelSetup({ threadPlace: { ...TRIP, latitude: 999 } });
    await expect(go(tool, { to: '2019-05', place: null })).rejects.toThrow();
    expect(record).not.toHaveBeenCalled();
  });

  it('a cancelled call records nothing', async () => {
    const { tool, record } = travelSetup();
    const controller = new AbortController();
    controller.abort();
    await expect(go(tool, { to: 'today', place: null }, controller.signal)).rejects.toThrow();
    await expect(go(tool, { to: '2019-03', place: 'Pune' }, controller.signal)).rejects.toThrow();
    expect(record).not.toHaveBeenCalled();
  });
});
