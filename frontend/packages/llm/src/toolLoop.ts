// The ONE seam between AlmaMesh and the Vercel AI SDK (`ai`,
// `@ai-sdk/openai-compatible`) and zod. ESLint forbids importing those
// libraries anywhere else, so upgrading or swapping the engine touches only
// this file.
//
// What the seam adds on top of the SDK's tool loop:
// - egress: the provider's fetch refuses every origin but the configured
//   endpoint (`guardedFetch`), and the model is always a provider instance,
//   never a bare id string (a bare id routes through the Vercel AI Gateway);
// - zod-typed tools whose invalid arguments go back to the model as a retry;
// - a final `answer` tool that carries the structured answer, streamed as
//   rendered snapshots while its arguments arrive;
// - per-tool budgets, tool timeouts, a runaway-reasoning cap, and telemetry;
// - a per-turn context budget: no request carries more than half the model's
//   context window. Older tool results go compact first (the newest result of
//   each tool stays whole), then the turn is closed with a forced `answer`.
//
// `explicitlyRejectsTools`, `TOOLS_UNAVAILABLE_*` and `AgentStatusEvent` live
// in ./toolsUnavailable (no SDK import).

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  APICallError,
  jsonSchema,
  RetryError,
  StreamProviderError,
  parsePartialJson,
  stepCountIs,
  streamText,
  tool,
  ToolChoiceViolationError,
  type JSONSchema7,
  type JSONValue,
  type LanguageModel,
  type ModelMessage,
  type PrepareStepResult,
  type StopCondition,
  type TextStreamPart,
  type Tool,
  type ToolResultPart,
  type ToolSet,
} from "ai";
import { z } from "zod";

import { LlmRequestError, type ChatMessage } from "./client";
import { compactToolResult } from "./compaction";
import { ensurePrivacy, OPENROUTER_API_BASE, PrivacyViolationError, type ProviderConfig } from "./config";
import { calibratedEstimate, estimateRequestTokens, turnTokenBudget, type TokenCalibration } from "./contextBudget";
import { CHAT_REASONING_MAX_TOKENS, REASONING_TIMEOUT_MS, ReasoningTimeoutError } from "./reasoning";
import {
  explicitlyRejectsTools,
  TOOLS_UNAVAILABLE_INSTRUCTION,
  TOOLS_UNAVAILABLE_NOTICE,
  type AgentStatusEvent,
} from "./toolsUnavailable";

export { z };
export { TOOLS_UNAVAILABLE_INSTRUCTION, TOOLS_UNAVAILABLE_NOTICE, type AgentStatusEvent };

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export interface ToolContext {
  readonly signal: AbortSignal;
  readonly now: Date;
}

export interface ToolDef<I> {
  readonly name: string;
  readonly description: string;
  /** Optional keys are `.nullable()`, never `.optional()`: strict mode needs every key required. */
  readonly input: z.ZodType<I>;
  /** Set false to opt this tool out of strict mode on endpoints that support it. */
  readonly strict?: boolean;
  /** Default {@link TOOL_TIMEOUT_MS.default}, capped at {@link TOOL_TIMEOUT_MS.max}. */
  readonly timeoutMs?: number;
  /** The status line shown while the tool runs (default `Using <name>`). */
  readonly statusLabel?: string;
  execute(input: I, ctx: ToolContext): Promise<unknown>;
  /**
   * The compact form sent in place of a result the turn's context budget cannot
   * carry in full (default: a one-line summary). Pure and deterministic.
   */
  compact?(result: unknown): unknown;
}

export function defineTool<I>(def: ToolDef<I>): ToolDef<I> {
  return def;
}

export type ToolCallStatus = "complete" | "error" | "skipped" | "retried";

export interface ToolCallEvent {
  readonly round: number;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: unknown;
  readonly result: unknown;
  readonly status: ToolCallStatus;
  /** Valid, and no earlier call to the same tool this turn was invalid. */
  readonly validFirstTry: boolean;
  /** A valid `answer` call only: the top-level keys the answer spec's `prepare` filled ([] when none). */
  readonly filled?: readonly string[];
}

export interface RoundEvent {
  readonly round: number;
  /** The provider's own count; undefined when it reported none. */
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly finishReason: string;
  /** Our estimate of the request (messages + tool definitions, chars / 4), calibrated by the provider's earlier counts. */
  readonly estimate: number;
  /** True when the provider reported no input tokens and only `estimate` is known. */
  readonly estimated: boolean;
  /** The turn's token budget: half the model's context window. */
  readonly budget: number;
  /** Tool results this request carried in their compact form. */
  readonly compacted: number;
}

export interface ToolLoopLimits {
  readonly maxRounds?: number;
  readonly maxCallsPerTool?: Readonly<Record<string, number>>;
}

export interface AnswerSpec<A> {
  readonly schema: z.ZodType<A>;
  /** The answer tool's description on the wire (default {@link ANSWER_TOOL_DESCRIPTION}). */
  readonly description?: string;
  render(partial: Partial<A>, final: boolean): string;
  /**
   * Fills facts the tools already returned into the model's answer before it is validated
   * (after omitted, "null" and blank nullable keys became null). Return the input unchanged when
   * there is nothing to fill; a wrong value must be left for validation to reject.
   */
  prepare?(input: unknown): unknown;
}

export interface RunToolTurnOptions<A> {
  readonly config: ProviderConfig;
  /** The model's context window in tokens; no request may carry more than half of it. Unknown: 8k. */
  readonly contextTokens?: number;
  readonly messages: readonly ChatMessage[];
  readonly tools: readonly ToolDef<unknown>[];
  readonly answer: AnswerSpec<A>;
  /** Round 1 must call a tool other than `answer` (trip turns). */
  readonly readFirst: boolean;
  readonly now: Date;
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
  readonly limits?: ToolLoopLimits;
  /** Runaway-reasoning cap per request (default REASONING_TIMEOUT_MS). */
  readonly reasoningTimeoutMs?: number;
  onStatus?(e: AgentStatusEvent): void;
  onToolCall?(e: ToolCallEvent): void;
  onRound?(e: RoundEvent): void;
}

