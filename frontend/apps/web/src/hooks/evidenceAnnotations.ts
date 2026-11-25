/**
 * The evidence-annotation request — the report's SECOND, optional model call.
 *
 * WHAT IT DOES. After a reading finishes, this asks the model to attach
 * interpretation prose to observations the deterministic engine has ALREADY
 * computed. The model authors nothing: it receives the engine's observation ids
 * and the engine's citable-factor allowlist, and anything it cites outside that
 * list is discarded later by `lib/evidence/ledger.ts`.
 *
 * WHY THE PROMPT STRINGS ARE DELIBERATELY DULL. The `statement` and `evidence`
 * fields here are PROMPT INPUT, not rendered copy — the renderer builds its own
 * localized strings from the same factors. So they are derived mechanically from
 * the `ChartFactor` union: sign, degrees, orb, dates, grade. Nothing interpretive
 * goes in, because an interpretive sentence sitting in a field labelled
 * "evidence" is exactly the laundering the evidence layer exists to prevent.
 *
 * WHY EVERY FAILURE IS SWALLOWED. Annotations are an enhancement on top of a
 * report that is already complete without them. A keyless reader gets the full
 * Observation / Evidence / Confidence / Alternative table; a failed call gets the
 * same. Nothing here may ever reach the reading's own error path.
 */

import {
  requestEvidenceAnnotations,
  sanitizeChartForLlm,
  type AnalysisInstant,
  type EvidenceObservationPrompt,
  type ProviderConfig,
  type RawEvidenceAnnotationPayload,
} from '@almamesh/llm';
import { safeError } from '@almamesh/shared-types';
import type { SiderealChart, YogaDashaActivation } from '@almamesh/browser/types';

import { aiErrorRegistry } from '../lib/errors';
import { buildObservations, type ChartFactor, type Observation } from '../lib/evidence';

/** The engine's observation prompts plus the exhaustive citation allowlist. */
export interface ObservationPrompts {
  readonly observations: readonly EvidenceObservationPrompt[];
  readonly factorIds: readonly string[];
}

export interface EvidenceAnnotationRequest {
  /** The same chart the reading was generated from. */
  readonly chart: SiderealChart;
  /** The chart's analysis instant (`storedChartAnalysisInstant`), never the wall clock. */
  readonly asOf: AnalysisInstant;
  /** The interpretation path's resolved provider config — no separate setting. */
  readonly config: ProviderConfig;
  /** The user's persisted UI language, as the reading itself used. */
  readonly language: string;
  /** The reading's abort signal, so cancelling the reading cancels this too. */
  readonly signal: AbortSignal;
}

/**
 * Whether an annotation call may be attempted at all.
 *
 * A resolved config only carries an `apiKey` when the user explicitly configured
 * an endpoint AND a key (see `resolveProviderConfig`). With no key the config is
 * the unconfigured `local_only` loopback default — the "no AI set up" state — and
 * firing a request there can only produce a failure the reader never asked for.
 * So: no key, no call. The report is complete without it.
 */
export function canRequestEvidenceAnnotations(config: ProviderConfig): boolean {
  return typeof config.apiKey === 'string' && config.apiKey.length > 0;
}

/** Two decimals, or an explicit `n/a` — never `NaN` or `undefined` in a prompt. */
function num(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : 'n/a';
}

/** The engine's own wording for a factor. Descriptive only, never interpretive. */
function statementOf(factor: ChartFactor): string {
  switch (factor.kind) {
    case 'lagna':
      return `ascendant ${factor.sign}`;
    case 'position':
      return `${factor.planet} in ${factor.sign}`;
    case 'dignity':
      return `${factor.planet} ${factor.dignity} in ${factor.sign}`;
    case 'combustion':
      return `${factor.planet} ${factor.combust ? 'combust' : 'not combust'}`;
    case 'retrograde':
      return `${factor.planet} retrograde`;
    case 'housePlacement':
      return `${factor.planet} in house ${factor.house}`;
    case 'rulership':
      return `${factor.planet} rules house(s) ${factor.housesRuled.join(', ')}`;
    case 'dasha':
      return `${factor.level} dasha of ${factor.lord}${factor.current ? ' (running)' : ''}`;
    case 'yoga':
      return `${factor.name} yoga present`;
    case 'yogaStrength':
      return `${factor.name} strength ${num(factor.strengthPct)}%`;
  }
}

