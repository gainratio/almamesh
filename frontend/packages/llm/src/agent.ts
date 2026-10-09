// Bounded, browser-native OpenAI-compatible tool loop.
//
// This is intentionally a capability shell, not a general autonomous agent:
// callers inject a small allowlist of read-only tools, every turn carries a
// caller-pinned clock, and the model never receives shell, filesystem, network,
// or storage access through this module. Tool arguments/results stay inside the
// request transcript and are never surfaced through status events.

import { LlmRequestError, reasoningField, type ChatMessage } from "./client";
import { ensurePrivacy, type ProviderConfig } from "./config";
import { CHAT_REASONING_MAX_TOKENS, REASONING_TIMEOUT_MS } from "./reasoning";
import { sseChunks } from "./sse";

export const AGENT_LIMITS = Object.freeze({
  maxDecisionRounds: 2,
  maxToolCalls: 3,
  maxToolCallsPerRound: 2,
  maxArgumentChars: 2_048,
  maxResultChars: 8_192,
  maxAggregateResultChars: 16_384,
  toolTimeoutMs: 2_000,
  // The timing tool's period computes (time travel): 150 s, under the worker's own 180 s.
  maxToolTimeoutMs: 150_000,
});

export type AgentJsonObject = Readonly<Record<string, unknown>>;

export interface AgentToolContext {
  /** A defensive copy of the caller-pinned instant for this turn. */
  readonly now: Date;
  /** Aborts when the caller cancels or the local execution deadline expires. */
  readonly signal: AbortSignal;
}

/** One explicitly allowlisted capability. Executors should be local/read-only. */
export interface AgentTool {
  readonly name: string;
  readonly description: string;
  /** OpenAI-compatible JSON Schema for this tool's arguments. */
  readonly parameters: AgentJsonObject;
  /** Human-readable activity label. Must not contain arguments or private data. */
  readonly statusLabel?: string;
  /**
   * Optional per-call label, chosen from the call's arguments (e.g. no "working out
   * the sky" when this call will not run the engine). Same rule: it must be a fixed
   * phrase, never the arguments or private data. Undefined falls back to `statusLabel`.
   */
  readonly statusLabelFor?: (args: AgentJsonObject) => string | undefined;
  /** Optional local deadline for known-long deterministic work, capped globally. */
  readonly timeoutMs?: number;
  readonly execute: (
    args: AgentJsonObject,
    context: AgentToolContext,
  ) => unknown | Promise<unknown>;
}

/** Safe, presentation-ready lifecycle events. No arguments, results, or reasoning. */
export type AgentStatusEvent =
  | { readonly phase: "deciding"; readonly round: number }
  | {
      readonly phase: "using_tool";
      readonly round: number;
      readonly toolName: string;
      readonly label: string;
      readonly callNumber: number;
    }
  | { readonly phase: "answering" }
  | { readonly phase: "complete" };

export interface StreamAgentChatOptions {
  readonly config: ProviderConfig;
  readonly messages: readonly ChatMessage[];
  readonly tools: readonly AgentTool[];
  /** Required: capture once at the start of the user turn. */
  readonly now: Date;
  readonly onStatus?: (event: AgentStatusEvent) => void;
  readonly signal?: AbortSignal;
  /** Injectable for deterministic tests; defaults to global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /**
   * Runaway-reasoning cap per request, in ms (default REASONING_TIMEOUT_MS):
   * no answer text or tool call by then fails the turn with a
   * ReasoningTimeoutError.
   */
  readonly reasoningTimeoutMs?: number;
}

interface OpenAiFunctionCall {
  readonly name: string;
  readonly arguments: string;
}

interface OpenAiToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: OpenAiFunctionCall;
}

interface AssistantToolMessage {
  readonly role: "assistant";
  readonly content: string | null;
  readonly tool_calls: readonly OpenAiToolCall[];
}

interface ToolResultMessage {
  readonly role: "tool";
  readonly tool_call_id: string;
  readonly name: string;
  readonly content: string;
}

type AgentWireMessage = ChatMessage | AssistantToolMessage | ToolResultMessage;

interface DecisionMessage {
  readonly content: string | null;
  readonly toolCalls: readonly OpenAiToolCall[];
}

