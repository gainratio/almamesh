import type { RoundEvent, ToolCallEvent } from '@almamesh/llm/toolLoop';
import { describe, expect, it } from 'vitest';

import { agentCallRows, agentRoundRows, beginAgentTurn, clearAgentRoundsForTest, recordAgentCall } from '../agentRoundTelemetry';

const BUDGET = { estimate: 12, estimated: false, budget: 4_096, compacted: 0 } as const;
const ROUND: RoundEvent = { round: 1, inputTokens: 10, outputTokens: 2, finishReason: 'tool-calls', ...BUDGET };
const CALL: ToolCallEvent = { round: 1, toolCallId: 'c1', toolName: 'read_period', args: {}, result: {}, status: 'complete', validFirstTry: true };

describe('agent round telemetry (dev diagnostics only, in memory)', () => {
  it('numbers each turn and keeps its rounds in order', () => {
    clearAgentRoundsForTest();
    const first = beginAgentTurn();
    first.onRound({ ...ROUND, round: 1 });
    first.onRound({ ...ROUND, round: 2 });
    beginAgentTurn().onRound({ ...ROUND, round: 1 });
    expect(agentRoundRows().map((row) => [row.turn, row.round])).toEqual([[1, 1], [1, 2], [2, 1]]);
  });

  it('keeps the provider token counts and why the round finished; unknown counts are null', () => {
    clearAgentRoundsForTest();
    beginAgentTurn().onRound({ round: 1, finishReason: 'stop', ...BUDGET, estimated: true });
    expect(agentRoundRows()).toEqual([{
      turn: 1, round: 1, phase: 'decision', input_tokens: null, output_tokens: null, finish_reason: 'stop',
      estimate: 12, estimated: true, budget: 4_096, compacted: 0,
    }]);
  });

  it("keeps the turn's budget, the request's estimate and how many results it carried compact", () => {
    clearAgentRoundsForTest();
    beginAgentTurn().onRound({ ...ROUND, estimate: 3_900, budget: 4_096, compacted: 2 });
    expect(agentRoundRows()[0]).toMatchObject({ estimate: 3_900, estimated: false, budget: 4_096, compacted: 2 });
  });

  it('the round that called answer is final, and so is the prose fallback', () => {
    clearAgentRoundsForTest();
    const turn = beginAgentTurn();
    turn.onToolCall({ ...CALL, round: 1 });
    turn.onRound({ ...ROUND, round: 1 });
    turn.onToolCall({ ...CALL, round: 2, toolName: 'answer' });
    turn.onRound({ ...ROUND, round: 2 });
    beginAgentTurn().onRound({ ...ROUND, finishReason: 'answer_fallback' });
    expect(agentRoundRows().map((row) => row.phase)).toEqual(['decision', 'final', 'final']);
  });

  it('a rejected answer does not make its round final', () => {
    clearAgentRoundsForTest();
    const turn = beginAgentTurn();
    turn.onToolCall({ ...CALL, toolName: 'answer', status: 'retried', validFirstTry: false });
    turn.onRound(ROUND);
    expect(agentRoundRows()[0]?.phase).toBe('decision');
  });

  it('keeps only the newest 64 rows', () => {
    clearAgentRoundsForTest();
    const record = beginAgentTurn();
    for (let round = 1; round <= 70; round += 1) record.onRound({ ...ROUND, round });
    const rows = agentRoundRows();
    expect(rows).toHaveLength(64);
    expect(rows[0]?.round).toBe(7);
  });

  it('hands out a copy, so a reader cannot rewrite the log', () => {
    clearAgentRoundsForTest();
    beginAgentTurn().onRound(ROUND);
    (agentRoundRows() as unknown as unknown[]).length = 0;
    expect(agentRoundRows()).toHaveLength(1);
  });
});

