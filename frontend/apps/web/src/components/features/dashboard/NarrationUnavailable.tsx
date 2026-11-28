/**
 * NarrationUnavailable — the calm, secondary notice shown when the OPTIONAL AI
 * narration cannot be produced.
 *
 * WHY this exists: a red "Interpretation could not be generated" block reads as
 * "the product is broken", and it is not — the chart is fully computed on-device
 * without any AI. This renders the same information as an informational aside:
 * reassurance first (your chart is complete and correct), then the specific
 * reason and its next step in muted secondary text, then the recovery
 * affordances the caller supplies. Neutral surface, informational icon,
 * `role="status"` — deliberately NOT `text-status-error` / a red border / a red
 * background, and deliberately not an `alert`.
 *
 * Only genuine defects keep the louder treatment; `NarrationOutage`'s `fault`
 * value is excluded from this component's props by construction.
 */
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { NarrationOutage } from '../../../lib/narrationOutage';

export interface NarrationUnavailableProps {
  /** Which optional-enhancement outage this is — picks the reason + next step. */
  readonly outage: Exclude<NarrationOutage, 'fault'>;
  /**
   * `fresh` — no reading on screen: reassure that the chart itself is complete.
   * `kept`  — a previous reading is still shown below: reassure it is untouched.
   */
  readonly context: 'fresh' | 'kept';
  /** Recovery affordances (Retry, AI settings, …). Rendered small and muted. */
  readonly actions?: ReactNode;
  /** Test hook for the notice root; child hooks are derived from it. */
  readonly testId: string;
}

export function NarrationUnavailable({
  outage,
  context,
  actions,
  testId,
}: NarrationUnavailableProps) {
  const { t } = useTranslation('dashboard');
  const kept = context === 'kept';
  return (
    <div
      role={kept ? 'alert' : 'status'}
      data-testid={testId}
      className={
        kept
          ? 'flex items-start gap-3 rounded-lg border border-accent-gold/50 bg-accent-gold/10 px-4 py-3'
          : 'flex items-start gap-3 rounded-lg border border-ui-border bg-background-tertiary/40 px-4 py-3'
      }
    >
      <svg
        className={kept ? 'mt-0.5 h-4 w-4 shrink-0 text-accent-gold' : 'mt-0.5 h-4 w-4 shrink-0 text-text-muted'}
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d={
            kept
              ? 'M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z'
              : 'M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z'
          }
        />
      </svg>
      <div className="min-w-0 flex-1 space-y-2">
        <p
          className="text-sm font-medium text-text-primary"
          data-testid={`${testId}-reassurance`}
        >
          {t(kept ? 'narration.kept_title' : 'narration.chart_complete_title')}
        </p>
        {kept ? (
          <>
            <p
              className="max-w-prose text-sm leading-relaxed text-text-primary"
              data-testid={`${testId}-reason`}
            >
              {t(`narration.reason_${outage}`)} {t(`narration.next_${outage}`)}
            </p>
            <p className="max-w-prose text-xs leading-relaxed text-text-secondary">
              {t('narration.kept_body')}
            </p>
          </>
        ) : (
          <>
            <p className="max-w-prose text-sm leading-relaxed text-text-secondary">
              {t('narration.chart_complete_body')}
            </p>
            <p
              className="max-w-prose text-xs leading-relaxed text-text-muted"
              data-testid={`${testId}-reason`}
            >
              {t(`narration.reason_${outage}`)} {t(`narration.next_${outage}`)}
            </p>
          </>
        )}
        {actions != null && (
          <div className="flex flex-wrap items-center gap-3 text-xs text-text-secondary">{actions}</div>
        )}
      </div>
    </div>
  );
}
