// OpenAI-compatible streaming chat client for in-browser narration.
//
// Talks to ANY OpenAI-compatible `/chat/completions` endpoint (local Ollama,
// llama.cpp, LM Studio, or — opt-in — OpenRouter) via `fetch` + SSE, yielding
// token deltas as they arrive. The privacy contract from `config.ts` is enforced
// BEFORE the request is built: a `local_only` config that does not resolve to a
// loopback/private endpoint throws `PrivacyViolationError` and nothing leaves
// the device.

import { ensurePrivacy, OPENROUTER_API_BASE, type ProviderConfig } from "./config";
import { type ModelPricing, parseModelPricing } from "./pricing";

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface StreamChatOptions {
  readonly config: ProviderConfig;
  readonly messages: readonly ChatMessage[];
  /** Abort the in-flight stream (wired to the UI cancel button). */
  readonly signal?: AbortSignal;
  /** Optional fetch override for testing; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

/** Raised when the endpoint is unreachable or returns a non-2xx status. */
export class LlmRequestError extends Error {
  /** HTTP status of the failed response, when one was received. */
  public readonly status?: number;
  /** Truncated response body, surfaced so failures are diagnosable. */
  public readonly body?: string;

  constructor(message: string, opts?: { status?: number; body?: string }) {
    super(message);
    this.name = "LlmRequestError";
    this.status = opts?.status;
    this.body = opts?.body;
  }
}

/** Cap surfaced response bodies so a huge error page can't flood logs/UI. */
const MAX_ERROR_BODY_CHARS = 500;

/**
 * Read and truncate a failed response's body so the message is diagnosable
 * (e.g. OpenRouter's "No endpoints found for x/y"). Tolerant of a body-read
 * failure: returns `undefined` rather than masking the original HTTP error.
 */
async function readErrorBody(response: Response): Promise<string | undefined> {
  try {
    const text = await response.text();
    return text.slice(0, MAX_ERROR_BODY_CHARS);
  } catch {
    return undefined;
  }
}

/** Build a diagnosable LlmRequestError for a non-2xx response. */
export async function requestErrorFor(response: Response): Promise<LlmRequestError> {
  const body = await readErrorBody(response);
  const suffix = body ? `: ${body}` : "";
  return new LlmRequestError(
    `LLM endpoint returned ${response.status} ${response.statusText}${suffix}`,
    { status: response.status, body },
  );
}

interface OpenAiDelta {
  readonly choices?: ReadonlyArray<{ readonly delta?: { readonly content?: string } }>;
}

interface InBandError {
  readonly code?: unknown;
  readonly message?: unknown;
}

interface OpenAiMessage {
  readonly error?: InBandError;
  readonly choices?: ReadonlyArray<{
    readonly finish_reason?: string | null;
    readonly error?: InBandError;
    readonly message?: { readonly content?: string };
  }>;
}

/** HTTP status for an in-band failure: its numeric code when it is one, else 502. */
function inBandStatus(code: unknown): number {
  return typeof code === "number" && code >= 400 && code <= 599 ? code : 502;
}

/**
 * OpenRouter answers HTTP 200 even when the upstream provider dies part-way
 * through a long non-streaming completion: the failure is in the body
 * (`finish_reason: "error"`, often no content, sometimes an `error` object).
 * Turn that into a status-carrying `LlmRequestError` so callers can classify
 * it as a provider failure and retry, instead of an anonymous empty answer.
 */
function inBandFailure(payload: OpenAiMessage): LlmRequestError | undefined {
  const choice = payload.choices?.[0];
  const error = payload.error ?? choice?.error;
  if (error === undefined && choice?.finish_reason !== "error") return undefined;
  const detail = typeof error?.message === "string" ? `: ${error.message}` : "";
  return new LlmRequestError(`LLM provider failed mid-generation${detail}`, {
    status: inBandStatus(error?.code),
  });
}

function buildRequestBody(options: StreamChatOptions): string {
  return JSON.stringify({
    model: options.config.model,
    messages: options.messages,
    stream: true,
  });
}

/** Options for a single non-streaming JSON-object chat completion. */
export interface ChatCompletionJsonOptions {
  readonly config: ProviderConfig;
  readonly messages: readonly ChatMessage[];
  readonly signal?: AbortSignal;
  /** Optional fetch override for testing; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /**
   * Reasoning budget sent as OpenRouter's `reasoning.max_tokens` (OpenRouter
   * endpoints only; see reasoning.ts). Unset: the model's own default.
   */
  readonly reasoningMaxTokens?: number;
  /**
   * Ask OpenRouter for the cheapest provider ({@link REPORT_PROVIDER_ROUTING}).
   * OpenRouter endpoints only; ignored elsewhere.
   */
  readonly cheapestProvider?: boolean;
}

/**
 * Preferred minimum median (p50) throughput, tokens/s, for report sections.
 * From OpenRouter's endpoint stats on 2026-10-10 (last 30 min): the slow tier
 * to avoid, OpenInference on deepseek-v4.1-flash, ran p50 17 tok/s (report
 * sections took 80-300+ s); the cheap tier to keep, StreamLake and Baidu on
 * deepseek-v4-pro, ran p50 36 and 42. 25 is about the geometric mean of 17
 * and 36, roughly 1.45x clear of each.
 */
export const REPORT_MIN_THROUGHPUT_P50 = 25;

/**
 * OpenRouter provider preference for report sections. `sort: "price"` tries
 * the cheapest provider first instead of OpenRouter's default price-weighted
 * load balancing, which sometimes picked an upstream billing 4-5x the catalog
 * price. `preferred_min_throughput` moves providers below the floor to the end
 * of that list; per the docs it never blocks a request. Fallbacks stay allowed
 * (OpenRouter's default): a failed reading costs more than a pricier fallback.
 * https://openrouter.ai/docs/guides/routing/provider-selection#performance-thresholds
 */
export const REPORT_PROVIDER_ROUTING = {
  sort: "price",
  preferred_min_throughput: { p50: REPORT_MIN_THROUGHPUT_P50 },
} as const;

function isOpenRouter(config: ProviderConfig): boolean {
  return config.baseUrl?.startsWith(OPENROUTER_API_BASE) === true;
}

/**
 * The `reasoning` request field for a budget, OpenRouter only (a strict
 * OpenAI-compatible server may reject an unknown field). Lives here, not in
 * reasoning.ts, so client.ts has no import cycle.
 */
export function reasoningField(
  config: ProviderConfig,
  maxTokens: number | undefined,
): { readonly reasoning?: { readonly max_tokens: number } } {
  if (maxTokens === undefined || !isOpenRouter(config)) return {};
  return { reasoning: { max_tokens: maxTokens } };
}

/** The `provider` request field, OpenRouter only (same reason as `reasoningField`). */
export function providerField(
  config: ProviderConfig,
  cheapest: boolean | undefined,
): { readonly provider?: typeof REPORT_PROVIDER_ROUTING } {
  if (cheapest !== true || !isOpenRouter(config)) return {};
  return { provider: REPORT_PROVIDER_ROUTING };
}

/** Strip a ```json … ``` (or plain ```) fence some models wrap JSON in. */
export function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenced ? fenced[1].trim() : trimmed;
}

