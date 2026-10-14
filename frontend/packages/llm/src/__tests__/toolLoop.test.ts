// The toolLoop seam: one AI SDK loop with zod-typed tools, invalid arguments
// returned to the model as retries, a final `answer` tool, budgets and events.
// One describe per implementation rule in the Task 2 brief.
import { describe, expect, it, vi } from "vitest";

import { LlmRequestError } from "../client";
import type { ProviderConfig } from "../config";
import { ReasoningTimeoutError } from "../reasoning";
import {
  ANSWER_TOOL_DESCRIPTION,
  TOOL_LOOP_LIMITS,
  TOOL_TIMEOUT_MS,
  TOOLS_UNAVAILABLE_INSTRUCTION,
  TOOLS_UNAVAILABLE_NOTICE,
  defineTool,
  runToolTurn,
  z,
  type AgentStatusEvent,
  type RoundEvent,
  type RunToolTurnOptions,
  type ToolCallEvent,
  type ToolDef,
} from "../toolLoop";
import { collect, fakeEndpoint, messagesOf, toolMessage, toolsOf, type FakeCall, type FakeTurn } from "./toolLoopFake";

const OPENROUTER: ProviderConfig = {
  engine: "openai-http",
  model: "deepseek/deepseek-chat",
  privacyMode: "cloud_premium",
  baseUrl: "https://openrouter.ai/api/v1",
  apiKey: "test-key",
};

const LOCAL: ProviderConfig = {
  engine: "openai-http",
  model: "llama3.1",
  privacyMode: "local_only",
  baseUrl: "http://localhost:11434/v1",
};

const NOW = new Date("2030-04-05T06:07:08.000Z");
const START_MESSAGE = "start must be YYYY, YYYY-MM or YYYY-MM-DD";

const Answer = z.object({ headline: z.string(), body: z.string() });
type AnswerShape = z.infer<typeof Answer>;
const render = (partial: Partial<AnswerShape>, final: boolean): string =>
  `${final ? "" : "… "}${partial.headline ?? ""}\n\n${partial.body ?? ""}`;

interface PeriodInput {
  readonly start: string;
  readonly end: string | null;
}

function readPeriod(seen: PeriodInput[] = []): ToolDef<PeriodInput> {
  return defineTool<PeriodInput>({
    name: "read_period",
    description: "Read the sky for a period.",
    statusLabel: "Reading the period",
    input: z.object({
      start: z.string().regex(/^\d{4}(-\d{2}(-\d{2})?)?$/, START_MESSAGE),
      end: z.string().nullable(),
    }),
    async execute(input) {
      seen.push(input);
      return { period: "Venus", start: input.start };
    },
  });
}

function asTools(...defs: ToolDef<never>[]): readonly ToolDef<unknown>[] {
  return defs as unknown as readonly ToolDef<unknown>[];
}

const call = (id: string, name: string, args: string | readonly string[]): FakeCall => ({ id, name, args });
const read = (id: string, args = '{"start":"2019-09","end":null}'): FakeTurn => ({ calls: [call(id, "read_period", args)] });
const answer = (id: string, args = '{"headline":"Venus rises","body":"Steady work."}'): FakeTurn => ({ calls: [call(id, "answer", args)] });

interface Harness {
  readonly toolCalls: ToolCallEvent[];
  readonly rounds: RoundEvent[];
  readonly statuses: AgentStatusEvent[];
}

function options(
  fetchImpl: typeof fetch,
  overrides: Partial<RunToolTurnOptions<AnswerShape>> = {},
): RunToolTurnOptions<AnswerShape> & Harness {
  const toolCalls: ToolCallEvent[] = [];
  const rounds: RoundEvent[] = [];
  const statuses: AgentStatusEvent[] = [];
  return {
    config: OPENROUTER,
    messages: [{ role: "user", content: "How is September 2019?" }],
    tools: asTools(readPeriod()),
    answer: { schema: Answer, render },
    readFirst: false,
    now: NOW,
    fetchImpl,
    onToolCall: (e) => toolCalls.push(e),
    onRound: (e) => rounds.push(e),
    onStatus: (e) => statuses.push(e),
    toolCalls,
    rounds,
    statuses,
    ...overrides,
  };
}

const FINAL = render({ headline: "Venus rises", body: "Steady work." }, true);

