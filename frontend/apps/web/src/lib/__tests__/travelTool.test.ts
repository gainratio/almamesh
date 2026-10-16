import { describe, expect, it, vi } from 'vitest';
import type { PlaceLookup, ResolvedPlace } from '../geo/placeLookup';
import { NO_PLACE_PICKER } from '../placePick';
import { periodAsOfFromDraft } from '../timeTravelSheet';
import { createTravelTool, TRAVEL_NEEDS_PLACE, TRAVEL_NOT_ASKED, TRAVEL_NOT_PENDING, TRAVEL_TOOL_NAME, type TravelArgs, type TravelToolInput } from '../travelTool';

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
  const tool = createTravelTool({ birthYear: 1990, language: 'en', record, threadPlace: undefined, homePlace: HOME, lookup, pick, grant: { kind: 'asked' }, ...overrides });
  return { tool, record, lookup, pick };
}
const go = (tool: ReturnType<typeof createTravelTool>, args: TravelArgs, signal = new AbortController().signal) =>
  tool.execute(args, { now: new Date('2026-10-14T12:00:00Z'), signal });
const issues = (tool: ReturnType<typeof createTravelTool>, args: unknown): string[] => {
  const parsed = tool.input.safeParse(args);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
};

describe('travel: the neutral ask for a trip with no place', () => {
  it('is pinned to its literal (a constant asserted only against itself guards nothing)', () => {
    expect(TRAVEL_NEEDS_PLACE).toEqual({ status: 'needs_place', ask: 'Ask where the user lived (or will be) then.' });
  });
});

