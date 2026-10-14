// The trip matrix's D3 ("What are the next 3 months like?", controller ruling, Task 10d): exactly one
// complete read_period over at least 3 consecutive months inside this month..3 months on, starting
// this month or next. This is a contract change from "any single month 0..3" (stricter, now that
// read_period reads ranges). The check lives in e2e/answerChecks.ts beside the answer checks.
// P1 (chat-springfield): the call that opened the picker named Springfield, and no travel row.
import { describe, expect, it } from 'vitest';

import {
  PLACE_CALL_MISS,
  SPAN_CALL_MISS,
  TRAVEL_ROW_MISS,
  placeCallMisses,
  spanCallMisses,
  spanFits,
  type CallRow,
  type RangeRow,
} from '../../../e2e/answerChecks';

/** Today is 14 Oct 2026: from 1 Oct 2026, a start by 30 Nov 2026, to 31 Jan 2027, 3+ months. */
const NEXT_3_MONTHS = { from: '2026-10-01', latestStart: '2026-11-30', to: '2027-01-31', minMonths: 3, minDays: 59 } as const;

function read(start: string, end: string, status = 'complete'): RangeRow {
  return { name: 'read_period', status, result: { period: { start, end } } };
}

describe('spanCallMisses (D3: one read over the next 3 months)', () => {
  it('pins the miss the matrix logs', () => {
    expect(SPAN_CALL_MISS).toBe('D3 not read in one call over 3+ consecutive months');
  });

  it.each([
    ['October to January (gpt-sol)', '2026-10-01', '2027-01-31'],
    ['November to January (deepseek)', '2026-11-01', '2027-01-31'],
    ['October to December', '2026-10-01', '2026-12-31'],
    ['from today to mid-January', '2026-10-14', '2027-01-13'],
  ])('passes one complete read over %s', (_label, start, end) => {
    expect(spanCallMisses([read(start, end)], NEXT_3_MONTHS)).toEqual([]);
    expect(spanFits({ start, end }, NEXT_3_MONTHS)).toBe(true);
  });

  it('ignores travel and answer rows and a failed read beside the one range call', () => {
    const rows: RangeRow[] = [
      { name: 'travel', status: 'complete', result: { status: 'queued' } },
      read('2026-10-01', '2027-01-31', 'error'),
      read('2026-10-01', '2027-01-31'),
    ];
    expect(spanCallMisses(rows, NEXT_3_MONTHS)).toEqual([]);
  });

  it.each<[string, RangeRow[]]>([
    ['no read at all', []],
    ['one month only (the old contract passed this)', [read('2026-10-01', '2026-10-31')]],
    ['month by month', [read('2026-10-01', '2026-10-31'), read('2026-11-01', '2026-11-30'), read('2026-12-01', '2026-12-31')]],
    ['the range plus a second read', [read('2026-10-01', '2027-01-31'), read('2026-11-01', '2026-11-30')]],
    ['two months', [read('2026-10-01', '2026-11-30')]],
    ['a start in December', [read('2026-12-01', '2027-01-31')]],
    ['a start before October', [read('2026-09-01', '2026-12-31')]],
    ['an end past January', [read('2026-11-01', '2027-02-28')]],
    ['33 days that touch 3 calendar months (30 Nov to 1 Jan)', [read('2026-11-30', '2027-01-01')]],
    ['a read with no period', [{ name: 'read_period', status: 'complete', result: { same_as: 'call_1' } }]],
    ['a read with a null result', [{ name: 'read_period', status: 'complete', result: null }]],
  ])('misses on %s', (_label, rows) => {
    const misses = spanCallMisses(rows, NEXT_3_MONTHS);
    expect(misses).toHaveLength(1);
    expect(misses[0]?.startsWith(SPAN_CALL_MISS)).toBe(true);
  });

  it('says what was read, so the log explains the miss', () => {
    expect(spanCallMisses([read('2026-10-01', '2026-11-30')], NEXT_3_MONTHS)).toEqual([`${SPAN_CALL_MISS}; read 2026-10-01..2026-11-30`]);
  });
});

function call(name: string, place: string | null, status = 'complete'): CallRow {
  return { name, status, args: { start: '2019-05', end: null, place, time: null, focus: null } };
}

describe('placeCallMisses (P1: the read that opened the picker named Springfield, and no travel)', () => {
  it('pins the misses the matrix logs', () => {
    expect(PLACE_CALL_MISS).toBe('no complete read_period named the place');
    expect(TRAVEL_ROW_MISS).toBe('a travel row in a place question');
  });

  it('passes one complete read whose place names Springfield', () => {
    expect(placeCallMisses([call('read_period', 'Springfield')], /Springfield/)).toEqual([]);
    expect(placeCallMisses([call('read_period', null), call('read_period', 'Springfield, IL')], /Springfield/)).toEqual([]);
  });

  it.each<[string, CallRow[], string[]]>([
    ['no read', [], [`${PLACE_CALL_MISS} /Springfield/`]],
    ['a read at home (place null)', [call('read_period', null)], [`${PLACE_CALL_MISS} /Springfield/`]],
    ['a failed read that named it', [call('read_period', 'Springfield', 'error')], [`${PLACE_CALL_MISS} /Springfield/`]],
    ['a travel row beside the read', [call('read_period', 'Springfield'), call('travel', 'Springfield')], [TRAVEL_ROW_MISS]],
  ])('misses on %s', (_label, rows, misses) => {
    expect(placeCallMisses(rows, /Springfield/)).toEqual(misses);
  });
});
