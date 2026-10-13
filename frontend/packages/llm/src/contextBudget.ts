// Per-turn context budget for the agent loop (spec 2026-10-13, "Context budget for
// the agentic loop", rules 1 and 6).
//
// One chat turn may run several model requests (decision rounds plus a final
// answer). Each request resends the whole conversation so far, so the turn's
// context footprint is its largest request. That footprint may use at most half
// the model's context window; the other half is left for the model's own
// reasoning and answer. Token counts are a deterministic character estimate
// (ceil(chars / 4)) that is scaled up, never down, once the provider reports
// what it actually counted.

import type { ChatPromptBudget } from "./prompt";
import { CLOUD_CHAT_BUDGET } from "./prompt";

/** The context window assumed for a model whose window is unknown (a small local model). */
export const DEFAULT_CONTEXT_TOKENS = 8_192;

/** Share of the context window one turn may fill. */
const TURN_SHARE = 0.5;

const CHARS_PER_TOKEN = 4;

/** Below this window the composed chat prompt is capped so tool rounds still fit. */
const SMALL_CONTEXT_TOKENS = 65_536;

function validContext(contextTokens: number | undefined): number {
  return contextTokens !== undefined && Number.isSafeInteger(contextTokens) && contextTokens > 0
    ? contextTokens
    : DEFAULT_CONTEXT_TOKENS;
}

/** The most tokens any one request of a turn may carry: half the model's context window. */
export function turnTokenBudget(contextTokens: number | undefined): number {
  return Math.floor(TURN_SHARE * validContext(contextTokens));
}

/** Deterministic prompt estimate for one request: ceil(chars / 4) of its messages and tool schemas. */
export function estimateRequestTokens(messages: readonly unknown[], tools: readonly unknown[]): number {
  return Math.ceil(JSON.stringify({ messages, tools }).length / CHARS_PER_TOKEN);
}

/** One earlier request's estimate and the provider's own `usage.prompt_tokens` for it. */
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
 * prompt at half the turn budget, so the other half is left for tool schemas and
 * tool results across rounds.
 */
export function chatPromptBudgetFor(contextTokens: number | undefined): ChatPromptBudget {
  const context = validContext(contextTokens);
  if (context >= SMALL_CONTEXT_TOKENS) return CLOUD_CHAT_BUDGET;
  const promptTokens = Math.floor(turnTokenBudget(context) / 2);
  return {
    historyTokens: Math.min(CLOUD_CHAT_BUDGET.historyTokens, Math.floor(promptTokens / 2)),
    interpTokens: Math.min(CLOUD_CHAT_BUDGET.interpTokens, Math.floor(promptTokens / 4)),
    includeRawPredictive: false,
    promptTokens,
  };
}
