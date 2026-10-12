import { describe, expect, it } from 'vitest';

import { parseSuccessfulToolResult } from '../../e2e/agenticToolResult.helpers';

const TRAVEL = { action: 'travel', status: 'queued', period_label: 'September 2017' };
const TIMING = {
  period: { start: '2017-09-01', end: '2017-09-30', basis: 'period' },
  section: 'dashas',
  shown: 'dashas',
  data: {
    maha: [{ lord: 'jupiter', start: '2015-01-01', end: '2031-01-01' }],
    antar: [{ lord: 'saturn', start: '2017-01-01', end: '2019-07-01' }],
  },
};

describe('real agentic tool result protocol', () => {
  it('unwraps the full successful September movement envelope observed in the live run', () => {
    expect(parseSuccessfulToolResult(JSON.stringify({ ok: true, value: TRAVEL }))).toEqual(TRAVEL);
  });

  it('preserves exact period boundaries, basis and calculated dasha rows from the successful envelope', () => {
    const result = parseSuccessfulToolResult(JSON.stringify({ ok: true, value: TIMING }));
    expect(result).toEqual(TIMING);
    expect(result.period).toEqual({ start: '2017-09-01', end: '2017-09-30', basis: 'period' });
    expect(result.data).toEqual(TIMING.data);
  });

  it('unwraps Back to today without inventing a date or place', () => {
    const value = { action: 'back_to_today', status: 'queued' };
    expect(parseSuccessfulToolResult(JSON.stringify({ ok: true, value }))).toEqual(value);
  });

  it.each([
    ['protocol failure', { ok: false, error: { code: 'tool_failed', message: 'Local tool failed.' } }],
    ['failure with a success-looking value', { ok: false, value: TRAVEL }],
    ['missing success flag', { value: TRAVEL }],
    ['truthy string success flag', { ok: 'true', value: TRAVEL }],
    ['truthy numeric success flag', { ok: 1, value: TRAVEL }],
    ['flat movement result', TRAVEL],
    ['flat period facts', TIMING],
    ['missing value', { ok: true }],
    ['null value', { ok: true, value: null }],
    ['array value', { ok: true, value: [TRAVEL] }],
    ['string value', { ok: true, value: 'queued' }],
    ['numeric value', { ok: true, value: 1 }],
    ['boolean value', { ok: true, value: true }],
    ['domain failure inside a successful protocol envelope', { ok: true, value: { error: 'Invalid period.' } }],
    ['success-looking value with a domain error', { ok: true, value: { ...TRAVEL, error: 'Invalid period.' } }],
    ['conflicting envelope error', { ok: true, value: TRAVEL, error: { code: 'tool_failed' } }],
    ['null envelope', null],
    ['array envelope', [TRAVEL]],
    ['string envelope', 'queued'],
    ['numeric envelope', 1],
    ['boolean envelope', true],
  ])('rejects %s', (_label, value) => {
    expect(() => parseSuccessfulToolResult(JSON.stringify(value))).toThrow();
  });

  it.each([undefined, null, '', '{not JSON'])('rejects unreadable or absent serialized content %s', (content) => {
    expect(() => parseSuccessfulToolResult(content)).toThrow();
  });
});
