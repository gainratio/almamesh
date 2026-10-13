import { describe, expect, it } from "vitest";

import { estimateTokens } from "../budget";
import { buildChatMessages } from "../prompt";
import type { SanitizedChart } from "../sanitize";

const CHART = {
  as_of: { date: "2026-01-01", basis: "chart" },
  ayanamsa_value: 24.1, lagna: { sign: "aries" }, planets: {}, houses: {}, yogas: [],
} as unknown as SanitizedChart;

import {
  CLOUD_CHAT_BUDGET,
  DEFAULT_CONTEXT_TOKENS,
  calibratedEstimate,
  chatPromptBudgetFor,
  compactToolContent,
  defaultToolSummary,
  estimateRequestTokens,
  summarizeToolResult,
  toolFactsNote,
  turnTokenBudget,
} from "../index";

describe("turnTokenBudget", () => {
  it("is half the model's context window", () => {
    expect(turnTokenBudget(1_000_000)).toBe(500_000);
    expect(turnTokenBudget(131_072)).toBe(65_536);
    expect(turnTokenBudget(8_191)).toBe(4_095);
  });

  it("assumes an 8k context when the model's window is unknown or nonsense", () => {
    expect(DEFAULT_CONTEXT_TOKENS).toBe(8_192);
    for (const unknown of [undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY, 12.5]) {
      expect(turnTokenBudget(unknown)).toBe(4_096);
    }
  });
});

describe("estimateRequestTokens", () => {
  it("is ceil(chars / 4) over the serialized messages and tool schemas", () => {
    const messages = [{ role: "user", content: "abc" }];
    const tools = [{ type: "function", function: { name: "t" } }];
    const chars = JSON.stringify({ messages, tools }).length;
    expect(estimateRequestTokens(messages, tools)).toBe(Math.ceil(chars / 4));
  });

  it("counts tool schemas, not only messages", () => {
    const messages = [{ role: "user", content: "abc" }];
    const big = [{ type: "function", function: { name: "t", description: "x".repeat(4_000) } }];
    expect(estimateRequestTokens(messages, big) - estimateRequestTokens(messages, [])).toBeGreaterThanOrEqual(1_000);
  });
});

describe("calibratedEstimate", () => {
  it("scales an estimate up when the provider counted more tokens than estimated", () => {
    expect(calibratedEstimate(1_000, { estimate: 500, reported: 1_000 })).toBe(2_000);
  });

  it("never scales an estimate down (the char estimate stays the floor)", () => {
    expect(calibratedEstimate(1_000, { estimate: 1_000, reported: 400 })).toBe(1_000);
    expect(calibratedEstimate(1_000, undefined)).toBe(1_000);
  });
});

describe("chatPromptBudgetFor", () => {
  it("keeps today's cloud sizing for a large context", () => {
    expect(chatPromptBudgetFor(1_000_000)).toBe(CLOUD_CHAT_BUDGET);
    expect(chatPromptBudgetFor(65_536)).toBe(CLOUD_CHAT_BUDGET);
  });

  it("caps the composed chat prompt for a small context, leaving room for tool rounds", () => {
    const small = chatPromptBudgetFor(8_192);
    expect(small.includeRawPredictive).toBe(false);
    // 40% of the 4,096-token turn budget: tool schemas and a compact round need the rest.
    expect(small.promptTokens).toBe(1_638);
    expect(small.historyTokens).toBeLessThanOrEqual(819);
    expect(chatPromptBudgetFor(undefined)).toEqual(small);
  });

  // P1 drive 2026-10-13: recalled memories grew with the thread on an 8k window, so a six-turn
  // trip thread's answer request crossed the turn budget (4,183 > 4,096).
  it("a small context keeps recalled memories inside the composed-prompt cap, best first", () => {
    const small = chatPromptBudgetFor(8_192);
    const memories = Array.from({ length: 12 }, (_, i) => `memory ${i} ${"m".repeat(600)}`);
    const [system, user] = buildChatMessages(CHART, "How is work?", "layman", [], memories, undefined, "en", undefined, undefined, small);
    const tokens = estimateTokens(system!.content) + estimateTokens(user!.content);
    expect(tokens).toBeLessThanOrEqual(small.promptTokens!);
    expect(user!.content).toContain("memory 0 ");
    expect(user!.content).not.toContain("memory 11 ");
  });

  it("the cloud budget keeps every recalled memory (bytes unchanged)", () => {
    const memories = Array.from({ length: 12 }, (_, i) => `memory ${i} ${"m".repeat(600)}`);
    const user = buildChatMessages(CHART, "How is work?", "layman", [], memories)[1]!;
    expect(user.content).toContain("memory 11 ");
  });
});

