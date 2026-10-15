// Per-turn context budget for the chat (spec 2026-10-13, "Context budget for
// the agentic loop", rules 1 and 6).
//
// One chat turn may run several model requests (reading rounds plus the answer).
// Each request resends the whole conversation so far, so the turn's context
// footprint is its largest request. That footprint may use at most half the
// model's context window; the other half is left for the model's own reasoning
// and answer. The composed prompt is sized here so the tool rounds still fit.
// Token counts are a deterministic character estimate (ceil(chars / 4)) that is
// scaled up, never down, once the provider reports what it actually counted.

import type { ChatPromptBudget } from "./prompt";
import { CLOUD_CHAT_BUDGET } from "./prompt";

/** The context window assumed for a model whose window is unknown (a small local model). */
export const DEFAULT_CONTEXT_TOKENS = 8_192;

/** Share of the context window one turn may fill. */
const TURN_SHARE = 0.5;

const CHARS_PER_TOKEN = 4;

/** Below this window the composed chat prompt is capped so tool rounds still fit. */
const SMALL_CONTEXT_TOKENS = 65_536;
/**
 * Share of the turn budget the composed prompt (system + history + user turn) may
 * fill on a small window. The rest carries the tool schemas (about 1.7k tokens for
 * the trip toolset) and one round of compact results. 0.5 left too little: an 8k
 * six-turn trip thread's answer request reached 4,183 of 4,096 (P1 drive 2026-10-13).
 */
const SMALL_PROMPT_SHARE = 0.4;

function validContext(contextTokens: number | undefined): number {
  return contextTokens !== undefined && Number.isSafeInteger(contextTokens) && contextTokens > 0
    ? contextTokens
    : DEFAULT_CONTEXT_TOKENS;
}

/** The most tokens any one request of a turn may carry: half the model's context window. */
export function turnTokenBudget(contextTokens: number | undefined): number {
  return Math.floor(TURN_SHARE * validContext(contextTokens));
}

/** Deterministic prompt estimate for one request: ceil(chars / 4) of its messages and tool definitions. */
export function estimateRequestTokens(messages: readonly unknown[], tools: readonly unknown[]): number {
  return Math.ceil(JSON.stringify({ messages, tools }).length / CHARS_PER_TOKEN);
}

/** One earlier request's estimate and the provider's own input token count for it. */
export interface TokenCalibration {
  readonly estimate: number;
  readonly reported: number;
}

/** Scale an estimate by how far the provider's count ran over ours. Never scales down. */
export function calibratedEstimate(estimate: number, calibration: TokenCalibration | undefined): number {
  if (!calibration || calibration.estimate <= 0 || calibration.reported <= calibration.estimate) return estimate;
  return Math.ceil(estimate * (calibration.reported / calibration.estimate));
}

/**
 * The chat prompt sizing for a model's context window. Large windows keep
 * today's cloud sizing (snapshot-locked bytes). A small window caps the composed
 * prompt at SMALL_PROMPT_SHARE of the turn budget, so the rest is left for tool
 * schemas and tool results across rounds.
 */
export function chatPromptBudgetFor(contextTokens: number | undefined): ChatPromptBudget {
  const context = validContext(contextTokens);
  if (context >= SMALL_CONTEXT_TOKENS) return CLOUD_CHAT_BUDGET;
  const promptTokens = Math.floor(turnTokenBudget(context) * SMALL_PROMPT_SHARE);
  return {
    historyTokens: Math.min(CLOUD_CHAT_BUDGET.historyTokens, Math.floor(promptTokens / 2)),
    interpTokens: Math.min(CLOUD_CHAT_BUDGET.interpTokens, Math.floor(promptTokens / 4)),
    includeRawPredictive: false,
    promptTokens,
  };
}
