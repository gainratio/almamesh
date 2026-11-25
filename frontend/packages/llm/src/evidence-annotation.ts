// The model-call side of the evidence-backed report.
//
// WHAT THIS IS. The deterministic layer (`apps/web/src/lib/evidence/`) computes
// every Observation in a chart, its Evidence, its Confidence and its Alternative
// — with no model involved. This module asks a language model to do the ONE
// thing it is allowed to do: attach interpretation prose to an observation the
// engine ALREADY made. The model never authors an observation, never computes a
// placement, never decides what is true.
//
// WHY THE FENCE IS THIS TIGHT. An Evidence block makes any sentence LOOK derived.
// Print "protect your energy rather than giving it away" under a heading that
// says Evidence and Confidence, and the reader takes it for chart-derivation
// whether or not a single computed value went into it — plausible wisdom
// laundered into apparent rigour. So a statement citing an id this chart does not
// contain is DISCARDED, and the prompt says so plainly.
//
// WHERE VALIDATION LIVES: not here. `lib/evidence/annotations.ts` is the single
// validation site, and it is un-bypassable by construction. This module returns
// the RAW parsed payload — bogus ids included — precisely so there is exactly one
// place that decides what renders. Two copies of that rule would eventually
// disagree, and the disagreement would be invisible.
//
// Privacy is enforced the same way every other call in this package enforces it:
// `ensurePrivacy(config)` runs BEFORE anything is built or sent, and the chart
// must already be a `SanitizedChart` — the type IS the boundary.

import { chatCompletionJson, LlmRequestError, type ChatMessage } from "./client";
import { ensurePrivacy, type ProviderConfig } from "./config";
import { extractExplicitCalendarDays } from "./date-guard";
import { withLanguage, type PromptLanguage } from "./language";
import { OUTPUT_DISCIPLINE_RULES, PRIVACY_RULE } from "./prompt";
import { SECTION_REASONING_MAX_TOKENS } from "./reasoning";
import {
  REFLECTION_RULE,
  reflectionCorrection,
  reflectionIssues,
  reflectionRetry,
  rewordedOr,
  type ReflectionIssue,
} from "./reflection";
import type { SanitizedChart } from "./sanitize";

// =============================================================================
// Public contract
// =============================================================================

/** One deterministic observation the model may attach interpretation to. */
export interface EvidenceObservationPrompt {
  /** Stable engine id, e.g. `dignity:venus`, `dasha:maha:saturn`, `lagna`. */
  readonly id: string;
  /** The observation as the engine already worded it. */
  readonly statement: string;
  /** The computed values behind it — printed to the reader above the prose. */
  readonly evidence: string;
}

