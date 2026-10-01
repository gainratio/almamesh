// Regression guard for the agent chat losing token streaming (2df38b8): the
// tool-decision request went out `stream:false`, so a no-tool answer arrived as
// one chunk after the whole completion (~49 s TTFT live). These tests pin the
// streaming contract of the decision round itself.
import { describe, expect, it, vi } from "vitest";

import { LlmRequestError, streamAgentChat, type AgentStatusEvent, type AgentTool } from "../index";
import type { ProviderConfig } from "../config";

const CONFIG: ProviderConfig = {
  engine: "openai-http",
  model: "test-model",
  privacyMode: "cloud_premium",
  baseUrl: "https://openrouter.ai/api/v1",
  apiKey: "test-key",
};

const NOW = new Date("2030-04-05T06:07:08.000Z");

type Chunk = Record<string, unknown>;

function sse(chunk: Chunk | "[DONE]"): string {
  return `data: ${chunk === "[DONE]" ? chunk : JSON.stringify(chunk)}\n\n`;
}

function content(text: string): Chunk {
  return { choices: [{ index: 0, delta: { content: text } }] };
}

function toolDelta(delta: Record<string, unknown>): Chunk {
  return { choices: [{ index: 0, delta: { tool_calls: [delta] } }] };
}

/** A stream the test feeds by hand, so it can observe yields between pushes. */
function controlledStream(): {
  readonly response: Response;
  readonly push: (text: string) => void;
  readonly close: () => void;
} {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    response: new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
    push: (text) => controller.enqueue(encoder.encode(text)),
    close: () => controller.close(),
  };
}

/** A complete stream whose raw bytes are split at arbitrary byte offsets. */
function rawStream(text: string, splitEvery: number): Response {
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (let at = 0; at < bytes.length; at += splitEvery) {
          controller.enqueue(bytes.slice(at, at + splitEvery));
        }
        controller.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

function clockTool(execute: AgentTool["execute"]): AgentTool {
  return {
    name: "get_current_datetime",
    description: "Read the pinned current time.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    statusLabel: "Checking the current time",
    execute,
  };
}

function recordingFetch(responses: Array<() => Response>): {
  readonly fetchImpl: typeof fetch;
  readonly bodies: Array<Record<string, unknown>>;
} {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const next = responses[bodies.length - 1];
    if (!next) throw new Error(`unexpected request #${bodies.length}`);
    return next();
  });
  return { fetchImpl: fetchImpl as typeof fetch, bodies };
}

async function collect(stream: AsyncGenerator<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const token of stream) out.push(token);
  return out;
}

