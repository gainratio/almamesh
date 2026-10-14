import { describe, expect, it, vi } from 'vitest';
import { BEFORE_BIRTH_MESSAGE, NEEDS_PLACE_ERROR, PLACE_REF_ERROR } from '@almamesh/llm';
import { createTimeTravelTool } from '../legacyTimeTravelTool';
import { periodAsOfFromDraft } from '../timeTravelSheet';

// The old toolset's time_travel; deleted with chatToolset.ts in Task 6 of the chat tool layer redesign.
const BOGOTA = { summary: { place_ref: 'city:42', label: 'Bogotá, Colombia', timezone: 'America/Bogota' }, latitude: 4.60971, longitude: -74.08175 };
const context = () => ({ now: new Date('2026-10-11T12:00:00Z'), signal: new AbortController().signal });
function setup() {
  const record = vi.fn();
  const placeFromRef = vi.fn(async (ref: string) => ref === 'city:42' ? BOGOTA : undefined);
  return { record, placeFromRef, tool: createTimeTravelTool({ birthYear: 1990, language: 'en', record, placeFromRef }) };
}

describe('legacy time_travel (the old toolset until Task 6) records an action without moving the UI during the turn', () => {
  it('queues a month through the same draft as the sheet', async () => {
    const { tool, record } = setup();
    expect(await tool.execute({ action: 'travel', period: 'month', date: '2019-03' }, context()))
      .toEqual({ status: 'queued', action: 'travel', period_label: 'March 2019' });
    expect(record).toHaveBeenCalledWith({ kind: 'travel', asOf: periodAsOfFromDraft({ granularity: 'month', day: '2019-03-01', month: '2019-03', year: 2019 }) });
  });

  it('queues Back to today with no date, place or engine call', async () => {
    const { tool, record, placeFromRef } = setup();
    expect(await tool.execute({ action: 'back_to_today' }, context())).toEqual({ status: 'queued', action: 'back_to_today' });
    expect(record).toHaveBeenCalledWith({ kind: 'back_to_today' });
    expect(placeFromRef).not.toHaveBeenCalled();
  });

  it('requires a day place, and returns only safe labels after resolving it', async () => {
    const { tool, record } = setup();
    expect(await tool.execute({ action: 'travel', period: 'day', date: '2019-03-14' }, context())).toEqual({ error: NEEDS_PLACE_ERROR });
    expect(record).not.toHaveBeenCalled();
    const result = await tool.execute({ action: 'travel', period: 'day', date: '2019-03-14', place_ref: 'city:42' }, context());
    expect(result).toMatchObject({ status: 'queued', place_label: BOGOTA.summary.label, time_zone: BOGOTA.summary.timezone });
    expect(JSON.stringify(result)).not.toMatch(/latitude|longitude|4\.609|74\.081/);
    expect(record.mock.calls[0]?.[0]?.asOf.place).toMatchObject({ latitude: BOGOTA.latitude, longitude: BOGOTA.longitude });
  });

  it.each(['city:9', 'pinned', 42])('refuses an unknown place %j', async (place_ref) => {
    const { tool, record } = setup();
    expect(await tool.execute({ action: 'travel', period: 'day', date: '2019-03-14', place_ref }, context())).toEqual({ error: PLACE_REF_ERROR });
    expect(record).not.toHaveBeenCalled();
  });

  it('refuses before birth, and cancelled calls record nothing', async () => {
    const { tool, record } = setup();
    expect(await tool.execute({ action: 'travel', period: 'year', date: '1989' }, context())).toEqual({ error: BEFORE_BIRTH_MESSAGE });
    const controller = new AbortController();
    controller.abort();
    await expect(tool.execute({ action: 'back_to_today' }, { ...context(), signal: controller.signal })).rejects.toThrow();
    expect(record).not.toHaveBeenCalled();
  });

  it.each([
    { action: 'other' }, { action: 'travel', period: 'week', date: '2019' },
    { action: 'travel', period: 'month', date: '2019-13' },
    { action: 'travel', period: 'month', date: '2019-3' },
    { action: 'travel', period: 'year', date: '2053' },
    { action: 'travel', period: 'year', date: '1899' },
    { action: 'travel', period: 'day', date: '2019-02-30', place_ref: 'city:42' },
    { action: 'back_to_today', date: '2019' }, { action: 'back_to_today', extra: true },
  ])('refuses malformed input %j without recording it', async (args) => {
    const { tool, record } = setup();
    expect(await tool.execute(args, context())).toHaveProperty('error');
    expect(record).not.toHaveBeenCalled();
  });
});

describe('a Month or Year move keeps the trip the user is on (2026-10-13)', () => {
  const SINGAPORE = { label: 'Singapore', timezone: 'Asia/Singapore', latitude: 1.2897, longitude: 103.8501 };
  function onTrip(currentPlace?: typeof SINGAPORE) {
    const record = vi.fn();
    const placeFromRef = vi.fn(async (ref: string) => ref === 'city:42' ? BOGOTA : undefined);
    return { record, tool: createTimeTravelTool({ birthYear: 1990, language: 'en', record, placeFromRef, ...(currentPlace ? { currentPlace } : {}) }) };
  }

  it.each([['month', '2020-03'], ['year', '2020']] as const)('a %s move with no place inherits the current trip place, not the birth place', async (period, date) => {
    const { tool, record } = onTrip(SINGAPORE);
    const result = await tool.execute({ action: 'travel', period, date }, context());
    expect(result).toMatchObject({ status: 'queued', place_label: 'Singapore', time_zone: 'Asia/Singapore' });
    expect(record.mock.calls[0]?.[0]?.asOf.place).toEqual(SINGAPORE);
  });

  it('a month move may name its own place instead', async () => {
    const { tool, record } = onTrip(SINGAPORE);
    await tool.execute({ action: 'travel', period: 'month', date: '2020-03', place_ref: 'city:42' }, context());
    expect(record.mock.calls[0]?.[0]?.asOf.place).toMatchObject({ label: BOGOTA.summary.label });
  });

  it('from a today thread a month move has no place of its own (the trip reads the birth place)', async () => {
    const { tool, record } = onTrip();
    await tool.execute({ action: 'travel', period: 'month', date: '2020-03' }, context());
    expect(record.mock.calls[0]?.[0]?.asOf.place).toBeUndefined();
  });
});
