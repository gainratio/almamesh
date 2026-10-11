// Reading cost estimate: input counted from the exact messages that will be
// sent, output from a documented budget, price from the catalog. Imports
// pricing (a leaf) only as a type; client.ts must never import this module.

import { estimateTokens } from "./budget";
import type { ChatMessage } from "./client";
import type { ModelPricing } from "./pricing";
import { REPORT_SECTION_REASONING_MAX_TOKENS } from "./reasoning";
import { REPORT_SECTIONS, REPORT_WORD_TARGETS } from "./report-targets";

export interface ReadingOutputBudget {
  readonly visibleTokensLow: number;
  readonly visibleTokensHigh: number;
  readonly reasoningTokensLow: number;
  readonly reasoningTokensHigh: number;
}

export interface CostEstimate {
  readonly lowUsd: number;
  readonly highUsd: number;
}

const TOKENS_PER_WORD = 1.35;
const VOICES = 2;
/** Same band the real spec accepts for word counts. */
const TARGET_TOLERANCE = 0.3;

function totalWords(edge: "low" | "high"): number {
  return REPORT_SECTIONS.reduce((sum, section) => sum + REPORT_WORD_TARGETS[section][edge], 0);
}

function visibleTokens(words: number): number {
  return Math.round(words * TOKENS_PER_WORD * VOICES);
}

/** Full report on a cloud model: visible prose plus reasoning, low to high. */
export const READING_OUTPUT_BUDGET: ReadingOutputBudget = {
  visibleTokensLow: visibleTokens(totalWords("low") * (1 - TARGET_TOLERANCE)),
  visibleTokensHigh: visibleTokens(totalWords("high") * (1 + TARGET_TOLERANCE)),
  reasoningTokensLow: 0,
  reasoningTokensHigh: REPORT_SECTIONS.length * REPORT_SECTION_REASONING_MAX_TOKENS,
};

/**
 * Input is counted from the exact message arrays that will be sent
 * (buildReportMessages, chars/4); output comes from the budget. No pricing,
 * no number.
 */
export function estimateReadingCost(
  messages: readonly (readonly ChatMessage[])[],
  pricing: ModelPricing | null,
  budget: ReadingOutputBudget,
): CostEstimate | null {
  if (pricing === null) return null;
  const inputTokens = messages.reduce(
    (sum, conversation) =>
      sum + conversation.reduce((acc, message) => acc + estimateTokens(message.content), 0),
    0,
  );
  const usd = (outputTokens: number): number =>
    inputTokens * pricing.promptUsdPerToken + outputTokens * pricing.completionUsdPerToken;
  return {
    lowUsd: usd(budget.visibleTokensLow + budget.reasoningTokensLow),
    highUsd: usd(budget.visibleTokensHigh + budget.reasoningTokensHigh),
  };
}