/** The computed values behind a factor — the numbers, verbatim from the engine. */
function evidenceOf(factor: ChartFactor): string {
  switch (factor.kind) {
    case 'lagna':
      return `${num(factor.signDegrees)}deg ${factor.sign}${cuspEvidence(factor.cuspDistanceDeg, factor.adjacentSign)}`;
    case 'position':
      return `${num(factor.signDegrees)}deg ${factor.sign}, nakshatra ${factor.nakshatra} pada ${factor.pada}`;
    case 'dignity':
      return `dignity=${factor.dignity} at ${num(factor.signDegrees)}deg ${factor.sign}`;
    case 'combustion':
      return `separation ${num(factor.separationDeg)}deg, orb ${num(factor.orbDeg)}deg, retrograde=${factor.retrograde}`;
    case 'retrograde':
      return `speed ${num(factor.speedDegPerDay)}deg/day`;
    case 'housePlacement':
      return `house ${factor.house}, sign ${factor.sign}`;
    case 'rulership':
      return `houses ruled ${factor.housesRuled.join(', ')}, yogakaraka=${factor.yogakaraka}`;
    case 'dasha':
      return `${factor.startIso} to ${factor.endIso}, ${num(factor.durationYears)} years, convention=${factor.convention}`;
    case 'yoga':
      return `grade=${factor.grade}, category=${factor.category}, houses ${listOr(factor.housesInvolved)}, planets ${listOr(factor.planetsInvolved)}${activationEvidence(factor.dashaActivation)}`;
    case 'yogaStrength':
      return `net marks ${factor.netMarks} (max favorable ${factor.maxFavorable}, max unfavorable ${factor.maxUnfavorable})`;
  }
}

/** The ascendant's distance to its boundary, when the engine measured one. */
function cuspEvidence(distanceDeg: number | null, adjacentSign: string | null): string {
  if (distanceDeg === null || adjacentSign === null) {
    return '';
  }
  return `, ${num(distanceDeg)}deg from ${adjacentSign}`;
}

function listOr(values: readonly (string | number)[]): string {
  return values.length > 0 ? values.join('/') : 'none';
}

function activationEvidence(activation: YogaDashaActivation | null | undefined): string {
  if (!activation) return '';
  const direct = activation.direct_lords.map((d) => `${d.level}:${d.lord}`).join('/');
  const chains = activation.dispositor_chains
    .map((c) => `${c.level}:${c.chain.join('->')}`)
    .join('/');
  const aspects = activation.aspect_links
    .map((a) => `${a.level}:${a.lord}->${a.target}(h${a.house_offset})`)
    .join('/');
  const mitigating = activation.mitigating_factors
    .map((m) =>
      m.kind === 'lagna_near_cusp'
        ? m.kind
        : `${m.planet ?? ''}:${m.kind}${m.house != null ? `(h${m.house})` : ''}`,
    )
    .join('/');
  const parts = [`dasha_activation=${activation.status}`];
  if (direct) parts.push(`direct=${direct}`);
  if (chains) parts.push(`dispositor=${chains}`);
  if (aspects) parts.push(`aspect=${aspects}`);
  if (mitigating) parts.push(`mitigating=${mitigating}`);
  return `, ${parts.join(', ')}`;
}

/** One observation as prompt input: its own numbers, then its support's. */
function promptFor(observation: Observation): EvidenceObservationPrompt {
  const support = observation.supporting
    .slice(1)
    .map((factor) => `${factor.id} (${statementOf(factor)}: ${evidenceOf(factor)})`);
  return {
    id: observation.id,
    statement: statementOf(observation.primary),
    evidence: [evidenceOf(observation.primary), ...support].join(' | '),
  };
}

