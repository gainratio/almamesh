/**
 * Centralized error handling utility
 *
 * Security: Internal error details should NEVER be exposed to users.
 * Instead, show generic user-friendly messages with error codes that can
 * be used by support to diagnose issues.
 *
 * Console diagnostics contain stable codes only; raw errors are never serialized.
 *
 * i18n: this is a plain (non-React) module, so user-facing strings are resolved
 * through the shared app i18n instance (the `errors` namespace) rather than
 * `useTranslation`. The active language follows the persisted language store,
 * exactly like the React surfaces, so error text is localized offline too.
 */

import { type Catalog, defineErrors, httpStatusOf, starterPack } from '@edgeproc/errors';
import { safeError } from '@almamesh/shared-types';
import i18n from '../i18n/config';

/**
 * Error codes for internal reference / support correlation. The codes
 * themselves are stable identifiers (logged + shown to the user); their
 * human-readable descriptions are localized via `ERROR_CODES(code)`.
 */
export type ErrorCode =
  // Chart generation errors (CHART_xxx)
  | 'CHART_GEN_001'
  | 'CHART_UPDATE_001'
  // Rectification errors (RECT_xxx)
  | 'RECT_001'
  // Q&A errors (QA_xxx)
  | 'QA_001'
  // Generic errors
  | 'UNKNOWN_001'
  // Engine readiness (transient, retryable). The in-browser Pyodide engine
  // bootstraps asynchronously; chart generation attempted before it is warm is
  // a transient race, NOT a compute failure — surface a distinct, retryable
  // message rather than the generic CHART_GEN_001.
  | 'ENGINE_WARMING';

/**
 * Localized human-readable description for an error code (e.g. "Chart
 * generation failed"). Resolved in the active language from the `errors:codes`
 * catalog; falls back to English offline. Use for developer-facing labels and
 * logging context, not as the primary user message (use the helpers below).
 */
export function ERROR_CODES(code: ErrorCode): string {
  return i18n.t(`errors:codes.${code}`);
}

/**
 * Get a user-friendly error message with error code.
 * A stable diagnostic code is logged; the actual error is never serialized.
 *
 * @param code - The error code for tracking
 * @param actualError - The actual error (classified but never serialized)
 * @param _context - Optional internal context retained for API compatibility
 * @returns User-friendly error message with error code
 */
export function getUserFriendlyError(
  code: ErrorCode,
  actualError?: unknown,
  _context?: string
): string {
  // Log the actual error for developers
  if (actualError) {
    safeError('app.typed_error', actualError);
  }

  return i18n.t('errors:generic', { code });
}

/**
 * A model-not-found failure from an OpenAI-compatible endpoint — surfaced as an
 * actionable "switch model / check AI settings" prompt instead of a raw error
 * body, since retrying the same dead model just loops. Shared by the reading
 * card (Dashboard) and the chat error mapper. OpenRouter reports this two ways:
 * the legacy HTTP 404 "No endpoints found for <model>" (retired model), and —
 * verified live 2026-07-03 — HTTP 400 "<slug> is not a valid model ID" for a
 * typo'd slug, which is the more common user error.
 */
export function isModelUnavailableMessage(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('no endpoints found') ||
    m.includes('model_not_found') ||
    m.includes('is not a valid model id') ||
    (m.includes('404') && m.includes('model'))
  );
}

/**
 * An exhausted-balance failure from a paid provider — HTTP 402 or an
 * "insufficient credits" body (live-verified against OpenRouter 2026-07-03:
 * a valid key on an account with usage ≥ credits gets 402 on every call).
 * Retrying or switching endpoints can never fix a billing problem, so this
 * must map to billing copy, not the generic "check your model" advice.
 */
export function isInsufficientCreditsMessage(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('insufficient credits') ||
    m.includes('requires more credits') ||
    m.includes('payment required') ||
    /\breturned 402\b/.test(m)
  );
}

/**
 * An authentication failure from a cloud provider — HTTP 401/403. The key is
 * missing, malformed, or rejected; retrying is pointless until the key is fixed,
 * so this maps to "check your API key", never the generic model advice.
 */
