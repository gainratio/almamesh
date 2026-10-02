import { describe, expect, it, vi } from "vitest";

import { chatCompletionJson, LlmRequestError, type ChatMessage } from "../client";
import type { ProviderConfig } from "../config";

// Regression: "Some timeline sections could not be generated: The road ahead".
// OpenRouter answers a long non-streaming completion with HTTP 200 even when
// the upstream provider dies mid-generation; the failure is reported in-band
// (`finish_reason: "error"`, no content, sometimes a top-level `error`). The
// client used to collapse that into a status-less "empty completion", which no
// caller could classify or retry.

const CFG: ProviderConfig = {
  engine: "openai-http",
  model: "z-ai/glm-5.3-flash",
  privacyMode: "local_only",
  baseUrl: "http://localhost:11434/v1",
};
const MESSAGES: readonly ChatMessage[] = [{ role: "user", content: "json please" }];

function okFetch(payload: unknown): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })) as unknown as typeof fetch;
}

async function rejection(fetchImpl: typeof fetch): Promise<LlmRequestError> {
  const err = await chatCompletionJson({ config: CFG, messages: MESSAGES, fetchImpl }).then(
    () => {
      throw new Error("expected chatCompletionJson to reject");
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(LlmRequestError);
  return err as LlmRequestError;
}

describe("chatCompletionJson — in-band provider errors on HTTP 200", () => {
  it("treats finish_reason 'error' with no content as a 502 provider failure", async () => {
    const err = await rejection(
      okFetch({ choices: [{ finish_reason: "error", native_finish_reason: null, message: { role: "assistant", content: "" } }] }),
    );
    expect(err.status).toBe(502);
    expect(err.message).toMatch(/provider failed mid-generation/i);
  });

  it("uses the numeric code and message of a top-level error object", async () => {
    const err = await rejection(
      okFetch({ error: { code: 524, message: "Provider timed out" } }),
    );
    expect(err.status).toBe(524);
    expect(err.message).toContain("Provider timed out");
  });

  it("uses the error object attached to the choice", async () => {
    const err = await rejection(
      okFetch({ choices: [{ finish_reason: "error", error: { code: 503, message: "upstream overloaded" } }] }),
    );
    expect(err.status).toBe(503);
    expect(err.message).toContain("upstream overloaded");
  });

  it("falls back to 502 when the error code is not an HTTP status", async () => {
    const err = await rejection(okFetch({ error: { code: "server_error", message: "boom" } }));
    expect(err.status).toBe(502);
  });

  it("treats finish_reason 'error' with partial content as a failure, not an answer", async () => {
    const err = await rejection(
      okFetch({ choices: [{ finish_reason: "error", message: { content: '{"upcoming_periods": [' } }] }),
    );
    expect(err.status).toBe(502);
  });

  it("still returns content on a normal stop", async () => {
    await expect(
      chatCompletionJson({
        config: CFG,
        messages: MESSAGES,
        fetchImpl: okFetch({ choices: [{ finish_reason: "stop", message: { content: '{"a":1}' } }] }),
      }),
    ).resolves.toBe('{"a":1}');
  });
});