export interface ToolTurnResult<A> {
  readonly answer: A | undefined;
}

export const ANSWER_TOOL_NAME = "answer";
export const ANSWER_TOOL_DESCRIPTION =
  "Submit the final answer to the user. Call it once, last, after the readings you need. " +
  "If the arguments are rejected, fix the named fields and call it again.";

export const TOOL_LOOP_LIMITS = Object.freeze({
  maxRounds: 6,
  maxCallsPerTool: Object.freeze<Record<string, number>>({ read_period: 3, travel: 1 }),
});

export const TOOL_TIMEOUT_MS = Object.freeze({ default: 2_000, max: 150_000 });

/** The system line of a turn the context budget closed. */
export const BUDGET_INSTRUCTION =
  "The context budget for this turn is used up, so no more tools can run. Answer from the facts " +
  "gathered so far and say plainly which facts you could not check.";

const SKIPPED_NOTE = "This turn already read enough; answer from the readings above.";
const PROSE_INSTRUCTION = "Write the answer as plain prose.";
const MAX_ERROR_BODY_CHARS = 500;
/** The pause before a model request that failed at the network layer is sent once more. */
export const NETWORK_RETRY_DELAY_MS = 1_000;
/** The AI SDK's own default: two retries of a transient HTTP failure inside one request. */
const SDK_MAX_RETRIES = 2;
const PROVIDER_NAME = "almamesh";

// ---------------------------------------------------------------------------
// Egress
// ---------------------------------------------------------------------------

function requestUrl(input: string | URL | Request): string {
  return input instanceof Request ? input.url : String(input);
}

