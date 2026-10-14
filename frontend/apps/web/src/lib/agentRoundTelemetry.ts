/**
 * Per-round token telemetry for the chat agent loop (context budget spec
 * 2026-10-13, rule 7). Each model request of a turn records its prompt and
 * completion tokens, whether they were estimated, the turn budget and how many
 * tool results it carried compact. Each tool call of a turn records its name,
 * status, the round that asked for it and whether it was valid on its first try
 * (tool layer redesign 2026-10-14: the trip matrix counts these per question).
 *
 * Dev diagnostics only: rows live in this tab's memory (newest 64 of each), and
 * in dev or hook builds they are readable as `window.__almameshAgentRounds()`
 * and `window.__almameshAgentCalls()`. Nothing here is persisted or sent anywhere.
 */
import type { AgentRoundUsage, AgentToolCallRecord } from '@almamesh/llm';

export interface AgentRoundRow extends AgentRoundUsage {
  /** Which chat turn of this tab the round belongs to (1-based). */
  readonly turn: number;
}

/** 'retried': the loop rejected the call's arguments and the model asked again (emitted by the new loop only). */
export type AgentCallStatus = 'complete' | 'error' | 'skipped' | 'retried';

export interface AgentCallRow {
  readonly turn: number;
  /** The latest model request of the turn when the call was reported; 0 before the first request. */
  readonly round: number;
  readonly name: string;
  readonly status: AgentCallStatus;
  readonly validFirstTry: boolean;
}

/** One turn's sinks: pass `onRoundUsage` and `onToolCall` to the agent loop. */
export interface AgentTurnTelemetry {
  readonly onRoundUsage: (usage: AgentRoundUsage) => void;
  readonly onToolCall: (record: AgentToolCallRecord) => void;
}

const MAX_ROWS = 64;
const rows: AgentRoundRow[] = [];
const calls: AgentCallRow[] = [];
let turns = 0;

declare global {
  interface Window {
    __almameshAgentRounds?: () => readonly AgentRoundRow[];
    __almameshAgentCalls?: () => readonly AgentCallRow[];
  }
}

function pushCapped<T>(list: T[], row: T): void {
  list.push(row);
  if (list.length > MAX_ROWS) list.splice(0, list.length - MAX_ROWS);
}

/** A copy of the recorded round rows, oldest first. */
export function agentRoundRows(): readonly AgentRoundRow[] {
  return rows.slice();
}

/** A copy of the recorded call rows, oldest first. */
export function agentCallRows(): readonly AgentCallRow[] {
  return calls.slice();
}

export function recordAgentCall(row: AgentCallRow): void {
  pushCapped(calls, row);
}

/**
 * Start a turn. The loop reports a call after the request that asked for it,
 * so a call belongs to the latest round seen. The current loop has no retry, so
 * a call was valid on its first try unless it ended in error.
 */
export function beginAgentTurn(): AgentTurnTelemetry {
  turns += 1;
  const turn = turns;
  let round = 0;
  return {
    onRoundUsage: (usage) => {
      round = usage.round;
      pushCapped(rows, { ...usage, turn });
    },
    onToolCall: (record) => {
      recordAgentCall({ turn, round, name: record.toolName, status: record.status, validFirstTry: record.status !== 'error' });
    },
  };
}

export function clearAgentRoundsForTest(): void {
  rows.length = 0;
  calls.length = 0;
  turns = 0;
}

if (typeof window !== 'undefined' && (import.meta.env.DEV || import.meta.env.VITE_EXIT_GATE_HOOKS === '1')) {
  window.__almameshAgentRounds = agentRoundRows;
  window.__almameshAgentCalls = agentCallRows;
}
