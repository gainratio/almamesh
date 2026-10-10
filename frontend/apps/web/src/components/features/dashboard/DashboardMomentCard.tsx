/**
 * What the Dashboard shows for a time-travel moment: the maha and antar dasha
 * (pure selection over the chart's own dasha list) and the transits from the
 * period sky. No astrology here, no AI.
 */
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { SiderealChart, VimshottariDasha } from '@almamesh/browser/types';
import { selectDashasForPeriod } from '@almamesh/llm';
import type { ChatThreadAsOf, ProcessedBirthData } from '@almamesh/shared-types';
import { useChartLibraryStore } from '@almamesh/store';

import { momentPeriod, useMomentSky, type MomentSky } from '../../../lib/momentSky';
import { formatPinLabel } from '../../../lib/timeTravelSheet';
import type { ChartEngineContextValue } from '../../../providers/chartEngineContext';
import { TransitsPanel } from '../predictive/TransitsPanel';

export interface DashboardMomentCardProps {
  readonly asOf: ChatThreadAsOf;
  readonly dashas: VimshottariDasha | undefined;
  readonly birthYear: number | undefined;
  readonly sky: MomentSky;
  readonly onRetry: () => void;
  readonly language: string;
}

interface SkyPartProps {
  readonly sky: MomentSky;
  readonly period: string;
  readonly onRetry: () => void;
}

function SkyPart({ sky, period, onRetry }: SkyPartProps): ReactElement {
  const { t } = useTranslation('dashboard');
  if (sky.kind === 'dashas-only') {
    return <p data-testid="time-travel-moment-dashas-only" className="text-sm text-text-secondary">{t('time_travel.dashas_only')}</p>;
  }
  if (sky.kind === 'working') {
    return <p data-testid="time-travel-moment-working" role="status" className="text-sm text-text-secondary">{t('time_travel.working', { period })}</p>;
  }
  if (sky.kind === 'failed') {
    return (
      <p data-testid="time-travel-moment-failed" role="alert" className="text-sm text-status-error">
        {t('time_travel.failed')}{' '}
        <button type="button" onClick={onRetry} className="min-h-11 underline">{t('time_travel.retry')}</button>
      </p>
    );
  }
  return (
    <section data-testid="time-travel-moment-transits" aria-label={t('time_travel.transits_title')}>
      <h3 className="mb-2 text-sm font-semibold text-text-primary">{t('time_travel.transits_title')}</h3>
      <TransitsPanel transitCtx={sky.transits} />
    </section>
  );
}

export function DashboardMomentCard({ asOf, dashas, birthYear, sky, onRetry, language }: DashboardMomentCardProps): ReactElement {
  const { t } = useTranslation(['dashboard', 'predictive']);
  const selected = dashas ? selectDashasForPeriod(dashas, momentPeriod(asOf), birthYear) : undefined;
  // Every row that overlaps the moment, in order: a Year can cross a boundary.
  const lords = (rows: readonly { readonly lord: string }[] | undefined): string =>
    rows?.length ? rows.map((row) => t(`predictive:graha.${row.lord.toLowerCase()}`)).join(' → ') : '—';
  return (
    <div data-testid="time-travel-moment-card" className="mx-4 mt-3 space-y-3 rounded-lg border border-accent-gold/30 p-4">
      <h2 className="text-base font-semibold text-text-primary">{t('dashboard:time_travel.moment_title')}</h2>
      <dl data-testid="time-travel-moment-dasha" className="grid grid-cols-2 gap-2 text-sm">
        <dt>{t('dashboard:time_travel.maha')}</dt>
        <dd data-testid="time-travel-moment-maha">{lords(selected?.maha)}</dd>
        <dt>{t('dashboard:time_travel.antar')}</dt>
        <dd data-testid="time-travel-moment-antar">{lords(selected?.antar)}</dd>
      </dl>
      <SkyPart sky={sky} period={formatPinLabel(asOf, language)} onRetry={onRetry} />
    </div>
  );
}

export interface DashboardMomentProps {
  readonly asOf: ChatThreadAsOf;
  readonly chart: SiderealChart | null;
  readonly chartId: string | null;
  readonly engine: ChartEngineContextValue | null;
  readonly birthYear: number | undefined;
  readonly language: string;
}

/** The card wired to the period sky. profileKey and birth match the chat's (Dashboard.tsx), so both share one compute. */
export function DashboardMoment({ asOf, chart, chartId, engine, birthYear, language }: DashboardMomentProps): ReactElement {
  const stored = useChartLibraryStore((s) => (chartId ? s.charts[chartId] : undefined));
  const { sky, retry } = useMomentSky({
    asOf,
    chart,
    profileKey: stored?.profile_id ?? chartId ?? 'primary',
    birth: stored?.birth_data as ProcessedBirthData | undefined,
    engine,
  });
  return <DashboardMomentCard asOf={asOf} dashas={chart?.dashas} birthYear={birthYear} sky={sky} onRetry={retry} language={language} />;
}