/** One tool call being reassembled from `delta.tool_calls` fragments. */
interface ToolCallDraft {
  id: string;
  type: string;
  name: string;
  arguments: string;
}

/** Whether any answer text has reached the caller yet this turn. */
interface EmitState {
  emitted: boolean;
}

interface OpenAiDecisionPayload {
  readonly choices?: ReadonlyArray<{
    readonly message?: {
      readonly content?: unknown;
      readonly tool_calls?: unknown;
    };
  }>;
}

const MAX_ERROR_BODY_CHARS = 500;
/** Upper bound on distinct streamed tool-call indices in one decision. */
const MAX_STREAMED_TOOL_CALLS = 16;
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_TOOL_CALL_ID_CHARS = 128;
const FINALIZATION_INSTRUCTION =
  "Tool use is closed for this turn. Answer only from the supplied conversation and tool results. " +
  "If a required fact is unavailable or a tool returned an error, say so plainly; do not infer it.";
const TOOLS_UNAVAILABLE_INSTRUCTION =
  "LOCAL TOOLS ARE UNAVAILABLE for this turn. Answer only from facts already present in the " +
  "conversation. Never guess a current date, current time, timezone, chart fact, or current " +
  "planetary context that is not explicitly supplied; say that the required local fact is " +
  "unavailable instead.";

function endpoint(config: ProviderConfig): string {
  if (!config.baseUrl) {
    throw new LlmRequestError("No OpenAI-compatible base URL configured");
  }
  return `${config.baseUrl.replace(/\/$/, "")}/chat/completions`;
}

function headers(config: ProviderConfig): Record<string, string> {
  const result: Record<string, string> = { "Content-Type": "application/json" };
  if (config.apiKey) result.Authorization = `Bearer ${config.apiKey}`;
  return result;
}

