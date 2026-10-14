// The tool loop's per-turn context budget (spec 2026-10-13, "Context budget for
// the agentic loop"; restored on the seam in Task 6b of the chat tool layer
// redesign). No request of a turn may carry more than half the model's context
// window: older tool results go compact first (the newest result of each tool
// stays whole), then the turn is closed with a forced `answer` call. The system
// prompt and the user's question are never dropped.
import { describe, expect, it } from "vitest";

import type { ProviderConfig } from "../config";
import { estimateRequestTokens } from "../contextBudget";
import { BUDGET_INSTRUCTION, defineTool, runToolTurn, z, type RoundEvent, type RunToolTurnOptions, type ToolDef } from "../toolLoop";
import { collect, fakeEndpoint, messagesOf, toolMessage, toolsOf, type FakeTurn, type RecordedRequest } from "./toolLoopFake";

const CONFIG: ProviderConfig = {
  engine: "openai-http",
  model: "deepseek/deepseek-chat",
  privacyMode: "cloud_premium",
  baseUrl: "https://openrouter.ai/api/v1",
  apiKey: "test-key",
};
const NOW = new Date("2030-04-05T06:07:08.000Z");
const SMALL = 8_192;
const SMALL_BUDGET = 4_096;
const QUESTION = "How was 2019 for me?";
const FORCED_ANSWER = { type: "function", function: { name: "answer" } };

const Answer = z.object({ headline: z.string() });
type AnswerShape = z.infer<typeof Answer>;

interface ReadInput {
  readonly start: string;
}

interface ReadOptions {
  readonly chars?: number;
  readonly description?: string;
  readonly compact?: (result: unknown) => unknown;
}

/** read_period whose result is `{ period: { label }, text }`, `chars` long. */
function readTool(o: ReadOptions = {}): ToolDef<unknown> {
  return defineTool<ReadInput>({
    name: "read_period",
    description: o.description ?? "Read a period.",
    input: z.object({ start: z.string() }),
    ...(o.compact ? { compact: o.compact } : {}),
    async execute(input) {
      return { period: { label: `period ${input.start}` }, text: `${input.start}:${"x".repeat(o.chars ?? 4_000)}` };
    },
  }) as ToolDef<unknown>;
}

const read = (id: string, start: string): FakeTurn => ({ calls: [{ id, name: "read_period", args: JSON.stringify({ start }) }] });
const answer = (id: string): FakeTurn => ({ calls: [{ id, name: "answer", args: '{"headline":"Done."}' }] });

function options(fetchImpl: typeof fetch, rounds: RoundEvent[], overrides: Partial<RunToolTurnOptions<AnswerShape>>): RunToolTurnOptions<AnswerShape> {
  return {
    config: CONFIG,
    messages: [{ role: "system", content: "System." }, { role: "user", content: QUESTION }],
    tools: [readTool()],
    answer: { schema: Answer, render: (partial) => partial.headline ?? "" },
    readFirst: false,
    now: NOW,
    fetchImpl,
    contextTokens: SMALL,
    onRound: (event) => rounds.push(event),
    ...overrides,
  };
}

async function run(turns: readonly FakeTurn[], overrides: Partial<RunToolTurnOptions<AnswerShape>>) {
  const { fetchImpl, requests } = fakeEndpoint(turns);
  const rounds: RoundEvent[] = [];
  const { result } = await collect(runToolTurn(options(fetchImpl, rounds, overrides)));
  return { requests, rounds, result };
}

/** The request's prompt footprint as the e2e measures it: messages + tools, chars / 4. */
function promptTokens(request: RecordedRequest): number {
  return estimateRequestTokens(messagesOf(request), toolsOf(request));
}

function expectPaired(request: RecordedRequest): void {
  const messages = request.body.messages as Array<{ role: string; tool_call_id?: string; tool_calls?: Array<{ id: string }> }>;
  const answered = new Set(messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id));
  for (const message of messages) for (const toolCall of message.tool_calls ?? []) expect(answered.has(toolCall.id)).toBe(true);
}

function expectWithin(requests: readonly RecordedRequest[], budget: number): void {
  for (const request of requests) {
    expect(promptTokens(request)).toBeLessThanOrEqual(budget);
    expectPaired(request);
  }
}

function expectQuestionKept(requests: readonly RecordedRequest[], system: string): void {
  for (const request of requests) {
    const messages = messagesOf(request);
    expect(messages[0]).toMatchObject({ role: "system", content: system });
    expect(messages.some((m) => m.role === "user" && m.content === QUESTION)).toBe(true);
  }
}

const parsed = (content: string): Record<string, unknown> => JSON.parse(content) as Record<string, unknown>;
const toolNames = (request: RecordedRequest): string[] => toolsOf(request).map((t) => t.function.name);