/** A fetch that only reaches `baseUrl`'s origin; anything else throws before `inner` runs. */
export function guardedFetch(baseUrl: string, inner?: typeof fetch): typeof fetch {
  const allowed = new URL(baseUrl).origin;
  const guarded = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const origin = new URL(requestUrl(input)).origin;
    if (origin !== allowed) {
      throw new PrivacyViolationError(
        `Refused a request to ${origin}: only the configured AI endpoint may be contacted.`,
      );
    }
    return (inner ?? globalThis.fetch)(input, init);
  };
  return guarded as typeof fetch;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** A provider error sent inside a 200 stream (OpenRouter's mid-stream `{"error":{code,message}}`), with its code as the status. */
function streamProviderError(error: StreamProviderError): LlmRequestError {
  const message = error.message.slice(0, MAX_ERROR_BODY_CHARS);
  if (error.statusCode === undefined) return new LlmRequestError(`LLM provider error: ${message}`, { body: message });
  return new LlmRequestError(`LLM endpoint returned ${error.statusCode}: ${message}`, { status: error.statusCode, body: message });
}

/**
 * HTTP failures become the app's LlmRequestError, so the app's classifier sees the status (429
 * rate-limited, 5xx provider outage). The SDK's RetryError (the retries ran out) is unwrapped to
 * its last error first. A browser's own fetch TypeError ("Failed to fetch") is not wrapped by the
 * SDK and passes through; a status-less SDK network error says "unreachable", which the app's
 * classifier reads as an unreachable endpoint.
 */
function toAppError(raw: unknown): unknown {
  const error = RetryError.isInstance(raw) ? raw.lastError : raw;
  if (StreamProviderError.isInstance(error)) return streamProviderError(error);
  if (!APICallError.isInstance(error)) return error;
  if (error.statusCode === undefined) return new LlmRequestError(`LLM endpoint unreachable: ${error.message}`);
  const body = error.responseBody?.slice(0, MAX_ERROR_BODY_CHARS) || undefined;
  return new LlmRequestError(`LLM endpoint returned ${error.statusCode}${body ? `: ${body}` : ""}`, {
    status: error.statusCode,
    body,
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Cancels a request that has produced no answer text or tool call for `ms`. */
class ReasoningWatchdog {
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly ms: number) {}

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  arm(): void {
    this.disarm();
    this.timer = setTimeout(() => this.controller.abort(new ReasoningTimeoutError(this.ms)), this.ms);
  }

  disarm(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The string "null", or an empty or blank string: what a model sends for an unused nullable key. */
function isNullText(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const text = value.trim().toLowerCase();
  return text === "" || text === "null";
}

/** Strip nullable/optional/default wrappers to the schema that decides the shape. */
function unwrapSchema(schema: z.ZodType): z.ZodType {
  let current = schema;
  for (;;) {
    const inner = (current as { def?: { innerType?: z.ZodType } }).def?.innerType;
    if (!inner) return current;
    current = inner;
  }
}

function normalizeObject(shape: Record<string, z.ZodType>, value: Record<string, unknown>): Record<string, unknown> {
  const filled: Record<string, unknown> = { ...value };
  for (const [key, field] of Object.entries(shape)) {
    const nullable = field.safeParse(null).success;
    if (nullable && (!(key in filled) || isNullText(filled[key]))) filled[key] = null;
    else if (key in filled) filled[key] = normalizeNullables(field, filled[key]);
  }
  return filled;
}

/**
 * Normalise every level (objects, array elements, through nullable/optional/default wrappers):
 * an omitted key that accepts null becomes null, and so do the string "null" and an empty or
 * blank string (deepseek sends either for an unused argument). A key that does not accept null
 * keeps its value. Only genuinely wrong values are retries.
 */
function normalizeNullables(schema: z.ZodType, value: unknown): unknown {
  const inner = unwrapSchema(schema);
  if (inner instanceof z.ZodObject && isRecord(value)) return normalizeObject(inner.shape as Record<string, z.ZodType>, value);
  if (inner instanceof z.ZodArray && Array.isArray(value)) {
    return value.map((item) => normalizeNullables(inner.element as z.ZodType, item));
  }
  return value;
}

const wireSchemas = new WeakMap<z.ZodType, JSONSchema7>();

/** The strict (all-required) JSON schema the endpoint sees; computed once per schema. */
function wireSchema(input: z.ZodType): JSONSchema7 {
  const cached = wireSchemas.get(input);
  if (cached) return cached;
  const { $schema: _dialect, ...schema } = z.toJSONSchema(input, { target: "draft-7", unrepresentable: "any" });
  wireSchemas.set(input, schema as JSONSchema7);
  return schema as JSONSchema7;
}

/** The top-level keys whose value `prepare` changed. */
function changedKeys(before: unknown, after: unknown): string[] {
  if (!isRecord(before) || !isRecord(after) || before === after) return [];
  return Object.keys(after).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
}

/** What the answer spec's `prepare` filled in the answer call validated last (read by the tool-call part that follows). */
interface AnswerFill {
  filled: readonly string[];
}

/** Send the strict (all-required) JSON schema; validate leniently with zod, after `prepare` fills what it can. */
function lenientSchema<I>(input: z.ZodType<I>, prepare?: (value: unknown) => unknown, fill?: AnswerFill) {
  return jsonSchema<I>(wireSchema(input), {
    validate: (value) => {
      const normalized = normalizeNullables(input, value);
      const prepared = prepare ? prepare(normalized) : normalized;
      if (fill) fill.filled = changedKeys(normalized, prepared);
      const parsed = input.safeParse(prepared);
      return parsed.success
        ? { success: true, value: parsed.data }
        : { success: false, error: new Error(z.prettifyError(parsed.error)) };
    },
  });
}

function rejectOnAbort(signal: AbortSignal, reason: () => unknown): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(reason());
    signal.addEventListener("abort", () => reject(reason()), { once: true });
  });
}

async function runWithTimeout<I>(def: ToolDef<I>, input: I, parent: AbortSignal, now: Date): Promise<unknown> {
  const ms = Math.min(def.timeoutMs ?? TOOL_TIMEOUT_MS.default, TOOL_TIMEOUT_MS.max);
  const timeout = AbortSignal.timeout(ms);
  const signal = AbortSignal.any([parent, timeout]);
  const aborted = rejectOnAbort(signal, () =>
    timeout.aborted ? new Error(`${def.name} timed out after ${ms} ms`) : parent.reason,
  );
  return Promise.race([def.execute(input, { signal, now }), aborted]);
}

function isSkipped(output: unknown): boolean {
  return isRecord(output) && output.status === "skipped";
}

class CallBudget {
  private readonly used = new Map<string, number>();

  constructor(private readonly limits: Readonly<Record<string, number>>) {}

  /** Count one call; false once the tool is over its per-turn limit. */
  take(name: string): boolean {
    const used = (this.used.get(name) ?? 0) + 1;
    this.used.set(name, used);
    return used <= (this.limits[name] ?? Number.POSITIVE_INFINITY);
  }
}

// ---------------------------------------------------------------------------
// Turn context
// ---------------------------------------------------------------------------

interface TurnContext {
  readonly model: LanguageModel;
  readonly messages: ModelMessage[];
  readonly tools: ToolSet;
  readonly readTools: string[];
  readonly maxRounds: number;
  readonly signal: AbortSignal;
  /** Aborted when the turn ends for any reason, so an abandoned generator stops its request and tools. */
  readonly cancel: AbortController;
  readonly watchdog: ReasoningWatchdog;
  readonly reads: ReadProgress;
  readonly fill: AnswerFill;
  readonly providerOptions: ProviderOptions;
  readonly budget: TurnBudget;
}

/** The turn's context budget and what it needs to size each request. */
interface TurnBudget {
  readonly limit: number;
  /** Every tool's wire definition by name (`answer` included): what a request's tools cost. */
  readonly definitions: ReadonlyMap<string, unknown>;
  readonly compactors: ReadonlyMap<string, (result: unknown) => unknown>;
  /** The provider's count for an earlier request against our estimate of it. */
  calibration: TokenCalibration | undefined;
  /** The budget closed the turn: every later request is a forced answer. */
  closed: boolean;
  /**
   * Each round's plan and the provider's count for it, by 1-based round. Keyed, not
   * "the request in flight": the SDK plans round N+1 on its own schedule, which need
   * not wait for this loop to read round N's finish-step.
   */
  readonly plans: Map<number, RequestPlan>;
  readonly reported: Map<number, number>;
}

interface RequestPlan {
  /** ceil(chars / 4) before calibration: what a provider count is compared with. */
  readonly raw: number;
  readonly estimate: number;
  readonly compacted: number;
}

/** Set by the tool wrapper (SDK side, so prepareStep sees it) when a read tool call completes. */
interface ReadProgress {
  completed: boolean;
}

/** What every wrapped tool shares within one turn. */
interface ToolRuntime {
  readonly strict: boolean;
  readonly budget: CallBudget;
  readonly now: Date;
  readonly signal: AbortSignal;
  readonly reads: ReadProgress;
}

/** The SDK's providerOptions shape (not exported by name from `ai`). */
type ProviderOptions = NonNullable<Parameters<typeof streamText>[0]["providerOptions"]>;

function isOpenRouter(config: ProviderConfig): boolean {
  return config.baseUrl.startsWith(OPENROUTER_API_BASE);
}

/** Strict function calling only where it is honoured: OpenRouter's OpenAI models. */
function endpointHonoursStrict(config: ProviderConfig): boolean {
  return isOpenRouter(config) && /^~?openai\//.test(config.model);
}

/** A browser's own fetch failure: no HTTP status, no cause (Chromium, Safari, Firefox wording). */
const BROWSER_NETWORK_FAILURE = /^(Failed to fetch|Load failed|NetworkError when attempting to fetch resource\.?)$/;

function isBrowserNetworkFailure(error: unknown): boolean {
  return error instanceof TypeError && BROWSER_NETWORK_FAILURE.test(error.message);
}

/**
 * Resolves after `ms`, or rejects with the signal's reason the moment it aborts (at once when it
 * already has). Its abort listener goes when the wait ends, so a long turn's signal does not
 * collect one per retry.
 */
function pause(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Sends a model request once more after {@link NETWORK_RETRY_DELAY_MS} when the browser's fetch
 * fails with no status ("Failed to fetch"): the SDK does not retry those. An aborted request is
 * never retried: `pause` rejects at once on an aborted signal (a browser may report the abort
 * itself as "Failed to fetch"). This wraps the model's fetch only, so a tool never runs twice.
 */
function retryNetworkOnce(inner: typeof fetch): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    try {
      return await inner(input, init);
    } catch (error) {
      if (!isBrowserNetworkFailure(error)) throw error;
      await pause(NETWORK_RETRY_DELAY_MS, init?.signal);
      return inner(input, init);
    }
  }) as typeof fetch;
}