describe("tool result summaries", () => {
  it("uses the tool's own summarize when it gives one", () => {
    const summary = summarizeToolResult(() => ({ line: "Saturn antar, 12th lord", factors: ["Sade Sati phase 1"] }), { big: 1 });
    expect(summary).toEqual({ line: "Saturn antar, 12th lord", factors: ["Sade Sati phase 1"] });
  });

  it("falls back to the deterministic default when summarize throws or returns junk", () => {
    const result = { period: { label: "May 2019" }, place: { label: "Singapore" } };
    expect(summarizeToolResult(() => { throw new Error("boom"); }, result)).toEqual(defaultToolSummary(result));
    expect(summarizeToolResult(() => ({ line: 3 }) as never, result)).toEqual(defaultToolSummary(result));
  });

  it("the default names the period and place, then short scalar fields, on one bounded line", () => {
    const summary = defaultToolSummary({
      period: { label: "May 2019", start: "2019-05-01", end: "2019-05-31" },
      place: { label: "Singapore" },
      dasha: "Saturn/Mercury",
      notes: "line one\nline two",
      huge: "x".repeat(10_000),
      nested: { deep: true },
    });
    expect(summary.line).toContain("May 2019");
    expect(summary.line).toContain("Singapore");
    expect(summary.line).toContain("dasha: Saturn/Mercury");
    expect(summary.line).not.toContain("\n");
    expect(summary.line.length).toBeLessThanOrEqual(240);
  });

  it("the default says when a tool answered with an error", () => {
    expect(defaultToolSummary({ error: "needs_place" }).line).toBe("error: needs_place");
    expect(defaultToolSummary(null).line).toBe("no result");
    expect(defaultToolSummary(["a", "b"]).line).toBe("2 items");
    expect(defaultToolSummary("plain").line).toBe("plain");
  });

  it("bounds factors: at most 6, each at most 80 chars, single-line", () => {
    const summary = summarizeToolResult(() => ({ line: "x", factors: Array.from({ length: 9 }, (_, i) => `f${i}\n${"y".repeat(200)}`) }), {});
    expect(summary.factors).toHaveLength(6);
    for (const factor of summary.factors ?? []) {
      expect(factor.length).toBeLessThanOrEqual(80);
      expect(factor).not.toContain("\n");
    }
  });

  it("a compacted tool message is short JSON that says it is compacted and carries the facts", () => {
    const content = compactToolContent({ line: "Saturn antar", factors: ["12th lord"] });
    expect(JSON.parse(content)).toEqual({ ok: true, compacted: true, facts: "Saturn antar", factors: ["12th lord"] });
  });
});

describe("toolFactsNote (history compaction)", () => {
  it("lists earlier turns' tool results as one-line summaries only", () => {
    const note = toolFactsNote([
      { toolName: "get_timing", result: { period: { label: "May 2019" }, payload: "z".repeat(5_000) }, status: "complete" },
      { toolName: "get_natal_summary", result: { lagna: "Capricorn" }, status: "complete" },
    ]);
    expect(note).toContain("get_timing: May 2019");
    expect(note).toContain("get_natal_summary: lagna: Capricorn");
    expect(note).not.toContain("z".repeat(100));
  });

  it("uses a named summarizer when one is supplied", () => {
    const note = toolFactsNote(
      [{ toolName: "get_period_reading", result: { anything: 1 }, status: "complete" }],
      { get_period_reading: () => ({ line: "Saturn/Mercury, confidence medium", factors: ["Sade Sati"] }) },
    );
    expect(note).toContain("get_period_reading: Saturn/Mercury, confidence medium (Sade Sati)");
  });

  it("skips failed calls and returns undefined when nothing succeeded", () => {
    expect(toolFactsNote([{ toolName: "get_timing", result: { code: "x" }, status: "error" }])).toBeUndefined();
    expect(toolFactsNote([])).toBeUndefined();
  });

  it("keeps only the newest entries within its cap", () => {
    const entries = Array.from({ length: 40 }, (_, i) => ({ toolName: "get_timing", result: { n: i, note: "x".repeat(50) }, status: "complete" as const }));
    const note = toolFactsNote(entries) ?? "";
    expect(note).toContain("n: 39");
    expect(note).not.toMatch(/n: 0 ·/u);
    expect(note.length).toBeLessThanOrEqual(1_600);
  });
});
