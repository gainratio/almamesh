// Structured THREE-section mesh edge reading — the AI voice for a relationship
// between two charts, run entirely client-side against any OpenAI-compatible
// endpoint (no backend).
//
// Reuses the section-fanout machinery style of ./structured-interpretation.ts:
// three independent JSON chat completions in parallel — `connection` (how the
// charts meet), `timing_together` (the joint dasha windows), `care` (frictions
// and how to tend them) — each requesting STRICT JSON for one TitledPersona
// { title, layman, technical }, merged into one `MeshReading`. A failed section
// degrades to its safe empty default with an `error` event; ALL sections
// failing throws loudly. The schema here is tiny (three string fields), so one
// prompt set serves both cloud and local models — no LITE variant needed.
//
// The edge is sanitized via `sanitizeMeshEdgeForLlm` BEFORE any prompt is
// built, so the pair privacy boundary cannot be skipped: month-precision dates
// only, both people as roles ("you" / "your spouse"), never names. Every call
// also runs the fail-closed `ensurePrivacy` gate.

import type { TitledPersona } from "@almamesh/shared-types";

import { chatCompletionJson, type ChatMessage } from "./client";
import { ensurePrivacy, type ProviderConfig } from "./config";
import { withLanguage, type PromptLanguage } from "./language";
import { buildMeshFactsBlock } from "./mesh-facts";
import { sanitizeMeshEdgeForLlm } from "./mesh-sanitize";
import type { MeshEdgeContext, MeshRelationship } from "./mesh-types";
import { ANTI_SCAM_RELATIONSHIP_FENCE, OUTPUT_DISCIPLINE_RULES, type ViewMode } from "./prompt";
import { jsonReflectionIssues, READING_WITHHELD, REFLECTION_RULE, reflectionRetry, rewordedOr, withholdFailingValues } from "./reflection";

// =============================================================================
// Public API
// =============================================================================

export type MeshReadingSectionKey = "connection" | "timing_together" | "care";

/** The merged reading: one dual-voice TitledPersona per section. */
export interface MeshReading {
  readonly connection: TitledPersona;
  readonly timing_together: TitledPersona;
  readonly care: TitledPersona;
}

export type MeshReadingEvent =
  | { type: "section_start"; section: MeshReadingSectionKey }
  | { type: "section_complete"; section: MeshReadingSectionKey }
  | { type: "complete"; reading: MeshReading }
  | { type: "error"; section?: MeshReadingSectionKey; message: string };

