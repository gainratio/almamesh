import { describe, expect, it } from 'vitest';

import { formatModelMetrics, modelMetrics } from '../../scripts/tripAcceptanceMetrics.mjs';

// Since 2026-10-14 (Task 9 follow-up) a line splits its calls: `toolCalls`/`toolValidFirstTry` count read_period and
// travel only, `answerValidFirstTry` is 1 when the first answer submission was accepted, `answerRetries` counts
// rejected answers. `retries` and `errorRows` still count every call, the answer included.
const line = (over: Record<string, unknown>) => ({
  model: 'm', question: 'q', pass: true, rounds: 3, calls: 4, validFirstTry: 3, retries: 1, errorRows: 1,
  toolCalls: 2, toolValidFirstTry: 1, answerValidFirstTry: 0, answerRetries: 1, ...over,
});

describe('trip acceptance metrics (the per-model numbers the report prints)', () => {
  it('splits first-try validity into tool calls and answers, and averages the rest per question', () => {
    const [metrics] = modelMetrics([
      line({}),
      line({ pass: false, rounds: 5, retries: 0, errorRows: 0, toolCalls: 3, toolValidFirstTry: 3, answerValidFirstTry: 1, answerRetries: 0 }),
    ]);
    expect(metrics).toEqual({
      model: 'm', questions: 2, passed: 1, measured: 2, split: 2,
      roundsPerQuestion: 4, toolCallsPerQuestion: 2.5, toolFirstTryValidPct: 80, answerFirstTryValidPct: 50,
      retriesPerQuestion: 0.5, answerRetriesPerQuestion: 0.5, errorRowsPerQuestion: 0.5,
    });
  });

  it('keeps models apart, in log order', () => {
    expect(modelMetrics([line({ model: 'a' }), line({ model: 'b', rounds: 1 })]).map((row) => [row.model, row.roundsPerQuestion])).toEqual([['a', 3], ['b', 1]]);
  });

  it('a log written before these fields existed reports them as unmeasured, not zero', () => {
    const [metrics] = modelMetrics([{ model: 'm', question: 'q', pass: true }]);
    expect(metrics?.measured).toBe(0);
    expect(metrics?.roundsPerQuestion).toBeNull();
    expect(metrics?.toolFirstTryValidPct).toBeNull();
    expect(metrics?.answerFirstTryValidPct).toBeNull();
    expect(formatModelMetrics(modelMetrics([{ model: 'm', question: 'q', pass: true }]))).toContain('| m | 1/1 | - | - | - | - | - | - | - |');
  });

  it('a line from before the split keeps its rounds, retries and error rows but no split rates', () => {
    const old = { model: 'm', question: 'q', pass: true, rounds: 3, calls: 4, validFirstTry: 3, retries: 1, errorRows: 0 };
    const [metrics] = modelMetrics([old]);
    expect(metrics).toMatchObject({ measured: 1, split: 0, roundsPerQuestion: 3, retriesPerQuestion: 1, errorRowsPerQuestion: 0 });
    expect(metrics?.toolFirstTryValidPct).toBeNull();
    expect(metrics?.answerFirstTryValidPct).toBeNull();
    expect(metrics?.answerRetriesPerQuestion).toBeNull();
  });

  it('a turn with no tool calls has no tool first-try rate, but still an answer rate', () => {
    const [metrics] = modelMetrics([line({ toolCalls: 0, toolValidFirstTry: 0, answerValidFirstTry: 1 })]);
    expect(metrics?.toolFirstTryValidPct).toBeNull();
    expect(metrics?.answerFirstTryValidPct).toBe(100);
  });

  it('prints one table row per model', () => {
    const text = formatModelMetrics(modelMetrics([
      line({}),
      line({ pass: false, rounds: 5, retries: 0, errorRows: 0, toolCalls: 3, toolValidFirstTry: 3, answerValidFirstTry: 1, answerRetries: 0 }),
    ]));
    expect(text.split('\n')[0]).toBe('| model | pass | rounds/question | tool first-try-valid % | answer first-try-valid % | retries/question | answer retries/question | error rows/question | tool calls/question |');
    expect(text).toContain('| m | 1/2 | 4.00 | 80.0 | 50.0 | 0.50 | 0.50 | 0.50 | 2.50 |');
  });
});