export interface EvidenceAnnotationParams {
  readonly chart: SanitizedChart;
  readonly observations: readonly EvidenceObservationPrompt[];
  /** Every citable factor id in this chart — the ONLY ids the model may cite. */
  readonly factorIds: readonly string[];
  /** Optional canonical YYYY-MM-DD boundary dates per factor/observation id. */
  readonly factorBoundaryDays?: Readonly<Record<string, readonly string[]>>;
  readonly config: ProviderConfig;
  readonly language?: string;
  readonly signal?: AbortSignal;
  /** Injectable for tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

/** Raw, unvalidated. The web app validates before anything renders. */
export interface RawEvidenceAnnotationPayload {
  readonly readings?: unknown;
  readonly general_guidance?: unknown;
}

// =============================================================================
// System prompt
// =============================================================================

const ROLE_BLOCK = [
  "You write the INTERPRETATION half of an astrology report whose FACTS are already",
  "fixed. A deterministic engine has computed every observation in this chart, the",
  "evidence behind it, its confidence, and its alternative reading. You compute",
  "nothing, you add nothing, and you never decide what is true about this chart.",
  "",
  "YOUR ONE JOB: for an observation the engine has ALREADY made, say what it means",
  "for this person's life. That is the only thing you can write that reaches the",
  "reader as a chart finding.",
].join("\n");

// The honest-self-labelling incentive. Both destinations PRINT, so there is no
// gain in smuggling an ungrounded thought into `readings` — and a real cost if
// you do. The prompt states the cost explicitly rather than merely forbidding it.
const SPLIT_BLOCK = [
  "TWO PLACES YOUR WORDS CAN GO. Choose honestly, every single time:",
  "",
  '  1. "readings" — ONLY for a statement you can tie to one of the observation ids',
  "     listed below. It prints directly beside that observation's evidence and",
  "     confidence, as a finding derived from this chart.",
  "",
  '  2. "general_guidance" — for ANYTHING you cannot tie to a listed observation:',
  "     general advice, classical background, encouragement, context, a caveat.",
  "     THIS IS ALSO PRINTED. It appears in its own clearly-marked section that",
  "     tells the reader plainly that it is NOT derived from their chart. Putting a",
  "     useful, unanchored thought here costs you nothing — it is the RIGHT place",
  "     for it, and the reader still gets to read it.",
  "",
  "THE ONE THING THAT GETS YOUR WORDS DELETED ENTIRELY: putting an ungrounded",
  '  statement in "readings". Any reading whose "observation_id" — or any entry in',
  '  its "also_cites" — is not in the lists below is DISCARDED. Not shown with a',
  "  warning, not softened, not moved to general guidance: deleted, and the drop is",
  "  counted and reported to the reader as a rejected citation. Inventing an id is",
  "  strictly worse for you than admitting a thought was general. When in doubt,",
  "  put it in general_guidance.",
].join("\n");

// The failure mode this catches is subtle and common: the model re-reads the
// evidence line back to the reader in slightly warmer words and it FEELS like
// analysis. It is not — and it wastes the one slot that could have carried meaning.
const NO_PARAPHRASE_BLOCK = [
  "NEVER RESTATE THE EVIDENCE AS THE INTERPRETATION. The evidence line is already",
  "  printed immediately above your words, verbatim. Repeating the degrees, the",
  "  dignity, the orb, or the grade adds nothing — it just spends the reader's",
  "  attention on something they have already read. Begin where the numbers stop:",
  "  what this pattern asks of the person, how it tends to feel from the inside,",
  "  what can be done with it.",
  "  Never repeat or reformat period start/end dates already printed above; if a",
  "  boundary date is ever named, it must match that observation's YYYY-MM-DD date",
  "  verbatim (never shifted by a day or converted to another timezone).",
  '  WRONG (a restatement): "Venus is debilitated in Virgo and combust the Sun."',
  '  RIGHT (a meaning): "Affection here gets audited before it is offered, so warmth',
  '  arrives late but lands honestly; it helps to say the kind thing before it feels',
  '  fully earned."',
].join("\n");

const EVIDENCE_SYSTEM_PROMPT = [
  ROLE_BLOCK,
  "",
  SPLIT_BLOCK,
  "",
  NO_PARAPHRASE_BLOCK,
  "",
  REFLECTION_RULE,
  "",
  OUTPUT_DISCIPLINE_RULES,
  "",
  PRIVACY_RULE,
  "",
  "OUTPUT: respond with a SINGLE strict JSON object matching the schema below. No",
  "prose outside the JSON. No markdown fences. Escape any quotes inside strings.",
].join("\n");

/** The literal output schema, shown last so it is the final thing the model reads. */
const OUTPUT_SCHEMA = [
  "Return EXACTLY this JSON shape:",
  "{",
  '  "readings": [',
  "    {",
  '      "observation_id": "<one id from the OBSERVATIONS list above, verbatim>",',
  '      "interpretation": "<what it MEANS — never a restatement of the evidence>",',
  '      "also_cites": ["<zero or more ids from the CITABLE FACTORS list, verbatim>"]',
  "    }",
  "  ],",
  '  "general_guidance": ["<a statement you could NOT tie to a listed observation>"]',
  "}",
  "",
  '"also_cites" is optional; omit it or use [] when the reading leans on nothing',
  "beyond its own observation. Provide ONE concise (1-2 sentence) reflective",
  "reading for EVERY observation id in the OBSERVATIONS list above — never invent",
  "an id and never write two entries for the same observation_id.",
].join("\n");

// =============================================================================
// Message building
// =============================================================================

function observationBlock(observations: readonly EvidenceObservationPrompt[]): string {
  const lines = observations.map((observation) =>
    [
      `- id: ${observation.id}`,
      `  observation: ${observation.statement}`,
      `  evidence: ${observation.evidence}`,
    ].join("\n"),
  );
  return [
    "OBSERVATIONS — the EXHAUSTIVE list of ids you may use as an \"observation_id\".",
    "An id that is not on this list does not exist in this chart:",
    ...lines,
  ].join("\n");
}

function factorBlock(factorIds: readonly string[]): string {
  return [
    "CITABLE FACTORS — the EXHAUSTIVE list of ids you may put in \"also_cites\".",
    "Any other value there discards the whole reading it appears in:",
    ...factorIds.map((id) => `- ${id}`),
  ].join("\n");
}

/** The sanitized chart as compact reference JSON (predictive block excluded). */
function chartReferenceBlock(chart: SanitizedChart): string {
  const { predictive: _predictive, ...chartForJson } = chart;
  return [
    "CHART (sanitized reference; no identifying information). Read it to make your",
    "interpretations specific to THIS person — do not copy it back, and never state a",
    "placement, lordship, dasha, or yoga it does not contain:",
    JSON.stringify(chartForJson),
  ].join("\n");
}

const PROMPT_LANGUAGES: readonly string[] = ["en", "es", "pt", "hi"];

/** Narrow a caller-supplied language string to a supported one; `en` otherwise. */
function asPromptLanguage(language: string | undefined): PromptLanguage {
  return PROMPT_LANGUAGES.includes(language ?? "") ? (language as PromptLanguage) : "en";
}

/**
 * Build the system+user messages for one evidence-annotation call.
 *
 * Exported for prompt-contract tests and for callers that want to inspect what
 * would be sent; `requestEvidenceAnnotations` is the path that actually calls out.
 */
export function buildEvidenceAnnotationMessages(
  params: EvidenceAnnotationParams,
): ChatMessage[] {
  const userContent = [
    observationBlock(params.observations),
    "",
    factorBlock(params.factorIds),
    "",
    chartReferenceBlock(params.chart),
    "",
    "------------------------------------------------------------------",
    OUTPUT_SCHEMA,
  ].join("\n");

  return [
    {
      role: "system",
      content: withLanguage(EVIDENCE_SYSTEM_PROMPT, asPromptLanguage(params.language)),
    },
    { role: "user", content: userContent },
  ];
}

// =============================================================================
// Parsing — deliberately NON-filtering
// =============================================================================

/** Cap the response echoed into an error so a runaway completion can't flood logs. */
const MAX_ERROR_BODY_CHARS = 500;

/**
 * Parse the completion into the raw payload shape the validator expects.
 *
 * It does NOT filter, drop, or repair rows: a reading citing an id this chart
 * never produced must reach `validateAnnotations` intact, so that rejection
 * happens exactly once, in the one place that counts and reports it.
 *
 * A completion that is not a JSON OBJECT is a hard failure, never a silent `{}` —
 * an empty payload is indistinguishable from "the model had nothing to add", and
 * that would render a report whose interpretation quietly vanished.
 */
function parsePayload(raw: string): RawEvidenceAnnotationPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new LlmRequestError("Evidence annotation response was not valid JSON", {
      body: raw.slice(0, MAX_ERROR_BODY_CHARS),
    });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new LlmRequestError("Evidence annotation response was not a JSON object", {
      body: raw.slice(0, MAX_ERROR_BODY_CHARS),
    });
  }
  return parsed as RawEvidenceAnnotationPayload;
}

