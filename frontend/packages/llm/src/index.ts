// @almamesh/llm — in-browser, privacy-redacted LLM narration (no backend).
//
// The ONLY chart data that leaves the device in an interpretation call is the
// output of `sanitizeChartForLlm` (identifier-free, dasha dates relativized),
// sent to an OpenAI-compatible endpoint under a fail-closed PrivacyMode contract.
// A key is never bundled; cloud (OpenRouter) is strictly opt-in.

export {
  sanitizeChartForLlm,
  IDENTIFIER_FIELDS,
  chartAnalysisInstant,
  todayAnalysisInstant,
  periodAnalysisInstant,
} from "./sanitize";
export type { AnalysisInstant, PeriodRange, SanitizedAsOf } from "./sanitize";
export type {
  SanitizedChart,
  SanitizedDashas,
  SanitizedMahaPeriod,
  SanitizedCurrentPeriod,
  SanitizedDatedPeriod,
  SanitizedPredictive,
  SanitizedTransits,
  SanitizedGocharaPlacement,
  SanitizedSadeSati,
  SanitizedFusion,
  SanitizedSlowHit,
  SanitizedTransitEvent,
  SanitizedStrength,
  SanitizedShadbalaLine,
  SanitizedVargaSummary,
  SanitizedDomainForecast,
  SanitizedDomainWindow,
} from "./sanitize";

export {
  buildPredictiveFactsBlock,
  PREDICTIVE_BLOCK_START,
  PREDICTIVE_BLOCK_END,
} from "./predictive-facts";

// --- Mesh edge narration (relationships between two charts) ---
// The boundary types mirror the RAW engine shape (schemas/mesh.py); the pair
// sanitizer + role labels are the privacy layer every mesh prompt rides through.
export type {
  MeshEdgeContext,
  MeshRelationship,
  MeshMatchRole,
  MeshContactKind,
  MeshMangalReference,
  MeshAshtakoota,
  MeshKootaResult,
  MeshDoshaFlag,
  MeshDoshaCancellation,
  MeshMangalMatch,
  MeshOverlayPair,
  MeshChartOverlay,
  MeshOverlayContact,
  MeshOverlayPlacement,
  MeshSynchrony,
  MeshSynchronySegment,
  MeshRelationSignificators,
  MeshGrahaCondition,
} from "./mesh-types";
export { sanitizeMeshEdgeForLlm, meshRoleLabels } from "./mesh-sanitize";
export type {
  SanitizedMeshEdge,
  SanitizedSynchrony,
  SanitizedSynchronySegment,
  MeshRoleLabelPair,
} from "./mesh-sanitize";
export { buildMeshFactsBlock, MESH_BLOCK_START, MESH_BLOCK_END } from "./mesh-facts";
export { streamMeshReading } from "./mesh-reading";
export type {
  MeshReading,
  MeshReadingEvent,
  MeshReadingSectionKey,
  MeshReadingParams,
} from "./mesh-reading";
export { ANTI_SCAM_RELATIONSHIP_FENCE, RECTIFICATION_FENCE } from "./prompt";

export { structureLifeEvents } from "./structure-life-events";

export {
  buildInterviewMessages,
  streamRectificationInterview,
  gatherEventsFromTurn,
} from "./rectification-interview";
export type { GatherEventsResult, InterviewGatheredEvent } from "./rectification-interview";

export {
  isLocalEndpoint,
  ensurePrivacy,
  resolveProviderConfig,
  openRouterPreset,
  OPENROUTER_API_BASE,
  RECOMMENDED_CLOUD_MODEL,
  RETIRED_CLOUD_MODELS,
  CHAT_CLOUD_MODEL,
  PrivacyViolationError,
} from "./config";
export type { PrivacyMode, ProviderConfig, LlmEnv } from "./config";

export {
  streamChatCompletion,
  LlmRequestError,
  testProviderConnection,
  fetchOpenRouterCredits,
  fetchOpenRouterModels,
} from "./client";
export type {
  TestConnectionOptions,
  FetchCreditsOptions,
  OpenRouterCredits,
  FetchModelsOptions,
  OpenRouterModel,
} from "./client";
export type { ChatMessage, StreamChatOptions } from "./client";

// --- Bounded browser-native tool orchestration ---
export { AGENT_LIMITS, streamAgentChat } from "./agent";
export type {
  AgentJsonObject,
  AgentStatusEvent,
  AgentTool,
  AgentToolContext,
  StreamAgentChatOptions,
} from "./agent";

// Reading provenance: which resolved config (engine/model/endpoint — never a
// secret) produced a stored reading, so the UI can caption it and a config
// change can trigger a regeneration.
export { configFingerprint, configProvenance } from "./provenance";
export type { ReadingProvenance } from "./provenance";

