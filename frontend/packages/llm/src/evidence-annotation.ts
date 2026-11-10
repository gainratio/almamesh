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
import { withLanguage, type PromptLanguage } from "./language";
import { OUTPUT_DISCIPLINE_RULES, PRIVACY_RULE } from "./prompt";
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
  "beyond its own observation. Write at most one reading per observation id, and",
  "skip any observation you have nothing meaningful to add to — an omitted",
  "observation still prints its evidence and confidence, so silence costs nothing.",
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

// =============================================================================
// The call
// =============================================================================

/**
 * Ask the model to attach interpretation prose to observations the engine has
 * already computed, and return the RAW payload for the web app to validate.
 *
 * Fails closed on privacy BEFORE any prompt is built or any byte is sent, and
 * throws `LlmRequestError` on a non-2xx, an empty completion, or a completion
 * that is not a JSON object.
 */
export async function requestEvidenceAnnotations(
  params: EvidenceAnnotationParams,
): Promise<RawEvidenceAnnotationPayload> {
  // Fail fast and CLEAN on a privacy mismatch (e.g. a cloud OpenRouter URL left
  // under the default `local_only`), before the prompt exists — mirroring
  // `streamStructuredInterpretation`. `chatCompletionJson` gates again; this one
  // is the gate the caller can see.
  ensurePrivacy(params.config);

  const raw = await chatCompletionJson({
    config: params.config,
    messages: buildEvidenceAnnotationMessages(params),
    ...(params.signal ? { signal: params.signal } : {}),
    ...(params.fetchImpl ? { fetchImpl: params.fetchImpl } : {}),
  });
  return parsePayload(raw);
}
