// Bounded, browser-native OpenAI-compatible tool loop.
//
// This is intentionally a capability shell, not a general autonomous agent:
// callers inject a small allowlist of local tools, every turn carries a
// caller-pinned clock, and the model never receives shell, filesystem, network,
// or storage access through this module. Tool arguments/results stay inside the
// request transcript and are never surfaced through status events.

import { LlmRequestError, reasoningField, type ChatMessage } from "./client";
import { compactToolContent, summarizeToolResult, type ToolSummarizer } from "./compaction";
import { ensurePrivacy, type ProviderConfig } from "./config";
import { calibratedEstimate, estimateRequestTokens, turnTokenBudget, type TokenCalibration } from "./contextBudget";
import { CHAT_REASONING_MAX_TOKENS, REASONING_TIMEOUT_MS } from "./reasoning";
import { sseChunks } from "./sse";

export const AGENT_LIMITS = Object.freeze({
  maxDecisionRounds: 2,
  // One full parallel round plus a follow-up; a trip's grounding calls do not count.
  maxToolCalls: 6,
  // Calls past this in one decision are answered "skipped", never run.
  maxToolCallsPerRound: 4,
  maxArgumentChars: 2_048,
  maxResultChars: 8_192,
  // Full results one round may add; past it a result arrives as its compact summary.
  maxAggregateResultChars: 16_384,
  toolTimeoutMs: 2_000,
  // The timing tool's period computes (time travel): 150 s, under the worker's own 180 s.
  maxToolTimeoutMs: 150_000,
});

/** Extra decision rounds a trip may spend retrying a required grounding tool that has not yet succeeded. */
export const GROUNDING_RETRY_ROUNDS = 2;

export type AgentJsonObject = Readonly<Record<string, unknown>>;

export interface AgentToolContext {
  /** A defensive copy of the caller-pinned instant for this turn. */
  readonly now: Date;
  /** Aborts when the caller cancels or the local execution deadline expires. */
  readonly signal: AbortSignal;
}

/** One explicitly allowlisted local capability. UI changes are queued by the caller. */
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
  /**
   * Optional deterministic one-line summary of a result (plus its key cited
   * factors). Later rounds and later turns see a consumed result only as this.
   * Without it, `defaultToolSummary` describes the result.
   */
  readonly summarize?: ToolSummarizer;
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

/** A tool execution that threw or timed out, for local diagnostics. */
export interface AgentToolFailure {
  readonly toolName: string;
  readonly code: "tool_failed" | "tool_timeout";
  readonly error: unknown;
}

/**
 * One executed (or refused) tool call, for the transcript the UI shows. `result`
 * is exactly the value the model received: the tool's sanitized value, or the
 * error object when the call failed.
 */
export interface AgentToolCallRecord {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: AgentJsonObject;
  readonly result: unknown;
  readonly status: "complete" | "error";
}

/**
 * One model request of a turn, for the transcript and dev diagnostics only
 * (never sent anywhere). `round` counts requests, the final answer included.
 */
export interface AgentRoundUsage {
  readonly round: number;
  readonly phase: "decision" | "final";
  /** The provider's `usage.prompt_tokens` when it reported one, else `estimate`. */
  readonly prompt_tokens: number;
  readonly completion_tokens: number | null;
  /** True when the provider reported no usage and `prompt_tokens` is the estimate. */
  readonly estimated: boolean;
  /** ceil(chars / 4) of the request, scaled by an earlier provider count. */
  readonly estimate: number;
  /** The turn's token budget: half the model's context window. */
  readonly budget: number;
  /** Tool messages this request carried as compact summaries. */
  readonly compacted: number;
}