async function requestError(response: Response): Promise<LlmRequestError> {
  let body: string | undefined;
  try {
    body = (await response.text()).slice(0, MAX_ERROR_BODY_CHARS) || undefined;
  } catch {
    // Preserve the transport failure even if its response body cannot be read.
  }
  return new LlmRequestError(
    `LLM endpoint returned ${response.status} ${response.statusText}${body ? `: ${body}` : ""}`,
    { status: response.status, body },
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException("The operation was aborted", "AbortError");
}

function explicitlyRejectsTools(error: unknown): boolean {
  if (!(error instanceof LlmRequestError)) return false;
  if (![400, 404, 422].includes(error.status ?? 0)) return false;
  const detail = error.body ?? error.message;
  const namesCapability = /\b(?:tool|tools|function|functions|tool_choice|tool_calls)\b|enable-auto-tool-choice/i;
  const namesRejection = /unsupported|not supported|unknown|invalid|requires?|enable/i;
  return namesCapability.test(detail) && namesRejection.test(detail);
}

function toolDefinitions(tools: readonly AgentTool[]): ReadonlyArray<Record<string, unknown>> {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

function validateOptions(options: StreamAgentChatOptions): Map<string, AgentTool> {
  if (!Number.isFinite(options.now.getTime())) {
    throw new LlmRequestError("Agent turn requires a valid pinned clock");
  }
  if (options.tools.length === 0) {
    throw new LlmRequestError("Agent turn requires at least one allowlisted tool");
  }
  const registry = new Map<string, AgentTool>();
  for (const tool of options.tools) {
    if (!TOOL_NAME.test(tool.name)) {
      throw new LlmRequestError(`Invalid agent tool name: ${tool.name}`);
    }
    if (registry.has(tool.name)) {
      throw new LlmRequestError(`Duplicate agent tool name: ${tool.name}`);
    }
    registry.set(tool.name, tool);
  }
  return registry;
}

function parseToolCall(value: unknown): OpenAiToolCall {
  if (typeof value !== "object" || value === null) {
    throw new LlmRequestError("LLM endpoint returned a malformed tool call");
  }
  const row = value as Record<string, unknown>;
  const fn = row.function;
  if (
    typeof row.id !== "string" ||
    row.id.length === 0 ||
    row.id.length > MAX_TOOL_CALL_ID_CHARS ||
    row.type !== "function" ||
    typeof fn !== "object" ||
    fn === null
  ) {
    throw new LlmRequestError("LLM endpoint returned a malformed tool call");
  }
  const functionRow = fn as Record<string, unknown>;
  if (
    typeof functionRow.name !== "string" ||
    !TOOL_NAME.test(functionRow.name) ||
    typeof functionRow.arguments !== "string"
  ) {
    throw new LlmRequestError("LLM endpoint returned a malformed tool call");
  }
  return {
    id: row.id,
    type: "function",
    function: { name: functionRow.name, arguments: functionRow.arguments },
  };
}

function parseDecision(payload: unknown): DecisionMessage {
  if (typeof payload !== "object" || payload === null) {
    throw new LlmRequestError("LLM endpoint returned a malformed agent completion");
  }
  const message = (payload as OpenAiDecisionPayload).choices?.[0]?.message;
  if (!message) {
    throw new LlmRequestError("LLM endpoint returned an empty agent completion");
  }
  const content = typeof message.content === "string" ? message.content : null;
  if (message.tool_calls === undefined) {
    return { content, toolCalls: [] };
  }
  if (!Array.isArray(message.tool_calls)) {
    throw new LlmRequestError("LLM endpoint returned malformed tool calls");
  }
  return { content, toolCalls: message.tool_calls.map(parseToolCall) };
}

function malformedToolCalls(): LlmRequestError {
  return new LlmRequestError("LLM endpoint returned malformed tool calls");
}

/**
 * Fold one `delta.tool_calls` array into the drafts. OpenAI-compatible streams
 * send `id`/`type`/`function.name` on a call's first fragment and then
 * `function.arguments` in pieces, all keyed by `index`.
 */
function mergeToolCallDeltas(drafts: Map<number, ToolCallDraft>, raw: unknown): void {
  if (!Array.isArray(raw)) throw malformedToolCalls();
  raw.forEach((item: unknown, position) => {
    if (typeof item !== "object" || item === null) throw malformedToolCalls();
    const row = item as Record<string, unknown>;
    const index =
      typeof row.index === "number" && Number.isInteger(row.index) && row.index >= 0
        ? row.index
        : position;
    let draft = drafts.get(index);
    if (!draft) {
      if (drafts.size >= MAX_STREAMED_TOOL_CALLS) throw malformedToolCalls();
      draft = { id: "", type: "", name: "", arguments: "" };
      drafts.set(index, draft);
    }
    if (typeof row.id === "string" && row.id && !draft.id) draft.id = row.id;
    if (typeof row.type === "string" && row.type) draft.type = row.type;
    const fn = row.function;
    if (typeof fn !== "object" || fn === null) return;
    const fnRow = fn as Record<string, unknown>;
    // Most providers send the name once; some repeat it on every fragment.
    if (typeof fnRow.name === "string" && fnRow.name && fnRow.name !== draft.name) {
      draft.name += fnRow.name;
    }
    if (typeof fnRow.arguments === "string") {
      // Keep one char past the limit so the size guard still trips, without
      // letting a hostile stream grow the buffer without bound.
      draft.arguments = (draft.arguments + fnRow.arguments).slice(
        0,
        AGENT_LIMITS.maxArgumentChars + 1,
      );
    }
  });
}

function assembleToolCalls(drafts: Map<number, ToolCallDraft>): OpenAiToolCall[] {
  return [...drafts.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, draft]) =>
      parseToolCall({
        id: draft.id,
        type: draft.type || "function",
        function: { name: draft.name, arguments: draft.arguments },
      }),
    );
}

function isJsonResponse(response: Response): boolean {
  return /\bapplication\/json\b/i.test(response.headers.get("content-type") ?? "");
}

async function parseJsonDecision(response: Response): Promise<DecisionMessage> {
  try {
    return parseDecision(await response.json());
  } catch (error) {
    if (error instanceof LlmRequestError) throw error;
    throw new LlmRequestError("LLM endpoint returned invalid JSON for an agent completion");
  }
}

/**
 * The tool-decision round, streamed. Content deltas are yielded as they arrive
 * (a no-tool answer is the common case and must not wait for the whole
 * completion); tool-call deltas are reassembled and returned for execution.
 */