function chatModel(o: RunToolTurnOptions<unknown>): LanguageModel {
  const guarded = guardedFetch(o.config.baseUrl, o.fetchImpl);
  const checked = retryNetworkOnce(((input: string | URL | Request, init?: RequestInit) => {
    ensurePrivacy(o.config); // re-checked before every request
    return guarded(input, init);
  }) as typeof fetch);
  const provider = createOpenAICompatible({
    name: PROVIDER_NAME,
    baseURL: o.config.baseUrl,
    apiKey: o.config.apiKey,
    fetch: checked,
    includeUsage: true,
  });
  return provider.chatModel(o.config.model);
}

async function executeCounted(def: ToolDef<unknown>, input: unknown, runtime: ToolRuntime): Promise<unknown> {
  if (!runtime.budget.take(def.name)) return { status: "skipped", note: SKIPPED_NOTE };
  const result = await runWithTimeout(def, input, runtime.signal, runtime.now);
  runtime.reads.completed = true;
  return result;
}

function sdkTool(def: ToolDef<unknown>, runtime: ToolRuntime): Tool {
  return tool({
    description: def.description,
    inputSchema: lenientSchema(def.input),
    ...(runtime.strict && def.strict !== false ? { strict: true } : {}),
    // The SDK's own abortSignal for execute IS the turn signal; use it directly.
    execute: (input: unknown) => executeCounted(def, input, runtime),
  });
}

function toolSet<A>(o: RunToolTurnOptions<A>, signal: AbortSignal, reads: ReadProgress, fill: AnswerFill): ToolSet {
  const runtime: ToolRuntime = {
    strict: endpointHonoursStrict(o.config),
    budget: new CallBudget(o.limits?.maxCallsPerTool ?? TOOL_LOOP_LIMITS.maxCallsPerTool),
    now: o.now,
    signal,
    reads,
  };
  const tools: ToolSet = {};
  for (const def of o.tools) tools[def.name] = sdkTool(def, runtime);
  tools[ANSWER_TOOL_NAME] = tool({
    description: o.answer.description ?? ANSWER_TOOL_DESCRIPTION,
    inputSchema: lenientSchema(o.answer.schema, o.answer.prepare?.bind(o.answer), fill),
    ...(runtime.strict ? { strict: true } : {}),
  });
  return tools;
}

function wireDefinition(name: string, description: string, input: z.ZodType): unknown {
  return { type: "function", function: { name, description, parameters: wireSchema(input) } };
}

function turnBudget<A>(o: RunToolTurnOptions<A>): TurnBudget {
  const definitions = new Map<string, unknown>(o.tools.map((t) => [t.name, wireDefinition(t.name, t.description, t.input)]));
  definitions.set(ANSWER_TOOL_NAME, wireDefinition(ANSWER_TOOL_NAME, o.answer.description ?? ANSWER_TOOL_DESCRIPTION, o.answer.schema));
  const compactors = new Map(o.tools.flatMap((t) => (t.compact ? [[t.name, t.compact.bind(t)] as const] : [])));
  return { limit: turnTokenBudget(o.contextTokens), definitions, compactors, calibration: undefined, closed: false, plans: new Map(), reported: new Map() };
}

function turnContext<A>(o: RunToolTurnOptions<A>): TurnContext {
  const watchdog = new ReasoningWatchdog(o.reasoningTimeoutMs ?? REASONING_TIMEOUT_MS);
  const cancel = new AbortController();
  const signal = AbortSignal.any([cancel.signal, watchdog.signal, ...(o.signal ? [o.signal] : [])]);
  const reads: ReadProgress = { completed: false };
  const fill: AnswerFill = { filled: [] };
  return {
    model: chatModel(o as RunToolTurnOptions<unknown>),
    messages: o.messages.map((m) => ({ role: m.role, content: m.content })),
    tools: toolSet(o, signal, reads, fill),
    readTools: o.tools.map((t) => t.name),
    maxRounds: o.limits?.maxRounds ?? TOOL_LOOP_LIMITS.maxRounds,
    signal,
    cancel,
    watchdog,
    reads,
    fill,
    providerOptions: { [PROVIDER_NAME]: isOpenRouter(o.config) ? { reasoning: { max_tokens: CHAT_REASONING_MAX_TOKENS } } : {} },
    budget: turnBudget(o),
  };
}

/** The abort that ended the stream: the reasoning cap, or the caller's own signal. */
function abortError(ctx: TurnContext): unknown {
  const reason: unknown = ctx.signal.reason;
  return reason instanceof Error ? reason : new DOMException("The operation was aborted", "AbortError");
}