/**
 * Build the prompt rows from the engine's OWN observation ledger.
 *
 * There is exactly one observation list in this app (`lib/evidence`), and this
 * reads it. A second list built for the prompt would drift from the one the
 * ledger validates against, and every drifted id would be silently rejected.
 */
export function buildObservationPrompts(chart: SiderealChart): ObservationPrompts {
  const ledger = buildObservations(chart);
  return {
    observations: ledger.observations.map(promptFor),
    factorIds: [...ledger.factorIds],
  };
}

export type EvidenceAnnotationOutcome =
  | { readonly kind: 'skipped' }
  | { readonly kind: 'ok'; readonly payload: RawEvidenceAnnotationPayload }
  | { readonly kind: 'failed'; readonly errorCode: string };

const inFlightAnnotations = new Map<string, Promise<void>>();

/** Register an in-flight evidence-annotation run so PDF export can await it cleanly. */
export function trackEvidenceAnnotationFlight(chartId: string, task: Promise<void>): Promise<void> {
  const settled = task.finally(() => {
    if (inFlightAnnotations.get(chartId) === settled) {
      inFlightAnnotations.delete(chartId);
    }
  });
  inFlightAnnotations.set(chartId, settled);
  return settled;
}

const MAX_EXPORT_ANNOTATION_WAIT_MS = 15_000;

/** Wait (up to 15s) for any in-flight evidence-annotation call on `chartId` (or exit on abort). */
export async function awaitInFlightEvidenceAnnotations(
  chartId: string,
  signal?: AbortSignal,
): Promise<void> {
  const pending = inFlightAnnotations.get(chartId);
  if (!pending || signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, MAX_EXPORT_ANNOTATION_WAIT_MS);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    void pending.finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    });
  });
}

/**
 * Ask the model to annotate this chart's observations, distinguishing a skipped
 * keyless run from a provider/parse failure.
 */
export async function fetchEvidenceAnnotationsOutcome(
  request: EvidenceAnnotationRequest,
): Promise<EvidenceAnnotationOutcome> {
  if (!canRequestEvidenceAnnotations(request.config)) {
    return { kind: 'skipped' };
  }
  let built: ObservationPrompts;
  try {
    built = buildObservationPrompts(request.chart);
  } catch (err) {
    safeError('report.evidence_annotation_failed', err);
    return { kind: 'skipped' };
  }
  if (built.observations.length === 0) {
    return { kind: 'skipped' };
  }
  try {
    const payload = await requestEvidenceAnnotations({
      chart: sanitizeChartForLlm(request.chart, request.asOf),
      observations: built.observations,
      factorIds: built.factorIds,
      config: request.config,
      language: request.language,
      signal: request.signal,
    });
    return { kind: 'ok', payload };
  } catch (err) {
    if (request.signal.aborted) {
      return { kind: 'skipped' };
    }
    // Only an allowlisted diagnostic code: a provider error can carry the
    // endpoint or prompt-adjacent data and must never be serialized to console.
    safeError('report.evidence_annotation_failed', err);
    return { kind: 'failed', errorCode: aiErrorRegistry.classify(err) };
  }
}

/**
 * Ask the model to annotate this chart's observations.
 *
 * Returns the RAW payload, or `null` when no call was made or the call failed.
 * NEVER throws: every caller is on the success path of a reading that is already
 * saved, and a thrown error there would degrade a reading that is perfectly fine.
 */
export async function fetchEvidenceAnnotations(
  request: EvidenceAnnotationRequest,
): Promise<RawEvidenceAnnotationPayload | null> {
  const outcome = await fetchEvidenceAnnotationsOutcome(request);
  return outcome.kind === 'ok' ? outcome.payload : null;
}