async function* decisionRequest(
  options: StreamAgentChatOptions,
  messages: readonly AgentWireMessage[],
  definitions: ReadonlyArray<Record<string, unknown>>,
): AsyncGenerator<string, DecisionMessage> {
  throwIfAborted(options.signal);
  // Re-check immediately before every request; callers can retain/mutate a
  // config object and a later turn must still fail closed.
  ensurePrivacy(options.config);
  const response = await (options.fetchImpl ?? fetch)(endpoint(options.config), {
    method: "POST",
    headers: headers(options.config),
    body: JSON.stringify({
      model: options.config.model,
      messages,
      stream: true,
      tools: definitions,
      tool_choice: "auto",
      ...reasoningField(options.config, CHAT_REASONING_MAX_TOKENS),
    }),
    signal: options.signal,
  });
  if (!response.ok) throw await requestError(response);
  // Compatibility: a server that ignores `stream:true` answers with one JSON body.
  if (isJsonResponse(response)) {
    const decision = await parseJsonDecision(response);
    if (decision.toolCalls.length === 0 && decision.content?.trim()) yield decision.content;
    return decision;
  }

  const drafts = new Map<number, ToolCallDraft>();
  let content = "";
  for await (const chunk of sseChunks(response, capOf(options))) {
    const delta = chunk.choices?.[0]?.delta;
    if (!delta) continue;
    if (typeof delta.content === "string" && delta.content) {
      content += delta.content;
      yield delta.content;
    }
    if (delta.tool_calls !== undefined && delta.tool_calls !== null) {
      mergeToolCallDeltas(drafts, delta.tool_calls);
    }
  }
  return { content: content || null, toolCalls: assembleToolCalls(drafts) };
}

/**
 * Relay a token source, separating it from earlier answer text this turn with
 * a paragraph break (a streamed tool-round preamble must not run into the
 * answer) and reporting the first token. Returns the source's return value.
 */
async function* relayTokens<T>(
  source: AsyncGenerator<string, T>,
  state: EmitState,
  onFirstToken?: () => void,
): AsyncGenerator<string, T> {
  const needsBreak = state.emitted;
  let first = true;
  try {
    while (true) {
      const step = await source.next();
      if (step.done) return step.value;
      if (first) {
        first = false;
        onFirstToken?.();
        if (needsBreak) yield "\n\n";
      }
      state.emitted = true;
      yield step.value;
    }
  } finally {
    // Propagate an early consumer exit so the underlying reader is cancelled.
    await source.return(undefined as never);
  }
}

function parseArguments(raw: string): AgentJsonObject {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new LlmRequestError("Tool arguments were not valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LlmRequestError("Tool arguments must be a JSON object");
  }
  return value as AgentJsonObject;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]),
  );
}

function callSignature(name: string, args: AgentJsonObject): string {
  return `${name}:${JSON.stringify(stableValue(args))}`;
}

function toolError(code: string, message: string): string {
  return JSON.stringify({ ok: false, error: { code, message } });
}

function safeToolResult(value: unknown): { readonly content: string; readonly failed: boolean } {
  try {
    const result = JSON.stringify({ ok: true, value: value ?? null });
    if (result.length > AGENT_LIMITS.maxResultChars) {
      return {
        content: toolError(
          "result_too_large",
          "The local tool result exceeded the safe size limit.",
        ),
        failed: true,
      };
    }
    return { content: result, failed: false };
  } catch {
    return {
      content: toolError(
        "result_not_serializable",
        "The local tool result was not JSON serializable.",
      ),
      failed: true,
    };
  }
}

async function executeWithDeadline(
  tool: AgentTool,
  args: AgentJsonObject,
  options: StreamAgentChatOptions,
  pinnedNowMs: number,
): Promise<unknown> {
  throwIfAborted(options.signal);
  const controller = new AbortController();
  const relayAbort = (): void => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", relayAbort, { once: true });
  const requestedTimeout = tool.timeoutMs ?? AGENT_LIMITS.toolTimeoutMs;
  const timeoutMs = Number.isFinite(requestedTimeout)
    ? Math.min(
        Math.max(1, requestedTimeout),
        AGENT_LIMITS.maxToolTimeoutMs,
      )
    : AGENT_LIMITS.toolTimeoutMs;
  const timeout = setTimeout(
    () => controller.abort(new DOMException("The local tool timed out", "TimeoutError")),
    timeoutMs,
  );
  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener("abort", () => reject(controller.signal.reason), {
      once: true,
    });
  });
  try {
    const execution = Promise.resolve(
      tool.execute(args, {
        now: new Date(pinnedNowMs),
        signal: controller.signal,
      }),
    );
    return await Promise.race([execution, aborted]);
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", relayAbort);
  }
}

