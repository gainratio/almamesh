/**
 * The citation validator — the anti-hallucination guard. It FAILS CLOSED.
 *
 * THE TRAP THIS EXISTS TO CLOSE. An Evidence block makes any sentence LOOK
 * derived. Put "protect your time, energy and money rather than giving them away
 * too freely" under a heading that says Evidence and Confidence, and a reader
 * will take it for chart-derivation whether or not a single computed value went
 * into it. That is strictly worse than plain prose: it launders plausible wisdom
 * into apparent rigour. Wrong AND authoritative-looking.
 *
 * So the model is not allowed to author observations. The deterministic layer
 * computes them (`observations.ts`) and hands the model a list of ids; the model
 * may only ATTACH prose to an id that already exists. Two outcomes, and no third:
 *
 *   REJECTED — the annotation names an observation id (or an extra citation)
 *              that is not in this chart. The prose does not render anywhere.
 *              Not downgraded, not shown with a warning: a statement that
 *              asserts a derivation which did not happen has forfeited its
 *              place. Promoting it to "general guidance" would reward the
 *              hallucination by still printing it.
 *
 *   GENERAL   — the model DECLARED the statement ungrounded by putting it in
 *   GUIDANCE   `general_guidance` instead. That is honest, so it is kept — but
 *              rendered in a visually separate section with NO evidence, NO
 *              confidence and NO alternative beside it. A vague evidence block
 *              is worse than none; this is the "or not at all" alternative,
 *              taken as "clearly separate" because deleting it would hide from
 *              the reader that the model was talking rather than the chart.
 *
 * Rejections are COUNTED and surfaced in Assumptions & Provenance, so a drop is
 * never silent even though the text never appears.
 *
 * NOT A REFLECTION — an interpretation or guidance statement that foretells,
 *              narrates the tools or guesses what the person lived through
 *              (the one reflection check, `@almamesh/llm/reflection`, every app
 *              language). Rejected and counted like a bogus citation.
 *
 * UN-BYPASSABLE BY CONSTRUCTION: `buildEvidenceLedger` is the only way to build
 * a renderable ledger, and it runs this validation internally. There is no path
 * from raw model output to the document that does not pass through here.
 */

import { reflectionIssues } from '@almamesh/llm/reflection';

/** Raw, untrusted model output. Every field is checked before it is believed. */
export interface RawAnnotation {
  readonly observation_id?: unknown;
  readonly interpretation?: unknown;
  readonly also_cites?: unknown;
}

export interface RawAnnotationPayload {
  readonly readings?: unknown;
  readonly general_guidance?: unknown;
}

/** An annotation that survived validation: prose bound to a real observation. */
export interface AcceptedAnnotation {
  readonly observationId: string;
  readonly interpretation: string;
  /** Extra factor ids the model cited, all verified present in this chart. */
  readonly alsoCites: readonly string[];
}

export type RejectionReason =
  | 'unknown-observation'
  | 'unknown-factor'
  | 'malformed'
  | 'empty-interpretation'
  | 'not-reflection';

export interface RejectedAnnotation {
  /** What the model claimed to be citing, verbatim, for the provenance count. */
  readonly citedId: string;
  readonly reason: RejectionReason;
}

export interface ValidatedAnnotations {
  readonly accepted: readonly AcceptedAnnotation[];
  readonly rejected: readonly RejectedAnnotation[];
  /** Statements the model itself declared ungrounded. Rendered apart. */
  readonly generalGuidance: readonly string[];
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function validateOne(
  raw: RawAnnotation,
  observationIds: ReadonlySet<string>,
  factorIds: ReadonlySet<string>,
): AcceptedAnnotation | RejectedAnnotation {
  const observationId = raw.observation_id;
  if (typeof observationId !== 'string' || observationId === '') {
    return { citedId: String(observationId ?? ''), reason: 'malformed' };
  }
  const interpretation = raw.interpretation;
  if (typeof interpretation !== 'string' || interpretation.trim() === '') {
    return { citedId: observationId, reason: 'empty-interpretation' };
  }
  if (reflectionIssues(interpretation).length > 0) {
    return { citedId: observationId, reason: 'not-reflection' };
  }
  if (!observationIds.has(observationId)) {
    return { citedId: observationId, reason: 'unknown-observation' };
  }
  const alsoCites = asStringArray(raw.also_cites);
  const bogus = alsoCites.find((id) => !factorIds.has(id));
  if (bogus !== undefined) {
    // One fabricated supporting citation condemns the whole statement. A claim
    // that cites three real factors and one invented one is not 75% true.
    return { citedId: bogus, reason: 'unknown-factor' };
  }
  return { observationId, interpretation: interpretation.trim(), alsoCites };
}

function isRejection(
  result: AcceptedAnnotation | RejectedAnnotation,
): result is RejectedAnnotation {
  return 'reason' in result;
}

/**
 * Validate raw model output against the factors and observations THIS chart
 * actually produced. Nothing here trusts a field's type without checking it —
 * the payload arrived from a language model over HTTP.
 */
export function validateAnnotations(
  payload: RawAnnotationPayload | null | undefined,
  observationIds: ReadonlySet<string>,
  factorIds: ReadonlySet<string>,
): ValidatedAnnotations {
  if (payload == null || typeof payload !== 'object') {
    return { accepted: [], rejected: [], generalGuidance: [] };
  }
  const rows = Array.isArray(payload.readings) ? payload.readings : [];
  const accepted: AcceptedAnnotation[] = [];
  const rejected: RejectedAnnotation[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    if (row == null || typeof row !== 'object') {
      rejected.push({ citedId: '', reason: 'malformed' });
      continue;
    }
    const result = validateOne(row as RawAnnotation, observationIds, factorIds);
    if (isRejection(result)) {
      rejected.push(result);
      continue;
    }
    // One interpretation per observation: a second is a duplicate claim on the
    // same evidence and cannot both be the reading.
    if (seen.has(result.observationId)) {
      rejected.push({ citedId: result.observationId, reason: 'unknown-observation' });
      continue;
    }
    seen.add(result.observationId);
    accepted.push(result);
  }

  const generalGuidance: string[] = [];
  for (const text of asStringArray(payload.general_guidance).map((item) => item.trim())) {
    if (text === '') continue;
    if (reflectionIssues(text).length > 0) rejected.push({ citedId: '', reason: 'not-reflection' });
    else generalGuidance.push(text);
  }
  return { accepted, rejected, generalGuidance };
}
