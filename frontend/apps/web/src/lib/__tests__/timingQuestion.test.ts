import { describe, expect, it } from 'vitest';
import { EPHEMERIS_LAST_YEAR } from '@almamesh/llm';

import { parseExplicitTimingPeriod } from '../timingQuestion';

const period = (start: string, end: string) => ({ kind: 'period', period: { start, end } });
const unresolved = (reason: 'ambiguous_period' | 'unsupported_period') => ({ kind: 'unresolved', reason });

describe('explicit timing question periods', () => {
  it.each([
    ['What will my career look like in June 2026?', '2026-06-01', '2026-06-30'],
    ['January 1900', '1900-01-01', '1900-01-31'],
    ['FEBRUARY 2024', '2024-02-01', '2024-02-29'],
    ['February 2026', '2026-02-01', '2026-02-28'],
    ['May 2026', '2026-05-01', '2026-05-31'],
    ['March 2026', '2026-03-01', '2026-03-31'],
    ['¿Cómo será junio de 2026?', '2026-06-01', '2026-06-30'],
    ['marzo 2026', '2026-03-01', '2026-03-31'],
    ['septiembre de 2026', '2026-09-01', '2026-09-30'],
    ['setiembre 2026', '2026-09-01', '2026-09-30'],
    ['Como será janeiro de 2026?', '2026-01-01', '2026-01-31'],
    ['março de 2026', '2026-03-01', '2026-03-31'],
    ['dezembro 2026', '2026-12-01', '2026-12-31'],
    ['June, 2026', '2026-06-01', '2026-06-30'],
    ['What about 2026-06?', '2026-06-01', '2026-06-30'],
    ['2024-02', '2024-02-01', '2024-02-29'],
    ['2026-06-09', '2026-06-09', '2026-06-09'],
    ['2024-02-29', '2024-02-29', '2024-02-29'],
    ['What about (2019-06-15)?', '2019-06-15', '2019-06-15'],
    ['Look at 2019-06-15.', '2019-06-15', '2019-06-15'],
    ['Will I get a job in 2026?', '2026-01-01', '2026-12-31'],
    ['1900', '1900-01-01', '1900-12-31'],
    ['What may happen in 2026?', '2026-01-01', '2026-12-31'],
    ['May I ask about June 2026?', '2026-06-01', '2026-06-30'],
    ['March forward with my career in June 2026', '2026-06-01', '2026-06-30'],
  ])('accepts a single literal calendar period: %s', (question, start, end) => {
    expect(parseExplicitTimingPeriod(question)).toEqual(period(start, end));
  });

  // Regression 2026-10-13: "Sep 2019" widened to all of 2019 (full month names only).
  it.each([
    ['what about Sep 2019?', '2019-09-01', '2019-09-30'],
    ['Sept 2019', '2019-09-01', '2019-09-30'],
    ['SEPT 2019', '2019-09-01', '2019-09-30'],
    ['sep. 2019', '2019-09-01', '2019-09-30'],
    ['Sept. 2019', '2019-09-01', '2019-09-30'],
    ['Jan 2020', '2020-01-01', '2020-01-31'],
    ['feb 2024', '2024-02-01', '2024-02-29'],
    ['Mar 2019', '2019-03-01', '2019-03-31'],
    ['Apr 2019', '2019-04-01', '2019-04-30'],
    ['May 2019', '2019-05-01', '2019-05-31'],
    ['Jun 2019', '2019-06-01', '2019-06-30'],
    ['Jul 2019', '2019-07-01', '2019-07-31'],
    ['Aug 2019', '2019-08-01', '2019-08-31'],
    ['Oct 2019', '2019-10-01', '2019-10-31'],
    ['Nov. 2019', '2019-11-01', '2019-11-30'],
    ['Dec 2019', '2019-12-01', '2019-12-31'],
    ['ene 2019', '2019-01-01', '2019-01-31'],
    ['abr. de 2019', '2019-04-01', '2019-04-30'],
    ['ago 2019', '2019-08-01', '2019-08-31'],
    ['dic. 2019', '2019-12-01', '2019-12-31'],
    ['fev 2019', '2019-02-01', '2019-02-28'],
    ['mai de 2019', '2019-05-01', '2019-05-31'],
    ['set 2019', '2019-09-01', '2019-09-30'],
    ['out. 2019', '2019-10-01', '2019-10-31'],
    ['dez de 2019', '2019-12-01', '2019-12-31'],
  ])('accepts an abbreviated month and year, never widening it to the year: %s', (question, start, end) => {
    expect(parseExplicitTimingPeriod(question)).toEqual(period(start, end));
  });

  it.each([
    ['What came out in 2019?', '2019-01-01', '2019-12-31'],
    ['Jan said 2019 was hard', '2019-01-01', '2019-12-31'],
    ['Two years ago, in 2019', '2019-01-01', '2019-12-31'],
    ['How did I set goals in 2019?', '2019-01-01', '2019-12-31'],
  ])('a short form that is also a common word needs calendar syntax: %s', (question, start, end) => {
    expect(parseExplicitTimingPeriod(question)).toEqual(period(start, end));
  });

  it.each(['Sep and Oct 2019', 'jan or feb 2020'])('clarifies two abbreviated months: %s', (question) => {
    expect(parseExplicitTimingPeriod(question)).toEqual(unresolved('ambiguous_period'));
  });

  it('uses the canonical engine upper bound inclusively', () => {
    expect(parseExplicitTimingPeriod(`${EPHEMERIS_LAST_YEAR}`)).toEqual(period(`${EPHEMERIS_LAST_YEAR}-01-01`, `${EPHEMERIS_LAST_YEAR}-12-31`));
    expect(parseExplicitTimingPeriod(`December ${EPHEMERIS_LAST_YEAR}`)).toEqual(period(`${EPHEMERIS_LAST_YEAR}-12-01`, `${EPHEMERIS_LAST_YEAR}-12-31`));
    expect(parseExplicitTimingPeriod(`${EPHEMERIS_LAST_YEAR + 1}`)).toEqual(unresolved('unsupported_period'));
  });

  it.each([
    'June or July 2026', 'May and June 2026', 'June 2026 and May',
    'June 2026 or June 2027', '2026 or 2027', '2026-2027',
    '2026-06 to 2026-07', '2026-06-01 through 2026-06-09',
    'From June to July 2026', 'June 1-15, 2026', 'June 1 to 15, 2026',
    'between June 2026 and July 2026', 'June 2026 / July 2026',
    'junio y julio de 2026', 'março e abril de 2026',
  ])('clarifies multiple periods or ranges: %s', (question) => {
    expect(parseExplicitTimingPeriod(question)).toEqual(unresolved('ambiguous_period'));
  });

  it.each([
    'October', 'in May', 'during March', 'junio', 'em março',
    'October 11', 'today, October 11', '11 October 2026', 'October 11, 2026',
    '11th of October 2026', '11 de octubre de 2026', '11 de março de 2026',
    'June in 2026', '2026 June', '06/09/2026', '09/06/2026', '06/2026',
    '2026/06', '2026-6', '2026-06-9', '2026-13', '2026-00',
    '2026-02-30', '2023-02-29', '2026-06-123', '1899', 'June 1899',
    '2053-01-01', 'June 2053', 'early June 2026', 'late 2026', 'mid-2026',
    'summer 2026', 'winter 2026', 'fall 2026', 'spring 2026',
    'Q1 2026', '2026 Q4', 'first quarter of 2026', 'second half of 2026',
    'beginning of 2026', 'end of June 2026', 'verano de 2026', 'verão de 2026',
    'from June 2026 onward', 'before 2026', 'after June 2026',
    'What happened in March?', 'what may happen in May?', '3 May was a big day',
    'Desde marco de 2020', 'Tudo mudou desde marco', 'Como foi março para mim?',
    'Como foi março para mim?'.normalize('NFD'),
    '2019-06-15T12:00:00Z', '2019-06-15t12:00:00z', '2019-06-15 12:00:00',
    '2019-06-15 at 12:00', '2019-06-15T12:00:00+05:30',
    '15.06.2019', '2019.06.15', '06.2019',
    '2017-09-xx', '2017-xx', '2017-09-??', '2017-09-', '2017-',
    '2019-06-15.5', '2019-06-15_invalid',
    'first week of June 2019', 'last day of June 2019', 'week 2 of June 2019',
    'first day of 2019', 'the week of June 2019',
    'primera semana de junio de 2019', 'primer día de junio de 2019',
    'última semana de junio de 2019', 'semana 2 de junio de 2019',
    'primeira semana de junho de 2019', 'primeiro dia de junho de 2019',
    'último dia de junho de 2019', 'semana 2 de junho de 2019',
  ])('keeps unsupported precision or vague periods unresolved: %s', (question) => {
    expect(parseExplicitTimingPeriod(question)).toEqual(unresolved('unsupported_period'));
  });

  it.each([
    '', 'Tell me about my career', 'May I have a reading?', 'What may happen?',
    'March forward with my career', 'Will Marco get a job?', 'Marco',
    'Will I fall in love?', 'today', 'hoy', 'hoje',
    'What may happen today?', 'Ask Marco about this week',
    'How should I march forward this month?',
  ])('leaves questions without an explicit period to the caller: %s', (question) => {
    expect(parseExplicitTimingPeriod(question)).toEqual({ kind: 'none' });
  });
});
