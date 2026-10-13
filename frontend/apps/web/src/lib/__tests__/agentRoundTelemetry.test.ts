import type { AgentRoundUsage } from '@almamesh/llm';
import { describe, expect, it } from 'vitest';

import { agentRoundRows, beginAgentTurn, clearAgentRoundsForTest } from '../agentRoundTelemetry';

const ROW: AgentRoundUsage = { round: 1, phase: 'decision', prompt_tokens: 10, completion_tokens: 2, estimated: false, estimate: 9, budget: 4096, compacted: 0 };

describe('agent round telemetry (dev diagnostics only, in memory)', () => {
  it('numbers each turn and keeps its rounds in order', () => {
    clearAgentRoundsForTest();
    const first = beginAgentTurn();
    first({ ...ROW, round: 1 });
    first({ ...ROW, round: 2, phase: 'final' });
    beginAgentTurn()({ ...ROW, round: 1 });
    expect(agentRoundRows().map((row) => [row.turn, row.round])).toEqual([[1, 1], [1, 2], [2, 1]]);
  });

  it('keeps only the newest 64 rows', () => {
    clearAgentRoundsForTest();
    const record = beginAgentTurn();
    for (let round = 1; round <= 70; round += 1) record({ ...ROW, round });
    const rows = agentRoundRows();
    expect(rows).toHaveLength(64);
    expect(rows[0]?.round).toBe(7);
  });

  it('hands out a copy, so a reader cannot rewrite the log', () => {
    clearAgentRoundsForTest();
    beginAgentTurn()(ROW);
    (agentRoundRows() as unknown as unknown[]).length = 0;
    expect(agentRoundRows()).toHaveLength(1);
  });
});