describe("rule 1: the provider is the OpenAI-compatible chat model on the configured endpoint", () => {
  it("streams to <baseUrl>/chat/completions with the configured model and per-step usage", async () => {
    const { fetchImpl, requests } = fakeEndpoint([answer("a1")]);
    await collect(runToolTurn(options(fetchImpl)));
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(requests[0].body).toMatchObject({ model: "deepseek/deepseek-chat", stream: true, stream_options: { include_usage: true } });
  });

  it("caps OpenRouter reasoning at the chat budget, and sends no reasoning field to a local endpoint", async () => {
    const remote = fakeEndpoint([answer("a1")]);
    await collect(runToolTurn(options(remote.fetchImpl)));
    expect(remote.requests[0].body.reasoning).toEqual({ max_tokens: 6_000 });

    const local = fakeEndpoint([answer("a1")]);
    await collect(runToolTurn(options(local.fetchImpl, { config: LOCAL })));
    expect(local.requests[0].url).toBe("http://localhost:11434/v1/chat/completions");
    expect(local.requests[0].body).not.toHaveProperty("reasoning");
  });

  it("sends the conversation messages in order", async () => {
    const { fetchImpl, requests } = fakeEndpoint([answer("a1")]);
    await collect(runToolTurn(options(fetchImpl, { messages: [{ role: "system", content: "sys" }, { role: "user", content: "hi" }] })));
    expect(messagesOf(requests[0]).map((m) => [m.role, m.content])).toEqual([["system", "sys"], ["user", "hi"]]);
  });
});

describe("rule 3: tools are zod-typed, strict-compatible, and lenient about omitted nullable keys", () => {
  it("fills an omitted nullable key with null: {start:'2019-09'} is valid on the first try", async () => {
    const seen: PeriodInput[] = [];
    const { fetchImpl } = fakeEndpoint([read("c1", '{"start":"2019-09"}'), answer("a1")]);
    const o = options(fetchImpl, { tools: asTools(readPeriod(seen)) });
    await collect(runToolTurn(o));
    expect(seen).toEqual([{ start: "2019-09", end: null }]);
    expect(o.toolCalls[0]).toMatchObject({ toolName: "read_period", status: "complete", validFirstTry: true, round: 1 });
  });

  it("sends every key as required, the optional one as nullable", async () => {
    const { fetchImpl, requests } = fakeEndpoint([answer("a1")]);
    await collect(runToolTurn(options(fetchImpl)));
    const period = toolsOf(requests[0]).find((t) => t.function.name === "read_period");
    expect(period?.function.parameters.required).toEqual(["start", "end"]);
  });

  it("offers the answer tool with its description", async () => {
    const { fetchImpl, requests } = fakeEndpoint([answer("a1")]);
    await collect(runToolTurn(options(fetchImpl)));
    const tool = toolsOf(requests[0]).find((t) => t.function.name === "answer");
    expect(tool?.function.description).toBe(ANSWER_TOOL_DESCRIPTION);
    expect(tool?.function.parameters.required).toEqual(["headline", "body"]);
  });

  it.each([
    ["openai/gpt-5-mini", true],
    ["~openai/gpt-latest", true],
    ["deepseek/deepseek-chat", undefined],
  ])("marks tools strict only for OpenRouter openai models (%s)", async (model, strict) => {
    const { fetchImpl, requests } = fakeEndpoint([answer("a1")]);
    await collect(runToolTurn(options(fetchImpl, { config: { ...OPENROUTER, model } })));
    expect(toolsOf(requests[0]).map((t) => t.function.strict)).toEqual([strict, strict]);
  });

  it("never marks tools strict on a non-OpenRouter endpoint, even for an openai/ model id", async () => {
    const { fetchImpl, requests } = fakeEndpoint([answer("a1")]);
    await collect(runToolTurn(options(fetchImpl, { config: { ...LOCAL, model: "openai/gpt-oss" } })));
    expect(toolsOf(requests[0]).every((t) => t.function.strict === undefined)).toBe(true);
  });
});

describe("rule 4: the loop stops on a VALID answer only", () => {
  it("retries an answer missing a required field, then ends on the valid one", async () => {
    const { fetchImpl, requests } = fakeEndpoint([answer("a1", '{"headline":"Venus rises"}'), answer("a2")]);
    const o = options(fetchImpl);
    const { snapshots, result } = await collect(runToolTurn(o));
    expect(requests).toHaveLength(2);
    expect(toolMessage(requests[1], "a1")).toContain("body");
    expect(snapshots.at(-1)).toBe(FINAL);
    expect(result).toEqual({ answer: { headline: "Venus rises", body: "Steady work." } });
    expect(o.toolCalls.map((e) => [e.toolName, e.status, e.validFirstTry])).toEqual([
      ["answer", "retried", false],
      ["answer", "complete", false],
    ]);
  });

  it("makes no request after a valid answer", async () => {
    const { fetchImpl, requests } = fakeEndpoint([read("c1"), answer("a1")]);
    const { result } = await collect(runToolTurn(options(fetchImpl)));
    expect(requests).toHaveLength(2);
    expect(result).toEqual({ answer: { headline: "Venus rises", body: "Steady work." } });
  });
});

