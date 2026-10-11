import { describe, expect, it } from "vitest";

import {
  estimateReadingCost,
  READING_OUTPUT_BUDGET,
} from "../cost-estimate";
import { findModelPricing, parseModelPricing, type ModelPricing } from "../pricing";

const FLASH: ModelPricing = { promptUsdPerToken: 0.0000003, completionUsdPerToken: 0.0000012 };
// 4,000 chars = 1,000 estimated input tokens (chars / 4).
const MESSAGES = [[{ role: "user" as const, content: "x".repeat(4000) }]];

describe("READING_OUTPUT_BUDGET", () => {
  it("pins the documented budget: targets -30 % / +30 %, x1.35 tokens/word, 2 voices, 9 x 6,000 reasoning", () => {
    expect(READING_OUTPUT_BUDGET).toEqual({
      visibleTokensLow: 8184,
      visibleTokensHigh: 21200,
      reasoningTokensLow: 0,
      reasoningTokensHigh: 54000,
    });
  });
});

describe("estimateReadingCost", () => {
  it("prices input from the built messages and output from the budget", () => {
    const estimate = estimateReadingCost(MESSAGES, FLASH, READING_OUTPUT_BUDGET);
    expect(estimate?.lowUsd).toBeCloseTo(1000 * 0.0000003 + 8184 * 0.0000012, 12);
    expect(estimate?.highUsd).toBeCloseTo(1000 * 0.0000003 + (21200 + 54000) * 0.0000012, 12);
  });

  it("no price, no number", () => {
    expect(estimateReadingCost(MESSAGES, null, READING_OUTPUT_BUDGET)).toBeNull();
  });

  it("a free model is a distinguishable zero, not a missing number", () => {
    expect(
      estimateReadingCost(MESSAGES, { promptUsdPerToken: 0, completionUsdPerToken: 0 }, READING_OUTPUT_BUDGET),
    ).toEqual({ lowUsd: 0, highUsd: 0 });
  });

  it("a model missing from the catalog gives no estimate", () => {
    const pricing = findModelPricing(
      [{ id: "other/model", name: "Other", pricing: FLASH }],
      "deepseek/deepseek-v4.1-flash",
    );
    expect(pricing).toBeNull();
    expect(estimateReadingCost(MESSAGES, pricing, READING_OUTPUT_BUDGET)).toBeNull();
  });

  it.each([
    ["negative", { prompt: "-1", completion: "-1" }],
    ["non-numeric", { prompt: "abc", completion: "0.000001" }],
    ["empty", { prompt: "", completion: "" }],
    ["numbers, not strings", { prompt: 0.0000003, completion: 0.0000012 }],
  ])("%s catalog prices give no estimate", (_label, raw) => {
    const pricing = parseModelPricing(raw) ?? null;
    expect(pricing).toBeNull();
    expect(estimateReadingCost(MESSAGES, pricing, READING_OUTPUT_BUDGET)).toBeNull();
  });
});