export {
  buildInterpretationMessages,
  buildChatMessages,
  serializeInterpretationForChat,
  INTERP_TOKEN_BUDGET,
  CLOUD_CHAT_BUDGET,
} from "./prompt";
export type { ViewMode, ChatRectificationContext, ChatPromptBudget } from "./prompt";

export { languageInstruction, withLanguage } from "./language";
export type { PromptLanguage } from "./language";

// --- Evidence annotation (the evidence-backed report's ONLY model call) ---
// The model may attach prose to observations the deterministic engine already
// computed; it may not author one. The payload returned here is RAW and
// UNVALIDATED on purpose — `apps/web/src/lib/evidence/annotations.ts` is the
// single validation site, and it rejects any statement citing an id this chart
// does not contain. A second validation pass here would be a second place for
// that rule to drift.
export {
  requestEvidenceAnnotations,
  buildEvidenceAnnotationMessages,
} from "./evidence-annotation";
export type {
  EvidenceObservationPrompt,
  EvidenceAnnotationParams,
  RawEvidenceAnnotationPayload,
} from "./evidence-annotation";

export { chatCompletionJson } from "./client";
export type { ChatCompletionJsonOptions } from "./client";

export {
  ALL_SECTIONS,
  CURRENT_TIMELINE_SECTIONS,
  NATAL_SECTIONS,
  streamCurrentTimeline,
  streamNatalInterpretation,
  streamStructuredInterpretation,
  usesLitePrompt,
} from "./structured-interpretation";
export type {
  CurrentTimelineContent,
  CurrentTimelineEvent,
  CurrentTimelineParams,
  CurrentTimelineSectionKey,
  InterpretationEvent,
  InterpretationSectionKey,
  NatalInterpretation,
  NatalInterpretationEvent,
  NatalInterpretationParams,
  NatalInterpretationSectionKey,
  SectionProgressSnapshot,
  StructuredInterpretationParams,
} from "./structured-interpretation";

// --- Chat transport + multi-turn public surface ---
export { routeChatCompletion, routeCompletionJson } from "./route";
export type { RouteChatOptions, RouteCompletionJsonOptions } from "./route";
export type { ChatStreamProvider, LlmEngine } from "./provider";

export { estimateTokens, trimHistoryToBudget } from "./budget";
export type { ChatTurn } from "./budget";

export {
  CHAT_SUMMARY_POLICY,
  CHAT_SUMMARY_PROMPT_SCHEMA_VERSION,
  ChatSummaryGenerationError,
  chatSummarySourceHash,
  finalizeChatSummary,
  generateChatSummaryDraft,
  hasValidChatSummaryShape,
  planChatSummary,
  summaryMatchesMessages,
} from "./chat-summary";
export type {
  ChatSummaryPlan,
  ChatSummaryGenerationErrorCode,
  FinalizeChatSummaryInput,
  GenerateChatSummaryDraftInput,
  PlanChatSummaryInput,
} from "./chat-summary";

export {
  readLlmSettings,
  hydrateLlmSettings,
  writeLlmSettings,
  applyLlmSettings,
  applyInterpretationSettings,
  applyChatSettings,
  describeLlmStatus,
  configureLlmSettingsPersistence,
  LLM_SETTINGS_KEY,
} from "./settings";
export type {
  LlmSettings,
  LlmStatus,
  LlmProviderKind,
  LlmSettingsPersistence,
} from "./settings";

// --- The one-call convenience used by the store/hook layer. ---

import type { ChatTurn } from "./budget";
import type { ProviderConfig } from "./config";
import type { PromptLanguage } from "./language";
import { sanitizeMeshEdgeForLlm } from "./mesh-sanitize";
import type { MeshEdgeContext } from "./mesh-types";
import {
  buildChatMessages,
  buildInterpretationMessages,
  type ChatRectificationContext,
  type ViewMode,
} from "./prompt";
import { routeChatCompletion } from "./route";
import { chartAnalysisInstant, sanitizeChartForLlm, type AnalysisInstant } from "./sanitize";
import type { SiderealChart } from "@almamesh/browser/types";

export interface StreamInterpretationParams {
  readonly chart: SiderealChart;
  readonly config: ProviderConfig;
  readonly mode?: ViewMode;
  /** UI/narration language for the reading (`en` default); engine is untouched. */
  readonly language?: PromptLanguage;
  readonly signal?: AbortSignal;
  /** Injectable for tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /**
   * The instant "current" dasha statements are relative to. Defaults to the
   * chart's own snapshot instant (`chartAnalysisInstant`), never the wall
   * clock; a chart stored before snapshots must pass its stored instant.
   */
  readonly asOf?: AnalysisInstant;
}

/**
 * Sanitize a chart and stream its interpretation as markdown token deltas.
 *
 * This is the single entry point the local-first store/hook layer calls: it
 * guarantees the sanitizer runs before the prompt is built, so no caller can
 * skip the privacy boundary.
 */