describe("rule 5: tool choice per round", () => {
  it("readFirst: round 1 must call a non-answer tool; later rounds require a tool with answer offered", async () => {
    const { fetchImpl, requests } = fakeEndpoint([read("c1"), answer("a1")]);
    await collect(runToolTurn(options(fetchImpl, { readFirst: true })));
    expect(requests[0].body.tool_choice).toBe("required");
    expect(toolsOf(requests[0]).map((t) => t.function.name)).toEqual(["read_period"]);
    expect(requests[1].body.tool_choice).toBe("required");
    expect(toolsOf(requests[1]).map((t) => t.function.name)).toEqual(["read_period", "answer"]);
  });

  it("without readFirst, round 1 offers every tool including answer", async () => {
    const { fetchImpl, requests } = fakeEndpoint([answer("a1")]);
    await collect(runToolTurn(options(fetchImpl)));
    expect(requests[0].body.tool_choice).toBe("required");
    expect(toolsOf(requests[0]).map((t) => t.function.name)).toEqual(["read_period", "answer"]);
  });

  it("the last round forces the answer tool", async () => {
    const { fetchImpl, requests } = fakeEndpoint([read("c1"), answer("a1")]);
    await collect(runToolTurn(options(fetchImpl, { limits: { maxRounds: 2 } })));
    expect(requests[1].body.tool_choice).toEqual({ type: "function", function: { name: "answer" } });
  });

  it("defaults to 6 rounds", () => {
    expect(TOOL_LOOP_LIMITS.maxRounds).toBe(6);
  });
});

describe("rule 6: per-tool call budget", () => {
  it("skips the 4th read_period call this turn and tells the model why", async () => {
    const seen: PeriodInput[] = [];
    const four: FakeTurn = { calls: ["c1", "c2", "c3", "c4"].map((id, i) => call(id, "read_period", `{"start":"201${i}","end":null}`)) };
    const { fetchImpl, requests } = fakeEndpoint([four, answer("a1")]);
    const o = options(fetchImpl, { tools: asTools(readPeriod(seen)) });
    await collect(runToolTurn(o));
    expect(seen).toHaveLength(3);
    // Parallel calls settle in any order; the 4th in call order is the one skipped.
    const statusById = Object.fromEntries(o.toolCalls.map((e) => [e.toolCallId, e.status]));
    expect(statusById).toEqual({ c1: "complete", c2: "complete", c3: "complete", c4: "skipped", a1: "complete" });
    expect(toolMessage(requests[1], "c4")).toContain("This turn already read enough; answer from the readings above.");
  });

  it("pins the default budgets: read_period 3, travel 1", () => {
    expect(TOOL_LOOP_LIMITS.maxCallsPerTool).toEqual({ read_period: 3, travel: 1 });
  });

  it("honours a caller budget", async () => {
    const seen: PeriodInput[] = [];
    const two: FakeTurn = { calls: [call("c1", "read_period", '{"start":"2010","end":null}'), call("c2", "read_period", '{"start":"2011","end":null}')] };
    const { fetchImpl } = fakeEndpoint([two, answer("a1")]);
    await collect(runToolTurn(options(fetchImpl, { tools: asTools(readPeriod(seen)), limits: { maxCallsPerTool: { read_period: 1 } } })));
    expect(seen).toHaveLength(1);
  });
});

