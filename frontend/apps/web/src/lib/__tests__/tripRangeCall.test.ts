// The trip matrix's T3 ("What about the rest of 2019?") must be read in ONE read_period call
// over a range that runs to 31 Dec 2019 (chat tool layer redesign, Task 9). The check lives in
// e2e/answerChecks.ts beside the answer checks; here it is held to that contract.
import { describe, expect, it } from 'vitest';

import { RANGE_CALL_MISS, rangeCallMisses, type RangeRow } from '../../../e2e/answerChecks';

const REST_OF_2019 = { startBy: '2019-06-01', end: '2019-12-31' } as const;

function read(start: string, end: string, status = 'complete'): RangeRow {
  return { name: 'read_period', status, result: { period: { start, end } } };
}

describe('rangeCallMisses (T3: one range call for the rest of 2019)', () => {
  it('pins the miss the matrix logs', () => {
    expect(RANGE_CALL_MISS).toBe('T3 not read in one range call');
  });

  it.each([
    ['June to December', '2019-06-01', '2019-12-31'],
    ['the whole year', '2019-01-01', '2019-12-31'],
    ['from mid-May', '2019-05-15', '2019-12-31'],
  ])('passes one complete read over %s', (_label, start, end) => {
    expect(rangeCallMisses([read(start, end)], REST_OF_2019)).toEqual([]);
  });

  it('ignores travel and answer rows and a failed read beside the one range call', () => {
    const rows: RangeRow[] = [
      { name: 'travel', status: 'complete', result: { status: 'queued' } },
      read('2019-06-01', '2019-12-31', 'error'),
      read('2019-06-01', '2019-12-31'),
    ];
    expect(rangeCallMisses(rows, REST_OF_2019)).toEqual([]);
  });

  it.each<[string, RangeRow[]]>([
    ['no read at all', []],
    ['two month-by-month reads', [read('2019-06-01', '2019-09-30'), read('2019-10-01', '2019-12-31')]],
    ['the range read plus a second read', [read('2019-06-01', '2019-12-31'), read('2019-10-01', '2019-12-31')]],
    ['one read that stops in September', [read('2019-06-01', '2019-09-30')]],
    ['one read that starts after June 1', [read('2019-07-01', '2019-12-31')]],
    ['one read that runs into 2020', [read('2019-06-01', '2020-01-31')]],
    ['a read with no period (a repeated call pointer)', [{ name: 'read_period', status: 'complete', result: { same_as: 'call_1' } }]],
    ['a read with a null result', [{ name: 'read_period', status: 'complete', result: null }]],
  ])('misses on %s', (_label, rows) => {
    expect(rangeCallMisses(rows, REST_OF_2019)).toEqual([RANGE_CALL_MISS]);
  });
});
