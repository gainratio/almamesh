import { describe, expect, it } from "vitest";

import type { OpenRouterModel } from "../client";
import { findModelPricing, parseModelPricing } from "../pricing";

const priced: OpenRouterModel = {
  id: "a/priced",
  name: "Priced",
  pricing: { promptUsdPerToken: 0.000001, completionUsdPerToken: 0.000002 },
};
const unpriced: OpenRouterModel = { id: "a/unpriced", name: "Unpriced" };

describe("parseModelPricing", () => {
  it("reads decimal USD-per-token strings", () => {
    expect(parseModelPricing({ prompt: "0.000001", completion: "0.000002" })).toEqual({
      promptUsdPerToken: 0.000001,
      completionUsdPerToken: 0.000002,
    });
  });

  it("keeps a genuine zero price as zeros", () => {
    expect(parseModelPricing({ prompt: "0", completion: "0" })).toEqual({
      promptUsdPerToken: 0,
      completionUsdPerToken: 0,
    });
  });

  it.each([
    ["negative", { prompt: "-1", completion: "-1" }],
    ["non-numeric", { prompt: "abc", completion: "0.1" }],
    ["blank", { prompt: " ", completion: "0.1" }],
    ["non-finite", { prompt: "Infinity", completion: "0.1" }],
    ["numbers not strings", { prompt: 0.1, completion: 0.1 }],
    ["missing completion", { prompt: "0.1" }],
    ["null", null],
    ["array", []],
    ["string", "0.1"],
  ])("returns undefined for %s input", (_label, raw) => {
    expect(parseModelPricing(raw)).toBeUndefined();
  });
});

describe("findModelPricing", () => {
  it("returns the matching model's pricing", () => {
    expect(findModelPricing([unpriced, priced], "a/priced")).toEqual(priced.pricing);
  });

  it("returns null when the model is missing from the catalog", () => {
    expect(findModelPricing([priced], "nope/missing")).toBeNull();
  });

  it("returns null when the model has no usable price", () => {
    expect(findModelPricing([unpriced], "a/unpriced")).toBeNull();
  });
});

describe("package entry", () => {
  it("loads without an import-cycle error", async () => {
    const entry = await import("../index");
    expect(typeof entry.fetchOpenRouterModels).toBe("function");
  });
});