async function* finalRequest(
  options: StreamAgentChatOptions,
  messages: readonly AgentWireMessage[],
  definitions: ReadonlyArray<Record<string, unknown>>,
): AsyncGenerator<string> {
  throwIfAborted(options.signal);
  ensurePrivacy(options.config);
  const response = await (options.fetchImpl ?? fetch)(endpoint(options.config), {
    method: "POST",
    headers: headers(options.config),
    body: JSON.stringify({
      model: options.config.model,
      messages: [...messages, { role: "system", content: FINALIZATION_INSTRUCTION }],
      stream: true,
      tools: definitions,
      tool_choice: "none",
      ...reasoningField(options.config, CHAT_REASONING_MAX_TOKENS),
    }),
    signal: options.signal,
  });
  if (!response.ok || !response.body) throw await requestError(response);
  yield* streamContent(response, options);
}

/** Compatibility path for OpenAI-compatible endpoints without function calling. */
async function* streamWithoutTools(
  options: StreamAgentChatOptions,
  messages: readonly ChatMessage[],
): AsyncGenerator<string> {
  throwIfAborted(options.signal);
  ensurePrivacy(options.config);
  const response = await (options.fetchImpl ?? fetch)(endpoint(options.config), {
    method: "POST",
    headers: headers(options.config),
    body: JSON.stringify({
      model: options.config.model,
      messages,
      stream: true,
      ...reasoningField(options.config, CHAT_REASONING_MAX_TOKENS),
    }),
    signal: options.signal,
  });
  if (!response.ok || !response.body) throw await requestError(response);
  yield* streamContent(response, options);
}

/** The runaway-reasoning cap for one chat request (see reasoning.ts). */
function capOf(options: StreamAgentChatOptions): { readonly answerDeadlineMs: number } {
  return { answerDeadlineMs: options.reasoningTimeoutMs ?? REASONING_TIMEOUT_MS };
}

async function* streamContent(response: Response, options: StreamAgentChatOptions): AsyncGenerator<string> {
  for await (const chunk of sseChunks(response, capOf(options))) {
    const content = chunk.choices?.[0]?.delta?.content;
    if (typeof content === "string" && content) yield content;
  }
}

/**
 * Run a bounded OpenAI-compatible tool loop and yield only the final answer.
 *
 * Every request streams. A normal no-tool answer is yielded delta by delta
 * straight from the decision round; tool-call deltas are reassembled by index,
 * executed, and the loop continues. Content that precedes a tool call is shown
 * as it arrives and separated from the eventual answer. When
 * the model uses the full round/call budget (or makes a rejected call), a final
 * streaming request is forced with `tool_choice: "none"` so the turn always
 * converges instead of looping.
 */
