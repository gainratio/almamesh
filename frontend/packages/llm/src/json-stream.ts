// Streamed variant of `chatCompletionJson`.
//
// Same request (JSON object mode, same privacy gate, same headers) but with
// `stream: true`, so a slow model shows text within seconds instead of after
// the whole completion. Deltas are handed to `onDelta` as they arrive; the
// assembled content is validated as JSON before it is returned, so callers keep
// exactly the non-streaming contract. Failures map like the non-streaming path
// (#192): an in-band `finish_reason: "error"` or a stream that ends on
// unparseable JSON is a 502 provider failure, which the section runner retries.

import {
  buildHeaders,
  completionJsonContent,
  joinUrl,
  LlmRequestError,
  requestErrorFor,
  reasoningField,
  requireBaseUrl,
  stripJsonFence,
  type ChatCompletionJsonOptions,
} from "./client";
import { ensurePrivacy } from "./config";
import { REASONING_TIMEOUT_MS } from "./reasoning";
import { sseChunks } from "./sse";

/** Status for a generation the provider dropped or truncated (matches #192). */
const DROPPED_GENERATION_STATUS = 502;

export interface StreamChatCompletionJsonOptions extends ChatCompletionJsonOptions {
  /** Called with each content delta, in order, as it arrives. */
  readonly onDelta?: (delta: string) => void;
  /**
   * Called with each reasoning ("thinking") delta. Reasoning models think for
   * a long time before the first content token; this is the only sign of life
   * meanwhile. Never part of the returned JSON.
   */
  readonly onReasoning?: (delta: string) => void;
  /**
   * Runaway-reasoning cap: no answer text this many ms after the stream opens
   * fails with a ReasoningTimeoutError (504, so the section runner retries
   * once). Default REASONING_TIMEOUT_MS.
   */
  readonly reasoningTimeoutMs?: number;
}

function abortError(): DOMException {
  return new DOMException("The streamed completion was aborted", "AbortError");
}

async function openJsonStream(options: StreamChatCompletionJsonOptions): Promise<Response> {
  const doFetch = options.fetchImpl ?? fetch;
  const response = await doFetch(joinUrl(requireBaseUrl(options.config)), {
    method: "POST",
    headers: buildHeaders(options.config),
    body: JSON.stringify({
      model: options.config.model,
      messages: options.messages,
      stream: true,
      response_format: { type: "json_object" },
      ...reasoningField(options.config, options.reasoningMaxTokens),
    }),
    signal: options.signal,
  });
  if (!response.ok) throw await requestErrorFor(response);
  return response;
}

function validatedJson(parts: readonly string[]): string {
  const content = stripJsonFence(parts.join(""));
  if (content === "") throw new LlmRequestError("LLM endpoint returned an empty completion");
  try {
    JSON.parse(content);
  } catch {
    throw new LlmRequestError("LLM endpoint ended the stream on incomplete JSON", {
      status: DROPPED_GENERATION_STATUS,
    });
  }
  return content;
}

export async function streamChatCompletionJson(
  options: StreamChatCompletionJsonOptions,
): Promise<string> {
  ensurePrivacy(options.config);
  const response = await openJsonStream(options);
  // Some OpenAI-compatible servers ignore `stream: true` and answer one JSON
  // body (the agent chat tolerates the same). Treat it as a single delta.
  if (response.headers.get("content-type")?.includes("application/json")) {
    const content = completionJsonContent(await response.json());
    options.onDelta?.(content);
    return validatedJson([content]);
  }
  // Deltas are kept as a list and joined once at the end: no per-token copy of
  // the growing document.
  const parts: string[] = [];
  const sse = {
    inBandFallbackStatus: DROPPED_GENERATION_STATUS,
    answerDeadlineMs: options.reasoningTimeoutMs ?? REASONING_TIMEOUT_MS,
  };
  for await (const chunk of sseChunks(response, sse)) {
    const delta = chunk.choices?.[0]?.delta;
    const content = delta?.content;
    if (typeof content === "string" && content) {
      parts.push(content);
      options.onDelta?.(content);
    }
    const reasoning = delta?.reasoning;
    if (typeof reasoning === "string" && reasoning) options.onReasoning?.(reasoning);
    // Leaving the loop cancels the body reader (sseChunks' finally).
    if (options.signal?.aborted) throw abortError();
  }
  return validatedJson(parts);
}