function proseIssuesOf(value: unknown): readonly ReflectionIssue[] {
  return typeof value === "string" ? reflectionIssues(value) : [];
}

/**
 * Scan ONLY user-facing prose fields (`readings[].interpretation` and
 * `general_guidance[]`) for non-reflective phrasing — never citation ids.
 */
function annotationReflectionIssues(
  payload: RawEvidenceAnnotationPayload,
): readonly ReflectionIssue[] {
  const readingIssues = Array.isArray(payload.readings)
    ? payload.readings.flatMap((entry) =>
        entry !== null && typeof entry === "object"
          ? proseIssuesOf((entry as { interpretation?: unknown }).interpretation)
          : [],
      )
    : [];
  const guidanceIssues = Array.isArray(payload.general_guidance)
    ? payload.general_guidance.flatMap(proseIssuesOf)
    : [];
  return [...readingIssues, ...guidanceIssues];
}

function isNonEmptyCleanString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    reflectionIssues(value).length === 0
  );
}

interface IdentifiableReading extends Record<string, unknown> {
  readonly observation_id: string;
  readonly interpretation?: unknown;
  readonly also_cites?: unknown;
}

function isObjectWithStringId(entry: unknown): entry is IdentifiableReading {
  return (
    entry !== null &&
    typeof entry === "object" &&
    !Array.isArray(entry) &&
    typeof (entry as { observation_id?: unknown }).observation_id === "string"
  );
}

