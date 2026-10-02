// Runaway-reasoning cap.
//
// z-ai/glm-5.3-flash once reasoned for 20+ minutes on "The road ahead" without
// writing a word. Two guards:
//
// 1. A reasoning budget per request, sent as OpenRouter's
//    `reasoning: { max_tokens }` (client.ts `reasoningField`, OpenRouter
//    only). Best effort: live probes (2026-10-01) showed some upstreams
//    overshoot it, and `effort: "low"` once made deepseek-v4-pro think for
//    26k tokens. So it is not the guard.
// 2. A wall-clock cap: a stream that has produced no answer text (content or a
//    tool call) REASONING_TIMEOUT_MS after it opened is cancelled with a
//    ReasoningTimeoutError. Its 504 status makes it transient, so a timeline
//    section gets #192's one retry before it is reported.

import { LlmRequestError } from "./client";

/** Thinking-time cap: no answer text this long after the stream opens aborts it. */
export const REASONING_TIMEOUT_MS = 180_000;

/**
 * Reasoning budget for one structured section (timeline or natal). Set above
 * normal use so it only stops runaways: live timeline runs (2026-10-01) used
 * 9-11k reasoning tokens for both sections together on deepseek-v4.1-flash.
 */
export const SECTION_REASONING_MAX_TOKENS = 12_000;

/** Reasoning budget for one chat request; chat answers are shorter. */
export const CHAT_REASONING_MAX_TOKENS = 6_000;

/** The canonical error code the app shows for a capped run. */
export const REASONING_TIMEOUT_CODE = "ai.reasoning_timeout";

export class ReasoningTimeoutError extends LlmRequestError {
  public readonly code = REASONING_TIMEOUT_CODE;

  constructor(timeoutMs: number) {
    super(`No answer after ${Math.round(timeoutMs / 1000)}s of reasoning (${REASONING_TIMEOUT_CODE})`, {
      status: 504,
    });
    this.name = "ReasoningTimeoutError";
  }
}
