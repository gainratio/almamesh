import type { AgentRoundUsage, AgentToolCallRecord } from '@almamesh/llm';
import { describe, expect, it } from 'vitest';

import { agentCallRows, agentRoundRows, beginAgentTurn, clearAgentRoundsForTest, recordAgentCall } from '../agentRoundTelemetry';

const ROW: AgentRoundUsage = { round: 1, phase: 'decision', prompt_tokens: 10, completion_tokens: 2, estimated: false, estimate: 9, budget: 4096, compacted: 0 };
const CALL: AgentToolCallRecord = { toolCallId: 'c1', toolName: 'get_period_reading', args: {}, result: {}, status: 'complete' };

describe('agent round telemetry (dev diagnostics only, in memory)', () => {
  it('numbers each turn and keeps its rounds in order', () => {
    clearAgentRoundsForTest();
    const first = beginAgentTurn();
    first.onRoundUsage({ ...ROW, round: 1 });
    first.onRoundUsage({ ...ROW, round: 2, phase: 'final' });
    beginAgentTurn().onRoundUsage({ ...ROW, round: 1 });
    expect(agentRoundRows().map((row) => [row.turn, row.round])).toEqual([[1, 1], [1, 2], [2, 1]]);
  });

  it('keeps only the newest 64 rows', () => {
    clearAgentRoundsForTest();
    const record = beginAgentTurn();
    for (let round = 1; round <= 70; round += 1) record.onRoundUsage({ ...ROW, round });
    const rows = agentRoundRows();
    expect(rows).toHaveLength(64);
    expect(rows[0]?.round).toBe(7);
  });

  it('hands out a copy, so a reader cannot rewrite the log', () => {
    clearAgentRoundsForTest();
    beginAgentTurn().onRoundUsage(ROW);
    (agentRoundRows() as unknown as unknown[]).length = 0;
    expect(agentRoundRows()).toHaveLength(1);
  });
});

describe('agent call telemetry (dev diagnostics only, in memory)', () => {
  it('an error call was not valid on its first try; a complete call was', () => {
    clearAgentRoundsForTest();
    const turn = beginAgentTurn();
    turn.onRoundUsage({ ...ROW, round: 1 });
    turn.onToolCall({ ...CALL, toolName: 'resolve_place', status: 'error' });
    turn.onToolCall({ ...CALL, status: 'complete' });
    expect(agentCallRows()).toEqual([
      { turn: 1, round: 1, name: 'resolve_place', status: 'error', validFirstTry: false },
      { turn: 1, round: 1, name: 'get_period_reading', status: 'complete', validFirstTry: true },
    ]);
  });

  it('a call belongs to the latest round of its own turn', () => {
    clearAgentRoundsForTest();
    const first = beginAgentTurn();
    first.onRoundUsage({ ...ROW, round: 1 });
    first.onRoundUsage({ ...ROW, round: 2 });
    first.onToolCall(CALL);
    const second = beginAgentTurn();
    second.onToolCall({ ...CALL, toolName: 'grounding_before_any_request' });
    second.onRoundUsage({ ...ROW, round: 1 });
    second.onToolCall({ ...CALL, status: 'skipped' });
    expect(agentCallRows().map((row) => [row.turn, row.round, row.status, row.validFirstTry])).toEqual([
      [1, 2, 'complete', true],
      [2, 0, 'complete', true],
      [2, 1, 'skipped', true],
    ]);
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