/**
 * Run ONE non-streaming OpenAI-compatible chat completion that requests a JSON
 * object (`response_format: { type: "json_object" }`) and return the raw message
 * content string. Enforces the same fail-closed privacy gate as the streaming
 * path. Tolerant of ```json fences in the returned content (stripped here).
 */
export async function chatCompletionJson(
  options: ChatCompletionJsonOptions,
): Promise<string> {
  ensurePrivacy(options.config);

  const doFetch = options.fetchImpl ?? fetch;
  const response = await doFetch(joinUrl(requireBaseUrl(options.config)), {
    method: "POST",
    headers: buildHeaders(options.config),
    body: JSON.stringify({
      model: options.config.model,
      messages: options.messages,
      stream: false,
      response_format: { type: "json_object" },
      ...reasoningField(options.config, options.reasoningMaxTokens),
      ...providerField(options.config, options.cheapestProvider),
    }),
    signal: options.signal,
  });
  if (!response.ok) {
    throw await requestErrorFor(response);
  }
  return completionJsonContent(await response.json());
}

/**
 * The fence-stripped content of one non-streaming completion body, or the
 * typed failure it reports in-band (#192). Shared with the streamed variant
 * for endpoints that ignore `stream: true`.
 */
export function completionJsonContent(body: unknown): string {
  const payload = body as OpenAiMessage;
  const failure = inBandFailure(payload);
  if (failure) throw failure;
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim() === "") {
    throw new LlmRequestError("LLM endpoint returned an empty completion");
  }
  return stripJsonFence(content);
}

