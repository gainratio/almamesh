/**
 * CandidateCard — one ranked rectification candidate.
 *
 * Anti-scam invariants:
 *  - NO percentage anywhere — `fitScore`, `positiveTotal`, `penaltyTotal`,
 *    `priorBonus` and `contribution` are NEVER shown. The fit summary is
 *    COUNTS ONLY ("4 supporting fits · 1 unexplained event · 1 quiet-period miss").
 *  - The recorded-time prior surfaces as a labeled qualitative row (only when
 *    it actually applied), never as a number.
 *  - Quiet-period misses are listed qualitatively ("predicted a strong
 *    {category} window with nothing reported") — negative evidence is shown,
 *    not hidden.
 *  - The representative time is clearly labelled as a window estimate, not an
 *    exact-minute claim.
 *  - The rising sign + navamsa rising are the engine's verbatim output
 *    (title-cased for display).
 */

import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { RectificationCandidate } from '@almamesh/shared-types';
import { fitCounts, localizeSignal } from '../../../lib/rectifySignals';
import { EvidenceTable } from './EvidenceTable';

export interface CandidateCardProps {
  readonly candidate: RectificationCandidate;
  /** 1-based rank label shown to the user. */
  readonly rank: number;
  readonly onConfirm: (candidate: RectificationCandidate) => void;
}

/** "pisces" / "PISCES" → "Pisces" */
function titleCase(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1).toLowerCase();
}

export function CandidateCard({ candidate, rank, onConfirm }: CandidateCardProps): ReactElement {
  const { t } = useTranslation('rectify');

  const counts = fitCounts(candidate);
  const summaryParts = [t('results.fit_supporting', { count: counts.supporting })];
  if (counts.unexplained > 0) {
    summaryParts.push(t('results.fit_unexplained', { count: counts.unexplained }));
  }
  if (counts.quiet > 0) {
    summaryParts.push(t('results.fit_quiet', { count: counts.quiet }));
  }

  return (
    <div
      data-testid="candidate-card"
      className="flex flex-col gap-3 rounded-lg border border-border-subtle bg-surface-secondary p-4"
    >
      {/* Rank + Sign + Navamsa rising */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-text-tertiary">
            {t('results.candidate_label', { rank })}
          </p>
          <p className="mt-0.5 text-lg font-semibold text-text-primary">
            {titleCase(candidate.ascendantSign)}
          </p>
        </div>
        {candidate.navamsaLagnaSign != null && (
          <div
            data-testid="d9-chip"
            className="rounded-full border border-border-subtle bg-surface-primary px-3 py-1 text-right"
          >
            <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-text-tertiary">
              {t('results.navamsa_rising_label')}
            </p>
            <p className="text-sm font-medium text-text-primary">
              {titleCase(candidate.navamsaLagnaSign)}
            </p>
          </div>
        )}
      </div>

      {/* Fit summary — COUNTS ONLY, never scores */}
      <p data-testid="fit-summary" className="text-xs text-text-tertiary">
        {summaryParts.join(' · ')}
      </p>

      {/* Representative time */}
      <div className="rounded-md border border-border-subtle bg-surface-primary px-3 py-2">
        <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-text-tertiary">
          {t('results.representative_time_label')}
        </p>
        <p className="mt-0.5 font-mono text-sm font-medium text-text-primary">
          {candidate.representativeTimeLocal}
        </p>
        <p className="mt-1 text-[11px] leading-relaxed text-text-secondary italic">
          {t('results.representative_caveat')}
        </p>
      </div>

      {/* Supporting events */}
      {candidate.supportingEvents.length > 0 && (
        <div>
          <EvidenceTable events={candidate.supportingEvents} />
        </div>
      )}

      {/* Recorded-time prior — a labeled qualitative row, only when it applied */}
      {candidate.priorBonus > 0 && (
        <div
          data-testid="prior-row"
          className="rounded-md border border-accent-blue/30 bg-accent-blue/5 px-3 py-2"
        >
          <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-accent-blue">
            {t('results.prior_label')}
          </p>
          <p className="mt-0.5 text-xs leading-relaxed text-text-secondary">
            {t('signals.prior_anchor')}
          </p>
        </div>
      )}

      {/* Quiet-period misses — negative evidence, shown honestly */}
      {candidate.misses.length > 0 && (
        <div
          data-testid="miss-list"
          className="rounded-md border border-status-warning/40 bg-status-warning/5 px-3 py-2"
        >
          <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-status-warning">
            {t('results.misses_label')}
          </p>
          <ul className="mt-1 flex flex-col gap-1">
            {candidate.misses.map((miss) => (
              <li key={miss} className="text-xs leading-relaxed text-text-secondary">
                {localizeSignal(t, miss)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Confirm action */}
      <button
        type="button"
        data-testid="confirm-button"
        onClick={() => onConfirm(candidate)}
        className="mt-1 w-full rounded-md bg-accent-gold px-4 py-2 text-sm font-semibold text-background-primary transition-opacity hover:opacity-90 focus:outline-hidden focus:ring-2 focus:ring-accent-gold focus:ring-offset-2 focus:ring-offset-surface-secondary"
      >
        {t('results.confirm')}
      </button>
    </div>
  );
}