interface DateMismatchIssue {
  readonly observationId: string;
  readonly wrongDays: readonly string[];
  readonly allowedDays: readonly string[];
}

function parentDashaIds(id: string): readonly string[] {
  if (id.startsWith("dasha:pratyantar:")) {
    const [maha, antar] = id.slice("dasha:pratyantar:".length).split("/");
    return maha && antar ? [`dasha:maha:${maha}`, `dasha:antar:${maha}/${antar}`] : [];
  }
  if (id.startsWith("dasha:antar:")) {
    const [maha] = id.slice("dasha:antar:".length).split("/");
    return maha ? [`dasha:maha:${maha}`] : [];
  }
  return [];
}

function buildAllowedDaysByObservation(
  observations: readonly EvidenceObservationPrompt[],
  factorBoundaryDays?: Readonly<Record<string, readonly string[]>>,
): {
  readonly observationIds: ReadonlySet<string>;
  readonly daysById: ReadonlyMap<string, ReadonlySet<string>>;
} {
  const daysById = new Map<string, Set<string>>();
  for (const [id, days] of Object.entries(factorBoundaryDays ?? {})) {
    daysById.set(id, new Set(days));
  }
  const observationIds = new Set<string>();
  for (const obs of observations) {
    observationIds.add(obs.id);
    const bucket = daysById.get(obs.id) ?? new Set<string>();
    for (const day of extractExplicitCalendarDays(`${obs.statement} ${obs.evidence}`)) {
      bucket.add(day);
    }
    daysById.set(obs.id, bucket);
  }
  return { observationIds, daysById };
}

function rowDateMismatch(
  entry: IdentifiableReading,
  observationIds: ReadonlySet<string>,
  daysById: ReadonlyMap<string, ReadonlySet<string>>,
): DateMismatchIssue | null {
  if (!observationIds.has(entry.observation_id) || typeof entry.interpretation !== "string") {
    return null;
  }
  const explicitDays = extractExplicitCalendarDays(entry.interpretation);
  if (explicitDays.length === 0) return null;
  const cites = Array.isArray(entry.also_cites)
    ? entry.also_cites.filter((c): c is string => typeof c === "string")
    : [];
  const allowed = new Set<string>();
  for (const refId of [entry.observation_id, ...parentDashaIds(entry.observation_id), ...cites]) {
    for (const day of daysById.get(refId) ?? []) allowed.add(day);
  }
  const wrongDays = explicitDays.filter((day) => !allowed.has(day));
  return wrongDays.length > 0
    ? { observationId: entry.observation_id, wrongDays, allowedDays: [...allowed] }
    : null;
}