/** Options for a save-time connectivity probe. */
export interface TestConnectionOptions {
  readonly config: ProviderConfig;
  readonly signal?: AbortSignal;
  /** Optional fetch override for testing; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Probe a provider with a single non-streaming chat completion that MIRRORS the
 * exact request the real interpretation reading makes (`chatCompletionJson`):
 * same endpoint, same auth, same model, same `response_format: { type:
 * "json_object" }` JSON-mode flag. Validates endpoint reachability + auth +
 * model id + JSON-mode support in one shot, on the EXACT path the reading uses —
 * so a model/endpoint that can't do JSON mode fails HERE, at save time, instead
 * of failing every real reading afterwards. Resolves on 2xx; otherwise throws
 * the SAME typed errors the reading would hit, so the settings UI can give an
 * honest, specific verdict the moment the user saves:
 *   - `PrivacyViolationError` — the fail-closed gate (local_only vs a cloud host).
 *   - `LlmRequestError` (carrying `.status`) — a non-2xx response (401/403 bad
 *     key, 402 out of credits, 404/400 bad model, …).
 *   - a `fetch` `TypeError` — the endpoint was unreachable (DNS, refused, offline).
 *
 * Chosen over `GET /models`: OpenRouter serves that unauthenticated and never
 * validates the model, so a bad key or typo'd slug would falsely pass.
 *
 * NOTE: OpenAI's `json_object` mode returns 400 unless the request's messages
 * contain the word "json" somewhere — the probe message is worded to satisfy
 * that requirement (mirroring how the real reading's prompts are worded).
 */
export async function testProviderConnection(options: TestConnectionOptions): Promise<void> {
  // Fail-closed BEFORE any network call — same contract as the streaming path.
  ensurePrivacy(options.config);

  const doFetch = options.fetchImpl ?? fetch;
  const response = await doFetch(joinUrl(requireBaseUrl(options.config)), {
    method: "POST",
    headers: buildHeaders(options.config),
    // NO `max_tokens`: the real reading never caps output, and a cap of 1 is
    // BELOW the minimum-output floor that OpenAI reasoning / GPT-5-family models
    // enforce (>= 16) — so a `max_tokens: 1` probe 400s on a perfectly valid
    // model (e.g. openai/gpt-5.6-sol) while the actual reading would succeed. The
    // probe must never be stricter than the request it stands in for.
    body: JSON.stringify({
      model: options.config.model,
      messages: [{ role: "user", content: 'Reply with a compact JSON object like {"ok":true}.' }],
      stream: false,
      response_format: { type: "json_object" },
    }),
    signal: options.signal,
  });
  if (!response.ok) {
    throw await requestErrorFor(response);
  }
}

/** The account balance OpenRouter reports (USD credits, not a token count). */
export interface OpenRouterCredits {
  /** Total credits ever granted/purchased on the account, in USD. */
  readonly totalCredits: number;
  /** Total credits spent to date, in USD. */
  readonly totalUsage: number;
  /** `totalCredits − totalUsage` — the spendable balance, in USD. */
  readonly remaining: number;
}

interface OpenRouterCreditsResponse {
  readonly data?: {
    readonly total_credits?: number;
    readonly total_usage?: number;
  };
}

/** Options for reading the OpenRouter account balance. */
export interface FetchCreditsOptions {
  readonly config: ProviderConfig;
  readonly signal?: AbortSignal;
  /** Optional fetch override for testing; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Read the OpenRouter account balance via `GET {baseUrl}/credits` (authenticated
 * with the same Bearer key the reading uses). Returns USD credits — OpenRouter
 * does NOT expose a token count — as `{ totalCredits, totalUsage, remaining }`.
 *
 * OpenRouter-ONLY by contract, enforced fail-closed HERE (not just by the caller):
 * the endpoint MUST be OpenRouter's — a key is never sent to a local/loopback or
 * a bring-your-own host, mirroring the `ensurePrivacy` gate in
 * `testProviderConnection`. On a non-2xx (401 bad key, 402 no credits) it throws
 * the same typed `LlmRequestError` the reading path uses, so the UI can classify
 * the failure with `classifyConnectionError`.
 */
export async function fetchOpenRouterCredits(
  options: FetchCreditsOptions,
): Promise<OpenRouterCredits> {
  const baseUrl = requireBaseUrl(options.config);
  // Fail-closed: this is an OpenRouter-account read; refuse to send the key
  // anywhere else even if a caller forgot to gate. Defense-in-depth for the
  // "no key to loopback/BYO" invariant.
  if (!baseUrl.startsWith(OPENROUTER_API_BASE)) {
    throw new LlmRequestError(
      `Credits are only available for OpenRouter (endpoint was ${baseUrl})`,
    );
  }
  const doFetch = options.fetchImpl ?? fetch;
  const response = await doFetch(creditsUrl(baseUrl), {
    method: "GET",
    headers: buildHeaders(options.config),
    signal: options.signal,
  });
  if (!response.ok) {
    throw await requestErrorFor(response);
  }
  let payload: OpenRouterCreditsResponse;
  try {
    payload = (await response.json()) as OpenRouterCreditsResponse;
  } catch {
    // A 2xx with a non-JSON body still breaks the contract — surface it as the
    // typed error the docstring promises, not a raw SyntaxError.
    throw new LlmRequestError("OpenRouter credits response was not valid JSON");
  }
  const totalCredits = payload.data?.total_credits;
  const totalUsage = payload.data?.total_usage;
  if (typeof totalCredits !== "number" || typeof totalUsage !== "number") {
    throw new LlmRequestError("OpenRouter credits response was malformed");
  }
  return { totalCredits, totalUsage, remaining: totalCredits - totalUsage };
}

/** One model offered by the OpenRouter catalog (its `/models` list). */
export interface OpenRouterModel {
  /** The slug used verbatim as the `model` in a completion request. */
  readonly id: string;
  /** Human-friendly display name; falls back to `id` when the catalog omits it. */
  readonly name: string;
  /** Per-token USD price from the catalog; absent when missing or unparseable. */
  readonly pricing?: ModelPricing;
}

interface OpenRouterModelsResponse {
  readonly data?: ReadonlyArray<{
    readonly id?: unknown;
    readonly name?: unknown;
    readonly pricing?: unknown;
  }>;
}

/** Options for reading the OpenRouter model catalog. */
export interface FetchModelsOptions {
  readonly config: ProviderConfig;
  readonly signal?: AbortSignal;
  /** Optional fetch override for testing; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Read OpenRouter's model catalog via `GET {baseUrl}/models`, mapped to a sorted
 * `{ id, name }[]` for a searchable model picker. Populating the picker from the
 * LIVE catalog means a user can never save a slug that isn't a real model — the
 * dead-end that "That model isn't available" was warning about.
 *
 * OpenRouter-ONLY by contract, enforced fail-closed HERE (not just by the caller):
 * the endpoint MUST be OpenRouter's, so the Bearer key is never sent to a
 * local/loopback or a bring-your-own host — mirroring {@link fetchOpenRouterCredits}.
 * A non-2xx (401 bad key) throws the same typed `LlmRequestError` the reading path
 * uses, so the UI can classify it with `classifyConnectionError` and degrade to
 * plain free-text entry rather than a hard failure.
 */
export async function fetchOpenRouterModels(
  options: FetchModelsOptions,
): Promise<OpenRouterModel[]> {
  const baseUrl = requireBaseUrl(options.config);
  if (!baseUrl.startsWith(OPENROUTER_API_BASE)) {
    throw new LlmRequestError(
      `Models are only available for OpenRouter (endpoint was ${baseUrl})`,
    );
  }
  const doFetch = options.fetchImpl ?? fetch;
  const response = await doFetch(modelsUrl(baseUrl), {
    method: "GET",
    headers: buildHeaders(options.config),
    signal: options.signal,
  });
  if (!response.ok) {
    throw await requestErrorFor(response);
  }
  let payload: OpenRouterModelsResponse;
  try {
    payload = (await response.json()) as OpenRouterModelsResponse;
  } catch {
    throw new LlmRequestError("OpenRouter models response was not valid JSON");
  }
  const rows = Array.isArray(payload.data) ? payload.data : [];
  const models: OpenRouterModel[] = [];
  for (const row of rows) {
    if (typeof row?.id !== "string" || row.id.length === 0) {
      continue;
    }
    const name = typeof row.name === "string" && row.name.length > 0 ? row.name : row.id;
    const pricing = parseModelPricing(row.pricing);
    models.push({ id: row.id, name, ...(pricing ? { pricing } : {}) });
  }
  models.sort((a, b) => a.id.localeCompare(b.id));
  return models;
}

export function buildHeaders(config: ProviderConfig): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }
  return headers;
}

export function joinUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/chat/completions`;
}

/** OpenRouter's account-balance endpoint, off the same `{baseUrl}` (…/api/v1). */
function creditsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/credits`;
}

