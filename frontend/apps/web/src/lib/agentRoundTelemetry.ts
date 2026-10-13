/**
 * Per-round token telemetry for the chat agent loop (context budget spec
 * 2026-10-13, rule 7). Each model request of a turn records its prompt and
 * completion tokens, whether they were estimated, the turn budget and how many
 * tool results it carried compact.
 *
 * Dev diagnostics only: rows live in this tab's memory (newest 64), and in
 * dev or hook builds they are readable as `window.__almameshAgentRounds()`.
 * Nothing here is persisted or sent anywhere.
 */
import type { AgentRoundUsage } from '@almamesh/llm';

export interface AgentRoundRow extends AgentRoundUsage {
  /** Which chat turn of this tab the round belongs to (1-based). */
  readonly turn: number;
}

const MAX_ROWS = 64;
const rows: AgentRoundRow[] = [];
let turns = 0;

declare global {
  interface Window {
    __almameshAgentRounds?: () => readonly AgentRoundRow[];
  }
}

/** A copy of the recorded rows, oldest first. */
export function agentRoundRows(): readonly AgentRoundRow[] {
  return rows.slice();
}

/** Start a turn; the returned sink records that turn's rounds (pass it as `onRoundUsage`). */
export function beginAgentTurn(): (usage: AgentRoundUsage) => void {
  turns += 1;
  const turn = turns;
  return (usage) => {
    rows.push({ ...usage, turn });
    if (rows.length > MAX_ROWS) rows.splice(0, rows.length - MAX_ROWS);
  };
}

export function clearAgentRoundsForTest(): void {
  rows.length = 0;
  turns = 0;
}

if (typeof window !== 'undefined' && (import.meta.env.DEV || import.meta.env.VITE_EXIT_GATE_HOOKS === '1')) {
  window.__almameshAgentRounds = agentRoundRows;
}