function streamOptions(ctx: TurnContext) {
  return {
    model: ctx.model,
    // A 408/409/429/5xx (or a dropped connection before the stream starts) is retried twice with
    // backoff, honouring retry-after; the app sees the last error's status if all three fail.
    maxRetries: SDK_MAX_RETRIES,
    abortSignal: ctx.signal,
    allowSystemInMessages: true, // the app's own system messages keep their place, as on the wire today
    providerOptions: ctx.providerOptions,
    onError: () => undefined, // errors arrive as stream parts and are rethrown below
  };
}


// ---------------------------------------------------------------------------
// Context budget (spec 2026-10-13, "Context budget for the agentic loop")
// ---------------------------------------------------------------------------

type WireMessage = Readonly<Record<string, unknown>>;
type StepPlan = NonNullable<PrepareStepResult<ToolSet>>;
type ToolOutput = ToolResultPart["output"];

function outputText(output: ToolOutput): string {
  if (output.type === "text" || output.type === "error-text") return output.value;
  return JSON.stringify("value" in output ? output.value : output);
}

/** A message as the OpenAI-compatible wire carries it, for estimating only. */
function wireOf(message: ModelMessage): WireMessage[] {
  if (typeof message.content === "string") return [{ role: message.role, content: message.content }];
  if (message.role === "tool") {
    return message.content.flatMap((part) => (part.type === "tool-result" ? [{ role: "tool", tool_call_id: part.toolCallId, content: outputText(part.output) }] : []));
  }
  const text = message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
  const calls = message.content.flatMap((part) =>
    part.type === "tool-call" ? [{ id: part.toolCallId, type: "function", function: { name: part.toolName, arguments: JSON.stringify(part.input) } }] : [],
  );
  return [{ role: message.role, content: text, ...(calls.length > 0 ? { tool_calls: calls } : {}) }];
}

function isCompacted(part: ToolResultPart): boolean {
  return part.output.type === "json" && isRecord(part.output.value) && part.output.value.compacted === true;
}

function resultParts(messages: readonly ModelMessage[]): ToolResultPart[] {
  return messages.flatMap((m) => (m.role === "tool" ? m.content.filter((p): p is ToolResultPart => p.type === "tool-result") : []));
}

function planOf(budget: TurnBudget, messages: readonly ModelMessage[], tools: readonly string[]): RequestPlan {
  const raw = estimateRequestTokens(messages.flatMap(wireOf), tools.map((name) => budget.definitions.get(name)));
  return { raw, estimate: calibratedEstimate(raw, budget.calibration), compacted: resultParts(messages).filter(isCompacted).length };
}

/** The newest full result of each tool: the one a lean request still carries whole. */
function newestPerTool(messages: readonly ModelMessage[]): Set<ToolResultPart> {
  const kept = new Map<string, ToolResultPart>();
  for (const part of resultParts(messages)) {
    if (part.output.type === "json" && !isCompacted(part) && !isSkipped(part.output.value)) kept.set(part.toolName, part);
  }
  return new Set(kept.values());
}

function compactPart(budget: TurnBudget, part: ToolResultPart, keep: ReadonlySet<ToolResultPart>): ToolResultPart {
  if (keep.has(part) || part.output.type !== "json" || isCompacted(part)) return part;
  const compact = compactToolResult(part.output.value, budget.compactors.get(part.toolName));
  if (JSON.stringify(compact).length >= JSON.stringify(part.output.value).length) return part;
  return { ...part, output: { type: "json", value: compact as JSONValue } };
}

/** Tool results in their compact form; with `keepNewest`, each tool's newest full result stays whole. */
function compactMessages(budget: TurnBudget, messages: readonly ModelMessage[], keepNewest: boolean): ModelMessage[] {
  const keep = keepNewest ? newestPerTool(messages) : new Set<ToolResultPart>();
  return messages.map((m) =>
    m.role === "tool" ? { ...m, content: m.content.map((p) => (p.type === "tool-result" ? compactPart(budget, p, keep) : p)) } : m,
  );
}

function withBudgetNote(messages: readonly ModelMessage[]): ModelMessage[] {
  const noted = messages.some((m) => m.role === "system" && m.content === BUDGET_INSTRUCTION);
  return noted ? [...messages] : [...messages, { role: "system", content: BUDGET_INSTRUCTION }];
}

function send(budget: TurnBudget, round: number, plan: RequestPlan, step: StepPlan): StepPlan {
  budget.plans.set(round, plan);
  return step;
}

/** The budget closed the turn: answer now, with only the answer tool; the newest results go compact only if they must. */
function forcedAnswer(budget: TurnBudget, round: number, messages: readonly ModelMessage[]): StepPlan {
  const force = { toolChoice: { type: "tool", toolName: ANSWER_TOOL_NAME }, activeTools: [ANSWER_TOOL_NAME] } as const;
  const noted = withBudgetNote(messages);
  const lean = compactMessages(budget, noted, true);
  const plan = planOf(budget, lean, [ANSWER_TOOL_NAME]);
  if (plan.estimate <= budget.limit) return send(budget, round, plan, { ...force, messages: lean });
  const leanest = compactMessages(budget, noted, false);
  return send(budget, round, planOf(budget, leanest, [ANSWER_TOOL_NAME]), { ...force, messages: leanest });
}

/**
 * Fit the next request to the budget: as it is; else with older results compact;
 * else close the turn with a forced answer. A read-first round still reads (its
 * prompt alone may be over); the system prompt and the question are never cut.
 */