export interface MeshReadingParams {
  /** The RAW engine mesh edge; sanitized internally (boundary unskippable). */
  readonly edge: MeshEdgeContext;
  readonly config: ProviderConfig;
  /** Overrides the role vocabulary; defaults to the edge's own relationship. */
  readonly relationship?: MeshRelationship;
  /** `layman` | `expert`; biases which voice the prompt foregrounds. */
  readonly mode?: ViewMode;
  /** UI/narration language for the reading (`en` default); engine is untouched. */
  readonly language?: PromptLanguage;
  readonly signal?: AbortSignal;
  /** Injectable for tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

const ALL_SECTIONS: readonly MeshReadingSectionKey[] = [
  "connection",
  "timing_together",
  "care",
];

// =============================================================================
// System prompt — narrate-only honesty + roles-not-names + the anti-scam fence
// =============================================================================

const SYSTEM_PROMPT = [
  "You are a master Vedic astrologer (Sidereal / Lahiri ayanamsa) and a warm,",
  "honest narrator of how two charts relate. You NARRATE the engine-computed",
  "relationship facts you are given; you never compute, recalculate, or invent",
  "an astrological fact, score, contact, or date that is not in the provided",
  "block.",
  "",
  'THE PEOPLE (ABSOLUTE): the reading\'s subject is addressed as "you"; the other',
  'person is addressed ONLY by their relationship role (e.g. "your spouse",',
  '"your mother") — never by any name, initial, or birth detail, even if one',
  "appears elsewhere in the conversation.",
  "",
  "DUAL-MODE OUTPUT (MANDATORY): the JSON object has a title plus TWO voice",
  "fields with zero overlap:",
  '  - "layman": everyday language for someone who has NEVER heard of astrology.',
  "    Speak only of the lived relationship themes (warmth, friction, timing,",
  "    support, patience) — no planet/sign/house numbers, no Sanskrit terms.",
  '  - "technical": for a practicing Jyotish reader — cite the exact kootas with',
  "    their earned/maximum scores, the named contacts and houses, and the",
  "    month-precision windows from the block, with their stated conventions.",
  "",
  "MESH HONESTY (ABSOLUTE): every guna score, band, dosha, cancellation, overlay",
  "contact, shared lord, significator condition, and dated window you mention",
  "MUST appear in the relationship block. Quote month windows (e.g. 2026-03)",
  "verbatim; where the block is silent, say nothing. The block's stated",
  "conventions (whole-sign overlay, the modern close-conjunction orb, the",
  "dasha-year convention) may be named but never altered or second-guessed.",
  "",
  OUTPUT_DISCIPLINE_RULES,
  "",
  ANTI_SCAM_RELATIONSHIP_FENCE,
  "",
  REFLECTION_RULE,
  "",
  "OUTPUT: respond with a SINGLE strict JSON object matching the requested",
  "schema. No prose outside the JSON. No markdown fences. Escape quotes in",
  "strings. Fill every field with real content — never blank or a placeholder.",
].join("\n");

// =============================================================================
// Per-section tasks (each returns ONE TitledPersona)
// =============================================================================

const JSON_SHAPE = '{ "title": "...", "layman": "...", "technical": "..." }';

const CONNECTION_TASK = [
  "TASK: Connection — HOW these two charts meet.",
  `Return JSON: ${JSON_SHAPE}.`,
  "Ground every claim in the relationship block:",
  "  - the graha_maitri koota (how the two Moon-sign lords regard each other),",
  "    and any other koota whose basis illuminates the bond — cite each with its",
  "    earned/maximum score;",
  "  - the strongest overlay contacts in BOTH directions (whose graha touches",
  "    whose natal point, the contact kind, and the house it lands in — houses",
  "    color WHERE in life the other person is felt);",
  "  - whether the two significator readings corroborate the bond (each karaka",
  "    house, its lord's stated condition, the karakas' conditions).",
  "title: a short, specific headline for THIS connection — not a generic phrase.",
].join("\n");

const TIMING_TOGETHER_TASK = [
  "TASK: Timing Together — the joint dasha windows, narrated.",
  `Return JSON: ${JSON_SHAPE}.`,
  "Use ONLY the dated segments listed in the block, in order, each with its",
  "month-precision window quoted verbatim (e.g. 2026-03 -> 2027-01). For each",
  "window: name whose period pairs with whose (you in X/Y while the other person",
  "runs P/Q) and what that pairing emphasizes for time spent together; when the",
  "block marks shared lord(s) on a segment, foreground that window — a shared",
  "lord means the same graha times BOTH lives at once. State the dasha-year",
  "convention when citing windows. NEVER invent a window, a lord, or any date",
  "beyond the listed segments; if the block lists no segments, say plainly that",
  "no dated joint windows are in scope.",
].join("\n");

const CARE_TASK = [
  "TASK: Care — the frictions in the facts, and how to tend them. Honest, never doom.",
  `Return JSON: ${JSON_SHAPE}.`,
  "Name ONLY the frictions the block actually states — kootas earning low or zero",
  "scores (cite earned/maximum and the basis), a dosha marked present (state its",
  "classical meaning in plain words and its cancellation status EXACTLY as",
  "stated), or a hard overlay contact. For each friction, move directly to what",
  "can be tended — communication, patience, timing, care — in concrete, kind",
  "terms. End on what the block itself shows is workable (a high koota, a",
  "cancellation, a supportive contact). Never advise marrying, leaving, or",
  "cutting off anyone; no fear language; no remedy that promises to erase",
  "anything.",
].join("\n");

const SECTION_TASKS: Record<MeshReadingSectionKey, string> = {
  connection: CONNECTION_TASK,
  timing_together: TIMING_TOGETHER_TASK,
  care: CARE_TASK,
};

function modeHint(mode: ViewMode): string {
  return mode === "expert"
    ? "The reader is an astrologer; make the technical field especially rigorous."
    : "The reader is a layperson; make the layman field especially warm and clear.";
}

/** Build the system+user messages for one section from the facts block. */
function buildMeshSectionMessages(
  section: MeshReadingSectionKey,
  factsBlock: string,
  mode: ViewMode,
  language: PromptLanguage,
): ChatMessage[] {
  const userContent = [
    // A stable marker so tests (and logs) can identify the section.
    `SECTION:${section}`,
    "",
    SECTION_TASKS[section],
    "",
    modeHint(mode),
    "",
    "Relationship facts (engine-computed, sanitized; both people appear as roles",
    "only — keep it that way):",
    factsBlock,
  ].join("\n");
  return [
    { role: "system", content: withLanguage(SYSTEM_PROMPT, language) },
    { role: "user", content: userContent },
  ];
}

// =============================================================================
// Parsing + orchestration (mirrors streamStructuredInterpretation)
// =============================================================================

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

const EMPTY_PERSONA: TitledPersona = { title: "", layman: "", technical: "" };

function parseTitledPersona(raw: string): TitledPersona {
  const json: unknown = JSON.parse(raw);
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return EMPTY_PERSONA;
  }
  const rec = json as Record<string, unknown>;
  return {
    title: asString(rec.title),
    layman: asString(rec.layman),
    technical: asString(rec.technical),
  };
}