describe("rule 7: tool events", () => {
  it("an invalid argument goes back to the model as a retry with the zod message, never an error", async () => {
    const seen: PeriodInput[] = [];
    const { fetchImpl, requests } = fakeEndpoint([read("c1", '{"start":"Sept 2019","end":null}'), read("c2"), answer("a1")]);
    const o = options(fetchImpl, { tools: asTools(readPeriod(seen)) });
    const { snapshots } = await collect(runToolTurn(o));
    expect(toolMessage(requests[1], "c1")).toContain(START_MESSAGE);
    expect(o.toolCalls.map((e) => [e.toolCallId, e.status, e.validFirstTry])).toEqual([
      ["c1", "retried", false],
      ["c2", "complete", false],
      ["a1", "complete", true],
    ]);
    expect(o.toolCalls.some((e) => e.status === "error")).toBe(false);
    expect(seen).toEqual([{ start: "2019-09", end: null }]);
    expect(snapshots.at(-1)).toBe(FINAL);
  });

  it("an unknown tool name is a retry", async () => {
    const { fetchImpl, requests } = fakeEndpoint([{ calls: [call("x1", "get_dasha", "{}")] }, answer("a1")]);
    const o = options(fetchImpl);
    await collect(runToolTurn(o));
    expect(o.toolCalls[0]).toMatchObject({ toolCallId: "x1", toolName: "get_dasha", status: "retried", validFirstTry: false });
    expect(toolMessage(requests[1], "x1")).toContain("get_dasha");
  });

  it("a throwing execute is an error, and the loop still continues", async () => {
    const broken = defineTool<{ readonly q: string }>({
      name: "lookup",
      description: "Look something up.",
      input: z.object({ q: z.string() }),
      async execute() {
        throw new Error("engine exploded");
      },
    });
    const { fetchImpl, requests } = fakeEndpoint([{ calls: [call("l1", "lookup", '{"q":"a"}')] }, answer("a1")]);
    const o = options(fetchImpl, { tools: asTools(broken) });
    const { result } = await collect(runToolTurn(o));
    expect(o.toolCalls[0]).toMatchObject({ toolCallId: "l1", status: "error", validFirstTry: true });
    expect(toolMessage(requests[1], "l1")).toContain("engine exploded");
    expect(result).toEqual({ answer: { headline: "Venus rises", body: "Steady work." } });
  });

  it("a returned object with an error field is a complete call, not a thrown error", async () => {
    const soft = defineTool<{ readonly q: string }>({
      name: "lookup",
      description: "Look something up.",
      input: z.object({ q: z.string() }),
      async execute() {
        return { error: "no such place" };
      },
    });
    const { fetchImpl } = fakeEndpoint([{ calls: [call("l1", "lookup", '{"q":"a"}')] }, answer("a1")]);
    const o = options(fetchImpl, { tools: asTools(soft) });
    await collect(runToolTurn(o));
    expect(o.toolCalls[0]).toMatchObject({ status: "complete", result: { error: "no such place" }, args: { q: "a" } });
  });

  it("reports status lifecycle with the tool's label, and usage per round", async () => {
    const { fetchImpl } = fakeEndpoint([{ ...read("c1"), usage: { prompt: 120, completion: 7 } }, answer("a1")]);
    const o = options(fetchImpl);
    await collect(runToolTurn(o));
    expect(o.statuses).toEqual([
      { phase: "deciding", round: 1 },
      { phase: "using_tool", round: 1, toolName: "read_period", label: "Reading the period", callNumber: 1 },
      { phase: "deciding", round: 2 },
      { phase: "answering" },
      { phase: "complete" },
    ]);
    expect(o.rounds).toEqual([
      { round: 1, inputTokens: 120, outputTokens: 7, finishReason: "tool-calls" },
      { round: 2, inputTokens: 10, outputTokens: 5, finishReason: "tool-calls" },
    ]);
  });

  it("passes the pinned clock to execute", async () => {
    let clock: Date | undefined;
    const tick = defineTool<Record<string, never>>({
      name: "clock",
      description: "Read the clock.",
      input: z.object({}),
      async execute(_input, ctx) {
        clock = ctx.now;
        return {};
      },
    });
    const { fetchImpl } = fakeEndpoint([{ calls: [call("k1", "clock", "{}")] }, answer("a1")]);
    await collect(runToolTurn(options(fetchImpl, { tools: asTools(tick) })));
    expect(clock).toBe(NOW);
  });
});

describe("rule 8: answer streaming and the prose fallback", () => {
  it("yields partial answer snapshots as the arguments stream, then the validated final", async () => {
    const pieces = ['{"headline":"Venus', ' rises","body":"Steady', ' work."}'];
    const { fetchImpl } = fakeEndpoint([{ calls: [call("a1", "answer", pieces)] }]);
    const { snapshots } = await collect(runToolTurn(options(fetchImpl)));
    expect(snapshots[0]).toBe(render({ headline: "Venus" }, false));
    expect(snapshots).toContain(render({ headline: "Venus rises", body: "Steady" }, false));
    expect(snapshots.at(-1)).toBe(FINAL);
    expect(new Set(snapshots).size).toBe(snapshots.length);
  });

  it("with no valid answer after maxRounds, asks once more without tools for plain prose", async () => {
    const bad = '{"headline":1}';
    const { fetchImpl, requests } = fakeEndpoint([answer("a1", bad), answer("a2", bad), { text: "Venus rises; steady work." }]);
    const o = options(fetchImpl, { limits: { maxRounds: 2 } });
    const { snapshots, result } = await collect(runToolTurn(o));
    expect(requests).toHaveLength(3);
    expect(requests[2].body.tool_choice).toBe("none");
    expect(messagesOf(requests[2]).some((m) => m.role === "system" && m.content === "Write the answer as plain prose.")).toBe(true);
    expect(snapshots.at(-1)).toBe("Venus rises; steady work.");
    expect(result).toEqual({ answer: undefined });
    expect(o.rounds.at(-1)).toMatchObject({ round: 3, finishReason: "answer_fallback" });
  });
});

describe("rule 9: an endpoint that rejects tools", () => {
  it("yields the notice, then answers without tools from the supplied facts", async () => {
    const reject: FakeTurn = { status: 400, errorBody: '{"error":{"message":"tools are not supported by this model"}}' };
    const { fetchImpl, requests } = fakeEndpoint([reject, { text: "From the facts: Venus." }]);
    const o = options(fetchImpl);
    const { snapshots, result } = await collect(runToolTurn(o));
    expect(snapshots[0]).toBe(TOOLS_UNAVAILABLE_NOTICE);
    expect(snapshots.at(-1)).toBe(`${TOOLS_UNAVAILABLE_NOTICE}From the facts: Venus.`);
    expect(requests[1].body).not.toHaveProperty("tools");
    expect(messagesOf(requests[1])[0]).toEqual({ role: "system", content: TOOLS_UNAVAILABLE_INSTRUCTION });
    expect(result).toEqual({ answer: undefined });
    expect(o.statuses.at(-1)).toEqual({ phase: "complete" });
  });

  it("does not degrade on an unrelated 400", async () => {
    const { fetchImpl, requests } = fakeEndpoint([{ status: 400, errorBody: '{"error":{"message":"context length exceeded"}}' }]);
    await expect(collect(runToolTurn(options(fetchImpl)))).rejects.toBeInstanceOf(LlmRequestError);
    expect(requests).toHaveLength(1);
  });
});

