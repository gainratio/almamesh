/**
 * RectifyResults — honest rectification results surface.
 *
 * Anti-scam mandate (enforced at this render boundary):
 *  - NEVER a headline percentage — `fitScore` / `margin` / `contribution` are
 *    never shown to the user.
 *  - `near_tie` band: BOTH top candidates are shown side by side with an
 *    explicit "only a recorded birth time can settle a near-tie" note.
 *  - `leans` band: labeled as a hypothesis, not a verdict.
 *  - `consistent` band: the leading candidate is highlighted with the honest
 *    caveat that no algorithm replaces a recorded birth certificate.
 *  - The honesty note comes verbatim from the engine via `honestyNoteKey`.
 *  - Representative times are labeled as window estimates, never exact minutes.
 */

import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { RectificationCandidate, RectificationResult } from '@almamesh/shared-types';
import {
  BirthTimeComparison,
  type CandidateReading,
} from '../settings/BirthTimeComparison';
import { cuspInfo } from '../../../lib/lagnaCusp';
import { decidedFamilies } from '../../../lib/rectifySignals';
import { CandidateCard } from './CandidateCard';

export interface RectifyResultsProps {
  readonly result: RectificationResult;
  /** The as-recorded time reading to show as a reference; null when unknown. */
  readonly recordedReading: CandidateReading | null;
  readonly onConfirm: (candidate: RectificationCandidate) => void;
  readonly onKeepRecorded: () => void;
}

/** Band label color by confidence level. */
function bandClass(band: RectificationResult['band']): string {
  if (band === 'consistent') return 'text-status-success';
  if (band === 'leans') return 'text-accent-blue';
  return 'text-status-warning'; // near_tie
}

/** Build a CandidateReading from a RectificationCandidate for BirthTimeComparison. */
function candidateReading(c: RectificationCandidate): CandidateReading {
  // lagnaLongitudeDeg is absolute ecliptic longitude; in-sign degrees = mod 30.
  return {
    time: c.representativeTimeLocal,
    sign: c.ascendantSign,
    signDegrees: c.lagnaLongitudeDeg % 30,
  };
}

/**
 * The engine's honestyNoteKey is prefixed with the namespace, e.g.
 * "rectify.honesty.consistent". Strip that prefix so it resolves cleanly
 * inside the `rectify` namespace via useTranslation('rectify').
 */