export function isAuthError(status: number | undefined): boolean {
  return status === 401 || status === 403;
}

/** The distinct ways a save-time connectivity probe can fail. */
export type ConnectionErrorKind =
  | 'credits'
  | 'auth'
  | 'model'
  | 'privacy'
  | 'rate_limited'
  | 'reasoning_timeout'
  | 'server'
  | 'network'
  | 'unknown';

/**
 * How a raw failure's searchable message is derived — the thrown `Error`'s
 * `.message`, or the stringified value for a non-Error. Kept identical to the
 * pre-@edgeproc/errors logic so classification stays byte-for-byte unchanged.
 */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A raw failure's `.name`, but only when it is a real `Error`. A plain object
 * carrying `{ name: 'PrivacyViolationError' }` deliberately does NOT count —
 * matching the previous `err instanceof Error ? err.name : ''` guard.
 */
function nameOf(err: unknown): string {
  return err instanceof Error ? err.name : '';
}

/**
 * The no-HTTP-status network signals: a `fetch` TypeError carries "Failed to
 * fetch" (Chrome) / "Load failed" (Safari) / "NetworkError" (Firefox). Matched
 * on the message — NOT the bare `TypeError` name — so a non-network code-bug
 * TypeError stays `unknown` (and visible in the logs) instead of masquerading as
 * unreachable. Mirrors the interpretation path's NETWORK_FAILURE_PATTERN.
 */
const NETWORK_MESSAGE_PATTERN = /failed to fetch|load failed|networkerror|network error|unreachable/i;

/**
 * The @almamesh/llm runaway-reasoning cap (`ReasoningTimeoutError`). Matched
 * by name AND by its message code, because a timeline section failure reaches
 * the classifier rebuilt from its message + status (504), without the class.
 */
const REASONING_TIMEOUT_PATTERN = /\(ai\.reasoning_timeout\)/;

/**
 * AlmaMesh's AI connection-error catalog, expressed in the shared
 * `@edgeproc/errors` vocabulary (the portfolio canonical-errors standard,
 * installed from npm — this file is the ONE seam through which the library
 * enters the app). Each code is REUSED from the library's
 * `starterPack`; on top of the starter data we attach the exact `match` predicate
 * the app has always used, so `registry.classify()` reproduces the previous
 * hand-written if-chain byte-for-byte.
 *
 * Registration ORDER is the precedence — `classify` returns the first code whose
 * `match` fires — so it mirrors the old order exactly: billing (402) is checked
 * before auth, and auth before model, because a 402 body can also mention the
 * model and a rejected key must not read as "bad model". Rate limiting (429) and
 * provider outages (any 5xx) come next — both transient and out of the user's
 * control — then a no-status fetch failure as `net.unreachable`.
 */
const AI_ERROR_CATALOG = {
  'ai.privacy.violation': {
    ...starterPack['ai.privacy.violation'],
    match: (raw: unknown) => nameOf(raw) === 'PrivacyViolationError',
  },
  'ai.provider.out_of_credits': {
    ...starterPack['ai.provider.out_of_credits'],
    match: (raw: unknown) => httpStatusOf(raw) === 402 || isInsufficientCreditsMessage(messageOf(raw)),
  },
  'ai.provider.unauthorized': {
    ...starterPack['ai.provider.unauthorized'],
    match: (raw: unknown) => isAuthError(httpStatusOf(raw)),
  },
  'ai.model.unavailable': {
    ...starterPack['ai.model.unavailable'],
    match: (raw: unknown) => httpStatusOf(raw) === 404 || isModelUnavailableMessage(messageOf(raw)),
  },
  'ai.provider.rate_limited': {
    ...starterPack['ai.provider.rate_limited'],
    match: (raw: unknown) => httpStatusOf(raw) === 429,
  },
  // Before server_error: the cap carries a 504 so the section runner retries it.
  'ai.reasoning_timeout': {
    category: 'timeout',
    params: [],
    en: 'The model thought for too long without answering. Try again, or pick a faster model.',
    match: (raw: unknown) =>
      nameOf(raw) === 'ReasoningTimeoutError' || REASONING_TIMEOUT_PATTERN.test(messageOf(raw)),
  },
  'ai.provider.server_error': {
    ...starterPack['ai.provider.server_error'],
    match: (raw: unknown) => {
      const status = httpStatusOf(raw);
      return status !== undefined && status >= 500;
    },
  },
  'net.unreachable': {
    ...starterPack['net.unreachable'],
    match: (raw: unknown) => httpStatusOf(raw) === undefined && NETWORK_MESSAGE_PATTERN.test(messageOf(raw)),
  },
  'internal.unknown': starterPack['internal.unknown'],
} satisfies Catalog;