type SectionOutcome =
  | { section: MeshReadingSectionKey; ok: true; raw: string }
  | { section: MeshReadingSectionKey; ok: false; message: string };

/**
 * One section's JSON through the reflection check (PR #366): a text that foretells, narrates the
 * tools or guesses lived experience goes back once with the issues named; a value that still
 * fails is withheld in the reading's language, as are the first text's failing values when the
 * reword request itself fails.
 */
async function reflectedSection(messages: ChatMessage[], params: MeshReadingParams): Promise<string> {
  const request = (sent: ChatMessage[]) =>
    chatCompletionJson({
      config: params.config,
      messages: sent,
      ...(params.signal ? { signal: params.signal } : {}),
      ...(params.fetchImpl ? { fetchImpl: params.fetchImpl } : {}),
    });
  const raw = await request(messages);
  const issues = jsonReflectionIssues(raw);
  if (issues.length === 0) return raw;
  const retry = await rewordedOr(raw, params.signal, () => request([...messages, ...reflectionRetry(raw, issues)]));
  return withholdFailingValues(retry, READING_WITHHELD[params.language ?? "en"]);
}

function runOneSection(
  section: MeshReadingSectionKey,
  factsBlock: string,
  params: MeshReadingParams,
): Promise<SectionOutcome> {
  const messages = buildMeshSectionMessages(
    section,
    factsBlock,
    params.mode ?? "layman",
    params.language ?? "en",
  );
  return reflectedSection(messages, params)
    .then((raw): SectionOutcome => ({ section, ok: true, raw }))
    .catch((err: unknown): SectionOutcome => ({
      section,
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    }));
}

function abortError(): Error {
  const err = new Error("Mesh reading aborted");
  err.name = "AbortError";
  return err;
}

/** Collapse the per-section failure messages (usually identical) into one line. */
function summarizeFailures(messages: readonly string[]): string {
  const unique = [...new Set(messages.map((m) => m.trim()).filter(Boolean))];
  if (unique.length === 0) {
    return "No further detail was reported by the endpoint.";
  }
  return unique.join(" / ");
}

/**
 * Sanitize a mesh edge and stream a structured three-section relationship
 * reading.
 *
 * Emits `section_start` for every section up front, runs the three JSON calls
 * in PARALLEL, emits `section_complete` per success and `error` per failure
 * (failed sections degrade to the empty persona), then one `complete` event
 * with the merged `MeshReading`. ALL sections failing throws loudly so the UI
 * shows an error instead of a silent blank.
 */
export async function* streamMeshReading(
  params: MeshReadingParams,
): AsyncGenerator<MeshReadingEvent> {
  if (params.signal?.aborted) {
    throw abortError();
  }

  // Fail fast and CLEAN on a privacy mismatch (e.g. a cloud URL left under the
  // default `local_only`) instead of three identical swallowed section errors.
  ensurePrivacy(params.config);

  const sanitized = sanitizeMeshEdgeForLlm(params.edge);
  const factsBlock = buildMeshFactsBlock(sanitized, params.relationship);

  for (const section of ALL_SECTIONS) {
    yield { type: "section_start", section };
  }

  const inFlight = ALL_SECTIONS.map((section) => runOneSection(section, factsBlock, params));
  const outcomes = await Promise.all(inFlight);

  if (params.signal?.aborted) {
    throw abortError();
  }

  const results: Record<MeshReadingSectionKey, TitledPersona> = {
    connection: EMPTY_PERSONA,
    timing_together: EMPTY_PERSONA,
    care: EMPTY_PERSONA,
  };
  let applied = 0;
  const failures: string[] = [];
  for (const outcome of outcomes) {
    if (!outcome.ok) {
      failures.push(outcome.message);
      yield { type: "error", section: outcome.section, message: outcome.message };
      continue;
    }
    try {
      results[outcome.section] = parseTitledPersona(outcome.raw);
      applied += 1;
      yield { type: "section_complete", section: outcome.section };
    } catch (err) {
      // A 2xx response that wasn't valid JSON for this section: degrade too.
      const message = err instanceof Error ? err.message : String(err);
      failures.push(message);
      yield { type: "error", section: outcome.section, message };
    }
  }

  if (applied === 0) {
    throw new Error(
      `Mesh reading failed: all ${outcomes.length} sections failed. ${summarizeFailures(failures)}`,
    );
  }

  yield {
    type: "complete",
    reading: {
      connection: results.connection,
      timing_together: results.timing_together,
      care: results.care,
    },
  };
}
