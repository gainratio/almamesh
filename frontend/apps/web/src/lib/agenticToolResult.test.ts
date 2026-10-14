import { describe, expect, it } from 'vitest';

import { parseCompletedToolResult } from '../../e2e/agenticToolResult.helpers';

// Contract reversed 2026-10-14 (chat tool layer redesign): tool results reach the provider as the
// tool's own JSON value (the AI SDK tool loop), no longer wrapped in an {ok, value} envelope. The
// guard keeps its point: only a readable, error-free object result counts as a completed call.
const TRAVEL = { status: 'queued', action: 'travel', period_label: 'September 2017' };
const READING = {
  period: { start: '2017-09-01', end: '2017-09-30', granularity: 'month', label: 'September 2017', tense: 'past' },
  dashas: {
    maha: [{ lord: 'Jupiter', start: '2015-01-01', end: '2031-01-01' }],
    antar: [{ lord: 'Saturn', start: '2017-01-01', end: '2019-07-01' }],
  },
};

describe('real agentic tool result protocol', () => {
  it('reads the September movement result observed on the wire', () => {
    expect(parseCompletedToolResult(JSON.stringify(TRAVEL))).toEqual(TRAVEL);
  });

  it('preserves exact period boundaries and calculated dasha rows of a read_period reading', () => {
    const result = parseCompletedToolResult(JSON.stringify(READING));
    expect(result).toEqual(READING);
    expect(result.period).toEqual(READING.period);
    expect(result.dashas).toEqual(READING.dashas);
  });

  it('reads Back to today without inventing a date or place', () => {
    const value = { status: 'queued', action: 'back_to_today' };
    expect(parseCompletedToolResult(JSON.stringify(value))).toEqual(value);
  });

  it.each([
    ['a tool error', { error: 'Invalid period.' }],
    ['a success-looking result with an error', { ...TRAVEL, error: 'Invalid period.' }],
    ['an unavailable reading', { ...READING, available: false, reason: 'engine_unavailable' }],
    ['null', null],
    ['an array', [TRAVEL]],
    ['a string', 'queued'],
    ['a number', 1],
    ['a boolean', true],
  ])('rejects %s', (_label, value) => {
    expect(() => parseCompletedToolResult(JSON.stringify(value))).toThrow();
  });

  it.each([undefined, null, '', '{not JSON', 'Invalid input for tool read_period'])('rejects unreadable or absent content %s', (content) => {
    expect(() => parseCompletedToolResult(content)).toThrow();
  });
});