/**
 * The AlmaMesh AI error registry — the single place raw LLM/transport failures
 * are classified into canonical codes, built with the shared `@edgeproc/errors`
 * library. Exported so the classification is inspectable and testable as the
 * library's own `Registry` (and so a server surface can later reuse the same
 * codes for RFC 9457 Problem Details without re-deriving them).
 */
export const aiErrorRegistry = defineErrors(AI_ERROR_CATALOG);

/**
 * Map a canonical `@edgeproc/errors` code to the local `ConnectionErrorKind` the
 * settings / chat / reading call sites already switch on. Keeping
 * `ConnectionErrorKind` as the public type at those call sites makes this
 * adoption a zero-churn internal swap: the registry replaces the if-chain, the
 * call sites are untouched.
 */
const CODE_TO_KIND: Readonly<Record<string, ConnectionErrorKind>> = {
  'ai.privacy.violation': 'privacy',
  'ai.provider.out_of_credits': 'credits',
  'ai.provider.unauthorized': 'auth',
  'ai.model.unavailable': 'model',
  'ai.provider.rate_limited': 'rate_limited',
  'ai.reasoning_timeout': 'reasoning_timeout',
  'ai.provider.server_error': 'server',
  'net.unreachable': 'network',
  'internal.unknown': 'unknown',
};

/**
 * Classify a caught connectivity-test error (from `testProviderConnection`) into
 * one actionable kind, so the settings UI can show a specific fix instead of a
 * raw error body. Delegates to the shared `@edgeproc/errors` registry
 * (`aiErrorRegistry`) — the same coded behavior as before, now expressed in the
 * portfolio's canonical-errors vocabulary — then maps the canonical code back to
 * the local `ConnectionErrorKind`. Duck-typed end-to-end (the registry reads
 * `.status` / `.name` / `.message`), so it still works across the @almamesh/llm
 * module boundary without `instanceof` coupling.
 */
export function classifyConnectionError(err: unknown): ConnectionErrorKind {
  return CODE_TO_KIND[aiErrorRegistry.classify(err)] ?? 'unknown';
}

/**
 * Map a failed LLM request to the actionable, localized copy shown in the chat
 * bubble and the dashboard reading card. This is the SINGLE coded-message mapper
 * both AI surfaces share, so they say exactly what the Settings "Save & test
 * connection" path already says: a 402 is a billing problem (add credits), a
 * 401/403 is a bad key, a 404/bad-slug is a dead model, a 429 is rate limiting,
 * a 5xx is a provider outage, and no-status is an unreachable endpoint. The old
 * behavior collapsed 402/401/429/5xx into the generic "request failed — check
 * your model and endpoint" dead-end, which sent users in circles on problems
 * retrying could never fix. Duck-typed via `classifyConnectionError`, so it
 * works across the @almamesh/llm boundary without `instanceof` coupling.
 *
 * Built on the shared @edgeproc/errors library: `classifyConnectionError` now
 * classifies through the `aiErrorRegistry` (canonical codes), and this mapper
 * renders each resulting kind to the app's existing `chat:errors.*` i18n string
 * — the coded behavior is unchanged, only its vocabulary is now the shared one.
 */
