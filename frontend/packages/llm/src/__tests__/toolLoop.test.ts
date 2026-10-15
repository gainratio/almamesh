// The toolLoop seam: one AI SDK loop with zod-typed tools, invalid arguments
// returned to the model as retries, a final `answer` tool, budgets and events.
// One describe per implementation rule in the Task 2 brief.
import { describe, expect, it, vi } from "vitest";

import { LlmRequestError } from "../client";
import type { ProviderConfig } from "../config";
import { REASONING_TIMEOUT_MS, ReasoningTimeoutError } from "../reasoning";
import {
  ANSWER_TOOL_DESCRIPTION,
  NETWORK_RETRY_DELAY_MS,
  TOOL_LOOP_LIMITS,
  TOOL_TIMEOUT_MS,
  TOOLS_UNAVAILABLE_INSTRUCTION,
  TURN_MODEL_TIME_CEILING_MS,
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
    reads: true,
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

interface TravelInput {
  readonly to: string;
}

const ALREADY_TRAVELLED = "Already travelled this turn; the move happens after your answer.";

function travelTool(moved: TravelInput[] = []): ToolDef<TravelInput> {
  return defineTool<TravelInput>({
    name: "travel",
    description: "Move the conversation to a period.",
    overLimitNote: ALREADY_TRAVELLED,
    input: z.object({ to: z.string() }),
    async execute(input) {
      moved.push(input);
      return { status: "queued" };
    },
  });
}

const travelTurn = (id: string): FakeTurn => ({ calls: [call(id, "travel", '{"to":"2017-09"}')] });

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

  describe('the string "null" a model sends for an unused nullable key', () => {
    interface WideInput {
      readonly start: string;
      readonly end: string | null;
      readonly place: string | null;
      readonly time: string | null;
      readonly focus: string | null;
    }
    const nullableText = z.string().regex(/^\d{4}(-\d{2})?$/, "end must be YYYY-MM").nullable();
    const wide = (seen: WideInput[]) =>
      defineTool<WideInput>({
        name: "read_period",
        description: "Read the sky for a period.",
        statusLabel: "Reading the period",
        input: z.object({
          start: z.string().regex(/^\d{4}(-\d{2})?$/, "start must be YYYY-MM"),
          end: nullableText,
          place: z.string().nullable(),
          time: z.string().nullable(),
          focus: z.string().nullable(),
        }),
        async execute(input) {
          seen.push(input);
          return { ok: true };
        },
      });

    it("becomes null on the first try (the exact deepseek-v4-pro args)", async () => {
      const seen: WideInput[] = [];
      const args = '{"start":"2019-09","end":"null","place":"Vadodara","time":"null","focus":"null"}';
      const { fetchImpl } = fakeEndpoint([read("c1", args), answer("a1")]);
      const o = options(fetchImpl, { tools: asTools(wide(seen)) });
      await collect(runToolTurn(o));
      expect(seen).toEqual([{ start: "2019-09", end: null, place: "Vadodara", time: null, focus: null }]);
      expect(o.toolCalls[0]).toMatchObject({ status: "complete", validFirstTry: true });
      expect(o.toolCalls.some((e) => e.status === "retried")).toBe(false);
    });

    it("is matched case-insensitively and trimmed", async () => {
      const seen: WideInput[] = [];
      const args = '{"start":"2019-09","end":" NULL ","place":"Null","time":null,"focus":null}';
      const { fetchImpl } = fakeEndpoint([read("c1", args), answer("a1")]);
      await collect(runToolTurn(options(fetchImpl, { tools: asTools(wide(seen)) })));
      expect(seen[0]).toMatchObject({ end: null, place: null });
    });

    it("leaves a genuinely wrong value alone: end:'Sept' still retries", async () => {
      const seen: WideInput[] = [];
      const args = '{"start":"2019-09","end":"Sept","place":null,"time":null,"focus":null}';
      const { fetchImpl } = fakeEndpoint([read("c1", args), answer("a1")]);
      const o = options(fetchImpl, { tools: asTools(wide(seen)) });
      await collect(runToolTurn(o));
      expect(seen).toEqual([]);
      expect(o.toolCalls[0]).toMatchObject({ status: "retried", validFirstTry: false });
    });

    it("leaves a non-nullable key alone: start:'null' still fails", async () => {
      const seen: WideInput[] = [];
      const args = '{"start":"null","end":null,"place":null,"time":null,"focus":null}';
      const { fetchImpl } = fakeEndpoint([read("c1", args), answer("a1")]);
      const o = options(fetchImpl, { tools: asTools(wide(seen)) });
      await collect(runToolTurn(o));
      expect(seen).toEqual([]);
      expect(o.toolCalls[0]).toMatchObject({ status: "retried", validFirstTry: false });
    });
  });

  describe("nested nullable keys (objects, arrays, wrapped schemas)", () => {
    const Nested = z.object({
      headline: z.string(),
      dashas: z.object({ maha: z.string(), pratyantar: z.string().nullable() }),
      themes: z.array(z.object({ name: z.string(), obstacle: z.string().nullable() })),
      extra: z.object({ note: z.string().nullable(), year: z.number() }).nullable(),
    });
    const runNested = async (args: string) => {
      const good = '{"headline":"H","dashas":{"maha":"V","pratyantar":null},"themes":[],"extra":null}';
      const { fetchImpl } = fakeEndpoint([
        { calls: [call("a1", "answer", args)] },
        { calls: [call("a2", "answer", good)] },
      ]);
      const o = options(fetchImpl, { answer: { schema: Nested, render: (p) => String(p.headline) } });
      const result = await collect(runToolTurn(o));
      return { o, result };
    };

    it("fills an omitted nested key and a nested \"null\" string on the first try", async () => {
      const args =
        '{"headline":"H","dashas":{"maha":"Venus","pratyantar":"null"},"themes":[{"name":"work"},{"name":"love","obstacle":"Null"}],"extra":{"year":3}}';
      const { o } = await runNested(args);
      expect(o.toolCalls[0]).toMatchObject({ toolName: "answer", status: "complete", validFirstTry: true });
    });

    it("a nested wrong value still retries", async () => {
      const args = '{"headline":"H","dashas":{"maha":"Venus","pratyantar":null},"themes":[{"name":7}],"extra":null}';
      const { o } = await runNested(args);
      expect(o.toolCalls[0]).toMatchObject({ status: "retried", validFirstTry: false });
    });
  });

  it("sends every key as required, the optional one as nullable", async () => {
    const { fetchImpl, requests } = fakeEndpoint([answer("a1")]);
    await collect(runToolTurn(options(fetchImpl)));
    const period = toolsOf(requests[0]).find((t) => t.function.name === "read_period");
    expect(period?.function.parameters.required).toEqual(["start", "end"]);
  });

  it("an answer spec's own description replaces the default one on the wire", async () => {
    const { fetchImpl, requests } = fakeEndpoint([answer("a1")]);
    await collect(runToolTurn(options(fetchImpl, { answer: { schema: Answer, render, description: "Copy the cite." } })));
    expect(toolsOf(requests[0]).find((t) => t.function.name === "answer")?.function.description).toBe("Copy the cite.");
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

  // dashboard.agentic.real 2026-10-15: an answer the reflection check sent back for rewording was
  // followed by another read, past the turn's three calls. Once a read has completed, the facts are
  // in hand: the retry round offers only the answer, so a rewording never spends a read.
  it("after a read, a rejected answer is retried with only the answer tool", async () => {
    const { fetchImpl, requests } = fakeEndpoint([read("c1"), answer("a1", '{"headline":"Venus rises"}'), answer("a2")]);
    const { result } = await collect(runToolTurn(options(fetchImpl)));
    expect(toolsOf(requests[1]).map((t) => t.function.name)).toEqual(["read_period", "answer"]);
    expect(toolsOf(requests[2]).map((t) => t.function.name)).toEqual(["answer"]);
    expect(requests[2].body.tool_choice).toEqual({ type: "function", function: { name: "answer" } });
    expect(result).toEqual({ answer: { headline: "Venus rises", body: "Steady work." } });
  });

  it("before any read, a rejected answer may still read: the fix can be to read the period first", async () => {
    const { fetchImpl, requests } = fakeEndpoint([answer("a1", '{"headline":"Venus rises"}'), read("c1"), answer("a2")]);
    await collect(runToolTurn(options(fetchImpl)));
    expect(toolsOf(requests[1]).map((t) => t.function.name)).toEqual(["read_period", "answer"]);
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

  it("readFirst: only a read tool unlocks answer; a completed travel call does not", async () => {
    const travel = defineTool<{ readonly start: string }>({
      name: "travel",
      description: "Move this conversation to a period.",
      input: z.object({ start: z.string() }),
      async execute() {
        return { moved: true };
      },
    });
    const travelCall: FakeTurn = { calls: [call("t1", "travel", '{"start":"2019-05"}')] };
    const { fetchImpl, requests } = fakeEndpoint([travelCall, read("r1"), answer("a1")]);
    await collect(runToolTurn(options(fetchImpl, { readFirst: true, tools: asTools(readPeriod(), travel) })));
    expect(toolsOf(requests[0]).map((t) => t.function.name)).toEqual(["read_period", "travel"]);
    // Contract reversed 2026-10-14 (travel at most once per turn): a travel that used its one call
    // this turn is no longer offered; the model called it twice in a real run (4 calls > 3).
    expect(toolsOf(requests[1]).map((t) => t.function.name)).toEqual(["read_period"]);
    expect(toolsOf(requests[2]).map((t) => t.function.name)).toEqual(["read_period", "answer"]);
  });

  it("readFirst: a tool whose result says there is nothing to read (back to today) unlocks answer", async () => {
    const back = defineTool<{ readonly to: string }>({
      name: "travel",
      description: "Move this conversation to a period, or back to today.",
      input: z.object({ to: z.string() }),
      unlocksAnswer: (result) => (result as { action?: string }).action === "back_to_today",
      async execute(input) {
        return { status: "queued", action: input.to === "today" ? "back_to_today" : "travel" };
      },
    });
    const home = fakeEndpoint([{ calls: [call("t1", "travel", '{"to":"today"}')] }, answer("a1")]);
    await collect(runToolTurn(options(home.fetchImpl, { readFirst: true, tools: asTools(readPeriod(), back) })));
    expect(toolsOf(home.requests[1]).map((t) => t.function.name)).toEqual(["read_period", "answer"]);

    const away = fakeEndpoint([{ calls: [call("t1", "travel", '{"to":"2019-05"}')] }, read("r1"), answer("a1")]);
    await collect(runToolTurn(options(away.fetchImpl, { readFirst: true, tools: asTools(readPeriod(), back) })));
    expect(toolsOf(away.requests[1]).map((t) => t.function.name)).toEqual(["read_period"]);
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

  it("a tool at its per-turn limit leaves the tools offered in later rounds", async () => {
    const moved: TravelInput[] = [];
    const { fetchImpl, requests } = fakeEndpoint([travelTurn("t1"), read("c1"), answer("a1")]);
    await collect(runToolTurn(options(fetchImpl, { tools: asTools(readPeriod(), travelTool(moved)) })));
    expect(toolsOf(requests[0]).map((t) => t.function.name)).toEqual(["read_period", "travel", "answer"]);
    expect(toolsOf(requests[1]).map((t) => t.function.name)).toEqual(["read_period", "answer"]);
    expect(toolsOf(requests[2]).map((t) => t.function.name)).toEqual(["read_period", "answer"]);
    expect(moved).toHaveLength(1);
  });

  it("a second travel in one round gets the tool's own neutral note: skipped, never an error", async () => {
    const moved: TravelInput[] = [];
    const twice: FakeTurn = { calls: [call("t1", "travel", '{"to":"2017-09"}'), call("t2", "travel", '{"to":"2017-10"}')] };
    const { fetchImpl, requests } = fakeEndpoint([twice, answer("a1")]);
    const o = options(fetchImpl, { tools: asTools(readPeriod(), travelTool(moved)) });
    await collect(runToolTurn(o));
    expect(moved).toHaveLength(1);
    const statusById = Object.fromEntries(o.toolCalls.map((e) => [e.toolCallId, e.status]));
    expect(statusById).toEqual({ t1: "complete", t2: "skipped", a1: "complete" });
    expect(toolMessage(requests[1], "t2")).toContain("Already travelled this turn");
    expect(toolMessage(requests[1], "t2")).not.toContain("read enough");
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
    // Each round also carries its budget fields (toolLoop.budget.test.ts covers them).
    const budget = { estimate: expect.any(Number), estimated: false, budget: 4_096, compacted: 0 };
    expect(o.rounds).toEqual([
      { round: 1, inputTokens: 120, outputTokens: 7, finishReason: "tool-calls", ...budget },
      { round: 2, inputTokens: 10, outputTokens: 5, finishReason: "tool-calls", ...budget },
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

describe("rule 9a: an endpoint that refuses tool_choice \"required\" (but does tools)", () => {
  const OPENROUTER_404: FakeTurn = {
    status: 404,
    errorBody: '{"error":{"message":"No endpoints found that support the provided \'tool_choice\' value.","code":404}}',
  };
  const NOT_SUPPORTED_400: FakeTurn = { status: 400, errorBody: "tool_choice is not supported" };

  it.each([
    ["OpenRouter's 404", OPENROUTER_404],
    ["a 400 'tool_choice is not supported'", NOT_SUPPORTED_400],
  ])("%s: reruns the turn under \"auto\" with every tool, answer included", async (_name, refusal) => {
    const { fetchImpl, requests } = fakeEndpoint([refusal, read("r1"), answer("a1")]);
    const { snapshots, result } = await collect(runToolTurn(options(fetchImpl)));
    expect(requests[0].body.tool_choice).toBe("required");
    expect(requests[1].body.tool_choice).toBe("auto");
    expect(toolsOf(requests[1]).map((t) => t.function.name).sort()).toEqual(["answer", "read_period"]);
    expect(requests[2].body.tool_choice).toBe("auto");
    expect(snapshots.some((s) => s.includes(TOOLS_UNAVAILABLE_NOTICE.trim()))).toBe(false);
    expect(snapshots.at(-1)).toBe(FINAL);
    expect(result).toEqual({ answer: { headline: "Venus rises", body: "Steady work." } });
  });

  it("a trip turn under \"auto\" still reads first: answer is hidden until a read completes", async () => {
    const { fetchImpl, requests } = fakeEndpoint([OPENROUTER_404, read("r1"), answer("a1")]);
    await collect(runToolTurn(options(fetchImpl, { readFirst: true })));
    expect(requests[1].body.tool_choice).toBe("auto");
    expect(toolsOf(requests[1]).map((t) => t.function.name)).toEqual(["read_period"]);
    expect(toolsOf(requests[2]).map((t) => t.function.name)).toContain("answer");
  });

  it("the last round under \"auto\" offers only the answer tool (no named tool_choice)", async () => {
    const { fetchImpl, requests } = fakeEndpoint([NOT_SUPPORTED_400, read("r1"), answer("a1")]);
    await collect(runToolTurn(options(fetchImpl, { limits: { maxRounds: 2 } })));
    expect(requests[2].body.tool_choice).toBe("auto");
    expect(toolsOf(requests[2]).map((t) => t.function.name)).toEqual(["answer"]);
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

  it("tools refused after a tool_choice rerun also degrade to the notice", async () => {
    const refusedChoice: FakeTurn = { status: 404, errorBody: "Unknown parameter: tool_choice" };
    const { fetchImpl, requests } = fakeEndpoint([refusedChoice, refusedChoice, { text: "From the facts: Venus." }]);
    const { snapshots } = await collect(runToolTurn(options(fetchImpl)));
    expect(requests[1].body.tool_choice).toBe("auto");
    expect(snapshots.at(-1)).toBe(`${TOOLS_UNAVAILABLE_NOTICE}From the facts: Venus.`);
  });

  it("OpenRouter's 'No endpoints found that support tool use' is a tools refusal", async () => {
    const reject: FakeTurn = { status: 404, errorBody: '{"error":{"message":"No endpoints found that support tool use.","code":404}}' };
    const { fetchImpl } = fakeEndpoint([reject, { text: "From the facts: Venus." }]);
    const { snapshots } = await collect(runToolTurn(options(fetchImpl)));
    expect(snapshots[0]).toBe(TOOLS_UNAVAILABLE_NOTICE);
  });

  it("the tools-unavailable request drops the prompt's TOOLS line (it says to call answer)", async () => {
    const reject: FakeTurn = { status: 400, errorBody: "tools are not supported by this model" };
    const { fetchImpl, requests } = fakeEndpoint([reject, { text: "From the facts: Venus." }]);
    const system = "You are kind.\nNOW: today is Monday.\nTOOLS: read_period reads any span. Finish every turn by calling answer.";
    await collect(runToolTurn(options(fetchImpl, { messages: [{ role: "system", content: system }, { role: "user", content: "Hi" }] })));
    const sent = messagesOf(requests[1]).map((m) => String(m.content)).join("\n");
    expect(sent).toContain("NOW: today is Monday.");
    expect(sent).not.toContain("TOOLS:");
    expect(sent).not.toMatch(/calling answer/);
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

  // CONTRACT REVERSAL (Task 10d): this test was "a 5xx is not retried by the SDK either"
  // (maxRetries: 0). A provider 5xx or 429 is transient, so the SDK now retries it twice inside
  // the seam (its default) before the turn fails; the status still reaches the app's classifier.
  it("a 5xx is retried by the SDK, and the turn goes on when the retry succeeds", async () => {
    const { fetchImpl, requests } = fakeEndpoint([{ status: 503, errorBody: "upstream down", retryAfterMs: 0 }, answer("a1")]);
    const o = options(fetchImpl);
    await collect(runToolTurn(o));
    expect(requests).toHaveLength(2);
    expect(o.statuses.at(-1)).toEqual({ phase: "complete" });
  });

  it.each([
    [429, "rate limited"],
    [503, "upstream down"],
  ])("a %i that outlasts two retries is an LlmRequestError with its status and body (not a RetryError)", async (status, errorBody) => {
    const failing = { status, errorBody, retryAfterMs: 0 };
    const { fetchImpl, requests } = fakeEndpoint([failing, failing, failing]);
    const failure = await collect(runToolTurn(options(fetchImpl))).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(LlmRequestError);
    expect(failure).toMatchObject({ status, body: errorBody });
    expect(requests).toHaveLength(3);
  });

  it("a 4xx other than 408/409/429 is not retried", async () => {
    const { fetchImpl, requests } = fakeEndpoint([{ status: 402, errorBody: "no credits", retryAfterMs: 0 }, answer("a1")]);
    await expect(collect(runToolTurn(options(fetchImpl)))).rejects.toMatchObject({ status: 402 });
    expect(requests).toHaveLength(1);
  });

  it("a provider error sent mid-stream (a 200 SSE error chunk) keeps its code as the status", async () => {
    const { fetchImpl } = fakeEndpoint([{ streamError: { message: "Provider returned error", code: 502 } }]);
    const failure = await collect(runToolTurn(options(fetchImpl))).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(LlmRequestError);
    expect(failure).toMatchObject({ status: 502 });
    expect((failure as Error).message).toContain("Provider returned error");
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

  it("the corrective request still carries the rounds before the text (the earlier read)", async () => {
    const { fetchImpl, requests } = fakeEndpoint([read("r1"), { text: DSML }, answer("a1")]);
    await collect(runToolTurn(options(fetchImpl)));
    expect(requests).toHaveLength(3);
    expect(toolMessage(requests[2], "r1")).toContain("Venus");
  });

  it("the prose fallback carries every round's messages, not only the last", async () => {
    const bad = '{"headline":1}';
    const { fetchImpl, requests } = fakeEndpoint([read("r1"), answer("a1", bad), { text: "Venus rises." }]);
    await collect(runToolTurn(options(fetchImpl, { limits: { maxRounds: 2 } })));
    expect(requests[2].body.tool_choice).toBe("none");
    expect(toolMessage(requests[2], "r1")).toContain("Venus");
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
  // Task 10e: a browser network failure is retried once by the seam (see "network retry"), so
  // this needs two failures in a row; what surfaces is still the browser's own TypeError.
  it("a network failure that outlasts its one retry keeps its own TypeError, so the app classifies it as unreachable", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { fetchImpl, requests } = fakeEndpoint([{ networkError: "browser" }, { networkError: "browser" }]);
      const pending = collect(runToolTurn(options(fetchImpl))).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(NETWORK_RETRY_DELAY_MS);
      const failure = await pending;
      expect(failure).toBeInstanceOf(TypeError);
      expect((failure as Error).message).toBe("Failed to fetch");
      expect(requests).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  // CONTRACT REVERSAL (Task 10d, 43092b5a): a refused connection used to fail on its one request
  // (maxRetries: 0). SDK retries are now on, so it is retried twice (2 s, then 4 s backoff) before
  // it reads as unreachable. Fake timers skip the backoff.
  it("a status-less SDK network error is retried twice, then is an LlmRequestError that says unreachable", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const refused = { networkError: "node" } as const;
      const { fetchImpl, requests } = fakeEndpoint([refused, refused, refused]);
      const pending = collect(runToolTurn(options(fetchImpl))).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.advanceTimersByTimeAsync(4_000);
      const failure = await pending;
      expect(failure).toBeInstanceOf(LlmRequestError);
      expect(failure).toMatchObject({ status: undefined });
      expect((failure as Error).message).toMatch(/^LLM endpoint unreachable: .*ECONNREFUSED/);
      expect(requests).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an HTTP failure with an empty body has no body and is not mistaken for a tools rejection", async () => {
    const { fetchImpl, requests } = fakeEndpoint([{ status: 404 }]);
    const failure = await collect(runToolTurn(options(fetchImpl))).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(LlmRequestError);
    expect(failure).toMatchObject({ status: 404, body: undefined, message: "LLM endpoint returned 404" });
    expect(requests).toHaveLength(1);
  });

  // CONTRACT REVERSAL (Task 10d, 43092b5a): this test sent ONE request (maxRetries: 0). A 500 is
  // now retried twice by the SDK, so three requests go out before the outage surfaces.
  it("a 500 that mentions tools is an outage, not a tools rejection", async () => {
    const outage = { status: 500, errorBody: "tools are not supported right now", retryAfterMs: 0 };
    const { fetchImpl, requests } = fakeEndpoint([outage, outage, outage]);
    await expect(collect(runToolTurn(options(fetchImpl)))).rejects.toMatchObject({ status: 500 });
    expect(requests).toHaveLength(3);
    expect(requests.every((request) => Array.isArray(request.body.tools))).toBe(true);
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

  // Real drive 2026-10-15: deepseek-v4-pro streamed reasoning for about 95 s, then sent its whole
  // answer call in one burst at 121 s; on a slower provider that crossed the 180 s cap. The
  // watchdog catches a stalled stream, not a slow thinker: every streamed part, reasoning
  // included, is progress; 180 s of silence is a stall; 300 s of model time ends a runaway.
  describe("the stall watchdog", () => {
    const timed = async <T,>(run: () => Promise<T>, ms: number): Promise<T> => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      try {
        const pending = run();
        await vi.advanceTimersByTimeAsync(ms);
        return await pending;
      } finally {
        vi.useRealTimers();
      }
    };

    it("pins the windows: 180 s of silence, 300 s of model time a turn", () => {
      expect([REASONING_TIMEOUT_MS, TURN_MODEL_TIME_CEILING_MS]).toEqual([180_000, 300_000]);
    });

    it("200 s of streamed reasoning, then the answer, succeeds", async () => {
      const slow: FakeTurn = { ...answer("a1"), reasoning: { forMs: 200_000, everyMs: 10_000 } };
      const { fetchImpl } = fakeEndpoint([slow]);
      const result = await timed(() => collect(runToolTurn(options(fetchImpl))).then((r) => r.result), 201_000);
      expect(result).toEqual({ answer: { headline: "Venus rises", body: "Steady work." } });
    });

    it("a stream that goes silent past the idle window fails with the timeout", async () => {
      const silent: FakeTurn = { ...answer("a1"), reasoning: { forMs: 10_000, everyMs: 10_000, thenSilent: true } };
      const { fetchImpl } = fakeEndpoint([silent]);
      const failure = await timed(() => collect(runToolTurn(options(fetchImpl))).catch((e: unknown) => e), 10_000 + REASONING_TIMEOUT_MS + 1_000);
      expect(failure).toBeInstanceOf(ReasoningTimeoutError);
      expect((failure as Error).message).toContain("180s");
    });

    it("a runaway that keeps reasoning still ends at the 300 s ceiling", async () => {
      const runaway: FakeTurn = { ...answer("a1"), reasoning: { forMs: 3_600_000, everyMs: 10_000 } };
      const { fetchImpl } = fakeEndpoint([runaway]);
      const failure = await timed(() => collect(runToolTurn(options(fetchImpl))).catch((e: unknown) => e), TURN_MODEL_TIME_CEILING_MS + 1_000);
      expect(failure).toBeInstanceOf(ReasoningTimeoutError);
      expect((failure as Error).message).toContain("300s");
    });

    it("the ceiling counts model time only: a slow tool between two long rounds does not end the turn", async () => {
      const slowRead = defineTool<{ readonly start: string }>({
        name: "read_period",
        description: "Read a period.",
        input: z.object({ start: z.string() }),
        timeoutMs: 150_000,
        execute: () => new Promise((resolve) => setTimeout(() => resolve({ period: "2019" }), 140_000)),
      });
      const first: FakeTurn = { calls: [call("r1", "read_period", '{"start":"2019"}')], reasoning: { forMs: 120_000, everyMs: 10_000 } };
      const second: FakeTurn = { ...answer("a1"), reasoning: { forMs: 120_000, everyMs: 10_000 } };
      const { fetchImpl } = fakeEndpoint([first, second]);
      const result = await timed(() => collect(runToolTurn(options(fetchImpl, { tools: asTools(slowRead) }))).then((r) => r.result), 400_000);
      expect(result).toEqual({ answer: { headline: "Venus rises", body: "Steady work." } });
    });
  });

  it("a request that never answers at all also hits the reasoning cap", async () => {
    const { fetchImpl } = fakeEndpoint([{ hangFetch: true }]);
    const failure = await collect(runToolTurn(options(fetchImpl, { reasoningTimeoutMs: 50 }))).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ReasoningTimeoutError);
  });

  it("an HTTP failure in the prose fallback is an LlmRequestError", async () => {
    const bad = '{"headline":1}';
    const { fetchImpl } = fakeEndpoint([answer("a1", bad), answer("a2", bad), { status: 502, errorBody: "bad gateway", retryAfterMs: 0 }, { status: 502, errorBody: "bad gateway", retryAfterMs: 0 }, { status: 502, errorBody: "bad gateway", retryAfterMs: 0 }]);
    await expect(collect(runToolTurn(options(fetchImpl, { limits: { maxRounds: 2 } })))).rejects.toMatchObject({ status: 502 });
  });

  it("a stalled prose stream after a tools rejection hits the reasoning cap", async () => {
    const reject: FakeTurn = { status: 400, errorBody: "tools are not supported" };
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

// Task 10e: a model request that dies at the network layer (a browser fetch TypeError, no HTTP
// status: "Failed to fetch" in Chromium, "Load failed" in Safari) is sent once more after a short
// pause. The SDK does not retry these (it only retries a TypeError with a cause). Only the model
// request is repeated: a tool that already ran is not run again.
describe("network retry", () => {
  async function withFakeTimers<T>(run: () => Promise<T>): Promise<T> {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      return await run();
    } finally {
      vi.useRealTimers();
    }
  }

  it("pins the pause at 1 s", () => {
    expect(NETWORK_RETRY_DELAY_MS).toBe(1_000);
  });

  it.each(["browser", "safari"] as const)("a %s fetch failure is sent once more after the pause, and the turn completes", async (kind) => {
    await withFakeTimers(async () => {
      const { fetchImpl, requests } = fakeEndpoint([{ networkError: kind }, answer("a1")]);
      const o = options(fetchImpl);
      const pending = collect(runToolTurn(o));
      await vi.advanceTimersByTimeAsync(NETWORK_RETRY_DELAY_MS - 1);
      expect(requests).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      const { result } = await pending;
      expect(result).toEqual({ answer: { headline: "Venus rises", body: "Steady work." } });
      expect(requests).toHaveLength(2);
      expect(requests[1]?.body).toEqual(requests[0]?.body);
    });
  });

  it("does not re-run a tool that already ran: only the failed model request is sent again", async () => {
    await withFakeTimers(async () => {
      const seen: PeriodInput[] = [];
      const { fetchImpl, requests } = fakeEndpoint([read("c1"), { networkError: "browser" }, answer("a1")]);
      const o = options(fetchImpl, { tools: asTools(readPeriod(seen)) });
      const pending = collect(runToolTurn(o));
      await vi.advanceTimersByTimeAsync(NETWORK_RETRY_DELAY_MS);
      await pending;
      expect(seen).toHaveLength(1);
      expect(requests).toHaveLength(3);
      expect(o.toolCalls.map((e) => [e.toolName, e.status])).toEqual([["read_period", "complete"], ["answer", "complete"]]);
    });
  });

  it("a turn cancelled during the pause sends nothing more", async () => {
    await withFakeTimers(async () => {
      const controller = new AbortController();
      const { fetchImpl, requests } = fakeEndpoint([{ networkError: "browser" }, answer("a1")]);
      const pending = collect(runToolTurn(options(fetchImpl, { signal: controller.signal }))).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(NETWORK_RETRY_DELAY_MS / 2);
      controller.abort();
      await vi.advanceTimersByTimeAsync(NETWORK_RETRY_DELAY_MS);
      // Quietly: the turn ends as a cancellation (the app shows no error bubble), not as the network failure.
      expect(await pending).toMatchObject({ name: "AbortError" });
      expect(requests).toHaveLength(1);
    });
  });

  it("an aborted request is never retried, even when the browser reports the abort as \"Failed to fetch\"", async () => {
    const controller = new AbortController();
    let requests = 0;
    // A fetch that fails with the network-failure text once its request is aborted: only the
    // aborted signal (not the error) can stop the retry.
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      requests += 1;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new TypeError("Failed to fetch")), { once: true });
      });
    }) as typeof fetch;
    const pending = collect(runToolTurn(options(fetchImpl, { signal: controller.signal }))).catch((e: unknown) => e);
    await vi.waitFor(() => expect(requests).toBe(1));
    controller.abort();
    await pending;
    await new Promise((resolve) => setTimeout(resolve, NETWORK_RETRY_DELAY_MS + 50));
    expect(requests).toBe(1);
  });

  it("the pause before a retry leaves no abort listener behind once it has waited", async () => {
    const added: EventListenerOrEventListenerObject[] = [];
    const removed: EventListenerOrEventListenerObject[] = [];
    let requests = 0;
    const { fetchImpl: answering } = fakeEndpoint([answer("a1")]);
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      requests += 1;
      if (requests > 1) return answering(input, init);
      const signal = init?.signal;
      if (signal) {
        const add = signal.addEventListener.bind(signal);
        const remove = signal.removeEventListener.bind(signal);
        signal.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, opts?: AddEventListenerOptions) => {
          if (type === "abort") added.push(listener);
          add(type, listener, opts);
        }) as typeof signal.addEventListener;
        signal.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, opts?: EventListenerOptions) => {
          if (type === "abort") removed.push(listener);
          remove(type, listener, opts);
        }) as typeof signal.removeEventListener;
      }
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;
    const { result } = await collect(runToolTurn(options(fetchImpl)));
    expect(result).toEqual({ answer: { headline: "Venus rises", body: "Steady work." } });
    expect(added.length).toBeGreaterThan(0);
    expect(added.filter((listener) => !removed.includes(listener))).toEqual([]);
  });

  it("any other fetch error is not retried by the seam", async () => {
    const failing = (async () => {
      calls += 1;
      throw new TypeError("Invalid header value");
    }) as typeof fetch;
    let calls = 0;
    const failure = await collect(runToolTurn(options(failing))).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(TypeError);
    expect(calls).toBe(1);
  });
});

describe("answer prepare: the spec fills facts the tools already returned, before validation", () => {
  const Filled = z
    .object({ headline: z.string(), body: z.string().nullable() })
    .refine((value) => value.body !== null, { message: "body is required", path: ["body"] });
  type FilledShape = z.infer<typeof Filled>;
  const seen: unknown[] = [];
  const prepare = (input: unknown): unknown => {
    seen.push(input);
    const value = input as Record<string, unknown>;
    return value.body === null ? { ...value, body: "From the reading." } : input;
  };
  const filledSpec = { schema: Filled, render: (p: Partial<FilledShape>, final: boolean) => `${final ? "final" : "partial"}:${String(p.headline)}:${String(p.body)}`, prepare };
  const run = (...turns: FakeTurn[]) => {
    seen.length = 0;
    const { fetchImpl } = fakeEndpoint(turns);
    const toolCalls: ToolCallEvent[] = [];
    const o = { ...options(fetchImpl), answer: filledSpec, onToolCall: (e: ToolCallEvent) => toolCalls.push(e) } as unknown as RunToolTurnOptions<FilledShape>;
    return { toolCalls, pending: collect(runToolTurn(o)) };
  };

  it("sees the normalized input (the string \"null\" is already null) and its fill passes on the first try", async () => {
    const { toolCalls, pending } = run(answer("a1", '{"headline":"H","body":"null"}'));
    const { result, snapshots } = await pending;
    expect(seen[0]).toEqual({ headline: "H", body: null });
    expect(result).toEqual({ answer: { headline: "H", body: "From the reading." } });
    expect(snapshots.at(-1)).toBe("final:H:From the reading.");
    expect(toolCalls).toMatchObject([{ toolName: "answer", status: "complete", validFirstTry: true, filled: ["body"] }]);
  });

  it("an answer it leaves alone reports no fill", async () => {
    const { toolCalls, pending } = run(answer("a1", '{"headline":"H","body":"Mine."}'));
    expect((await pending).result).toEqual({ answer: { headline: "H", body: "Mine." } });
    expect(toolCalls).toMatchObject([{ status: "complete", validFirstTry: true, filled: [] }]);
  });

  it("a value prepare cannot fix is still a retry", async () => {
    const { toolCalls, pending } = run(answer("a1", '{"headline":7,"body":null}'), answer("a2", '{"headline":"H","body":"Mine."}'));
    await pending;
    expect(toolCalls.map((e) => e.status)).toEqual(["retried", "complete"]);
  });
});