/** OpenRouter's model-catalog endpoint, off the same `{baseUrl}` (…/api/v1). */
function modelsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/models`;
}

/**
 * The HTTP transport needs an endpoint. A config always carries a `baseUrl`, but
 * an empty string is guarded here so a misconfiguration is a clean, diagnosable
 * error rather than a URL crash.
 */
export function requireBaseUrl(config: ProviderConfig): string {
  if (!config.baseUrl) {
    throw new LlmRequestError("No OpenAI-compatible base URL configured");
  }
  return config.baseUrl;
}

/** Extract the token delta from one parsed SSE `data:` payload, if any. */
function deltaContent(payload: OpenAiDelta): string | null {
  return payload.choices?.[0]?.delta?.content ?? null;
}

/** Parse the `data:` lines in one SSE chunk, yielding token deltas. */
function* parseSseChunk(chunk: string): Generator<string> {
  for (const line of chunk.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) {
      continue;
    }
    const data = trimmed.slice("data:".length).trim();
    if (data === "" || data === "[DONE]") {
      continue;
    }
    const token = deltaContent(JSON.parse(data) as OpenAiDelta);
    if (token) {
      yield token;
    }
  }
}

async function openStream(options: StreamChatOptions): Promise<Response> {
  const doFetch = options.fetchImpl ?? fetch;
  const response = await doFetch(joinUrl(requireBaseUrl(options.config)), {
    method: "POST",
    headers: buildHeaders(options.config),
    body: buildRequestBody(options),
    signal: options.signal,
  });
  if (!response.ok || !response.body) {
    throw await requestErrorFor(response);
  }
  return response;
}

/**
 * Stream an OpenAI-compatible chat completion as an async iterable of token
 * deltas. Enforces the privacy contract first (fail-closed for `local_only`),
 * then streams `/chat/completions` with `stream: true`.
 */
export async function* streamChatCompletion(
  options: StreamChatOptions,
): AsyncGenerator<string> {
  // Privacy gate runs BEFORE any network call: nothing leaves the device unless
  // the endpoint satisfies the configured PrivacyMode.
  ensurePrivacy(options.config);

  const response = await openStream(options);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    // SSE events are separated by a blank line; process complete events only.
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    for (const event of events) {
      yield* parseSseChunk(event);
    }
  }
  // Flush any trailing buffered event (endpoints that omit the final blank line).
  if (buffer.trim() !== "") {
    yield* parseSseChunk(buffer);
  }
}