describe("streamAgentChat decision streaming", () => {
  it("yields a no-tool answer delta by delta, before the completion finishes", async () => {
    const live = controlledStream();
    const { fetchImpl, bodies } = recordingFetch([() => live.response]);
    const statuses: AgentStatusEvent[] = [];
    const stream = streamAgentChat({
      config: CONFIG,
      messages: [{ role: "user", content: "Tell me about my career." }],
      tools: [clockTool(() => ({}))],
      now: NOW,
      onStatus: (event) => statuses.push(event),
      fetchImpl,
    });

    live.push(sse(content("Your tenth ")));
    // The first token must surface while the provider is still generating.
    await expect(stream.next()).resolves.toEqual({ value: "Your tenth ", done: false });
    expect(statuses).toContainEqual({ phase: "answering" });
    live.push(sse(content("house is strong.")));
    await expect(stream.next()).resolves.toEqual({ value: "house is strong.", done: false });
    live.push(sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
    live.push(sse("[DONE]"));
    live.close();
    await expect(stream.next()).resolves.toEqual({ value: undefined, done: true });

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ stream: true, tool_choice: "auto" });
    expect(statuses.at(-1)).toEqual({ phase: "complete" });
  });

  it("reassembles tool_call deltas split across chunks and byte boundaries", async () => {
    const decisionText =
      sse(toolDelta({ index: 0, id: "call-1", type: "function", function: { name: "get_current_datetime", arguments: "" } })) +
      sse(toolDelta({ index: 0, function: { arguments: '{"zo' } })) +
      sse(toolDelta({ index: 0, function: { arguments: 'ne":"chart"}' } })) +
      sse({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) +
      sse("[DONE]");
    const execute = vi.fn((args: Readonly<Record<string, unknown>>) => ({ zone: args.zone, time: "11:37" }));
    const { fetchImpl, bodies } = recordingFetch([
      () => rawStream(decisionText, 7),
      () => rawStream(sse(content("It is ")) + sse(content("11:37.")) + sse("[DONE]"), 5),
    ]);

    const tokens = await collect(
      streamAgentChat({
        config: CONFIG,
        messages: [{ role: "user", content: "What time is it?" }],
        tools: [clockTool(execute)],
        now: NOW,
        fetchImpl,
      }),
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toEqual({ zone: "chart" });
    expect(tokens).toEqual(["It is ", "11:37."]);
    expect(bodies).toHaveLength(2);
    const transcript = bodies[1]?.messages as Array<Record<string, unknown>>;
    expect(transcript).toContainEqual({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call-1",
          type: "function",
          function: { name: "get_current_datetime", arguments: '{"zone":"chart"}' },
        },
      ],
    });
    expect(transcript).toContainEqual(
      expect.objectContaining({ role: "tool", tool_call_id: "call-1", name: "get_current_datetime" }),
    );
  });

  it("streams preamble content that arrives alongside parallel tool calls", async () => {
    const decisionText =
      sse(content("Let me check. ")) +
      sse({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: "a", type: "function", function: { name: "get_current_datetime", arguments: "{}" } },
                { index: 1, id: "b", type: "function", function: { name: "lookup", arguments: '{"k":' } },
              ],
            },
          },
        ],
      }) +
      sse(toolDelta({ index: 1, function: { arguments: "1}" } })) +
      sse("[DONE]");
    const clock = vi.fn(() => ({ time: "11:37" }));
    const lookup = vi.fn(() => ({ found: true }));
    const { fetchImpl, bodies } = recordingFetch([
      () => rawStream(decisionText, 11),
      () => rawStream(sse(content("Done.")) + sse("[DONE]"), 64),
    ]);

    const tokens = await collect(
      streamAgentChat({
        config: CONFIG,
        messages: [{ role: "user", content: "Check both." }],
        tools: [clockTool(clock), { ...clockTool(lookup), name: "lookup" }],
        now: NOW,
        fetchImpl,
      }),
    );

    expect(clock).toHaveBeenCalledTimes(1);
    expect(lookup.mock.calls[0]?.[0]).toEqual({ k: 1 });
    expect(tokens.join("")).toBe("Let me check. \n\nDone.");
    const transcript = bodies[1]?.messages as Array<Record<string, unknown>>;
    expect(transcript).toContainEqual(
      expect.objectContaining({ role: "assistant", content: "Let me check. " }),
    );
  });

  it("maps an in-band mid-stream provider error to LlmRequestError", async () => {
    const text =
      sse(content("Partial ")) +
      sse({
        error: { code: 502, message: "Provider disconnected unexpectedly" },
        choices: [{ index: 0, delta: { content: "" }, finish_reason: "error" }],
      }) +
      sse("[DONE]");
    const { fetchImpl } = recordingFetch([() => rawStream(text, 9)]);
    const stream = streamAgentChat({
      config: CONFIG,
      messages: [{ role: "user", content: "Hello" }],
      tools: [clockTool(() => ({}))],
      now: NOW,
      fetchImpl,
    });

    await expect(stream.next()).resolves.toEqual({ value: "Partial ", done: false });
    const failure = await stream.next().then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(LlmRequestError);
    expect((failure as LlmRequestError).name).toBe("LlmRequestError");
    expect((failure as LlmRequestError).status).toBe(502);
    expect((failure as LlmRequestError).message).toContain("Provider disconnected unexpectedly");
  });

  it("treats a stream that ends with neither content nor tool calls as empty", async () => {
    const { fetchImpl } = recordingFetch([() => rawStream(sse("[DONE]"), 64)]);
    await expect(
      collect(
        streamAgentChat({
          config: CONFIG,
          messages: [{ role: "user", content: "Hello" }],
          tools: [clockTool(() => ({}))],
          now: NOW,
          fetchImpl,
        }),
      ),
    ).rejects.toThrow("empty agent completion");
  });

  it("propagates a caller abort while the decision stream is open", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode(sse(content("Start "))));
            signal?.addEventListener("abort", () => c.error(signal.reason), { once: true });
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    });
    const stream = streamAgentChat({
      config: CONFIG,
      messages: [{ role: "user", content: "Hello" }],
      tools: [clockTool(() => ({}))],
      now: NOW,
      signal: controller.signal,
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(stream.next()).resolves.toEqual({ value: "Start ", done: false });
    controller.abort(new DOMException("stop", "AbortError"));
    await expect(stream.next()).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a non-array tool_calls delta", sse({ choices: [{ delta: { tool_calls: { index: 0 } } }] }), "malformed tool calls"],
    ["a non-object tool_call fragment", sse({ choices: [{ delta: { tool_calls: ["x"] } }] }), "malformed tool calls"],
    [
      "more streamed tool-call indices than the cap",
      sse({
        choices: [
          {
            delta: {
              tool_calls: Array.from({ length: 17 }, (_, index) => ({
                index,
                id: `c${index}`,
                type: "function",
                function: { name: "get_current_datetime", arguments: "{}" },
              })),
            },
          },
        ],
      }),
      "malformed tool calls",
    ],
    ["a streamed tool call that never carried an id", sse(toolDelta({ index: 0, function: { name: "get_current_datetime", arguments: "{}" } })), "malformed tool call"],
    ["an unparseable data line", "data: {not json\n\n", "invalid streaming JSON"],
    ["a non-object data line", "data: 5\n\n", "invalid streaming JSON"],
    ["finish_reason error without an error object", sse({ choices: [{ delta: {}, finish_reason: "error" }] }), "mid-stream: unknown error"],
  ])("rejects %s with LlmRequestError", async (_label, text, message) => {
    const { fetchImpl } = recordingFetch([() => rawStream(`${text}${sse("[DONE]")}`, 13)]);
    const failure = await collect(
      streamAgentChat({
        config: CONFIG,
        messages: [{ role: "user", content: "Hello" }],
        tools: [clockTool(() => ({}))],
        now: NOW,
        fetchImpl,
      }),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(LlmRequestError);
    expect((failure as Error).message).toContain(message);
  });

  it("ignores SSE comments, delta-less chunks, and fragments without a function; parses an unterminated tail", async () => {
    const text =
      ": OPENROUTER PROCESSING\n\n" +
      sse({ choices: [{ index: 0 }] }) +
      sse({ choices: [{ index: 0, delta: { content: null, tool_calls: null } }] }) +
      sse(toolDelta({ index: 0, id: "call-1", type: "function" })) +
      sse(toolDelta({ index: 0, function: { name: "get_current_datetime", arguments: "{}" } })) +
      sse(toolDelta({ index: 0, function: { name: "get_current_datetime" } }));
    const execute = vi.fn(() => ({ time: "11:37" }));
    const { fetchImpl } = recordingFetch([
      () => rawStream(text, 17),
      // No trailing blank line: the final event must still be parsed.
      () => rawStream(`data: ${JSON.stringify(content("Answer."))}`, 64),
    ]);
    const tokens = await collect(
      streamAgentChat({
        config: CONFIG,
        messages: [{ role: "user", content: "Time?" }],
        tools: [clockTool(execute)],
        now: NOW,
        fetchImpl,
      }),
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(tokens).toEqual(["Answer."]);
  });

  it("caps streamed argument growth so the oversize guard still refuses the call", async () => {
    const huge = "x".repeat(4_096);
    const text =
      sse(toolDelta({ index: 0, id: "call-1", type: "function", function: { name: "get_current_datetime", arguments: '{"a":"' } })) +
      sse(toolDelta({ index: 0, function: { arguments: huge } })) +
      sse(toolDelta({ index: 0, function: { arguments: '"}' } })) +
      sse("[DONE]");
    const execute = vi.fn(() => ({}));
    const { fetchImpl, bodies } = recordingFetch([
      () => rawStream(text, 512),
      () => rawStream(sse(content("Refused.")) + sse("[DONE]"), 64),
    ]);
    await collect(
      streamAgentChat({
        config: CONFIG,
        messages: [{ role: "user", content: "Time?" }],
        tools: [clockTool(execute)],
        now: NOW,
        fetchImpl,
      }),
    );
    expect(execute).not.toHaveBeenCalled();
    const transcript = bodies[1]?.messages as Array<{ role: string; content: unknown; tool_calls?: Array<{ function: { arguments: string } }> }>;
    const assistant = transcript.find((message) => message.role === "assistant");
    expect(assistant?.tool_calls?.[0]?.function.arguments.length).toBe(2_049);
    expect(JSON.stringify(transcript)).toContain("arguments_too_large");
  });

  it("maps a mid-stream error in the forced final answer to LlmRequestError", async () => {
    const decide = (id: string, args: string): string =>
      sse(toolDelta({ index: 0, id, type: "function", function: { name: "get_current_datetime", arguments: args } })) +
      sse("[DONE]");
    const { fetchImpl } = recordingFetch([
      () => rawStream(decide("call-1", "{}"), 64),
      () => rawStream(decide("call-2", '{"b":1}'), 64),
      () => rawStream(sse({ error: { code: "server_error", message: "boom" } }), 64),
    ]);
    const failure = await collect(
      streamAgentChat({
        config: CONFIG,
        messages: [{ role: "user", content: "Time?" }],
        tools: [clockTool(() => ({}))],
        now: NOW,
        fetchImpl,
      }),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(LlmRequestError);
    expect((failure as LlmRequestError).status).toBeUndefined();
    expect((failure as Error).message).toContain("boom");
  });

  it("rejects a 200 streaming response that has no body", async () => {
    const { fetchImpl } = recordingFetch([() => new Response(null, { status: 200 })]);
    await expect(
      collect(
        streamAgentChat({
          config: CONFIG,
          messages: [{ role: "user", content: "Hello" }],
          tools: [clockTool(() => ({}))],
          now: NOW,
          fetchImpl,
        }),
      ),
    ).rejects.toThrow("empty streaming response");
  });

  it("rejects a JSON body that is not valid JSON", async () => {
    const { fetchImpl } = recordingFetch([
      () => new Response("{oops", { headers: { "Content-Type": "application/json" } }),
    ]);
    await expect(
      collect(
        streamAgentChat({
          config: CONFIG,
          messages: [{ role: "user", content: "Hello" }],
          tools: [clockTool(() => ({}))],
          now: NOW,
          fetchImpl,
        }),
      ),
    ).rejects.toThrow("invalid JSON for an agent completion");
  });

  it("cancels the provider stream when the consumer stops early", async () => {
    const cancel = vi.fn();
    const { fetchImpl } = recordingFetch([
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(new TextEncoder().encode(sse(content("One "))));
            },
            cancel,
          }),
        ),
    ]);
    for await (const token of streamAgentChat({
      config: CONFIG,
      messages: [{ role: "user", content: "Hello" }],
      tools: [clockTool(() => ({}))],
      now: NOW,
      fetchImpl,
    })) {
      expect(token).toBe("One ");
      break;
    }
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