describe("rule 10: errors", () => {
  it("an HTTP failure is an LlmRequestError carrying status and body, with no retry", async () => {
    const { fetchImpl, requests } = fakeEndpoint([{ status: 401, errorBody: '{"error":{"message":"No auth credentials found"}}' }]);
    const failure = await collect(runToolTurn(options(fetchImpl))).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(LlmRequestError);
    expect(failure).toMatchObject({ status: 401, body: '{"error":{"message":"No auth credentials found"}}' });
    expect(String((failure as Error).message)).toContain("401");
    expect(requests).toHaveLength(1);
  });

  it("a 5xx is not retried by the SDK either", async () => {
    const { fetchImpl, requests } = fakeEndpoint([{ status: 503, errorBody: "upstream down" }, answer("a1")]);
    await expect(collect(runToolTurn(options(fetchImpl)))).rejects.toMatchObject({ status: 503 });
    expect(requests).toHaveLength(1);
  });

  it("a user abort passes through as an AbortError", async () => {
    const controller = new AbortController();
    const stop = defineTool<Record<string, never>>({
      name: "stop",
      description: "Stops.",
      input: z.object({}),
      async execute() {
        controller.abort();
        return {};
      },
    });
    const { fetchImpl } = fakeEndpoint([{ calls: [call("s1", "stop", "{}")] }, answer("a1")]);
    const failure = await collect(runToolTurn(options(fetchImpl, { tools: asTools(stop), signal: controller.signal }))).catch((e: unknown) => e);
    expect(failure).toMatchObject({ name: "AbortError" });
  });

  it("a stream with no output past the reasoning cap fails with ReasoningTimeoutError", async () => {
    const { fetchImpl } = fakeEndpoint([{ hang: true }]);
    const failure = await collect(runToolTurn(options(fetchImpl, { reasoningTimeoutMs: 50 }))).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ReasoningTimeoutError);
  });
});