function fitStep(ctx: TurnContext, round: number, messages: readonly ModelMessage[], choice: StepPlan, readFirst: boolean): StepPlan {
  const { budget } = ctx;
  if (budget.closed) return forcedAnswer(budget, round, messages);
  const tools = (choice.activeTools as readonly string[] | undefined) ?? [...budget.definitions.keys()];
  const full = planOf(budget, messages, tools);
  if (full.estimate <= budget.limit) return send(budget, round, full, choice);
  const older = compactMessages(budget, messages, true);
  const lean = planOf(budget, older, tools);
  if (lean.estimate <= budget.limit || mustReadFirst(ctx, readFirst)) return send(budget, round, lean, { ...choice, messages: older });
  budget.closed = true;
  return forcedAnswer(budget, round, messages);
}

/** Calibrate later estimates by the provider's count for `round`, paired with that round's own plan. */
function calibrate(budget: TurnBudget, round: number, inputTokens: number | undefined): void {
  const plan = budget.plans.get(round);
  if (inputTokens !== undefined && plan !== undefined && plan.raw > 0) budget.calibration = { estimate: plan.raw, reported: inputTokens };
}

/** Plan round `round`, calibrated first by the round before it (the SDK's step, else what this loop recorded). */
function planRound(ctx: TurnContext, round: number, previousInput: number | undefined, messages: readonly ModelMessage[], choice: StepPlan, readFirst: boolean): StepPlan {
  calibrate(ctx.budget, round - 1, previousInput ?? ctx.budget.reported.get(round - 1));
  return fitStep(ctx, round, messages, choice, readFirst);
}

/** A finished round's budget fields, from its own plan. */
function roundBudget(budget: TurnBudget, round: number, inputTokens: number | undefined): Pick<RoundEvent, "estimate" | "estimated" | "budget" | "compacted"> {
  if (inputTokens !== undefined) budget.reported.set(round, inputTokens);
  const plan = budget.plans.get(round) ?? { raw: 0, estimate: 0, compacted: 0 };
  return { estimate: plan.estimate, estimated: inputTokens === undefined, budget: budget.limit, compacted: plan.compacted };
}

// ---------------------------------------------------------------------------
// The tool rounds
// ---------------------------------------------------------------------------

const EMPTY_COMPLETION = "LLM endpoint returned an empty agent completion";

/** `hasToolCall('answer')` also matches an invalid call; only a valid answer ends the turn. */
const validAnswer: StopCondition<ToolSet> = ({ steps }) =>
  steps.at(-1)?.toolCalls.some((c) => c.toolName === ANSWER_TOOL_NAME && !("invalid" in c && c.invalid)) === true;

/** readFirst turns keep `answer` hidden until a read tool call has completed. */
function mustReadFirst(ctx: TurnContext, readFirst: boolean): boolean {
  return readFirst && !ctx.reads.completed && ctx.readTools.length > 0;
}

/** Tool choice for a 1-based round of the whole turn; the last round always forces the answer. */
function roundChoice(round: number, ctx: TurnContext, readFirst: boolean): StepPlan {
  if (round >= ctx.maxRounds) return { toolChoice: { type: "tool", toolName: ANSWER_TOOL_NAME } };
  if (mustReadFirst(ctx, readFirst)) return { toolChoice: "required", activeTools: ctx.readTools };
  return { toolChoice: "required" };
}

/** "a", "a or b", "a, b or c". */
function orList(names: readonly string[]): string {
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;
}

/** Sent after a step with no tool call (e.g. deepseek writing its tool call as DSML text). */
function correctiveInstruction(ctx: TurnContext, readFirst: boolean): string {
  const textRule = "Do not write tool calls as text.";
  if (ctx.readTools.length === 0) return `Call the answer tool to finish. ${textRule}`;
  const read = `Call a tool: use ${orList(ctx.readTools)} to read`;
  return mustReadFirst(ctx, readFirst) ? `${read}. ${textRule}` : `${read}, or answer to finish. ${textRule}`;
}

interface TurnState {
  round: number;
  finishedRounds: number;
  callNumber: number;
  /** Tool calls (valid or not) in the current step. */
  stepCalls: number;
  /** The current step wrote text instead of the required tool call. */
  stepWroteText: boolean;
  yielded: boolean;
  answering: boolean;
  answerInput: unknown;
  lastSnapshot: string | undefined;
  readonly firstTry: Set<string>;
  readonly invalidIds: Set<string>;
  readonly invalidNames: Set<string>;
  readonly answerDrafts: Map<string, string>;
}

function newState(): TurnState {
  return {
    round: 0,
    finishedRounds: 0,
    callNumber: 0,
    stepCalls: 0,
    stepWroteText: false,
    yielded: false,
    answering: false,
    answerInput: undefined,
    lastSnapshot: undefined,
    firstTry: new Set(),
    invalidIds: new Set(),
    invalidNames: new Set(),
    answerDrafts: new Map(),
  };
}

type Part = TextStreamPart<ToolSet>;
type PartOf<T extends Part["type"]> = Extract<Part, { type: T }>;

interface CallPart {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
}

/** The error a failure part stands for, or undefined for any other part. */
function failure(part: Part, ctx: TurnContext): unknown {
  if (part.type === "abort") return abortError(ctx);
  if (part.type === "error") return ctx.signal.aborted ? abortError(ctx) : toAppError(part.error);
  return undefined;
}

/**
 * A step that answered in text under `required` (deepseek writing its tool
 * call as DSML text). The SDK reports it as an error part, then finishes the
 * step normally; the turn treats it as a step with no tool call.
 */
function isTextInsteadOfTool(part: Part): boolean {
  return part.type === "error" && ToolChoiceViolationError.isInstance(part.error);
}

function startAnswering<A>(o: RunToolTurnOptions<A>, state: TurnState): void {
  if (state.answering) return;
  state.answering = true;
  o.onStatus?.({ phase: "answering" });
}

function emitCall<A>(o: RunToolTurnOptions<A>, state: TurnState, part: CallPart, result: unknown, status: ToolCallStatus, filled?: readonly string[]): void {
  o.onToolCall?.({
    round: state.round,
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    args: part.input,
    result,
    status,
    validFirstTry: state.firstTry.has(part.toolCallId),
    ...(filled ? { filled } : {}),
  });
}