describe("a large window keeps every result whole", () => {
  it("a 1M-context turn sends every read in full through the answer; nothing is compacted", async () => {
    const { requests, rounds } = await run([read("r1", "2019-01"), read("r2", "2019-02"), answer("a1")], { contextTokens: 1_000_000 });
    expect(requests).toHaveLength(3);
    expect(toolMessage(requests[2], "r1")).toContain("x".repeat(4_000));
    expect(toolMessage(requests[2], "r2")).toContain("x".repeat(4_000));
    expect(JSON.stringify(messagesOf(requests[2]))).not.toContain("compacted");
    expect(rounds.map((r) => [r.budget, r.compacted])).toEqual([[500_000, 0], [500_000, 0], [500_000, 0]]);
  });
});

describe("under budget pressure older results go compact", () => {
  const system = "s".repeat(6_000);

  it("the older read goes compact, the newest stays whole, and the turn keeps reading", async () => {
    const { requests, rounds } = await run([read("r1", "2019-01"), read("r2", "2019-02"), answer("a1")], {
      messages: [{ role: "system", content: system }, { role: "user", content: QUESTION }],
      tools: [readTool({ chars: 5_000 })],
    });
    expect(requests).toHaveLength(3);
    const compact = parsed(toolMessage(requests[2], "r1"));
    expect(compact).toMatchObject({ compacted: true });
    expect(JSON.stringify(compact)).toContain("period 2019-01");
    expect(toolMessage(requests[2], "r2")).toContain("x".repeat(5_000));
    expect(requests[2].body.tool_choice).toBe("required");
    expect(rounds[2]).toMatchObject({ compacted: 1, budget: SMALL_BUDGET });
    expectWithin(requests, SMALL_BUDGET);
    expectQuestionKept(requests, system);
  });

  it("a tool's own compact form replaces its result", async () => {
    const compactRead = readTool({ chars: 5_000, compact: (result) => ({ period: (result as { period: unknown }).period, maha: ["venus"] }) });
    const { requests } = await run([read("r1", "2019-01"), read("r2", "2019-02"), answer("a1")], {
      messages: [{ role: "system", content: system }, { role: "user", content: QUESTION }],
      tools: [compactRead],
    });
    expect(parsed(toolMessage(requests[2], "r1"))).toEqual({ compacted: true, period: { label: "period 2019-01" }, maha: ["venus"] });
  });

  it("six large results in one round still fit: all but the newest go compact", async () => {
    const lookup = defineTool<Record<string, never>>({
      name: "lookup",
      description: "Look something up.",
      input: z.object({}),
      async execute() {
        return { period: { label: "lookup" }, text: "y".repeat(7_000) };
      },
    }) as ToolDef<unknown>;
    const six = { calls: Array.from({ length: 6 }, (_, i) => ({ id: `c${i}`, name: "lookup", args: "{}" })) };
    const { requests, result } = await run([six, answer("a1")], {
      messages: [{ role: "system", content: "s".repeat(2_000) }, { role: "user", content: QUESTION }],
      tools: [lookup],
      limits: { maxCallsPerTool: { lookup: 6 } },
    });
    expect(result).toMatchObject({ answer: { headline: "Done." } });
    expect(toolMessage(requests[1], "c5")).toContain("y".repeat(7_000));
    expect(parsed(toolMessage(requests[1], "c0"))).toMatchObject({ compacted: true });
    expectWithin(requests, SMALL_BUDGET);
  });
});

describe("past the budget the turn answers now", () => {
  it("forces the answer with only the answer tool and the budget note; the newest read stays whole", async () => {
    // The read tool's long description is what the forced answer sheds.
    const system = "s".repeat(10_000);
    const { requests, rounds } = await run([read("r1", "2019-01"), answer("a1")], {
      messages: [{ role: "system", content: system }, { role: "user", content: QUESTION }],
      tools: [readTool({ description: "Read a period. ".repeat(140) })],
    });
    expect(requests).toHaveLength(2);
    expect(requests[1].body.tool_choice).toEqual(FORCED_ANSWER);
    expect(toolNames(requests[1])).toEqual(["answer"]);
    expect(messagesOf(requests[1]).some((m) => m.role === "system" && m.content === BUDGET_INSTRUCTION)).toBe(true);
    expect(toolMessage(requests[1], "r1")).toContain("x".repeat(4_000));
    expect(rounds[1]).toMatchObject({ compacted: 0 });
    expectWithin(requests, SMALL_BUDGET);
    expectQuestionKept(requests, system);
  });

  it("when even the forced answer is over, the newest read goes compact too", async () => {
    const system = "s".repeat(14_000);
    const { requests, rounds } = await run([read("r1", "2019-01"), answer("a1")], {
      messages: [{ role: "system", content: system }, { role: "user", content: QUESTION }],
    });
    expect(requests[1].body.tool_choice).toEqual(FORCED_ANSWER);
    expect(parsed(toolMessage(requests[1], "r1"))).toMatchObject({ compacted: true });
    expect(rounds[1]).toMatchObject({ compacted: 1 });
    expectWithin(requests, SMALL_BUDGET);
    expectQuestionKept(requests, system);
  });

  it("a trip turn still reads first, even when its prompt alone is over budget", async () => {
    const system = "s".repeat(20_000);
    const { requests } = await run([read("r1", "2019-01"), answer("a1")], {
      readFirst: true,
      messages: [{ role: "system", content: system }, { role: "user", content: QUESTION }],
    });
    expect(requests[0].body.tool_choice).toBe("required");
    expect(toolNames(requests[0])).toEqual(["read_period"]);
    expect(requests[1].body.tool_choice).toEqual(FORCED_ANSWER);
    expectQuestionKept(requests, system);
  });

  it("an answer rejected after the budget closed the turn is asked again, still forced, with one budget note", async () => {
    const system = "s".repeat(10_000);
    const bad: FakeTurn = { calls: [{ id: "a0", name: "answer", args: '{"headline":7}' }] };
    const { requests, result } = await run([read("r1", "2019-01"), bad, answer("a1")], {
      messages: [{ role: "system", content: system }, { role: "user", content: QUESTION }],
      tools: [readTool({ description: "Read a period. ".repeat(140) })],
    });
    expect(result).toMatchObject({ answer: { headline: "Done." } });
    expect(requests[2].body.tool_choice).toEqual(FORCED_ANSWER);
    expect(messagesOf(requests[2]).filter((m) => m.content === BUDGET_INSTRUCTION)).toHaveLength(1);
  });
});

