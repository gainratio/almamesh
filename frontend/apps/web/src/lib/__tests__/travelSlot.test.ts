import { describe, expect, it } from 'vitest';
import { createTravelSlot, draftFromToolArgs } from '../travelSlot';

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

  it('keeps an offer apart from a move: offering queues no move, take empties it', () => {
    const slot = createTravelSlot();
    const asOf = { start: '2019-03-01', end: '2019-03-31', granularity: 'month' as const };
    slot.offer({ kind: 'travel', asOf });
    expect(slot.take()).toBeUndefined();
    asOf.start = '2020-03-01';
    expect(slot.takeOffer()).toMatchObject({ kind: 'travel', asOf: { start: '2019-03-01' } });
    expect(slot.takeOffer()).toBeUndefined();
  });

  it('builds byte-equal day/month/year drafts', () => {
    expect(draftFromToolArgs('year', '2027')).toEqual({ granularity: 'year', day: '2027-01-01', month: '2027-01', year: 2027 });
    expect(draftFromToolArgs('month', '2019-03')).toEqual({ granularity: 'month', day: '2019-03-01', month: '2019-03', year: 2019 });
  });
});
