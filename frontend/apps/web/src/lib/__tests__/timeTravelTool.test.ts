import { describe, expect, it, vi } from 'vitest';
import { BEFORE_BIRTH_MESSAGE, NEEDS_PLACE_ERROR, PLACE_REF_ERROR } from '@almamesh/llm';
import { asOfFromDraft } from '../timeTravelSheet';
import { createTimeTravelTool, createTravelSlot, draftFromToolArgs } from '../timeTravelTool';

const BOGOTA = { summary: { place_ref: 'city:42', label: 'Bogotá, Colombia', timezone: 'America/Bogota' }, latitude: 4.60971, longitude: -74.08175 };
const context = () => ({ now: new Date('2026-10-11T12:00:00Z'), signal: new AbortController().signal });
function setup() {
  const record = vi.fn();
  const placeFromRef = vi.fn(async (ref: string) => ref === 'city:42' ? BOGOTA : undefined);
  return { record, placeFromRef, tool: createTimeTravelTool({ birthYear: 1990, language: 'en', record, placeFromRef }) };
}

describe('time_travel records an action without moving the UI during the turn', () => {
  it('queues a month through the same draft as the sheet', async () => {
    const { tool, record } = setup();
    expect(await tool.execute({ action: 'travel', period: 'month', date: '2019-03' }, context()))
      .toEqual({ status: 'queued', action: 'travel', period_label: 'March 2019' });
    expect(record).toHaveBeenCalledWith({ kind: 'travel', asOf: asOfFromDraft({ granularity: 'month', day: '2019-03-01', month: '2019-03', year: 2019 }) });
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

describe('travel slot', () => {
  it('last action wins, take empties it, and action values are copied', () => {
    const slot = createTravelSlot();
    const asOf = { start: '2019-03-01', end: '2019-03-31', granularity: 'month' as const };
    slot.record({ kind: 'travel', asOf });
    asOf.start = '2020-03-01';
    expect(slot.take()).toMatchObject({ asOf: { start: '2019-03-01' } });
    slot.record({ kind: 'travel', asOf });
    slot.record({ kind: 'back_to_today' });
    expect(slot.take()).toEqual({ kind: 'back_to_today' });
    expect(slot.take()).toBeUndefined();
  });

  it('builds byte-equal day/month/year drafts', () => {
    expect(draftFromToolArgs('year', '2027')).toEqual({ granularity: 'year', day: '2027-01-01', month: '2027-01', year: 2027 });
    expect(draftFromToolArgs('month', '2019-03')).toEqual({ granularity: 'month', day: '2019-03-01', month: '2019-03', year: 2019 });
  });
});