describe("rule 11: tool timeouts", () => {
  function sleeper(timeoutMs?: number): ToolDef<Record<string, never>> {
    return defineTool<Record<string, never>>({
      name: "slow",
      description: "Never finishes.",
      input: z.object({}),
      timeoutMs,
      execute: () => new Promise<never>(() => undefined),
    });
  }

  it("a tool past its timeoutMs is an error the model sees, and the turn goes on", async () => {
    const { fetchImpl, requests } = fakeEndpoint([{ calls: [call("w1", "slow", "{}")] }, answer("a1")]);
    const o = options(fetchImpl, { tools: asTools(sleeper(30)) });
    const { result } = await collect(runToolTurn(o));
    expect(o.toolCalls[0]).toMatchObject({ toolCallId: "w1", status: "error" });
    expect(toolMessage(requests[1], "w1")).toContain("timed out");
    expect(result).toEqual({ answer: { headline: "Venus rises", body: "Steady work." } });
  });

  it("aborts the tool's own signal on timeout", async () => {
    let aborted = false;
    const listener = defineTool<Record<string, never>>({
      name: "slow",
      description: "Waits for its signal.",
      input: z.object({}),
      timeoutMs: 20,
      execute: (_input, ctx) =>
        new Promise((_resolve, reject) => {
          ctx.signal.addEventListener("abort", () => {
            aborted = true;
            reject(ctx.signal.reason);
          });
        }),
    });
    const { fetchImpl } = fakeEndpoint([{ calls: [call("w1", "slow", "{}")] }, answer("a1")]);
    await collect(runToolTurn(options(fetchImpl, { tools: asTools(listener) })));
    expect(aborted).toBe(true);
  });

  it("pins the default 2000 ms and the 150_000 ms ceiling", () => {
    expect(TOOL_TIMEOUT_MS).toEqual({ default: 2_000, max: 150_000 });
  });

  it("applies the 2000 ms default when a tool names none", async () => {
    const { fetchImpl } = fakeEndpoint([{ calls: [call("w1", "slow", "{}")] }, answer("a1")]);
    const o = options(fetchImpl, { tools: asTools(sleeper()) });
    const started = Date.now();
    await collect(runToolTurn(o));
    expect(o.toolCalls[0]).toMatchObject({ status: "error" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_900);
  }, 10_000);
});

describe("tool calls written as text (deepseek DSML)", () => {
  const DSML =
    '<｜DSML｜tool_calls> <｜DSML｜invoke name="get_timing"><｜DSML｜parameter name="start">2019-09</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>';

  it("never yields the text, and continues the turn with one corrective message", async () => {
    const { fetchImpl, requests } = fakeEndpoint([{ text: DSML }, answer("a1")]);
    const o = options(fetchImpl);
    const { snapshots, result } = await collect(runToolTurn(o));
    expect(snapshots.some((s) => s.includes("DSML"))).toBe(false);
    expect(snapshots.at(-1)).toBe(FINAL);
    expect(result).toEqual({ answer: { headline: "Venus rises", body: "Steady work." } });
    expect(requests).toHaveLength(2);
    expect(messagesOf(requests[1]).at(-1)).toEqual({
      role: "system",
      content: "Call a tool: use read_period to read, or answer to finish. Do not write tool calls as text.",
    });
    expect(o.rounds.map((r) => r.round)).toEqual([1, 2]);
  });

  it("the corrective round counts toward maxRounds: the last round still forces the answer", async () => {
    const { fetchImpl, requests } = fakeEndpoint([{ text: DSML }, answer("a1")]);
    await collect(runToolTurn(options(fetchImpl, { limits: { maxRounds: 2 } })));
    expect(requests[1].body.tool_choice).toEqual({ type: "function", function: { name: "answer" } });
  });

  // CONTRACT REVERSED (fix round 1): this test used to assert that the
  // readFirst restriction applied to round 1 only. A DSML round 1 then let a
  // trip turn answer without reading. Now `answer` stays hidden until a read
  // tool call has completed this turn (or the forced last round).
  it("readFirst: a DSML round 1 does not unlock answer; the corrective round still only offers reads", async () => {
    const { fetchImpl, requests } = fakeEndpoint([{ text: DSML }, read("c1"), answer("a1")]);
    await collect(runToolTurn(options(fetchImpl, { readFirst: true })));
    expect(toolsOf(requests[0]).map((t) => t.function.name)).toEqual(["read_period"]);
    expect(toolsOf(requests[1]).map((t) => t.function.name)).toEqual(["read_period"]);
    expect(messagesOf(requests[1]).at(-1)).toEqual({
      role: "system",
      content: "Call a tool: use read_period to read. Do not write tool calls as text.",
    });
    expect(toolsOf(requests[2]).map((t) => t.function.name)).toEqual(["read_period", "answer"]);
  });

  it("readFirst: an invalid read does not unlock answer", async () => {
    const { fetchImpl, requests } = fakeEndpoint([read("c1", '{"start":"Sept 2019","end":null}'), read("c2"), answer("a1")]);
    await collect(runToolTurn(options(fetchImpl, { readFirst: true })));
    expect(toolsOf(requests[1]).map((t) => t.function.name)).toEqual(["read_period"]);
    expect(toolsOf(requests[2]).map((t) => t.function.name)).toEqual(["read_period", "answer"]);
  });

  it("readFirst: the forced last round offers answer even with no completed read", async () => {
    const { fetchImpl, requests } = fakeEndpoint([{ text: DSML }, answer("a1")]);
    await collect(runToolTurn(options(fetchImpl, { readFirst: true, limits: { maxRounds: 2 } })));
    expect(requests[1].body.tool_choice).toEqual({ type: "function", function: { name: "answer" } });
    expect(toolsOf(requests[1]).map((t) => t.function.name)).toContain("answer");
  });

  it("with no read tools, the corrective message asks only for the answer", async () => {
    const { fetchImpl, requests } = fakeEndpoint([{ text: DSML }, answer("a1")]);
    await collect(runToolTurn(options(fetchImpl, { tools: [] })));
    expect(messagesOf(requests[1]).at(-1)).toEqual({
      role: "system",
      content: "Call the answer tool to finish. Do not write tool calls as text.",
    });
  });

  it("the corrective message names the turn's own read tools", async () => {
    const lookup = defineTool<{ readonly q: string }>({
      name: "lookup",
      description: "Look something up.",
      input: z.object({ q: z.string() }),
      execute: async () => ({}),
    });
    const { fetchImpl, requests } = fakeEndpoint([{ text: DSML }, answer("a1")]);
    await collect(runToolTurn(options(fetchImpl, { tools: asTools(readPeriod(), lookup) })));
    expect(messagesOf(requests[1]).at(-1)).toEqual({
      role: "system",
      content: "Call a tool: use read_period or lookup to read, or answer to finish. Do not write tool calls as text.",
    });
  });

  it("the prose fallback strips tool-call markup from the text", async () => {
    const prose = `Venus rises.${DSML}<tool_call>{"name":"answer"}</tool_call>`;
    const { fetchImpl, requests } = fakeEndpoint([{ text: DSML }, { text: DSML }, { text: prose }]);
    const { snapshots, result } = await collect(runToolTurn(options(fetchImpl, { limits: { maxRounds: 2 } })));
    expect(requests).toHaveLength(3);
    expect(snapshots.some((s) => s.includes("DSML") || s.includes("tool_call"))).toBe(false);
    expect(snapshots.at(-1)).toBe("Venus rises.");
    expect(result).toEqual({ answer: undefined });
  });

  it.each([
    ["DSML only", '<｜DSML｜tool_calls><｜DSML｜invoke name="x">1</｜DSML｜invoke></｜DSML｜tool_calls>'],
    ["an unclosed DSML block", '<｜DSML｜tool_calls><｜DSML｜invoke name="x">'],
    ["a <tool_call> tag only", '  <tool_call>{"name":"answer"}</tool_call>  '],
  ])("a fallback with nothing but markup (%s) is an empty agent completion", async (_label, text) => {
    const { fetchImpl } = fakeEndpoint([{ text: DSML }, { text: DSML }, { text }]);
    const failure = await collect(runToolTurn(options(fetchImpl, { limits: { maxRounds: 2 } }))).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(LlmRequestError);
    expect((failure as Error).message).toContain("empty agent completion");
  });
});

describe("error branches", () => {
  it("a network failure keeps its own TypeError, so the app classifies it as unreachable", async () => {
    const { fetchImpl } = fakeEndpoint([{ networkError: "browser" }]);
    const failure = await collect(runToolTurn(options(fetchImpl))).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(TypeError);
    expect((failure as Error).message).toBe("Failed to fetch");
  });

  it("a status-less SDK network error is an LlmRequestError that says unreachable, without retry", async () => {
    const { fetchImpl, requests } = fakeEndpoint([{ networkError: "node" }, answer("a1")]);
    const failure = await collect(runToolTurn(options(fetchImpl))).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(LlmRequestError);
    expect(failure).toMatchObject({ status: undefined });
    expect((failure as Error).message).toMatch(/^LLM endpoint unreachable: .*ECONNREFUSED/);
    expect(requests).toHaveLength(1);
  });

  it("an HTTP failure with an empty body has no body and is not mistaken for a tools rejection", async () => {
    const { fetchImpl, requests } = fakeEndpoint([{ status: 404 }]);
    const failure = await collect(runToolTurn(options(fetchImpl))).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(LlmRequestError);
    expect(failure).toMatchObject({ status: 404, body: undefined, message: "LLM endpoint returned 404" });
    expect(requests).toHaveLength(1);
  });

  it("a 500 that mentions tools is an outage, not a tools rejection", async () => {
    const { fetchImpl, requests } = fakeEndpoint([{ status: 500, errorBody: "tools are not supported right now" }]);
    await expect(collect(runToolTurn(options(fetchImpl)))).rejects.toMatchObject({ status: 500 });
    expect(requests).toHaveLength(1);
  });

  it("non-object tool arguments are a retry", async () => {
    const { fetchImpl } = fakeEndpoint([read("c1", '"Sept 2019"'), answer("a1")]);
    const o = options(fetchImpl);
    await collect(runToolTurn(o));
    expect(o.toolCalls[0]).toMatchObject({ toolCallId: "c1", status: "retried", validFirstTry: false });
  });

  it("an abort with a non-Error reason still surfaces as an AbortError", async () => {
    const controller = new AbortController();
    const stop = defineTool<Record<string, never>>({
      name: "stop",
      description: "Stops.",
      input: z.object({}),
      async execute() {
        controller.abort("user closed the chat");
        return {};
      },
    });
    const { fetchImpl } = fakeEndpoint([{ calls: [call("s1", "stop", "{}")] }, answer("a1")]);
    const failure = await collect(runToolTurn(options(fetchImpl, { tools: asTools(stop), signal: controller.signal }))).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(DOMException);
    expect(failure).toMatchObject({ name: "AbortError" });
  });

  it("a request that never answers at all also hits the reasoning cap", async () => {
    const { fetchImpl } = fakeEndpoint([{ hangFetch: true }]);
    const failure = await collect(runToolTurn(options(fetchImpl, { reasoningTimeoutMs: 50 }))).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ReasoningTimeoutError);
  });

  it("an HTTP failure in the prose fallback is an LlmRequestError", async () => {
    const bad = '{"headline":1}';
    const { fetchImpl } = fakeEndpoint([answer("a1", bad), answer("a2", bad), { status: 502, errorBody: "bad gateway" }]);
    await expect(collect(runToolTurn(options(fetchImpl, { limits: { maxRounds: 2 } })))).rejects.toMatchObject({ status: 502 });
  });

  it("a stalled prose stream after a tools rejection hits the reasoning cap", async () => {
    const reject: FakeTurn = { status: 400, errorBody: "tool_choice is not supported" };
    const { fetchImpl } = fakeEndpoint([reject, { hang: true }]);
    const failure = await collect(runToolTurn(options(fetchImpl, { reasoningTimeoutMs: 50 }))).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ReasoningTimeoutError);
  });

  it("model text beside a tool call is never yielded", async () => {
    const { fetchImpl } = fakeEndpoint([{ text: "Let me check.", calls: [call("a1", "answer", '{"headline":"Venus rises","body":"Steady work."}')] }]);
    const { snapshots } = await collect(runToolTurn(options(fetchImpl)));
    expect(snapshots.some((s) => s.includes("Let me check"))).toBe(false);
    expect(snapshots.at(-1)).toBe(FINAL);
  });

  it("whitespace before the answer JSON yields nothing until there is an object", async () => {
    const { fetchImpl } = fakeEndpoint([{ calls: [call("a1", "answer", ["  ", '{"headline":"Venus rises","body":"Steady work."}'])] }]);
    const { snapshots } = await collect(runToolTurn(options(fetchImpl)));
    expect(snapshots).toEqual([render({ headline: "Venus rises", body: "Steady work." }, false), FINAL]);
  });
});