export function chatErrorMessage(error: unknown): string {
  switch (classifyConnectionError(error)) {
    case 'credits':
      return i18n.t('chat:errors.insufficient_credits');
    case 'auth':
      return i18n.t('chat:errors.auth_failed');
    case 'model':
      return i18n.t('chat:errors.model_unavailable');
    case 'rate_limited':
      return i18n.t('chat:errors.rate_limited');
    case 'reasoning_timeout':
      return i18n.t('chat:errors.reasoning_timeout');
    case 'server':
      return i18n.t('chat:errors.server_error');
    case 'network':
      return i18n.t('chat:errors.endpoint_unreachable');
    case 'privacy':
      // The fail-closed privacy fence writes its own specific, user-facing
      // message (which endpoint was refused and why); surface it verbatim. Both
      // call sites short-circuit privacy before reaching here — this is the
      // defensive fallback so the mapper is correct even if called directly.
      return error instanceof Error ? error.message : i18n.t('chat:errors.request_failed');
    default:
      return i18n.t('chat:errors.request_failed');
  }
}

/** Cap the surfaced connection-error detail so a huge body can't flood the UI. */
const MAX_DETAIL_CHARS = 200;

/**
 * Extract a short, human-readable detail from a caught connectivity-test error —
 * the PROVIDER'S OWN reason (e.g. "Expected a value >= 16, but got 1 instead.")
 * — so an otherwise-unclassifiable failure (`unknown`: a 400/429/5xx or an
 * exotic fetch error) is never a blind dead-end. Prefers the deepest structured
 * message from an OpenAI/OpenRouter JSON error body (unwrapping OpenRouter's
 * `error.metadata.raw` wrapper — see `deepestProviderMessage`); falls back to the
 * raw body, then the error message. Returns `undefined` when there's nothing
 * useful. This is the endpoint's response to a connection TEST the user
 * triggered — surfacing it is honest and actionable, not an internal leak (a key
 * never appears in a provider error body).
 */
/**
 * Pull the deepest human-readable reason out of a provider error body. OpenAI-
 * compatible bodies put it at `error.message`. OpenRouter, however, WRAPS the
 * upstream error: the top-level `error.message` is a generic "Provider returned
 * error" and the real reason is a JSON string in `error.metadata.raw` (verified
 * live against openrouter.ai 2026-07-10). We recurse into that nested raw and
 * prefer the deepest message, so the surfaced detail is the actionable upstream
 * reason, not OpenRouter's generic wrapper. Returns undefined for non-JSON input
 * (the caller then surfaces the raw text as-is).
 */
function deepestProviderMessage(raw: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const error = (parsed as { error?: unknown } | null)?.error;
  const nestedRaw = (error as { metadata?: { raw?: unknown } } | undefined)?.metadata?.raw;
  if (typeof nestedRaw === 'string' && nestedRaw.trim()) {
    const deeper = deepestProviderMessage(nestedRaw);
    if (deeper) {
      return deeper;
    }
  }
  const msg =
    (error as { message?: unknown } | undefined)?.message ??
    (parsed as { message?: unknown } | null)?.message;
  return typeof msg === 'string' && msg.trim() ? msg : undefined;
}

export function connectionErrorDetail(err: unknown): string | undefined {
  const body = (err as { body?: unknown } | null)?.body;
  const raw =
    typeof body === 'string' && body.trim()
      ? body
      : err instanceof Error
        ? err.message
        : '';
  if (!raw.trim()) {
    return undefined;
  }
  const text = deepestProviderMessage(raw) ?? raw;
  const cleaned = text.replace(/\s+/g, ' ').trim().slice(0, MAX_DETAIL_CHARS);
  return cleaned || undefined;
}

/**
 * Get a user-friendly error message for chat/Q&A errors.
 * These are shown inline in the chat interface.
 */
export function getChatErrorMessage(code: ErrorCode, actualError?: unknown): string {
  safeError('chat.stream_failed', actualError);

  return i18n.t('errors:chat', { code });
}

/**
 * Get a user-friendly message for the transient "engine still warming up"
 * condition. Unlike the generic getUserFriendlyError, this is explicitly
 * retryable: the on-device Pyodide engine simply has not finished bootstrapping
 * yet, so the right action is to wait a moment and try again — not to report a
 * compute failure.
 */
export function getEngineWarmingMessage(actualError?: unknown): string {
  safeError('engine.warming', actualError);

  return i18n.t('errors:engine_warming');
}