// dashboard.agentic.real 2026-10-15 (GPT Luna): "outlook today?" in a September 2017 trip called
// travel back to today and ended the trip. A turn whose message asks for no move refuses travel.
describe('travel: only an explicit request moves the conversation', () => {
  // travel-guard-live 2026-10-15: after this refusal DeepSeek v4.1 flash told the user it had moved
  // (3 of 20 runs). The note says the conversation stays, forbids the claim, and names how to move.
  it('pins the refusal to its literal: a typed status the model is told to answer with read_period', () => {
    expect(TRAVEL_NOT_ASKED).toEqual({
      status: 'refused',
      reason: 'not_asked',
      note: 'The user did not ask to move this conversation, so it stays where it is. Answer their question here: read the time they asked about with read_period. Do not say the conversation moved or the trip ended. If they want to move, they can use the Time travel control, or say "back to today" or "take me to May 2019".',
    });
  });

  it.each([
    [{ to: 'today', place: null }],
    [{ to: '2019-05', place: 'Pune' }],
  ])('a turn that did not ask to move refuses %j and records nothing', async (args) => {
    const { tool, record, lookup } = travelSetup({ grant: { kind: 'none' } });
    expect(await go(tool, args)).toEqual(TRAVEL_NOT_ASKED);
    expect(record).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('a turn that asked to move still moves', async () => {
    const { tool, record } = travelSetup({ grant: { kind: 'asked' } });
    expect(await go(tool, { to: 'today', place: null })).toEqual({ status: 'queued', action: 'back_to_today' });
    expect(record).toHaveBeenCalledWith({ kind: 'back_to_today' });
  });

  // travel-guard-live 2026-10-15 (GPT Luna, round 2): "I'm done with September 2017. Leave this trip
  // and tell me my outlook today." was answered in place in 4 of 10 runs; leaving is a move to today.
  it('names leaving a trip as a move back to today', () => {
    const { tool } = travelSetup();
    expect(tool.description).toContain('"back to today" or "leave this trip" -> {"to":"today","place":null}.');
  });

  it('says so in its description: an explicit request only, else read_period', () => {
    const { tool } = travelSetup();
    expect(tool.description).toContain('Only when the user asks to move ("take me to ...", "back to today") in this message, or names the place you asked for; a question about another time, today included, is answered here with read_period.');
  });
});

// Re-grade of PR #366 (2026-10-15): a pending move granted ANY call on the next turn. With "take me
// to June 2019" pending, the reply "what's my moon sign?" queued {to:"1990", place:"Lisbon"}, and
// {to:"today"} queued a return. The grant is now bound: the same `to`, a place, a place answer.
describe('travel: a reply to a pending move finishes only that move', () => {
  const finish = (reply = 'Pune') => travelSetup({ grant: { kind: 'finish', to: '2019-05', reply } });

  it('pins the refusal to its literal', () => {
    expect(TRAVEL_NOT_PENDING).toEqual({
      status: 'refused',
      reason: 'not_pending_move',
      note: 'This reply can only finish the move you asked a place for: the same "to" as that call, with the place the user just named. Nothing moved. Answer their message here; do not say the conversation moved or the trip ended.',
    });
  });

  it.each(['Pune', 'Pune.', 'Pune?', 'I lived in Pune then'])('the same `to` with the place from %j queues the move', async (reply) => {
    const { tool, record } = finish(reply);
    expect(await go(tool, { to: '2019-05', place: 'Pune' })).toMatchObject({ status: 'queued', action: 'travel', place_label: 'Pune, India' });
    expect(record).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['another year', 'Pune', { to: '1990', place: 'Pune' }],
    ['the same year at another precision', 'Pune', { to: '2019', place: 'Pune' }],
    ['another month', 'Pune', { to: '2019-06', place: 'Pune' }],
    ['back to today', 'Pune', { to: 'today', place: null }],
    ['back to today at home', 'Pune', { to: 'today', place: 'home' }],
    ['no place', 'Pune', { to: '2019-05', place: null }],
    ['a reply that asks something else', "actually, what's my moon sign?", { to: '2019-05', place: 'Pune' }],
    ['a reply that asks something else (es)', '¿y mi carrera?', { to: '2019-05', place: 'Pune' }],
    ['a reply that asks something else (pt)', 'e a minha carreira?', { to: '2019-05', place: 'Pune' }],
  ])('%s is refused and records nothing', async (_case, reply, args) => {
    const { tool, record, lookup } = finish(reply);
    expect(await go(tool, args as TravelArgs)).toEqual(TRAVEL_NOT_PENDING);
    expect(record).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe('travel: the schema the model fills', () => {
  it('is named travel and describes when to move (audit 4.3)', () => {
    const { tool } = travelSetup();
    expect(tool.name).toBe(TRAVEL_TOOL_NAME);
    expect(TRAVEL_TOOL_NAME).toBe('travel');
    expect(tool.description).toContain('Move this conversation and the Dashboard to a day, month or year (a time-travel trip), or back to today.');
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

  // travel-guard-live 2026-10-15 (DeepSeek v4.1 flash, "Leave this trip and tell me my outlook
  // today"): the call {"to":"today","place":"home"} was sent back, the model read today instead,
  // and the trip stayed. Today is where the user lives now, so "home" says nothing more: accepted.
  it('back to today accepts place "home": today is where the user lives now', async () => {
    const { tool, record } = travelSetup();
    expect(issues(tool, { to: 'today', place: 'home' })).toEqual([]);
    expect(issues(tool, { to: 'today', place: 'Home' })).toEqual([]);
    expect(await go(tool, { to: 'today', place: 'home' })).toEqual({ status: 'queued', action: 'back_to_today' });
    expect(record).toHaveBeenCalledWith({ kind: 'back_to_today' });
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

  // Names Pune since the Task 11 ruling: a trip with no place now asks where (see below).
  it('a year is read from the date precision', async () => {
    const { tool, record } = travelSetup();
    expect(await go(tool, { to: '2020', place: 'Pune' })).toMatchObject({ status: 'queued', period_label: '2020' });
    expect(record.mock.calls[0]?.[0]?.asOf).toMatchObject({ start: '2020-01-01', end: '2020-12-31', granularity: 'year' });
  });

  it('a month with no place keeps the trip the user is on', async () => {
    const { tool, record } = travelSetup({ threadPlace: TRIP });
    expect(await go(tool, { to: '2019-09', place: null })).toMatchObject({ place_label: 'Vadodara, India', time_zone: 'Asia/Kolkata' });
    expect(record.mock.calls[0]?.[0]?.asOf.place).toEqual(TRIP);
  });

  // CONTRACT REVERSED (Task 11 ruling, 2026-10-14): a month with no place from a today thread used to
  // record a placeless trip. Every trip needs a place and none is assumed (071faf4f), so it now asks.
  it('from a today thread a month with no place asks where, and records nothing', async () => {
    const { tool, record } = travelSetup();
    expect(await go(tool, { to: '2019-09', place: null })).toEqual(TRAVEL_NEEDS_PLACE);
    expect(record).not.toHaveBeenCalled();
  });

  // Task 11: Settings' "Where do you live now?" is never assumed for another time.
  describe('where the user lives now is never assumed for a trip', () => {
    const NOVATO = { label: 'Novato, California, United States', timezone: 'America/Los_Angeles', latitude: 38.1074, longitude: -122.5697 };

    it.each([
      { to: '2019-09', place: null },
      { to: '2019', place: null },
      { to: '2027-03', place: null },
      { to: '2019-09', place: 'trip' },
    ])('%j from a today thread asks where the user lived then; nothing recorded', async (args) => {
      const { tool, record } = travelSetup({ homePlace: NOVATO });
      expect(await go(tool, args)).toEqual(TRAVEL_NEEDS_PLACE);
      expect(record).not.toHaveBeenCalled();
    });

    it('a day with no place still asks where the user was that day (never home)', async () => {
      const { tool, record } = travelSetup({ homePlace: NOVATO });
      expect(await go(tool, { to: '2019-03-14', place: null })).toEqual({ status: 'needs_place', ask: 'Ask where the user was that day.' });
      expect(record).not.toHaveBeenCalled();
    });

    it('"home" said outright pins the current place, coordinates kept on the device', async () => {
      const { tool, record } = travelSetup({ homePlace: NOVATO });
      expect(await go(tool, { to: '2019-09', place: 'home' })).toEqual({
        status: 'queued', action: 'travel', period_label: 'September 2019', place_label: NOVATO.label, time_zone: 'America/Los_Angeles',
      });
      expect(record.mock.calls[0]?.[0]?.asOf.place).toEqual(NOVATO);
    });

    it('on a trip, no place still keeps the trip place, not home', async () => {
      const { tool, record } = travelSetup({ homePlace: NOVATO, threadPlace: TRIP });
      expect(await go(tool, { to: '2019-09', place: null })).toMatchObject({ place_label: 'Vadodara, India' });
      expect(record.mock.calls[0]?.[0]?.asOf.place).toEqual(TRIP);
    });
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

describe('travel: at most once per turn (dashboard.agentic.real run A called it twice, 2026-10-14)', () => {
  it('says so in its description', () => {
    const { tool } = travelSetup();
    expect(tool.description).toContain('Call it at most once per turn.');
  });

  it('a call past the loop budget gets the neutral "already travelled" note', () => {
    const { tool } = travelSetup();
    expect(tool.overLimitNote).toBe('Already travelled this turn; the move happens after your answer.');
  });

  it('a second queued move in the same turn records nothing and returns the neutral skipped note', async () => {
    const { tool, record } = travelSetup();
    await expect(go(tool, { to: '2017-09', place: 'Pune' })).resolves.toMatchObject({ status: 'queued' });
    await expect(go(tool, { to: '2017-10', place: 'Pune' })).resolves.toEqual({
      status: 'skipped', note: 'Already travelled this turn; the move happens after your answer.',
    });
    await expect(go(tool, { to: 'today', place: null })).resolves.toMatchObject({ status: 'skipped' });
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('a neutral place ask is not a move: the call after it can still travel', async () => {
    const { tool, record } = travelSetup();
    await expect(go(tool, { to: '2017-09', place: null })).resolves.toEqual(TRAVEL_NEEDS_PLACE);
    await expect(go(tool, { to: '2017-09', place: 'Pune' })).resolves.toMatchObject({ status: 'queued' });
    expect(record).toHaveBeenCalledTimes(1);
  });
});

describe('travel: back to today needs no read before the answer', () => {
  it('a queued return unlocks answer; a queued trip or an ask does not', () => {
    const { tool } = travelSetup();
    expect(tool.unlocksAnswer?.({ status: 'queued', action: 'back_to_today' })).toBe(true);
    expect(tool.unlocksAnswer?.({ status: 'queued', action: 'travel', period_label: 'May 2019' })).toBe(false);
    expect(tool.unlocksAnswer?.(TRAVEL_NEEDS_PLACE)).toBe(false);
    expect(tool.unlocksAnswer?.(null)).toBe(false);
  });
});

// Harish 2026-10-16: the phrase gate is the fast path, not the only one. A call the gate refused,
// when the page can offer a button, returns a typed needs_confirmation and offers the move to the
// user: nothing moves until they tap.
describe('travel: a call the phrase gate closed becomes an offer', () => {
  const offered = (overrides: Partial<TravelToolInput> = {}) => {
    const offer = vi.fn();
    return { offer, ...travelSetup({ grant: { kind: 'none' }, offer, ...overrides }) };
  };

  it('tells the model in its description that an unasked move is only offered, never claimed', () => {
    const { tool } = offered();
    expect(tool.description).toContain('Without that request nothing moves: the app offers the user a "Move to" button under your answer, so never say you moved.');
  });

  it('returns needs_confirmation with the exact to and place, records only the offer', async () => {
    const { tool, record, offer } = offered();
    const result = await go(tool, { to: '2019-05', place: 'Pune' });
    expect(result).toMatchObject({ status: 'needs_confirmation', action: 'travel', to: '2019-05', place: 'Pune, India', period_label: 'May 2019' });
    expect(record).not.toHaveBeenCalled();
    expect(offer).toHaveBeenCalledTimes(1);
    expect(offer).toHaveBeenCalledWith({
      kind: 'travel',
      asOf: periodAsOfFromDraft({ granularity: 'month', day: '2019-05-01', month: '2019-05', year: 2019, place: { label: 'Pune, India', timezone: 'Asia/Kolkata', latitude: 18.5204, longitude: 73.8567 } }),
    });
  });

  it('pins the note to its literal: nothing moved, the user decides with a tap', async () => {
    const { tool } = offered();
    const result = await go(tool, { to: '2019-05', place: 'Pune' });
    expect((result as { note: string }).note).toBe(
      'Nothing moved. The app shows the user a "Move to" button under your answer; the conversation moves only if they tap it. Answer their question here: read the time they asked about with read_period. Do not say the conversation moved or the trip ended.',
    );
  });

  it('offers back to today without a place', async () => {
    const { tool, record, offer } = offered();
    expect(await go(tool, { to: 'today', place: null })).toMatchObject({ status: 'needs_confirmation', action: 'back_to_today', to: 'today' });
    expect(offer).toHaveBeenCalledWith({ kind: 'back_to_today' });
    expect(record).not.toHaveBeenCalled();
  });

  it('never puts coordinates in the result the model reads', async () => {
    const { tool } = offered();
    const text = JSON.stringify(await go(tool, { to: '2019-05', place: 'Pune' }));
    for (const pattern of COORDINATE_LIKE) expect(text).not.toMatch(pattern);
  });

  it('a place that cannot be found still says so, with no offer', async () => {
    const { tool, offer } = offered();
    expect(await go(tool, { to: '2019-05', place: 'Nowhereville' })).toMatchObject({ status: 'place_not_found' });
    expect(offer).not.toHaveBeenCalled();
  });

  // Northstar on PR #377: an offered call that returned needs_place was read as a pending move, so the
  // user's answer ("Mumbai") finished it with no tap. An unasked call never asks for a place.
  it('an offered call with no place is refused as not asked: nothing pending, no offer', async () => {
    const { tool, offer } = offered();
    expect(await go(tool, { to: '2019-05', place: null })).toEqual(TRAVEL_NOT_ASKED);
    expect(offer).not.toHaveBeenCalled();
  });

  it('an offered call with an ambiguous place never opens the picker', async () => {
    const { tool, offer, pick } = offered();
    expect(await go(tool, { to: '2019-05', place: 'Springfield' })).toMatchObject({ status: 'place_not_chosen' });
    expect(pick).not.toHaveBeenCalled();
    expect(offer).not.toHaveBeenCalled();
  });

  it('a second call in the turn offers nothing more', async () => {
    const { tool, offer } = offered();
    await go(tool, { to: '2019-05', place: 'Pune' });
    expect(await go(tool, { to: '2018-05', place: 'Pune' })).toMatchObject({ status: 'skipped' });
    expect(offer).toHaveBeenCalledTimes(1);
  });

  it('a wrong reply to a pending move is still refused, with no offer', async () => {
    const { tool, offer } = offered({ grant: { kind: 'finish', to: '2019-05', reply: "what's my moon sign?" } });
    expect(await go(tool, { to: '1990', place: 'Pune' })).toEqual(TRAVEL_NOT_PENDING);
    expect(offer).not.toHaveBeenCalled();
  });

  it('a turn that asked to move moves, and offers nothing', async () => {
    const offer = vi.fn();
    const { tool, record } = travelSetup({ grant: { kind: 'asked' }, offer });
    expect(await go(tool, { to: '2019-05', place: 'Pune' })).toMatchObject({ status: 'queued' });
    expect(record).toHaveBeenCalledTimes(1);
    expect(offer).not.toHaveBeenCalled();
  });
});
