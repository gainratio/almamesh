/**
 * The two screens the dashboard shows when it has no chart to draw.
 *
 * They are different things and must not share copy:
 *
 * - `NoChartYet` — the ACTIVE person has no saved chart. Usually a person just
 *   created, but a reload during the first compute used to lose the chart for
 *   good (prod 6a89c0e, 2026-10-05) and no birth data survives to rebuild from.
 *   So the copy never claims "nothing was lost": it says no saved chart was
 *   found, why that can happen, and offers to rebuild it for THIS person.
 * - `ChartReadFailed` — the on-device read genuinely rejected. Honest error
 *   copy, and a retry that can actually change the outcome.
 *
 * Deliberately NOT exported from the `dashboard` barrel: tests that stub the
 * heavy chart surfaces (`vi.mock('.../features/dashboard')`) must still render
 * these two states for real.
 */
import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import type { TFunction } from 'i18next';

export interface ChartlessStateProps {
  readonly t: TFunction;
}

export interface NoChartYetProps extends ChartlessStateProps {
  /** The active person's name, when one is known. */
  readonly personName: string | null;
  /** The active person's id: the rebuild reuses it, never a new profile. */
  readonly personId: string | null;
}

const SHELL = 'flex min-h-[60vh] flex-col items-center justify-center p-8';
const PRIMARY =
  'rounded-lg bg-accent-gold px-6 py-3 font-semibold text-background-primary transition-colors hover:bg-accent-gold/90';
const SECONDARY =
  'rounded-lg border border-ui-border px-6 py-3 text-text-secondary transition-colors hover:border-accent-gold/40 hover:text-text-primary';

/** Normal empty state: this person's chart hasn't been created yet. */
export function NoChartYet({ t, personName, personId }: NoChartYetProps): ReactElement {
  const onboardingPath = personId
    ? `/onboarding?person=${encodeURIComponent(personId)}`
    : '/onboarding';
  return (
    <div className={SHELL}>
      <div data-testid="no-chart-state" className="max-w-md text-center">
        <h2 className="mb-2 text-xl font-bold text-text-primary">
          {personName
            ? t('dashboard:error.title', { name: personName })
            : t('dashboard:error.title_unnamed')}
        </h2>
        <p className="mb-6 text-text-secondary">
          {personName
            ? t('dashboard:error.body_missing', { name: personName })
            : t('dashboard:error.body')}
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Link to={onboardingPath} data-testid="no-chart-create" className={PRIMARY}>
            {personName ? t('dashboard:actions.rebuild_chart') : t('dashboard:actions.create_chart')}
          </Link>
          <Link to="/settings/people" data-testid="no-chart-switch" className={SECONDARY}>
            {t('dashboard:actions.manage_people')}
          </Link>
        </div>
      </div>
    </div>
  );
}

/** Genuine failure: the on-device chart read rejected. Retrying is real. */
export function ChartReadFailed({ t }: ChartlessStateProps): ReactElement {
  return (
    <div className={SHELL}>
      <div data-testid="chart-read-failed" className="max-w-md text-center">
        <div className="mb-6">
          <svg
            className="mx-auto h-16 w-16 text-status-warning"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
        </div>
        <h2 className="mb-2 text-xl font-bold text-text-primary">
          {t('dashboard:error.read_failed_title')}
        </h2>
        <p className="mb-6 text-text-secondary">{t('dashboard:error.read_failed_body')}</p>
        <button type="button" onClick={() => window.location.reload()} className={PRIMARY}>
          {t('dashboard:actions.try_again')}
        </button>
      </div>
    </div>
  );
}
