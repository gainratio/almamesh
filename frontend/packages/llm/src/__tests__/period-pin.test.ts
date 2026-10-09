import { describe, expect, it } from 'vitest';

import { pinRelative, pinnedPeriodRules } from '../index';

const YEAR_2027 = { start: '2027-01-01', end: '2027-12-31' };

describe('pinRelative', () => {
  it.each([
    ['2026-12-31', 'future'],
    ['2027-01-01', 'contains_today'],
    ['2027-06-15', 'contains_today'],
    ['2027-12-31', 'contains_today'],
    ['2028-01-01', 'past'],
  ] as const)('today %s is %s', (today, expected) => {
    expect(pinRelative(YEAR_2027, today)).toBe(expected);
  });

  it('a single-day pin contains only its own day', () => {
    const day = { start: '2026-06-15', end: '2026-06-15' };
    expect(pinRelative(day, '2026-06-14')).toBe('future');
    expect(pinRelative(day, '2026-06-15')).toBe('contains_today');
    expect(pinRelative(day, '2026-06-16')).toBe('past');
  });
});

describe('pinnedPeriodRules', () => {
  it.each([
    ['future', 'future tense'],
    ['past', 'past tense'],
    ['contains_today', 'present tense'],
  ] as const)('tells the model which tense to use when %s', (relative, tense) => {
    const rules = pinnedPeriodRules({ ...YEAR_2027, relative });
    expect(rules).toContain('PINNED PERIOD: this conversation is about 2027-01-01 to 2027-12-31');
    expect(rules).toContain('get_timing called without dates reads this period');
    expect(rules).toContain(tense);
    expect(rules).toContain('first and last day of the current month');
  });
});