function annotationDateMismatches(
  payload: RawEvidenceAnnotationPayload,
  observationIds: ReadonlySet<string>,
  daysById: ReadonlyMap<string, ReadonlySet<string>>,
): readonly DateMismatchIssue[] {
  if (!Array.isArray(payload.readings)) return [];
  return payload.readings.flatMap((entry) => {
    if (!isObjectWithStringId(entry)) return [];
    const mismatch = rowDateMismatch(entry, observationIds, daysById);
    return mismatch ? [mismatch] : [];
  });
}

function dateMismatchCorrection(mismatches: readonly DateMismatchIssue[]): string {
  const details = mismatches
    .map(
      (m) =>
        `${m.observationId} stated ${m.wrongDays.join(", ")} (canonical boundaries: ${m.allowedDays.join(", ") || "none"})`,
    )
    .join("; ");
  return (
    `Your last reply stated calendar date(s) that disagree with the computed observation boundaries (${details}). ` +
    "Remove repeated calendar dates or use ONLY the exact YYYY-MM-DD boundary dates printed in each observation's evidence line."
  );
}

function isCleanEntry(
  entry: IdentifiableReading,
  observationIds: ReadonlySet<string>,
  daysById: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  return (
    isNonEmptyCleanString(entry.interpretation) &&
    rowDateMismatch(entry, observationIds, daysById) === null
  );
}

/**
 * Merge a reflection/date-retry payload onto the initial payload without filtering:
 * clean rows from `first` survive even if the retry omits them, while rows that
 * failed reflection or date-consistency adopt the retry's clean non-empty rewording
 * while preserving `first`'s sibling metadata (`also_cites`, etc.). Malformed retry
 * rows never overwrite structurally valid rows from `first`.
 */
function mergeRewordedPayload(
  first: RawEvidenceAnnotationPayload,
  retried: RawEvidenceAnnotationPayload,
  observationIds: ReadonlySet<string>,
  daysById: ReadonlyMap<string, ReadonlySet<string>>,
): RawEvidenceAnnotationPayload {
  const retriedById = new Map<string, IdentifiableReading>();
  if (Array.isArray(retried.readings)) {
    for (const entry of retried.readings) {
      if (isObjectWithStringId(entry) && !retriedById.has(entry.observation_id)) {
        retriedById.set(entry.observation_id, entry);
      }
    }
  }

  let readings: unknown = first.readings;
  if (Array.isArray(first.readings) && Array.isArray(retried.readings)) {
    const seenIds = new Set<string>();
    const merged = first.readings.map((entry) => {
      if (!isObjectWithStringId(entry)) return entry;
      seenIds.add(entry.observation_id);
      const replacement = retriedById.get(entry.observation_id);
      const firstBroken =
        proseIssuesOf(entry.interpretation).length > 0 ||
        rowDateMismatch(entry, observationIds, daysById) !== null;
      if (!firstBroken || !replacement || !isCleanEntry(replacement, observationIds, daysById)) {
        return entry;
      }
      return {
        ...entry,
        interpretation: replacement.interpretation,
        ...(Array.isArray(replacement.also_cites) ? { also_cites: replacement.also_cites } : {}),
      };
    });
    for (const extra of retried.readings) {
      if (
        isObjectWithStringId(extra) &&
        !seenIds.has(extra.observation_id) &&
        isCleanEntry(extra, observationIds, daysById)
      ) {
        seenIds.add(extra.observation_id);
        merged.push(extra);
      }
    }
    readings = merged;
  }

  let general_guidance: unknown = first.general_guidance;
  const firstGuidanceBroken =
    Array.isArray(first.general_guidance) &&
    first.general_guidance.flatMap(proseIssuesOf).length > 0;
  if (
    firstGuidanceBroken &&
    Array.isArray(first.general_guidance) &&
    Array.isArray(retried.general_guidance) &&
    retried.general_guidance.length > 0
  ) {
    if (
      retried.general_guidance.every(isNonEmptyCleanString) &&
      retried.general_guidance.length >= first.general_guidance.length
    ) {
      general_guidance = [...new Set(retried.general_guidance)];
    } else {
      const existingClean = new Set(first.general_guidance.filter(isNonEmptyCleanString));
      const queue = retried.general_guidance.filter(
        (item): item is string => isNonEmptyCleanString(item) && !existingClean.has(item),
      );
      let cursor = 0;
      general_guidance = first.general_guidance.map((entry) => {
        if (isNonEmptyCleanString(entry)) return entry;
        const nextClean = queue[cursor];
        if (nextClean !== undefined) {
          cursor += 1;
          return nextClean;
        }
        return entry;
      });
    }
  }

  return {
    ...first,
    ...(readings !== undefined ? { readings } : {}),
    ...(general_guidance !== undefined ? { general_guidance } : {}),
  };
}