export interface StreamAgentChatOptions {
  readonly config: ProviderConfig;
  /**
   * The model's context window in tokens (OpenRouter's `context_length`, or a
   * configured value). No request of the turn may exceed half of it. Unknown: 8k.
   */
  readonly contextTokens?: number;
  /** Diagnostics only: one row per model request. A throwing handler is ignored. */
  readonly onRoundUsage?: (usage: AgentRoundUsage) => void;
  readonly messages: readonly ChatMessage[];
  readonly tools: readonly AgentTool[];
  /** Required: capture once at the start of the user turn. */
  readonly now: Date;
  readonly onStatus?: (event: AgentStatusEvent) => void;
  /**
   * Diagnostics only: a tool threw or timed out. The model sees just the
   * opaque code; this hands the caller the real error so a failing tool can
   * say why. It may hold private text, so callers must never send it anywhere.
   * A throwing handler is ignored.
   */
  readonly onToolError?: (failure: AgentToolFailure) => void;
  /** Every tool call this turn, in order, with the value the model received. A throwing handler is ignored. */
  readonly onToolCall?: (record: AgentToolCallRecord) => void;
  /**
   * 'required' makes the first decision round call a tool (a trip grounds
   * itself before it answers). Later rounds are always 'auto'. Default 'auto'.
   */
  readonly firstRoundToolChoice?: "auto" | "required";
  /**
   * With 'required': the no-argument tool the loop runs itself when the
   * provider refuses tool_choice 'required'. Its result reaches the model as a
   * tool message, never as prompt text.
   */
  readonly groundingToolName?: string;
  /**
   * With 'required': the calls the loop makes itself when a required round
   * gets no tool call at all (a refused tool_choice, a text-only reply, or an
   * empty provider error). Their results reach the model as tool messages and
   * the turn continues with 'auto'. Defaults to `groundingToolName` with {}.
   */
  readonly groundingCalls?: ReadonlyArray<{ readonly name: string; readonly args: AgentJsonObject }>;
  /**
   * With 'required': later rounds stay 'required' until each of these
   * registered tools has run once this turn (a trip reads its natal chart, its
   * period and place, and its timing before it answers). Bounded by the round
   * and call budgets; unregistered names are ignored.
   */
  readonly requiredToolNames?: readonly string[];
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
  meaningful: boolean;
}

