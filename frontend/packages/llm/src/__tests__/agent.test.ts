import { describe, expect, it, vi } from "vitest";

import {
  AGENT_LIMITS,
  LlmRequestError,
  PrivacyViolationError,
  streamAgentChat,
  type AgentStatusEvent,
  type AgentTool,
} from "../index";
import type { ProviderConfig } from "../config";

const CONFIG: ProviderConfig = {
  engine: "openai-http",
  model: "test-model",
  privacyMode: "cloud_premium",
  baseUrl: "https://openrouter.ai/api/v1",
  apiKey: "test-key",
};

const NOW = new Date("2030-04-05T06:07:08.000Z");

function decision(message: Record<string, unknown>): Response {
  return Response.json({ choices: [{ message }] });
}

function call(id: string, name: string, argumentsJson = "{}"): Record<string, unknown> {
  return { id, type: "function", function: { name, arguments: argumentsJson } };
}

function streamed(...tokens: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const token of tokens) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ choices: [{ delta: { content: token } }] })}\n\n`,
            ),
          );
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }),
  );
}

async function collect(stream: AsyncGenerator<string>): Promise<string> {
  let output = "";
  for await (const token of stream) output += token;
  return output;
}

function tool(
  execute: AgentTool["execute"],
  overrides: Partial<AgentTool> = {},
): AgentTool {
  return {
    name: "get_current_datetime",
    description: "Read the pinned current time.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    statusLabel: "Checking the current time",
    execute,
    ...overrides,
  };
}

describe("streamAgentChat", () => {
  it("falls back to ordinary streaming when an endpoint explicitly rejects tools", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (bodies.length === 1) {
        return new Response('{"error":"requires --enable-auto-tool-choice"}', {
          status: 400,
          statusText: 'Bad Request',
        });
      }
      return streamed('Compatible ', 'answer');
    });

    await expect(
      collect(
        streamAgentChat({
          config: CONFIG,
          messages: [{ role: "user", content: "Answer safely." }],
          tools: [tool(() => ({ ok: true }))],
          now: NOW,
          fetchImpl: fetchImpl as typeof fetch,
        }),
      ),
    ).resolves.toBe('Compatible answer');
    expect(bodies).toHaveLength(2);
    expect(bodies[1]?.stream).toBe(true);
    expect(bodies[1]?.tools).toBeUndefined();
    expect(bodies[1]?.tool_choice).toBeUndefined();
    expect(JSON.stringify(bodies[1]?.messages)).toContain('LOCAL TOOLS ARE UNAVAILABLE');
  });

  it("advertises only injected tools and returns OpenAI-compatible tool results", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const statuses: AgentStatusEvent[] = [];
    const execute = vi.fn(({ zone }: Readonly<Record<string, unknown>>, context) => ({
      zone,
      instant: context.now.toISOString(),
    }));
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (bodies.length === 1) {
        return decision({
          role: "assistant",
          content: null,
          tool_calls: [call("call-1", "get_current_datetime", '{"zone":"chart"}')],
        });
      }
      return decision({ role: "assistant", content: "It is 11:37 in the chart timezone." });
    });

    const answer = await collect(
      streamAgentChat({
        config: CONFIG,
        messages: [{ role: "user", content: "What time is it for this chart?" }],
        tools: [tool(execute)],
        now: NOW,
        onStatus: (status) => statuses.push(status),
        fetchImpl: fetchImpl as typeof fetch,
      }),
    );

    expect(answer).toBe("It is 11:37 in the chart timezone.");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[1].now).toEqual(NOW);
    // Inverted 2026-10: this asserted `stream: false`, which is the regression
    // that made no-tool answers arrive as one chunk (~49 s TTFT live).
    expect(bodies[0]).toMatchObject({
      model: "test-model",
      stream: true,
      tool_choice: "auto",
      tools: [
        {
          type: "function",
          function: { name: "get_current_datetime", description: expect.any(String) },
        },
      ],
    });
    expect(bodies[1]?.messages).toEqual([
      { role: "user", content: "What time is it for this chart?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [call("call-1", "get_current_datetime", '{"zone":"chart"}')],
      },
      {
        role: "tool",
        tool_call_id: "call-1",
        name: "get_current_datetime",
        content: JSON.stringify({ ok: true, value: { zone: "chart", instant: NOW.toISOString() } }),
      },
    ]);
    expect(statuses).toEqual([
      { phase: "deciding", round: 1 },
      {
        phase: "using_tool",
        round: 1,
        toolName: "get_current_datetime",
        label: "Checking the current time",
        callNumber: 1,
      },
      { phase: "deciding", round: 2 },
      { phase: "answering" },
      { phase: "complete" },
    ]);
    expect(JSON.stringify(statuses)).not.toContain("zone");
    expect(JSON.stringify(statuses)).not.toContain(NOW.toISOString());
  });

  it("snapshots the caller clock once before any asynchronous work", async () => {
    const turnNow = new Date(NOW);
    let executorNow = "";
    const execute = vi.fn((_args, context) => {
      executorNow = context.now.toISOString();
      return { instant: executorNow };
    });
    let request = 0;
    const fetchImpl = vi.fn(async () => {
      request += 1;
      if (request === 1) {
        turnNow.setUTCFullYear(2040);
        return decision({
          role: "assistant",
          content: null,
          tool_calls: [call("clock", "get_current_datetime")],
        });
      }
      return decision({ role: "assistant", content: "Pinned." });
    });

    await collect(
      streamAgentChat({
        config: CONFIG,
        messages: [{ role: "user", content: "Use one clock." }],
        tools: [tool(execute)],
        now: turnNow,
        fetchImpl: fetchImpl as typeof fetch,
      }),
    );

    expect(executorNow).toBe(NOW.toISOString());
  });

  it("forces a final streamed answer with tool_choice none after two decision rounds", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const execute = vi.fn(() => ({ found: true }));
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (bodies.length <= AGENT_LIMITS.maxDecisionRounds) {
        return decision({
          role: "assistant",
          content: null,
          tool_calls: [call(`call-${bodies.length}`, "lookup", `{"round":${bodies.length}}`)],
        });
      }
      return streamed("Bounded ", "answer.");
    });

    const answer = await collect(
      streamAgentChat({
        config: CONFIG,
        messages: [{ role: "user", content: "Use tools." }],
        tools: [tool(execute, { name: "lookup" })],
        now: NOW,
        fetchImpl: fetchImpl as typeof fetch,
      }),
    );

    expect(answer).toBe("Bounded answer.");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(bodies[2]).toMatchObject({ stream: true, tool_choice: "none" });
    expect(JSON.stringify(bodies[2]?.messages)).toContain("do not infer it");
  });

  it("never executes more than three tool calls and returns an error for excess calls", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const execute = vi.fn(() => ({ ok: true }));
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (bodies.length === 1) {
        return decision({
          role: "assistant",
          content: null,
          tool_calls: [call("a", "lookup", '{"n":1}'), call("b", "lookup", '{"n":2}')],
        });
      }
      if (bodies.length === 2) {
        return decision({
          role: "assistant",
          content: null,
          tool_calls: [call("c", "lookup", '{"n":3}'), call("d", "lookup", '{"n":4}')],
        });
      }
      return streamed("done");
    });

    await collect(
      streamAgentChat({
        config: CONFIG,
        messages: [{ role: "user", content: "Look up four things." }],
        tools: [tool(execute, { name: "lookup" })],
        now: NOW,
        fetchImpl: fetchImpl as typeof fetch,
      }),
    );

    expect(execute).toHaveBeenCalledTimes(AGENT_LIMITS.maxToolCalls);
    expect(JSON.stringify(bodies[2]?.messages)).toContain("tool_call_limit");
  });

  it("does not echo more than two model-requested calls from one decision", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const execute = vi.fn(() => ({ ok: true }));
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (bodies.length === 1) {
        return decision({
          role: "assistant",
          content: null,
          tool_calls: [
            call("a", "lookup", '{"n":1}'),
            call("b", "lookup", '{"n":2}'),
            call("c", "lookup", '{"n":3}'),
          ],
        });
      }
      return streamed("bounded");
    });

    await collect(
      streamAgentChat({
        config: CONFIG,
        messages: [{ role: "user", content: "Request too many." }],
        tools: [tool(execute, { name: "lookup" })],
        now: NOW,
        fetchImpl: fetchImpl as typeof fetch,
      }),
    );

    const finalMessages = bodies[1]?.messages as Array<{
      role: string;
      tool_calls?: unknown[];
    }>;
    expect(execute).toHaveBeenCalledTimes(AGENT_LIMITS.maxToolCallsPerRound);
    expect(finalMessages.find((message) => message.role === "assistant")?.tool_calls).toHaveLength(
      AGENT_LIMITS.maxToolCallsPerRound,
    );
    expect(finalMessages.filter((message) => message.role === "tool")).toHaveLength(
      AGENT_LIMITS.maxToolCallsPerRound,
    );
  });

  it("rejects duplicate semantic calls without executing them twice", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const execute = vi.fn(() => ({ ok: true }));
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (bodies.length === 1) {
        return decision({ role: "assistant", content: null, tool_calls: [call("a", "lookup", '{"a":1,"b":2}')] });
      }
      if (bodies.length === 2) {
        return decision({ role: "assistant", content: null, tool_calls: [call("b", "lookup", '{"b":2,"a":1}')] });
      }
      return streamed("No repeated lookup needed.");
    });

    await collect(
      streamAgentChat({
        config: CONFIG,
        messages: [{ role: "user", content: "Repeat." }],
        tools: [tool(execute, { name: "lookup" })],
        now: NOW,
        fetchImpl: fetchImpl as typeof fetch,
      }),
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(bodies[2]?.messages)).toContain("duplicate_tool_call");
  });

  it("fails closed on oversized arguments and oversized results", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const execute = vi.fn(() => ({ text: "x".repeat(AGENT_LIMITS.maxResultChars + 1) }));
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (bodies.length === 1) {
        return decision({
          role: "assistant",
          content: null,
          tool_calls: [
            call("too-large", "lookup", JSON.stringify({ text: "x".repeat(AGENT_LIMITS.maxArgumentChars) })),
            call("large-result", "lookup"),
          ],
        });
      }
      return streamed("Safe answer.");
    });

    await collect(
      streamAgentChat({
        config: CONFIG,
        messages: [{ role: "user", content: "Try large values." }],
        tools: [tool(execute, { name: "lookup" })],
        now: NOW,
        fetchImpl: fetchImpl as typeof fetch,
      }),
    );

    expect(execute).toHaveBeenCalledTimes(1);
    const messages = bodies[1]?.messages as Array<{ role?: string; content?: string }>;
    const finalMessages = JSON.stringify(messages);
    expect(finalMessages).toContain("arguments_too_large");
    expect(finalMessages).toContain("result_too_large");
    expect(JSON.stringify(messages.filter((message) => message.role === "tool"))).not.toContain(
      "x".repeat(100),
    );
  });

  it("aborts while a local tool is running and does not make another request", async () => {
    const controller = new AbortController();
    const execute = vi.fn(
      async (_args: Readonly<Record<string, unknown>>, context: { signal: AbortSignal }) =>
        await new Promise((_resolve, reject) => {
          context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
          controller.abort(new DOMException("Stopped", "AbortError"));
        }),
    );
    const fetchImpl = vi.fn(async () =>
      decision({ role: "assistant", content: null, tool_calls: [call("a", "lookup")] }),
    );

    await expect(
      collect(
        streamAgentChat({
          config: CONFIG,
          messages: [{ role: "user", content: "Stop." }],
          tools: [tool(execute, { name: "lookup" })],
          now: NOW,
          signal: controller.signal,
          fetchImpl: fetchImpl as typeof fetch,
        }),
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("runs the privacy guard before every request", async () => {
    const mutableConfig = {
      engine: "openai-http" as const,
      model: "test-model",
      privacyMode: "local_only" as const,
      baseUrl: "http://localhost:11434/v1",
    };
    const fetchImpl = vi.fn(async () => {
      mutableConfig.baseUrl = "https://example.com/v1";
      return decision({ role: "assistant", content: null, tool_calls: [call("a", "lookup")] });
    });

    await expect(
      collect(
        streamAgentChat({
          config: mutableConfig,
          messages: [{ role: "user", content: "Check privacy." }],
          tools: [tool(() => ({ ok: true }), { name: "lookup" })],
          now: NOW,
          fetchImpl: fetchImpl as typeof fetch,
        }),
      ),
    ).rejects.toBeInstanceOf(PrivacyViolationError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed model tool calls without invoking an executor", async () => {
    const execute = vi.fn();
    const fetchImpl = vi.fn(async () =>
      decision({
        role: "assistant",
        content: null,
        tool_calls: [{ id: "a", type: "function", function: { name: "lookup", arguments: 42 } }],
      }),
    );

    await expect(
      collect(
        streamAgentChat({
          config: CONFIG,
          messages: [{ role: "user", content: "Malformed." }],
          tools: [tool(execute, { name: "lookup" })],
          now: NOW,
          fetchImpl: fetchImpl as typeof fetch,
        }),
      ),
    ).rejects.toBeInstanceOf(LlmRequestError);
    expect(execute).not.toHaveBeenCalled();
  });
});