describe("round telemetry", () => {
  it("reports the budget, the estimate, and whether the provider counted the tokens", async () => {
    const { rounds } = await run([{ ...read("r1", "2019-01"), usage: { prompt: 321, completion: 4 } }, { ...answer("a1"), noUsage: true }], {});
    expect(rounds[0]).toMatchObject({ round: 1, inputTokens: 321, estimated: false, budget: SMALL_BUDGET, compacted: 0 });
    expect(rounds[0].estimate).toBeGreaterThan(0);
    expect(rounds[1]).toMatchObject({ round: 2, inputTokens: undefined, estimated: true });
  });

  it("calibrates later estimates by the provider's own count, so an undercounted turn still closes in time", async () => {
    // The provider counts 30x our estimate of round 1: round 2 must be planned with that ratio.
    const { requests, rounds } = await run([{ ...read("r1", "2019-01"), usage: { prompt: 3_000, completion: 4 } }, answer("a1")], {});
    // Uncalibrated, round 2 is ~1.2k tokens and would keep reading; calibrated, it is closed and its read goes compact.
    expect(rounds[1].estimate).toBeGreaterThan(rounds[0].estimate * 10);
    expect(rounds[1]).toMatchObject({ compacted: 1 });
    expect(requests[1].body.tool_choice).toEqual(FORCED_ANSWER);
  });

  it("a consumer that lags behind the SDK still gets each round's own estimate, and calibration pairs the right numbers", async () => {
    // Round 1 streams a rejected answer in pieces, so the turn yields snapshots there; the caller
    // dawdles on each one while the SDK finishes round 1 and plans round 2 on its own.
    const rejected: FakeTurn = { calls: [{ id: "a0", name: "answer", args: ['{"head', 'line":', ' 7, "x', '": 1}'] }], usage: { prompt: 900, completion: 4 } };
    const { fetchImpl, requests } = fakeEndpoint([rejected, { ...answer("a1"), usage: { prompt: 1_000, completion: 4 } }]);
    const rounds: RoundEvent[] = [];
    const turn = runToolTurn(options(fetchImpl, rounds, { contextTokens: 1_000_000 }));
    for (;;) {
      const next = await turn.next();
      if (next.done) break;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    expect(rounds.map((r) => r.round)).toEqual([1, 2]);
    const raw = requests.map(promptTokens);
    // Round 1 is uncalibrated: its estimate is its own request's size.
    expect(Math.abs(rounds[0].estimate - raw[0]) / raw[0]).toBeLessThan(0.05);
    // Round 2 is calibrated by round 1's count against round 1's estimate (900 / ~raw[0]), never by round 2's own.
    const ratio = 900 / rounds[0].estimate;
    expect(Math.abs(rounds[1].estimate - raw[1] * ratio) / (raw[1] * ratio)).toBeLessThan(0.05);
    expect(rounds[1].estimate).toBeGreaterThan(rounds[0].estimate);
  });

  it("a corrective restart (a tool call written as text) is still calibrated by the round before it", async () => {
    // Round 1 writes text instead of a tool call; the provider counts ~25x our estimate. Round 2 runs
    // in a fresh SDK loop, so its calibration must come from what this loop recorded for round 1.
    const text: FakeTurn = { text: "<tool_call>read_period</tool_call>", usage: { prompt: 9_000, completion: 4 } };
    const { requests, rounds } = await run([text, answer("a1")], {
      messages: [{ role: "system", content: "s".repeat(1_000) }, { role: "user", content: QUESTION }],
    });
    expect(rounds[0]).toMatchObject({ round: 1, finishReason: "text_instead_of_tool" });
    expect(rounds[1].estimate).toBeGreaterThan(SMALL_BUDGET);
    expect(requests[1].body.tool_choice).toEqual(FORCED_ANSWER);
  });
});
