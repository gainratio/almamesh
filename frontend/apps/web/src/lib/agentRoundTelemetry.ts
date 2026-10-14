/**
 * Per-round token telemetry for the chat tool loop (context budget spec
 * 2026-10-13, rule 7; tool layer redesign 2026-10-14). Each model request of a
 * turn records its input and output tokens and why it finished; each tool call
 * records its name, status, the round that asked for it and whether it was valid
 * on its first try (the trip matrix counts these per question); a retried call
 * also keeps why it was rejected (the start of the error the model was sent).
 *
 * Dev diagnostics only: rows live in this tab's memory (newest 64 of each), and
 * in dev or hook builds they are readable as `window.__almameshAgentRounds()`
 * and `window.__almameshAgentCalls()`. Nothing here is persisted or sent anywhere.
 */
import type { RoundEvent, ToolCallEvent, ToolCallStatus } from '@almamesh/llm/toolLoop';

export interface AgentRoundRow {
  /** Which chat turn of this tab the round belongs to (1-based). */
  readonly turn: number;
  readonly round: number;
  /** 'final': the request that answered (the `answer` call, or the prose fallback). */
  readonly phase: 'decision' | 'final';
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly finish_reason: string;
  /** Our estimate of the request (chars / 4, calibrated by the provider's earlier counts). */
  readonly estimate: number;
  /** True when the provider reported no input tokens. */
  readonly estimated: boolean;
  /** The turn's token budget: half the model's context window. */
  readonly budget: number;
  /** Tool results the request carried in their compact form. */
  readonly compacted: number;
}

export interface AgentCallRow {
  readonly turn: number;
  /** The model request that asked for the call. */
  readonly round: number;
  readonly name: string;
  /** 'retried': the loop rejected the call's arguments and the model asked again. */
  readonly status: ToolCallStatus;
  readonly validFirstTry: boolean;
  /** A retried call only: why, the first 300 characters of the error the model was sent. */
  readonly retryReason?: string;
}

/** One turn's sinks: pass `onRound` and `onToolCall` to the tool loop. */
export interface AgentTurnTelemetry {
  readonly onRound: (event: RoundEvent) => void;
  readonly onToolCall: (event: ToolCallEvent) => void;
}

const MAX_ROWS = 64;
const MAX_REASON_CHARS = 300;
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

/** A retried call's error as text: the loop hands it over as a string; anything else as JSON. */
function retryReasonOf(result: unknown): string {
  const text = typeof result === 'string' ? result : JSON.stringify(result) ?? String(result);
  return text.slice(0, MAX_REASON_CHARS);
}

/** The rounds that answered: the one that called `answer`, or the loop's prose fallback. */
const FINAL_REASONS = new Set(['answer_fallback']);

/** Start a turn. A call reports its own round; the answer call marks its round final. */
export function beginAgentTurn(): AgentTurnTelemetry {
  turns += 1;
  const turn = turns;
  let answerRound: number | undefined;
  return {
    onRound: (event) => {
      const final = event.round === answerRound || FINAL_REASONS.has(event.finishReason);
      pushCapped(rows, {
        turn, round: event.round, phase: final ? 'final' : 'decision',
        input_tokens: event.inputTokens ?? null, output_tokens: event.outputTokens ?? null, finish_reason: event.finishReason,
        estimate: event.estimate, estimated: event.estimated, budget: event.budget, compacted: event.compacted,
      });
    },
    onToolCall: (event) => {
      if (event.toolName === 'answer' && event.status === 'complete') answerRound = event.round;
      recordAgentCall({
        turn, round: event.round, name: event.toolName, status: event.status, validFirstTry: event.validFirstTry,
        ...(event.status === 'retried' ? { retryReason: retryReasonOf(event.result) } : {}),
      });
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