describe('agent call telemetry (dev diagnostics only, in memory)', () => {
  it('records each call with its own round, status and first-try validity', () => {
    clearAgentRoundsForTest();
    const turn = beginAgentTurn();
    turn.onToolCall({ ...CALL, status: 'retried', validFirstTry: false, result: 'start must be YYYY, YYYY-MM or YYYY-MM-DD' });
    turn.onToolCall({ ...CALL, round: 2, validFirstTry: false });
    turn.onToolCall({ ...CALL, round: 2, toolName: 'travel', status: 'skipped' });
    expect(agentCallRows()).toEqual([
      { turn: 1, round: 1, name: 'read_period', status: 'retried', validFirstTry: false, retryReason: 'start must be YYYY, YYYY-MM or YYYY-MM-DD' },
      { turn: 1, round: 2, name: 'read_period', status: 'complete', validFirstTry: false },
      { turn: 1, round: 2, name: 'travel', status: 'skipped', validFirstTry: true },
    ]);
  });

  it('a retried call keeps why: the first 300 characters of the error the model was sent', () => {
    clearAgentRoundsForTest();
    const why = `Invalid input for tool answer: maha lord must be one of: jupiter (from the reading) ${'x'.repeat(400)}`;
    beginAgentTurn().onToolCall({ ...CALL, toolName: 'answer', status: 'retried', validFirstTry: false, result: why });
    expect(agentCallRows()[0]?.retryReason).toBe(why.slice(0, 300));
    expect(agentCallRows()[0]?.retryReason).toHaveLength(300);
  });

  it("a schema rejection keeps the issues, not the rejected value the AI SDK puts first", () => {
    clearAgentRoundsForTest();
    const issues = [
      { code: 'invalid_type', expected: 'string', path: ['place'], message: 'place is required when kind is "period"' },
      { code: 'custom', path: ['dashas', 'maha', 'lord'], message: 'maha lord must be one of: jupiter (from the reading)' },
    ];
    const error = 'AI_InvalidToolInputError: Invalid input for tool answer: AI_TypeValidationError: Type validation failed: '
      + `Value: {"kind":"period","opening":"${'long text '.repeat(60)}"}.\nError message: ZodError: ${JSON.stringify(issues, null, 2)}`;
    beginAgentTurn().onToolCall({ ...CALL, toolName: 'answer', status: 'retried', validFirstTry: false, result: error });
    expect(agentCallRows()[0]?.retryReason).toBe('place: place is required when kind is "period"; dashas.maha.lord: maha lord must be one of: jupiter (from the reading)');
  });

  it('an error message that is not a list of issues keeps its text after "Error message:", whitespace collapsed', () => {
    clearAgentRoundsForTest();
    const error = 'Type validation failed: Value: {"to":"2019-13"}.\nError message: to must be   "today",\n YYYY, YYYY-MM or YYYY-MM-DD';
    beginAgentTurn().onToolCall({ ...CALL, toolName: 'travel', status: 'retried', validFirstTry: false, result: error });
    expect(agentCallRows()[0]?.retryReason).toBe('to must be "today", YYYY, YYYY-MM or YYYY-MM-DD');
  });

  it('a retried call whose error is not text keeps it as JSON', () => {
    clearAgentRoundsForTest();
    beginAgentTurn().onToolCall({ ...CALL, status: 'retried', validFirstTry: false, result: { issues: ['place'] } });
    expect(agentCallRows()[0]?.retryReason).toBe('{"issues":["place"]}');
  });

  it('only a retried call carries a retry reason', () => {
    clearAgentRoundsForTest();
    const turn = beginAgentTurn();
    turn.onToolCall({ ...CALL, result: 'fine' });
    turn.onToolCall({ ...CALL, status: 'error', result: 'engine failed' });
    expect(agentCallRows().map((row) => 'retryReason' in row)).toEqual([false, false]);
  });

  it('records a retried row as given and keeps only the newest 64 calls', () => {
    clearAgentRoundsForTest();
    for (let round = 1; round <= 70; round += 1) recordAgentCall({ turn: 1, round, name: 'x', status: 'retried', validFirstTry: false });
    const rows = agentCallRows();
    expect(rows).toHaveLength(64);
    expect(rows[0]?.round).toBe(7);
    expect(rows[0]?.status).toBe('retried');
  });

  it('hands out a copy, so a reader cannot rewrite the call log', () => {
    clearAgentRoundsForTest();
    beginAgentTurn().onToolCall(CALL);
    (agentCallRows() as unknown as unknown[]).length = 0;
    expect(agentCallRows()).toHaveLength(1);
  });
});