function labelFor<A>(o: RunToolTurnOptions<A>, name: string): string {
  return o.tools.find((t) => t.name === name)?.statusLabel ?? `Using ${name}`;
}

function onToolCall<A>(part: PartOf<"tool-call">, o: RunToolTurnOptions<A>, ctx: TurnContext, state: TurnState): void {
  const invalid = "invalid" in part && part.invalid === true;
  state.stepCalls += 1;
  if (!invalid && !state.invalidNames.has(part.toolName)) state.firstTry.add(part.toolCallId);
  if (invalid) {
    state.invalidIds.add(part.toolCallId);
    state.invalidNames.add(part.toolName);
  } else if (part.toolName === ANSWER_TOOL_NAME) {
    state.answerInput ??= part.input;
    // The SDK validates a call, then emits its tool-call part: the last fill is this call's.
    emitCall(o, state, part, undefined, "complete", ctx.fill.filled);
  } else {
    state.callNumber += 1;
    o.onStatus?.({ phase: "using_tool", round: state.round, toolName: part.toolName, label: labelFor(o, part.toolName), callNumber: state.callNumber });
  }
}

async function answerSnapshot<A>(part: PartOf<"tool-input-delta">, o: RunToolTurnOptions<A>, state: TurnState): Promise<string | undefined> {
  const draft = state.answerDrafts.get(part.id);
  if (draft === undefined) return undefined;
  const text = draft + part.delta;
  state.answerDrafts.set(part.id, text);
  const { value } = await parsePartialJson(text);
  if (!isRecord(value)) return undefined;
  const snapshot = o.answer.render(value as Partial<A>, false);
  if (snapshot === state.lastSnapshot) return undefined;
  state.lastSnapshot = snapshot;
  return snapshot;
}

function onToolInputStart<A>(part: PartOf<"tool-input-start">, o: RunToolTurnOptions<A>, state: TurnState): void {
  if (part.toolName !== ANSWER_TOOL_NAME) return;
  state.answerDrafts.set(part.id, "");
  startAnswering(o, state);
}

function onStartStep<A>(o: RunToolTurnOptions<A>, state: TurnState): void {
  state.round += 1;
  state.stepCalls = 0;
  state.stepWroteText = false;
  o.onStatus?.({ phase: "deciding", round: state.round });
}

function onFinishStep<A>(part: PartOf<"finish-step">, o: RunToolTurnOptions<A>, ctx: TurnContext, state: TurnState): void {
  state.finishedRounds += 1;
  const finishReason = state.stepWroteText ? "text_instead_of_tool" : part.finishReason;
  const usage = roundBudget(ctx.budget, state.round, part.usage.inputTokens);
  o.onRound?.({ round: state.round, inputTokens: part.usage.inputTokens, outputTokens: part.usage.outputTokens, finishReason, ...usage });
  ctx.watchdog.arm(); // the next request starts now
}

/**
 * Handle one stream part; returns an answer snapshot to yield, if any. Model
 * free text is never yielded while tools are active: under `required` it is
 * an ungrounded answer or a tool call written as text.
 */
async function onPart<A>(part: Part, o: RunToolTurnOptions<A>, ctx: TurnContext, state: TurnState): Promise<string | undefined> {
  switch (part.type) {
    case "start-step":
      onStartStep(o, state);
      return undefined;
    case "text-delta":
      ctx.watchdog.disarm();
      return undefined;
    case "tool-input-start":
      ctx.watchdog.disarm();
      onToolInputStart(part, o, state);
      return undefined;
    case "tool-input-delta":
      ctx.watchdog.disarm();
      return answerSnapshot(part, o, state);
    case "tool-call":
      ctx.watchdog.disarm();
      onToolCall(part, o, ctx, state);
      return undefined;
    case "tool-error":
      emitCall(o, state, part, errorText(part.error), state.invalidIds.has(part.toolCallId) ? "retried" : "error");
      return undefined;
    case "tool-result":
      emitCall(o, state, part, part.output, isSkipped(part.output) ? "skipped" : "complete");
      return undefined;
    case "finish-step":
      onFinishStep(part, o, ctx, state);
      return undefined;
    default:
      return undefined;
  }
}

/** One SDK tool loop over `messages`, numbered on from the rounds already run; returns its response messages. */
async function* streamRounds<A>(o: RunToolTurnOptions<A>, ctx: TurnContext, state: TurnState, messages: ModelMessage[]): AsyncGenerator<string, ModelMessage[]> {
  const offset = state.finishedRounds;
  const result = streamText({
    ...streamOptions(ctx),
    messages,
    tools: ctx.tools,
    stopWhen: [validAnswer, stepCountIs(ctx.maxRounds - offset)],
    prepareStep: ({ stepNumber, steps, messages: step }) => {
      const round = offset + stepNumber + 1;
      return planRound(ctx, round, steps.at(-1)?.usage.inputTokens, step, roundChoice(round, ctx, o.readFirst), o.readFirst);
    },
  });
  ctx.watchdog.arm();
  for await (const part of result.fullStream) {
    if (isTextInsteadOfTool(part)) {
      state.stepWroteText = true;
      continue;
    }
    const failed = failure(part, ctx);
    if (failed !== undefined) throw failed;
    const snapshot = await onPart(part, o, ctx, state);
    if (snapshot === undefined) continue;
    state.yielded = true;
    yield snapshot;
  }
  return state.answerInput === undefined ? (await result.response).messages : [];
}

/** A step ended with no tool call, no answer yet, and rounds remain: ask again. */
function needsCorrection(ctx: TurnContext, state: TurnState): boolean {
  return state.answerInput === undefined && state.stepCalls === 0 && state.finishedRounds < ctx.maxRounds;
}