// =============================================================================
// The call
// =============================================================================

function abortAwareDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isRetryableAnnotationFailure(err: unknown): boolean {
  if (err instanceof TypeError) return true;
  if (!(err instanceof LlmRequestError)) return false;
  if (err.status === undefined) return true;
  return err.status === 408 || err.status === 429 || err.status >= 500;
}

/**
 * Ask the model to attach interpretation prose to observations the engine has
 * already computed, and return the RAW payload for the web app to validate.
 *
 * Fails closed on privacy BEFORE any prompt is built or any byte is sent, and
 * throws `LlmRequestError` on a non-2xx, an empty completion, or a completion
 * that is not a JSON object. Retries transient HTTP/network/truncated-JSON
 * failures once, and if the first valid JSON trips the reflection rule, sends a
 * single reword retry while preserving already-clean rows.
 */
export async function requestEvidenceAnnotations(
  params: EvidenceAnnotationParams,
): Promise<RawEvidenceAnnotationPayload> {
  // Fail fast and CLEAN on a privacy mismatch (e.g. a cloud OpenRouter URL left
  // under the default `local_only`), before the prompt exists — mirroring
  // `streamStructuredInterpretation`. `chatCompletionJson` gates again; this one
  // is the gate the caller can see.
  ensurePrivacy(params.config);

  const baseMessages = buildEvidenceAnnotationMessages(params);
  const request = (messages: ChatMessage[]): Promise<string> =>
    chatCompletionJson({
      config: params.config,
      messages,
      reasoningMaxTokens: SECTION_REASONING_MAX_TOKENS,
      ...(params.signal ? { signal: params.signal } : {}),
      ...(params.fetchImpl ? { fetchImpl: params.fetchImpl } : {}),
    });

  let raw: string;
  let first: RawEvidenceAnnotationPayload;
  try {
    raw = await request(baseMessages);
    first = parsePayload(raw);
  } catch (err) {
    if (params.signal?.aborted || !isRetryableAnnotationFailure(err)) {
      throw err;
    }
    const backoffMs = err instanceof LlmRequestError && err.status === 429 ? 400 : 150;
    await abortAwareDelay(backoffMs, params.signal);
    if (params.signal?.aborted) {
      throw err;
    }
    raw = await request(baseMessages);
    first = parsePayload(raw);
  }

  const { observationIds, daysById } = buildAllowedDaysByObservation(
    params.observations,
    params.factorBoundaryDays,
  );
  const issues = annotationReflectionIssues(first);
  const dateMismatches = annotationDateMismatches(first, observationIds, daysById);
  if (issues.length === 0 && dateMismatches.length === 0) {
    return first;
  }

  const retryMessages =
    issues.length > 0 && dateMismatches.length === 0
      ? reflectionRetry(raw, issues)
      : [
          { role: "assistant" as const, content: raw },
          {
            role: "user" as const,
            content: [
              ...(issues.length > 0 ? [reflectionCorrection(issues)] : []),
              ...(dateMismatches.length > 0 ? [dateMismatchCorrection(dateMismatches)] : []),
              "Return the same JSON shape, updating only the offending observation(s).",
            ].join(" "),
          },
        ];

  const retriedRaw = await rewordedOr(raw, params.signal, () =>
    request([...baseMessages, ...retryMessages]),
  );
  if (retriedRaw === raw) {
    return first;
  }
  try {
    return mergeRewordedPayload(first, parsePayload(retriedRaw), observationIds, daysById);
  } catch {
    return first;
  }
}