function stripNsPrefix(key: string, ns: string): string {
  const prefix = `${ns}.`;
  return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

/**
 * Resolve the engine's honesty-note key into a base band note plus an optional
 * Spec 062 lead qualifier. The engine emits either `rectify.honesty.{band}` or
 * a variant `rectify.honesty.{band}.prior_influenced` / `.penalty_driven` —
 * variants render the band's base note PLUS the matching caveat sentence, so
 * a prior-made or penalty-made lead is never presented as a clean event win.
 * Unknown qualifiers degrade gracefully to the base note.
 */
export function resolveHonestyKeys(honestyNoteKey: string): {
  baseKey: string;
  qualifierKey: string | null;
} {
  const key = stripNsPrefix(honestyNoteKey, 'rectify');
  const parts = key.split('.');
  if (parts[0] !== 'honesty' || parts.length < 2) {
    return { baseKey: key, qualifierKey: null };
  }
  const qualifier = parts[2];
  const qualifierKey =
    qualifier === 'prior_influenced' || qualifier === 'penalty_driven'
      ? `honesty_qualifier.${qualifier}`
      : null;
  return { baseKey: `honesty.${parts[1]}`, qualifierKey };
}

export function RectifyResults({
  result,
  recordedReading,
  onConfirm,
  onKeepRecorded,
}: RectifyResultsProps): ReactElement {
  const { t } = useTranslation('rectify');

  const { band, candidates, honestyNoteKey } = result;
  const { baseKey: honestyKey, qualifierKey: honestyQualifierKey } =
    resolveHonestyKeys(honestyNoteKey);
  const topCandidate = candidates[0];

  // "What decided it" — the top candidate's strongest evidence KINDS (never
  // scores). The D9 flip callout fires when navamsa signals contributed.
  const families = topCandidate != null ? decidedFamilies(topCandidate.supportingEvents) : [];
  const decidedReasons =
    families.length > 0
      ? families.map((family) => t(`results.reason_${family}`)).join(' · ')
      : t('results.reason_balance');
  const d9Contributed = families.includes('d9');

  // For the BirthTimeComparison: recorded vs top rectified candidate.
  const rectifiedReading = topCandidate != null ? candidateReading(topCandidate) : null;
  const cusp =
    topCandidate != null
      ? cuspInfo(topCandidate.ascendantSign, topCandidate.lagnaLongitudeDeg % 30)
      : null;

  const isNearTie = band === 'near_tie';
  const isWindowMode = result.mode === 'window';

  return (
    <div className="flex flex-col gap-6">
      {/* ── Window mode: sign-level caveat (not minute-level) ───────────── */}
      {isWindowMode && (
        <div
          data-testid="window-sign-caveat"
          className="rounded-md border border-accent-blue/30 bg-accent-blue/5 px-4 py-3"
          role="note"
        >
          <p className="text-sm leading-relaxed text-accent-blue">
            {t('results.window_caveat')}
          </p>
        </div>
      )}

      {/* ── Header: band label + honesty note ──────────────────────────── */}
      <div>
        <p
          data-testid="band-label"
          className={`text-xs font-semibold uppercase tracking-[0.18em] ${bandClass(band)}`}
        >
          {t(`band.${band}`)}
        </p>
        <p
          data-testid="honesty-note"
          className="mt-2 text-sm leading-relaxed text-text-secondary"
        >
          {t(honestyKey)}
        </p>
        {honestyQualifierKey != null && (
          <p
            data-testid="honesty-qualifier"
            className="mt-2 text-sm italic leading-relaxed text-text-secondary"
          >
            {t(honestyQualifierKey)}
          </p>
        )}
        <p data-testid="decided-line" className="mt-3 text-xs text-text-tertiary">
          {t('results.decided_line', { reasons: decidedReasons })}
        </p>
        {d9Contributed && (
          <p
            data-testid="d9-flip-callout"
            className="mt-1.5 text-xs leading-relaxed text-accent-blue"
          >
            {t('results.d9_flip_callout')}
          </p>
        )}
      </div>

      {/* ── Near-tie settle note ────────────────────────────────────────── */}
      {isNearTie && (
        <div
          data-testid="near-tie-settle-note"
          className="rounded-md border border-status-warning/40 bg-status-warning/5 px-4 py-3"
          role="note"
        >
          <p className="text-sm leading-relaxed text-status-warning">
            {t('results.near_tie_settle_note')}
          </p>
        </div>
      )}

      {/* ── Candidate cards ─────────────────────────────────────────────── */}
      {isNearTie ? (
        /* Near-tie: top 2 candidates side by side */
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {candidates.slice(0, 2).map((candidate, index) => (
            <CandidateCard
              key={candidate.ascendantSign + candidate.representativeTimeLocal}
              candidate={candidate}
              rank={index + 1}
              onConfirm={onConfirm}
            />
          ))}
        </div>
      ) : (
        /* Leans / consistent: ranked list */
        <div className="flex flex-col gap-4">
          {candidates.map((candidate, index) => (
            <CandidateCard
              key={candidate.ascendantSign + candidate.representativeTimeLocal}
              candidate={candidate}
              rank={index + 1}
              onConfirm={onConfirm}
            />
          ))}
        </div>
      )}

      {/* ── Recorded-time reference ─────────────────────────────────────── */}
      {/* Omit the entire section when no time was ever entered (unknown confidence). */}
      {recordedReading != null && (
        <div data-testid="recorded-reference">
          <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-text-tertiary">
            {t('results.recorded_reference_label')}
          </p>
          {rectifiedReading != null && (
            <BirthTimeComparison
              recorded={recordedReading}
              rectified={rectifiedReading}
              cusp={cusp}
            />
          )}
        </div>
      )}

      {/* ── Keep recorded action ─────────────────────────────────────────── */}
      <button
        type="button"
        data-testid="keep-recorded-button"
        onClick={onKeepRecorded}
        className="w-full rounded-md border border-border-subtle px-4 py-2 text-sm text-text-secondary transition-colors hover:border-text-tertiary hover:text-text-primary focus:outline-hidden focus:ring-2 focus:ring-accent-primary focus:ring-offset-2 focus:ring-offset-background-primary"
      >
        {t('results.keep_recorded')}
      </button>
    </div>
  );
}