export async function* streamChartInterpretation(
  params: StreamInterpretationParams,
): AsyncGenerator<string> {
  const sanitized = sanitizeChartForLlm(params.chart, params.asOf ?? chartAnalysisInstant(params.chart));
  const messages = buildInterpretationMessages(
    sanitized,
    params.mode ?? "layman",
    params.language ?? "en",
  );
  yield* routeChatCompletion({
    config: params.config,
    messages,
    ...(params.signal ? { signal: params.signal } : {}),
    ...(params.fetchImpl ? { fetchImpl: params.fetchImpl } : {}),
  });
}

export interface StreamChatParams {
  readonly chart: SiderealChart;
  readonly question: string;
  readonly config: ProviderConfig;
  readonly mode?: ViewMode;
  /** Prior conversational turns for multi-turn memory (trimmed to a budget). */
  readonly history?: readonly ChatTurn[];
  /**
   * Optional retrieved snippets (RAG) — relevant earlier conversation injected
   * as a labelled block so the answer can draw on it.
   */
  readonly retrievedContext?: readonly string[];
  /**
   * The already-generated natal reading, serialized via
   * `serializeInterpretationForChat`. When present, a fast/small chat model can
   * ground its answer in the frontier reading; when absent, chat behaves exactly
   * as the facts-only path.
   */
  readonly interpretationText?: string;
  /**
   * The RAW engine mesh edge for a relationship the question concerns (e.g.
   * "how do my chart and my mother's interact?"). Sanitized internally — month
   * precision, roles not names — and injected as the delimited mesh facts
   * block; when absent, chat is byte-identical to the single-chart path.
   */
  readonly meshEdge?: MeshEdgeContext;
  /**
   * The PII-safe slice of a CONFIRMED rectification record (band + entered/
   * working signs + cusp status ONLY — Spec 062 delta 3). When present, the
   * prompt pins the engine's birth-time story so narration never contradicts
   * it; when absent, the prompt is byte-identical to the record-less path.
   */
  readonly rectification?: ChatRectificationContext;
  /** UI/narration language for the answer (`en` default); engine is untouched. */
  readonly language?: PromptLanguage;
  readonly signal?: AbortSignal;
  /** Injectable for tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /**
   * The instant "current" dasha statements are relative to. Defaults to the
   * chart's own snapshot instant (`chartAnalysisInstant`), never the wall
   * clock; a chart stored before snapshots must pass its stored instant.
   */
  readonly asOf?: AnalysisInstant;
}

/**
 * Sanitize a chart and stream a grounded answer to the user's question as
 * markdown token deltas. Like `streamChartInterpretation`, this is the single
 * entry point for the chat panel: the sanitizer runs before the prompt is built,
 * so the privacy boundary cannot be skipped.
 *
 * BOTH cloud and local endpoints take a SINGLE streaming pass: the deterministic
 * engine facts are PRE-INJECTED into the prompt (via the facts block) and any
 * `retrievedContext` snippets are threaded in, so the first token arrives
 * immediately — there is no blocking tool/decision round trip.
 */
export async function* streamChartChat(
  params: StreamChatParams,
): AsyncGenerator<string> {
  const sanitized = sanitizeChartForLlm(params.chart, params.asOf ?? chartAnalysisInstant(params.chart));
  // The pair boundary is just as unskippable: a raw mesh edge is sanitized here
  // (month-precision dates, roles not names) before any prompt sees it.
  const meshEdge = params.meshEdge ? sanitizeMeshEdgeForLlm(params.meshEdge) : undefined;
  const messages = buildChatMessages(
    sanitized,
    params.question,
    params.mode ?? "layman",
    params.history ?? [],
    params.retrievedContext ?? [],
    params.interpretationText,
    params.language ?? "en",
    meshEdge,
    params.rectification,
  );

  yield* routeChatCompletion({
    config: params.config,
    messages,
    ...(params.signal ? { signal: params.signal } : {}),
    ...(params.fetchImpl ? { fetchImpl: params.fetchImpl } : {}),
  });
}

// Runaway-reasoning cap: budget sent to OpenRouter + thinking-time abort.
export {
  CHAT_REASONING_MAX_TOKENS,
  REASONING_TIMEOUT_CODE,
  REASONING_TIMEOUT_MS,
  ReasoningTimeoutError,
  SECTION_REASONING_MAX_TOKENS,
} from "./reasoning";

// Time travel: argument rules for the timing tool's optional start/end.
export {
  BEFORE_BIRTH_MESSAGE,
  ISO_DAY_PATTERN,
  OVER_TWO_YEARS_NOTE,
  PAST_EPHEMERIS_NOTE,
  parsePeriodArgs,
  periodEcho,
  periodLimits,
  startsBeforeBirth,
} from "./period";
export type { PeriodArgs, PeriodEcho, PeriodLimits } from "./period";