export async function* streamAgentChat(
  options: StreamAgentChatOptions,
): AsyncGenerator<string> {
  const registry = validateOptions(options);
  // Date is mutable. Snapshot its epoch before the first await so every tool in
  // the turn observes exactly one instant even if the caller retains the Date.
  const pinnedNowMs = options.now.getTime();
  const definitions = toolDefinitions(options.tools);
  const transcript: AgentWireMessage[] = [...options.messages];
  const seen = new Set<string>();
  const seenCallIds = new Set<string>();
  let executedCalls = 0;
  let aggregateResultChars = 0;
  let forceFinal = false;
  const emit: EmitState = { emitted: false };

  for (let round = 1; round <= AGENT_LIMITS.maxDecisionRounds; round += 1) {
    options.onStatus?.({ phase: "deciding", round });
    let decision: DecisionMessage;
    try {
      decision = yield* relayTokens(
        decisionRequest(options, transcript, definitions),
        emit,
        () => options.onStatus?.({ phase: "answering" }),
      );
    } catch (error) {
      // Some otherwise-valid Ollama/llama.cpp/OpenAI-compatible models reject
      // the tools fields outright. On the first request only, retain privacy
      // and grounded messages while degrading to their ordinary SSE contract.
      if (round === 1 && !emit.emitted && explicitlyRejectsTools(error)) {
        options.onStatus?.({ phase: "answering" });
        yield* streamWithoutTools(options, [
          { role: "system", content: TOOLS_UNAVAILABLE_INSTRUCTION },
          ...options.messages,
        ]);
        options.onStatus?.({ phase: "complete" });
        return;
      }
      throw error;
    }
    if (decision.toolCalls.length === 0) {
      if (!decision.content?.trim()) {
        throw new LlmRequestError("LLM endpoint returned an empty agent completion");
      }
      options.onStatus?.({ phase: "complete" });
      return;
    }

    const roundCalls = decision.toolCalls.slice(0, AGENT_LIMITS.maxToolCallsPerRound);
    if (roundCalls.length < decision.toolCalls.length) forceFinal = true;
    transcript.push({
      role: "assistant",
      content: decision.content,
      tool_calls: roundCalls,
    });

    for (const modelCall of roundCalls) {
      const name = modelCall.function.name;
      let content: string;

      if (seenCallIds.has(modelCall.id)) {
        content = toolError("duplicate_call_id", "This tool-call id was already used.");
        forceFinal = true;
      } else if (executedCalls >= AGENT_LIMITS.maxToolCalls) {
        content = toolError("tool_call_limit", "The tool-call budget is exhausted.");
        forceFinal = true;
      } else if (modelCall.function.arguments.length > AGENT_LIMITS.maxArgumentChars) {
        content = toolError(
          "arguments_too_large",
          "The requested tool arguments exceeded the safe size limit.",
        );
        forceFinal = true;
      } else {
        let args: AgentJsonObject;
        try {
          args = parseArguments(modelCall.function.arguments);
        } catch {
          content = toolError("invalid_arguments", "Tool arguments must be a JSON object.");
          transcript.push({ role: "tool", tool_call_id: modelCall.id, name, content });
          forceFinal = true;
          continue;
        }
        const signature = callSignature(name, args);
        const selectedTool = registry.get(name);
        if (seen.has(signature)) {
          content = toolError("duplicate_tool_call", "This tool call was already attempted.");
          forceFinal = true;
        } else if (!selectedTool) {
          content = toolError("unknown_tool", "The requested tool is not allowlisted.");
          forceFinal = true;
        } else {
          seen.add(signature);
          executedCalls += 1;
          options.onStatus?.({
            phase: "using_tool",
            round,
            toolName: selectedTool.name,
            label: selectedTool.statusLabelFor?.(args) ?? selectedTool.statusLabel ?? `Using ${selectedTool.name}`,
            callNumber: executedCalls,
          });
          try {
            const value = await executeWithDeadline(selectedTool, args, options, pinnedNowMs);
            throwIfAborted(options.signal);
            const encoded = safeToolResult(value);
            content = encoded.content;
            if (encoded.failed) forceFinal = true;
          } catch (error) {
            throwIfAborted(options.signal);
            const code =
              error instanceof DOMException && error.name === "TimeoutError"
                ? "tool_timeout"
                : "tool_failed";
            content = toolError(code, "The local tool could not complete safely.");
            forceFinal = true;
          }
        }
      }

      seenCallIds.add(modelCall.id);
      if (aggregateResultChars + content.length > AGENT_LIMITS.maxAggregateResultChars) {
        content = toolError(
          "aggregate_results_too_large",
          "The tool-result budget is exhausted.",
        );
        forceFinal = true;
      }
      aggregateResultChars += content.length;
      transcript.push({ role: "tool", tool_call_id: modelCall.id, name, content });
    }

    if (
      forceFinal ||
      executedCalls >= AGENT_LIMITS.maxToolCalls ||
      round === AGENT_LIMITS.maxDecisionRounds
    ) {
      break;
    }
  }

  options.onStatus?.({ phase: "answering" });
  yield* relayTokens(finalRequest(options, transcript, definitions), emit);
  options.onStatus?.({ phase: "complete" });
}