/**
 * All tool rounds of the turn. The SDK loop ends on a step without a tool
 * call; when that step was text (a tool call written as text), the turn goes
 * on with one corrective message, counting toward maxRounds. The common path
 * (read, then answer) stays two requests. Returns the history after the
 * caller's messages.
 */
async function* runRounds<A>(o: RunToolTurnOptions<A>, ctx: TurnContext, state: TurnState): AsyncGenerator<string, ModelMessage[]> {
  const history = [...(yield* streamRounds(o, ctx, state, ctx.messages))];
  while (needsCorrection(ctx, state)) {
    const before = state.finishedRounds;
    history.push({ role: "system", content: correctiveInstruction(ctx, o.readFirst) });
    history.push(...(yield* streamRounds(o, ctx, state, [...ctx.messages, ...history])));
    if (state.finishedRounds === before) break; // no progress: never spin
  }
  return history;
}

// ---------------------------------------------------------------------------
// Prose paths: the no-answer fallback and the tools-unavailable degrade
// ---------------------------------------------------------------------------

/** Tool calls some models write as text (deepseek DSML, `<tool_call>` tags), closed or still streaming. */
const TOOL_MARKUP: readonly RegExp[] = [
  /<｜DSML｜(\w+)[^>]*>[\s\S]*?(?:<\/｜DSML｜\1>|$)/g,
  /<\/?｜DSML｜[^>]*>/g,
  /<tool_call>[\s\S]*?(?:<\/tool_call>|$)/g,
];

/** A tag still arriving at the end of the stream; held back until it completes. */
const PARTIAL_TAG = /<[^<>]*$/;

function visibleProse(text: string, final: boolean): string {
  const clean = TOOL_MARKUP.reduce((stripped, pattern) => stripped.replace(pattern, ""), text);
  return final ? clean : clean.replace(PARTIAL_TAG, "");
}

interface ProseRequest {
  readonly messages: ModelMessage[];
  readonly tools?: ToolSet;
}

/** Stream plain text as snapshots, tool markup stripped; nothing meaningful left is an error. */
async function* proseSnapshots(ctx: TurnContext, prefix: string, request: ProseRequest): AsyncGenerator<string, PartOf<"finish-step"> | undefined> {
  const result = streamText({
    ...streamOptions(ctx),
    messages: request.messages,
    ...(request.tools ? { tools: request.tools, toolChoice: "none" as const } : {}),
  });
  ctx.watchdog.arm();
  let text = "";
  let shown = "";
  let finished: PartOf<"finish-step"> | undefined;
  for await (const part of result.fullStream) {
    const failed = failure(part, ctx);
    if (failed !== undefined) throw failed;
    if (part.type === "finish-step") finished = part;
    if (part.type !== "text-delta") continue;
    ctx.watchdog.disarm();
    text += part.text;
    const clean = visibleProse(text, false);
    if (clean === shown) continue;
    shown = clean;
    yield prefix + clean;
  }
  const final = visibleProse(text, true);
  if (!final.trim()) throw new LlmRequestError(EMPTY_COMPLETION);
  if (final !== shown) yield prefix + final;
  return finished;
}

async function* proseFallback<A>(o: RunToolTurnOptions<A>, ctx: TurnContext, state: TurnState, history: ModelMessage[]): AsyncGenerator<string, ToolTurnResult<A>> {
  startAnswering(o, state);
  const messages: ModelMessage[] = [...ctx.messages, ...history, { role: "system", content: PROSE_INSTRUCTION }];
  const round = state.round + 1;
  calibrate(ctx.budget, state.round, ctx.budget.reported.get(state.round));
  ctx.budget.plans.set(round, planOf(ctx.budget, messages, [...ctx.budget.definitions.keys()]));
  const finished = yield* proseSnapshots(ctx, "", { messages, tools: ctx.tools });
  const usage = roundBudget(ctx.budget, round, finished?.usage.inputTokens);
  o.onRound?.({ round, inputTokens: finished?.usage.inputTokens, outputTokens: finished?.usage.outputTokens, finishReason: "answer_fallback", ...usage });
  o.onStatus?.({ phase: "complete" });
  return { answer: undefined };
}

async function* toolsUnavailable<A>(o: RunToolTurnOptions<A>, ctx: TurnContext): AsyncGenerator<string, ToolTurnResult<A>> {
  o.onStatus?.({ phase: "answering" });
  yield TOOLS_UNAVAILABLE_NOTICE;
  yield* proseSnapshots(ctx, TOOLS_UNAVAILABLE_NOTICE, {
    messages: [{ role: "system", content: TOOLS_UNAVAILABLE_INSTRUCTION }, ...ctx.messages],
  });
  o.onStatus?.({ phase: "complete" });
  return { answer: undefined };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Yields full markdown snapshots of the answer as it streams; the last one is the validated answer. */
export async function* runToolTurn<A>(o: RunToolTurnOptions<A>): AsyncGenerator<string, ToolTurnResult<A>> {
  ensurePrivacy(o.config);
  const ctx = turnContext(o);
  const state = newState();
  try {
    let history: ModelMessage[];
    try {
      history = yield* runRounds(o, ctx, state);
    } catch (error) {
      if (state.finishedRounds > 0 || state.yielded || !explicitlyRejectsTools(error)) throw error;
      return yield* toolsUnavailable(o, ctx);
    }
    if (state.answerInput === undefined) return yield* proseFallback(o, ctx, state, history);
    // Already validated (and transformed) by the SDK through the answer schema; parsing
    // it again would break a transform whose output is not valid input.
    const answer = state.answerInput as A;
    yield o.answer.render(answer, true);
    o.onStatus?.({ phase: "complete" });
    return { answer };
  } finally {
    ctx.watchdog.disarm();
    ctx.cancel.abort(); // an early return() must not leave the request or a tool running
  }
}
