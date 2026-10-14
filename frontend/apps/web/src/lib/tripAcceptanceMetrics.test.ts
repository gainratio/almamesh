import { describe, expect, it } from 'vitest';

import { formatModelMetrics, modelMetrics } from '../../scripts/tripAcceptanceMetrics.mjs';

const line = (over: Record<string, unknown>) => ({ model: 'm', question: 'q', pass: true, rounds: 3, calls: 4, validFirstTry: 3, retries: 1, errorRows: 1, ...over });

describe('trip acceptance metrics (the per-model numbers the report prints)', () => {
  it('averages rounds, calls, retries and error rows per question, and first-try-valid over all calls', () => {
    const [metrics] = modelMetrics([line({}), line({ pass: false, rounds: 5, calls: 6, validFirstTry: 6, retries: 0, errorRows: 0 })]);
    expect(metrics).toEqual({
      model: 'm', questions: 2, passed: 1, measured: 2,
      roundsPerQuestion: 4, callsPerQuestion: 5, firstTryValidPct: 90, retriesPerQuestion: 0.5, errorRowsPerQuestion: 0.5,
    });
  });

  it('keeps models apart, in log order', () => {
    expect(modelMetrics([line({ model: 'a' }), line({ model: 'b', rounds: 1 })]).map((row) => [row.model, row.roundsPerQuestion])).toEqual([['a', 3], ['b', 1]]);
  });

  it('a log written before these fields existed reports them as unmeasured, not zero', () => {
    const [metrics] = modelMetrics([{ model: 'm', question: 'q', pass: true }]);
    expect(metrics?.measured).toBe(0);
    expect(metrics?.roundsPerQuestion).toBeNull();
    expect(metrics?.firstTryValidPct).toBeNull();
    expect(formatModelMetrics(modelMetrics([{ model: 'm', question: 'q', pass: true }]))).toContain('| m | 1/1 | - | - | - | - | - |');
  });

  it('a turn with no tool calls has no first-try-valid rate', () => {
    expect(modelMetrics([line({ calls: 0, validFirstTry: 0, retries: 0, errorRows: 0 })])[0]?.firstTryValidPct).toBeNull();
  });

  it('prints one table row per model', () => {
    const text = formatModelMetrics(modelMetrics([line({}), line({ pass: false, rounds: 5, calls: 6, validFirstTry: 6, retries: 0, errorRows: 0 })]));
    expect(text.split('\n')[0]).toBe('| model | pass | rounds/question | first-try-valid % | retries/question | error rows/question | calls/question |');
    expect(text).toContain('| m | 1/2 | 4.00 | 90.0 | 0.50 | 0.50 | 5.00 |');
  });
});