describe("prose fallback: a held-back partial tag", () => {
  it("shows a literal '<' once the stream ends without closing it", async () => {
    const bad = '{"headline":1}';
    const { fetchImpl } = fakeEndpoint([answer("a1", bad), answer("a2", bad), { text: "Mars is strong when 3 < 5" }]);
    const { snapshots } = await collect(runToolTurn(options(fetchImpl, { limits: { maxRounds: 2 } })));
    expect(snapshots.at(-1)).toBe("Mars is strong when 3 < 5");
  });
});

describe("fix round 1", () => {
  it("returning early from the generator aborts the in-flight request", async () => {
    const held: FakeTurn = { holdOpen: true, calls: [call("a1", "answer", ['{"headline":"Venus', ' rises"'])] };
    const { fetchImpl, signals } = fakeEndpoint([held]);
    const stream = runToolTurn(options(fetchImpl));
    expect((await stream.next()).done).toBe(false);
    expect(signals[0]?.aborted).toBe(false);
    await stream.return({ answer: undefined });
    expect(signals[0]?.aborted).toBe(true);
  });

  it("returning early from the generator aborts a running tool", async () => {
    let toolSignal: AbortSignal | undefined;
    const slow = defineTool<Record<string, never>>({
      name: "slow",
      description: "Waits for its signal.",
      input: z.object({}),
      timeoutMs: 60_000,
      execute: (_input, ctx) => {
        toolSignal = ctx.signal;
        return new Promise((_resolve, reject) => ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason)));
      },
    });
    const { fetchImpl } = fakeEndpoint([{ calls: [call("w1", "slow", "{}"), call("a1", "answer", ['{"headline":"Venus', ' rises"}'])] }]);
    const stream = runToolTurn(options(fetchImpl, { tools: asTools(slow) }));
    expect((await stream.next()).done).toBe(false);
    await vi.waitFor(() => expect(toolSignal).toBeDefined());
    expect(toolSignal?.aborted).toBe(false);
    await stream.return({ answer: undefined });
    expect(toolSignal?.aborted).toBe(true);
  });

  it("keeps the SDK-validated answer instead of parsing it a second time", async () => {
    const Counted = z.object({ headline: z.string().transform((s) => s.length), body: z.string() });
    const { fetchImpl } = fakeEndpoint([answer("a1")]);
    const { result, snapshots } = await collect(
      runToolTurn({
        ...options(fetchImpl),
        answer: { schema: Counted, render: (p, final) => `${final ? "final" : "partial"}:${String(p.headline)}` },
      } as unknown as RunToolTurnOptions<z.infer<typeof Counted>>),
    );
    expect(result).toEqual({ answer: { headline: 11, body: "Steady work." } });
    expect(snapshots.at(-1)).toBe("final:11");
  });

  // Holds today because the SDK drops the tool-error part once the turn is
  // aborted (probed with four abort timings). Kept as a tripwire: if an SDK
  // upgrade starts emitting it, this goes red.
  it("a user abort during a tool's execute ends the turn without an error row", async () => {
    const controller = new AbortController();
    const waits = defineTool<Record<string, never>>({
      name: "waits",
      description: "Waits for its signal.",
      input: z.object({}),
      timeoutMs: 60_000,
      execute: (_input, ctx) => {
        setTimeout(() => controller.abort(), 5);
        return new Promise((_resolve, reject) => ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason)));
      },
    });
    const { fetchImpl } = fakeEndpoint([{ calls: [call("w1", "waits", "{}")] }, answer("a1")]);
    const o = options(fetchImpl, { tools: asTools(waits), signal: controller.signal });
    const failure = await collect(runToolTurn(o)).catch((e: unknown) => e);
    expect(failure).toMatchObject({ name: "AbortError" });
    expect(o.toolCalls.filter((e) => e.status === "error")).toEqual([]);
  });
});