/** The provider's own token counts for one request, when it reports them. */
interface UsageSink {
  prompt?: number;
  completion?: number;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function readUsage(raw: unknown, sink: UsageSink): void {
  if (typeof raw !== "object" || raw === null) return;
  const usage = raw as { prompt_tokens?: unknown; completion_tokens?: unknown };
  sink.prompt = count(usage.prompt_tokens) ?? sink.prompt;
  sink.completion = count(usage.completion_tokens) ?? sink.completion;
}

interface OpenAiDecisionPayload {
  readonly usage?: unknown;
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
  "conversation. Verified local facts already supplied remain available; interpret those facts " +
  "and do not claim they could not be verified. Additional local lookups or UI actions cannot run. " +
  "Never guess a current date, current time, timezone, chart fact, or current " +
  "planetary context that is not explicitly supplied; say that the required local fact is " +
  "unavailable instead.";
const TOOLS_UNAVAILABLE_NOTICE =
  "Your AI provider does not support chat tools. I can interpret the verified local facts already supplied, " +
  "but cannot run additional tools or change the selected date this turn.\n\n";

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

/** Tool schemas in name order, so every round and turn sends a byte-identical prefix. */
function toolDefinitions(tools: readonly AgentTool[]): ReadonlyArray<Record<string, unknown>> {
  const byName = [...tools].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return byName.map((tool) => ({
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
  if (options.groundingToolName !== undefined && !registry.has(options.groundingToolName)) {
    throw new LlmRequestError(`Grounding tool is not allowlisted: ${options.groundingToolName}`);
  }
  for (const call of options.groundingCalls ?? []) {
    if (!registry.has(call.name)) throw new LlmRequestError(`Grounding tool is not allowlisted: ${call.name}`);
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

async function parseJsonDecision(response: Response, usage: UsageSink): Promise<DecisionMessage> {
  try {
    const payload: unknown = await response.json();
    readUsage((payload as OpenAiDecisionPayload | null)?.usage, usage);
    return parseDecision(payload);
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
  toolChoice: "auto" | "required",
  usage: UsageSink,
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
      tool_choice: toolChoice,
      ...reasoningField(options.config, CHAT_REASONING_MAX_TOKENS),
    }),
    signal: options.signal,
  });
  if (!response.ok) throw await requestError(response);
  // Compatibility: a server that ignores `stream:true` answers with one JSON body.
  if (isJsonResponse(response)) {
    const decision = await parseJsonDecision(response, usage);
    if (decision.toolCalls.length === 0 && decision.content?.trim()) yield decision.content;
    return decision;
  }

  const drafts = new Map<number, ToolCallDraft>();
  let content = "";
  for await (const chunk of sseChunks(response, capOf(options))) {
    readUsage(chunk.usage, usage);
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
      if (step.value.trim()) state.meaningful = true;
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

function errorText(value: unknown): string {
  const error = (value as { error?: unknown }).error;
  return typeof error === "string" ? error : JSON.stringify(error);
}

/** A tool that answered with { error } returned, but did not succeed. */
function isErrorValue(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "error" in value;
}

/** Read a decision without showing any of its text. */
async function drain<T>(source: AsyncGenerator<string, T>): Promise<T> {
  while (true) {
    const step = await source.next();
    if (step.done) return step.value;
  }
}

function reportToolCall(options: StreamAgentChatOptions, call: OpenAiToolCall, args: AgentJsonObject, content: string): void {
  let result: unknown;
  let status: AgentToolCallRecord["status"] = "error";
  try {
    const parsed = JSON.parse(content) as { ok?: boolean; value?: unknown; error?: unknown };
    // A tool that answered { error } ran, but did not succeed: the row says so.
    status = parsed.ok === true && !isErrorValue(parsed.value) ? "complete" : "error";
    // A compacted result carries no `value`: the model got the summary object itself.
    result = parsed.ok === true ? ("value" in parsed ? parsed.value : parsed) : parsed.error;
  } catch {
    result = undefined;
  }
  try {
    options.onToolCall?.({ toolCallId: call.id, toolName: call.function.name, args, result, status });
  } catch {
    // A transcript sink must never change the turn's outcome.
  }
}

function reportToolFailure(options: StreamAgentChatOptions, failure: AgentToolFailure): void {
  try {
    options.onToolError?.(failure);
  } catch {
    // A diagnostic sink must never change the turn's outcome.
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

/** The forced last request: tools off (`tool_choice: none`), the messages already assembled to fit. */
async function* finalRequest(
  options: StreamAgentChatOptions,
  messages: readonly AgentWireMessage[],
  definitions: ReadonlyArray<Record<string, unknown>>,
  usage: UsageSink,
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
      tools: definitions,
      tool_choice: "none",
      ...reasoningField(options.config, CHAT_REASONING_MAX_TOKENS),
    }),
    signal: options.signal,
  });
  if (!response.ok || !response.body) throw await requestError(response);
  yield* streamContent(response, options, usage);
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

async function* streamContent(response: Response, options: StreamAgentChatOptions, usage: UsageSink = {}): AsyncGenerator<string> {
  for await (const chunk of sseChunks(response, capOf(options))) {
    readUsage(chunk.usage, usage);
    const content = chunk.choices?.[0]?.delta?.content;
    if (typeof content === "string" && content) yield content;
  }
}

const BUDGET_INSTRUCTION =
  "The context budget for this turn is used up, so no more tools can run. Answer from the facts " +
  "gathered so far and say plainly which facts you could not check.";
const COMPACTED_PREFIX = '{"ok":true,"compacted":true';
const SKIPPED_CALL = toolError("skipped", "skipped: too many calls this round");

/** One message of the turn's wire transcript, with what compaction needs to know about it. */
interface TranscriptEntry {
  readonly message: AgentWireMessage;
  /** A tool result: the results round it arrived in. */
  readonly resultRound?: number;
  /** A tool result's compact form, kept only when shorter than its full content. */
  readonly compact?: string;
  /** One of the caller's earlier conversation turns: dropped oldest-first under budget pressure. */
  readonly history?: boolean;
}

/** One request, assembled to fit the turn's budget. */
interface RequestPlan {
  readonly messages: readonly AgentWireMessage[];
  /** ceil(chars / 4), before calibration (what a provider count is compared with). */
  readonly raw: number;
  readonly estimate: number;
  readonly compacted: number;
  readonly fits: boolean;
}

/**
 * The turn's wire transcript and how each request is cut to fit the budget.
 * A tool result read by an earlier request goes out as its compact summary;
 * only the newest round's results stay in full. Under budget pressure the
 * caller's earlier turns are dropped (oldest first, whole user turns), and the
 * final answer may carry the newest round compact too. Every tool message keeps
 * its tool_call pairing; only its content shrinks.
 */
class TurnTranscript {
  private readonly entries: TranscriptEntry[];
  private resultRound = 0;

  constructor(messages: readonly ChatMessage[]) {
    const lastUser = messages.map((message) => message.role).lastIndexOf("user");
    this.entries = messages.map((message, index) => ({ message, history: index < lastUser && message.role !== "system" }));
  }

  /** Every decision round's (or local grounding's) results form one results round. */
  beginRound(): void {
    this.resultRound += 1;
  }

  push(message: AgentWireMessage): void {
    this.entries.push({ message });
  }

  pushResult(message: ToolResultMessage, compact: string | undefined): void {
    const shorter = compact !== undefined && compact.length < message.content.length;
    this.entries.push({ message, resultRound: this.resultRound, ...(shorter ? { compact } : {}) });
  }

  /** The first variant that fits, from fullest to leanest; the leanest when none does. */
  plan(budget: number, definitions: readonly unknown[], calibration: TokenCalibration | undefined,
    extra: readonly AgentWireMessage[], final: boolean): RequestPlan {
    const cuts = this.historyCuts();
    const leanest = cuts.at(-1) ?? 0;
    const variants = [...cuts.map((drop) => ({ compactNewest: false, drop })),
      ...(final ? [{ compactNewest: true, drop: leanest }] : [])];
    const build = ({ compactNewest, drop }: { compactNewest: boolean; drop: number }): RequestPlan => {
      const messages = [...this.view(compactNewest, drop), ...extra];
      const raw = estimateRequestTokens(messages, definitions);
      const estimate = calibratedEstimate(raw, calibration);
      const compacted = messages.filter((message) => message.role === "tool" && message.content.startsWith(COMPACTED_PREFIX)).length;
      return { messages, raw, estimate, compacted, fits: estimate <= budget };
    };
    let plan = build({ compactNewest: false, drop: 0 });
    for (const variant of variants.slice(1)) {
      if (plan.fits) break;
      plan = build(variant);
    }
    return plan;
  }

  private view(compactNewest: boolean, drop: number): AgentWireMessage[] {
    let dropped = 0;
    const messages: AgentWireMessage[] = [];
    for (const entry of this.entries) {
      if (entry.history && dropped < drop) {
        dropped += 1;
        continue;
      }
      const consumed = entry.resultRound !== undefined && (compactNewest || entry.resultRound < this.resultRound);
      messages.push(consumed && entry.compact !== undefined ? { ...(entry.message as ToolResultMessage), content: entry.compact } : entry.message);
    }
    return messages;
  }

  /** How many earlier-turn messages to drop: none, then up to each later user turn, then all. */
  private historyCuts(): number[] {
    const history = this.entries.filter((entry) => entry.history);
    const cuts = [0];
    history.forEach((entry, index) => {
      if (index > 0 && entry.message.role === "user") cuts.push(index);
    });
    if (history.length > 0) cuts.push(history.length);
    return cuts;
  }
}

function reportRoundUsage(options: StreamAgentChatOptions, usage: AgentRoundUsage): void {
  try {
    options.onRoundUsage?.(usage);
  } catch {
    // A diagnostic sink must never change the turn's outcome.
  }
}

/** A succeeded result's compact form: the tool's own summary, else the default one. */
function compactOf(tool: AgentTool, value: unknown): string {
  return compactToolContent(summarizeToolResult(tool.summarize, value));
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
 *
 * Context budget (spec 2026-10-13): no request may exceed half the model's
 * context window (`contextTokens`, 8k when unknown). Consumed tool results are
 * sent compact, an identical successful call gets a pointer to the first, and
 * when the next decision round would not fit, one final round with tools off
 * answers from what was gathered and says what it could not check.
 */
export async function* streamAgentChat(
  options: StreamAgentChatOptions,
): AsyncGenerator<string> {
  const registry = validateOptions(options);
  // Date is mutable. Snapshot its epoch before the first await so every tool in
  // the turn observes exactly one instant even if the caller retains the Date.
  const pinnedNowMs = options.now.getTime();
  const definitions = toolDefinitions(options.tools);
  const transcript = new TurnTranscript(options.messages);
  const budget = turnTokenBudget(options.contextTokens);
  let calibration: TokenCalibration | undefined;
  let requestNumber = 0;
  /** After each request: telemetry, and calibrate later estimates by the provider's own count. */
  const settle = (phase: AgentRoundUsage["phase"], plan: RequestPlan, usage: UsageSink): void => {
    requestNumber += 1;
    if (usage.prompt !== undefined) calibration = { estimate: plan.raw, reported: usage.prompt };
    reportRoundUsage(options, {
      round: requestNumber, phase, prompt_tokens: usage.prompt ?? plan.estimate, completion_tokens: usage.completion ?? null,
      estimated: usage.prompt === undefined, estimate: plan.estimate, budget, compacted: plan.compacted,
    });
  };
  const seen = new Set<string>();
  // Calls that ran and failed, by signature: an identical retry gets the same error back with
  // instructions instead of ending the turn as a duplicate (2026-10-13: Harish's dead end).
  const failedCalls = new Map<string, string>();
  // Calls that succeeded, by signature: an identical call later in the turn gets a pointer to the first.
  const succeededCalls = new Map<string, string>();
  const seenCallIds = new Set<string>();
  let executedCalls = 0;
  let forceFinal = false;
  let budgetExhausted = false;
  const emit: EmitState = { emitted: false, meaningful: false };
  let toolChoice = options.firstRoundToolChoice ?? "auto";
  const groundingPlan = (options.groundingCalls ?? (options.groundingToolName ? [{ name: options.groundingToolName, args: {} }] : []))
    .flatMap((call) => {
      const tool = registry.get(call.name);
      return tool ? [{ tool, args: call.args }] : [];
    });
  let localCallNumber = 0;
  /** The grounding calls for tools the turn still needs (a tool that already succeeded is not run again). */
  const pendingGrounding = () => groundingPlan.filter(({ tool }) => stillRequired.size === 0 || stillRequired.has(tool.name));
  /** Run the pending grounding calls here; each result reaches the model as a tool message. */
  const groundLocally = async (round: number): Promise<void> => {
    const calls = pendingGrounding().map(({ tool, args }) => {
      localCallNumber += 1;
      const call: OpenAiToolCall = { id: `local-grounding-${localCallNumber}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(args) } };
      return { tool, args, call };
    });
    transcript.beginRound();
    transcript.push({ role: "assistant", content: null, tool_calls: calls.map(({ call }) => call) });
    for (const { tool, args, call } of calls) {
      options.onStatus?.({ phase: "using_tool", round, toolName: tool.name,
        label: tool.statusLabelFor?.(args) ?? tool.statusLabel ?? `Using ${tool.name}`, callNumber: localCallNumber });
      let content: string;
      let value: unknown;
      try {
        value = await executeWithDeadline(tool, args, options, pinnedNowMs);
        content = safeToolResult(value).content;
      } catch (failure) {
        throwIfAborted(options.signal);
        reportToolFailure(options, { toolName: tool.name, code: "tool_failed", error: failure });
        content = toolError("tool_failed", "The local tool could not complete safely.");
      }
      const signature = callSignature(tool.name, args);
      seen.add(signature);
      const succeeded = !isErrorValue(value) && !content.startsWith('{"ok":false');
      if (isErrorValue(value)) failedCalls.set(signature, errorText(value));
      else if (succeeded) {
        stillRequired.delete(tool.name);
        succeededCalls.set(signature, call.id);
      }
      seenCallIds.add(call.id);
      transcript.pushResult({ role: "tool", tool_call_id: call.id, name: tool.name, content }, succeeded ? compactOf(tool, value) : undefined);
      reportToolCall(options, call, args, content);
    }
  };
  const stillRequired = new Set((options.requiredToolNames ?? []).filter((name) => registry.has(name)));
  const choiceFor = (round: number): "auto" | "required" =>
    toolChoice === "required" && (round === 1 || stillRequired.size > 0) ? "required" : "auto";

  const lastRound = AGENT_LIMITS.maxDecisionRounds + (stillRequired.size > 0 ? GROUNDING_RETRY_ROUNDS : 0);
  for (let round = 1; round <= lastRound; round += 1) {
    // The next decision round must fit; if it cannot, the turn answers now with tools off.
    const plan = transcript.plan(budget, definitions, calibration, [], false);
    if (!plan.fits) {
      budgetExhausted = true;
      break;
    }
    options.onStatus?.({ phase: "deciding", round });
    let decision: DecisionMessage;
    const choice = choiceFor(round);
    const usage: UsageSink = {};
    try {
      // A required round must call a tool, so its text is never streamed: a
      // text-only reply there is an ungrounded answer and is thrown away.
      decision = choice === "required" && groundingPlan.length > 0
        ? await drain(decisionRequest(options, plan.messages, definitions, choice, usage))
        : yield* relayTokens(
          decisionRequest(options, plan.messages, definitions, choice, usage),
          emit,
          () => options.onStatus?.({ phase: "answering" }),
        );
    } catch (error) {
      // A provider that refuses tool_choice 'required' still gets grounded: the
      // loop runs the grounding tool itself and the result arrives as a tool
      // message. The first round is then retried with 'auto'.
      if (round === 1 && toolChoice === "required" && groundingPlan.length > 0 && !emit.emitted && explicitlyRejectsTools(error)) {
        toolChoice = "auto";
        await groundLocally(round);
        round -= 1;
        continue;
      }
      // Some otherwise-valid Ollama/llama.cpp/OpenAI-compatible models reject
      // the tools fields outright. On the first request only, retain privacy
      // and grounded messages while degrading to their ordinary SSE contract.
      if (round === 1 && !emit.emitted && explicitlyRejectsTools(error)) {
        options.onStatus?.({ phase: "answering" });
        yield TOOLS_UNAVAILABLE_NOTICE;
        yield* streamWithoutTools(options, [
          { role: "system", content: TOOLS_UNAVAILABLE_INSTRUCTION },
          ...options.messages,
        ]);
        options.onStatus?.({ phase: "complete" });
        return;
      }
      throw error;
    }
    settle("decision", plan, usage);
    if (decision.toolCalls.length === 0 && choice === "required" && pendingGrounding().length > 0) {
      // No tool call under 'required' (2026-10-13: qwen answered from nothing; a host
      // routed for gpt-oss returned finish_reason "error" with no content). Ground the
      // trip locally, then let the model answer with 'auto'.
      toolChoice = "auto";
      await groundLocally(round);
      continue;
    }
    if (decision.toolCalls.length === 0) {
      if (!decision.content?.trim()) {
        throw new LlmRequestError("LLM endpoint returned an empty agent completion");
      }
      options.onStatus?.({ phase: "complete" });
      return;
    }

    // Every requested call is echoed (each needs its tool message); only the first few run.
    const roundCalls = decision.toolCalls.slice(0, MAX_STREAMED_TOOL_CALLS);
    transcript.beginRound();
    transcript.push({
      role: "assistant",
      content: decision.content,
      tool_calls: roundCalls,
    });
    let roundResultChars = 0;

    for (const [index, modelCall] of roundCalls.entries()) {
      const name = modelCall.function.name;
      let content: string;
      let callArgs: AgentJsonObject = {};
      let compact: string | undefined;

      if (seenCallIds.has(modelCall.id)) {
        content = toolError("duplicate_call_id", "This tool-call id was already used.");
        forceFinal = true;
      } else if (index >= AGENT_LIMITS.maxToolCallsPerRound) {
        content = SKIPPED_CALL;
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
          seenCallIds.add(modelCall.id);
          transcript.pushResult({ role: "tool", tool_call_id: modelCall.id, name, content }, undefined);
          reportToolCall(options, modelCall, {}, content);
          forceFinal = true;
          continue;
        }
        callArgs = args;
        const signature = callSignature(name, args);
        const selectedTool = registry.get(name);
        const earlierFailure = failedCalls.get(signature);
        const earlierSuccess = succeededCalls.get(signature);
        if (earlierFailure !== undefined) {
          content = toolError("repeated_failed_call", `This exact call already failed: ${earlierFailure} Change the arguments as that error says before calling again.`);
        } else if (earlierSuccess !== undefined) {
          content = JSON.stringify({ ok: true, value: `unchanged; see the earlier result ${earlierSuccess}` });
        } else if (seen.has(signature)) {
          content = toolError("duplicate_tool_call", "This tool call was already attempted.");
          forceFinal = true;
        } else if (!selectedTool) {
          content = toolError("unknown_tool", "The requested tool is not allowlisted.");
          forceFinal = true;
        } else {
          seen.add(signature);
          // A trip's calls to a grounding tool it still needs are the trip's,
          // not the model's: they do not spend the model's own tool budget.
          const grounding = stillRequired.has(selectedTool.name);
          if (!grounding) executedCalls += 1;
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
            // Only a call that succeeded grounds the trip; an { error } result lets the model retry.
            else if (isErrorValue(value)) failedCalls.set(signature, errorText(value));
            else {
              if (grounding) stillRequired.delete(selectedTool.name);
              succeededCalls.set(signature, modelCall.id);
              compact = compactOf(selectedTool, value);
            }
          } catch (error) {
            throwIfAborted(options.signal);
            const code =
              error instanceof DOMException && error.name === "TimeoutError"
                ? "tool_timeout"
                : "tool_failed";
            reportToolFailure(options, { toolName: selectedTool.name, code, error });
            content = toolError(code, "The local tool could not complete safely.");
            forceFinal = true;
          }
        }
      }

      seenCallIds.add(modelCall.id);
      // Past the round's full-result allowance, a result arrives as its summary.
      if (compact !== undefined && roundResultChars + content.length > AGENT_LIMITS.maxAggregateResultChars) {
        content = compact;
      }
      roundResultChars += content.length;
      transcript.pushResult({ role: "tool", tool_call_id: modelCall.id, name, content }, compact);
      reportToolCall(options, modelCall, callArgs, content);
    }

    // Past the normal round budget only while a required grounding tool has not succeeded.
    const outOfRounds = round >= AGENT_LIMITS.maxDecisionRounds && (stillRequired.size === 0 || round >= lastRound);
    if (
      forceFinal ||
      executedCalls >= AGENT_LIMITS.maxToolCalls ||
      outOfRounds
    ) {
      break;
    }
  }

  options.onStatus?.({ phase: "answering" });
  const missing = [...stillRequired];
  const closing: ChatMessage[] = [
    { role: "system", content: FINALIZATION_INSTRUCTION },
    ...(missing.length === 0 ? [] : [{
      role: "system" as const,
      content: `${missing.join(", ")} did not succeed this turn. Say plainly which facts could not be read; do not guess or infer them.`,
    }]),
    ...(budgetExhausted ? [{ role: "system" as const, content: BUDGET_INSTRUCTION }] : []),
  ];
  const finalPlan = transcript.plan(budget, definitions, calibration, closing, true);
  const usage: UsageSink = {};
  yield* relayTokens(finalRequest(options, finalPlan.messages, definitions, usage), emit);
  settle("final", finalPlan, usage);
  if (!emit.meaningful) throw new LlmRequestError("LLM endpoint returned an empty agent completion");
  options.onStatus?.({ phase: "complete" });
}
