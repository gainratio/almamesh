// The one OpenAI-compatible SSE parser (`stream: true` responses).
//
// Shared by the agent chat (agent.ts) and the streamed JSON sections
// (json-stream.ts) so both read events, `[DONE]`, and in-band failures the
// same way. Moved here unchanged from agent.ts (restored in #186).

import { LlmRequestError } from "./client";

const MAX_ERROR_BODY_CHARS = 500;

export interface StreamChunk {
  readonly error?: unknown;
  readonly choices?: ReadonlyArray<{
    readonly delta?: {
      readonly content?: unknown;
      readonly tool_calls?: unknown;
      /** OpenRouter's reasoning-model "thinking" text, streamed before content. */
      readonly reasoning?: unknown;
    };
    readonly finish_reason?: unknown;
  }>;
}

export interface SseOptions {
  /**
   * Status for an in-band failure that carries no numeric HTTP-like code.
   * The agent chat leaves it unset; the JSON sections pass 502 so a dropped
   * generation classifies exactly like the non-streaming path (#192).
   */
  readonly inBandFallbackStatus?: number;
}

/** Parse an OpenAI-compatible SSE body into JSON chunks, failing on in-band errors. */
export async function* sseChunks(
  response: Response,
  options: SseOptions = {},
): AsyncGenerator<StreamChunk> {
  if (!response.body) {
    throw new LlmRequestError("LLM endpoint returned an empty streaming response");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() ?? "";
      for (const event of events) yield* parseSseEvent(event, options);
    }
    buffer += decoder.decode();
    if (buffer.trim()) yield* parseSseEvent(buffer, options);
    finished = true;
  } finally {
    if (!finished) reader.cancel().catch(() => undefined);
  }
}

/**
 * After a 200 is committed, OpenRouter (and other OpenAI-compatible relays)
 * report failures in-band: a chunk with a top-level `error` and/or
 * `finish_reason: "error"`. Surface it as the same typed error as an HTTP
 * failure so the caller maps it to the same code instead of ending silently.
 */
function midStreamError(payload: StreamChunk, options: SseOptions): LlmRequestError {
  const raw = payload.error;
  const row = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const detail = typeof row.message === "string" && row.message ? row.message : "unknown error";
  const status =
    typeof row.code === "number" && Number.isInteger(row.code) && row.code >= 400 && row.code <= 599
      ? row.code
      : options.inBandFallbackStatus;
  const body = JSON.stringify({ error: raw ?? null }).slice(0, MAX_ERROR_BODY_CHARS);
  return new LlmRequestError(
    `LLM endpoint failed mid-stream: ${detail.slice(0, MAX_ERROR_BODY_CHARS)}`,
    { status, body },
  );
}

function* parseSseEvent(event: string, options: SseOptions): Generator<StreamChunk> {
  for (const line of event.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    let payload: StreamChunk;
    try {
      payload = JSON.parse(data) as StreamChunk;
    } catch {
      throw new LlmRequestError("LLM endpoint returned invalid streaming JSON");
    }
    if (typeof payload !== "object" || payload === null) {
      throw new LlmRequestError("LLM endpoint returned invalid streaming JSON");
    }
    if (
      (payload.error !== undefined && payload.error !== null) ||
      payload.choices?.[0]?.finish_reason === "error"
    ) {
      throw midStreamError(payload, options);
    }
    yield payload;
  }
}
