import { describe, expect, it, vi } from "vitest";

import { LlmRequestError, type ChatMessage } from "../client";
import type { ProviderConfig } from "../config";
import { streamChatCompletionJson } from "../json-stream";

// The road-ahead section used to be ONE non-streaming JSON completion: on a slow
// model the screen stayed empty for minutes. The streamed variant must deliver
// deltas as they arrive while keeping the same final contract (a validated JSON
// string) and the same error mapping as the non-streaming path (#192).

const CFG: ProviderConfig = {
  engine: "openai-http",
  model: "z-ai/glm-5.3-flash",
  privacyMode: "cloud_premium",
  baseUrl: "https://openrouter.ai/api/v1",
  apiKey: "k",
};
const MESSAGES: readonly ChatMessage[] = [{ role: "user", content: "json please" }];

function sse(chunk: Record<string, unknown> | "[DONE]"): string {
  return `data: ${chunk === "[DONE]" ? chunk : JSON.stringify(chunk)}\n\n`;
}

function delta(text: string): Record<string, unknown> {
  return { choices: [{ index: 0, delta: { content: text } }] };
}

function streamResponse(text: string, every = 7): Response {
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (let at = 0; at < bytes.length; at += every) controller.enqueue(bytes.slice(at, at + every));
        controller.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

function fetchOnce(response: Response): { fetchImpl: typeof fetch; bodies: Array<Record<string, unknown>> } {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return response;
  }) as unknown as typeof fetch;
  return { fetchImpl, bodies };
}

async function failure(promise: Promise<unknown>): Promise<LlmRequestError> {
  const err = await promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(LlmRequestError);
  return err as LlmRequestError;
}

describe("streamChatCompletionJson", () => {
  it("requests a streamed JSON object", async () => {
    const { fetchImpl, bodies } = fetchOnce(streamResponse(sse(delta("{}")) + sse("[DONE]")));
    await streamChatCompletionJson({ config: CFG, messages: MESSAGES, fetchImpl });
    expect(bodies[0]).toMatchObject({ stream: true, response_format: { type: "json_object" } });
  });

  it("hands each delta to onDelta in order and returns the assembled JSON", async () => {
    const parts = ['{"upcoming_periods":[', '{"title":"Jupiter"}', "]}"];
    const { fetchImpl } = fetchOnce(streamResponse(parts.map((p) => sse(delta(p))).join("") + sse("[DONE]")));
    const seen: string[] = [];
    const raw = await streamChatCompletionJson({
      config: CFG,
      messages: MESSAGES,
      fetchImpl,
      onDelta: (text) => seen.push(text),
    });
    expect(seen).toEqual(parts);
    expect(JSON.parse(raw)).toEqual({ upcoming_periods: [{ title: "Jupiter" }] });
  });

  it("hands reasoning deltas to onReasoning and keeps them out of the JSON", async () => {
    const reasoning = { choices: [{ index: 0, delta: { reasoning: "Thinking hard" } }] };
    const { fetchImpl } = fetchOnce(streamResponse(sse(reasoning) + sse(delta('{"a":1}')) + sse("[DONE]")));
    const thoughts: string[] = [];
    const raw = await streamChatCompletionJson({
      config: CFG,
      messages: MESSAGES,
      fetchImpl,
      onReasoning: (text) => thoughts.push(text),
    });
    expect(thoughts).toEqual(["Thinking hard"]);
    expect(raw).toBe('{"a":1}');
  });

  it("strips a ```json fence from the assembled content", async () => {
    const { fetchImpl } = fetchOnce(streamResponse(sse(delta('```json\n{"a":1}\n```')) + sse("[DONE]")));
    await expect(streamChatCompletionJson({ config: CFG, messages: MESSAGES, fetchImpl })).resolves.toBe('{"a":1}');
  });

  it("maps an in-band finish_reason error mid-stream to a 502, like the non-streaming path", async () => {
    const text = sse(delta('{"upcoming_periods":[')) + sse({ choices: [{ delta: {}, finish_reason: "error" }] });
    const { fetchImpl } = fetchOnce(streamResponse(text));
    const err = await failure(streamChatCompletionJson({ config: CFG, messages: MESSAGES, fetchImpl }));
    expect(err.status).toBe(502);
    expect(err.message).toMatch(/mid-stream/);
  });

  it("keeps the numeric code of an in-band error object", async () => {
    const text = sse(delta("{")) + sse({ error: { code: 524, message: "Provider timed out" } });
    const { fetchImpl } = fetchOnce(streamResponse(text));
    const err = await failure(streamChatCompletionJson({ config: CFG, messages: MESSAGES, fetchImpl }));
    expect(err.status).toBe(524);
  });

  it("rejects a stream that ends with invalid JSON as a retryable 502", async () => {
    const { fetchImpl } = fetchOnce(streamResponse(sse(delta('{"upcoming_periods":[{"title":"Jup')) + sse("[DONE]")));
    const err = await failure(streamChatCompletionJson({ config: CFG, messages: MESSAGES, fetchImpl }));
    expect(err.status).toBe(502);
    expect(err.message).toMatch(/incomplete JSON/i);
  });

  it("rejects an empty stream like an empty completion", async () => {
    const { fetchImpl } = fetchOnce(streamResponse(sse("[DONE]")));
    const err = await failure(streamChatCompletionJson({ config: CFG, messages: MESSAGES, fetchImpl }));
    expect(err.message).toMatch(/empty completion/);
  });

  it("surfaces an HTTP error status before any stream", async () => {
    const { fetchImpl } = fetchOnce(new Response("nope", { status: 429 }));
    const err = await failure(streamChatCompletionJson({ config: CFG, messages: MESSAGES, fetchImpl }));
    expect(err.status).toBe(429);
  });

  it("stops reading and rejects with AbortError when the signal aborts mid-stream", async () => {
    const controller = new AbortController();
    const encoder = new TextEncoder();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(encoder.encode(sse(delta('{"a":"'))));
      },
      cancel() {
        cancelled = true;
      },
    });
    const { fetchImpl } = fetchOnce(new Response(body));
    const run = streamChatCompletionJson({
      config: CFG,
      messages: MESSAGES,
      fetchImpl,
      signal: controller.signal,
      onDelta: () => controller.abort(),
    });
    const err = await run.then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as Error).name).toBe("AbortError");
    expect(cancelled).toBe(true);
  });

  it("enforces the privacy gate before any network call", async () => {
    const { fetchImpl } = fetchOnce(streamResponse(sse("[DONE]")));
    await expect(
      streamChatCompletionJson({ config: { ...CFG, privacyMode: "local_only" }, messages: MESSAGES, fetchImpl }),
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
