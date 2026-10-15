/**
 * What the Dashboard shows for a time-travel moment: the maha and antar dasha
 * (pure selection over the chart's own dasha list) and the transits from the
 * period sky. No astrology here, no AI.
 */
import { useEffect, useId, useRef, type ReactElement, type RefObject } from 'react';
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
  /** This card is the result of a Go just now: bring it into view and focus it. */
  readonly arrive?: boolean;
  readonly onArrived?: () => void;
}

/**
 * On a phone the card renders below the fold, so after Go nothing visibly
 * happened. Scroll it to the top (instantly under reduced motion) and move
 * focus to it, so sighted and screen-reader users both land on the trip.
 */
function useArrival(ref: RefObject<HTMLElement | null>, arrive: boolean, onArrived: (() => void) | undefined): void {
  useEffect(() => {
    const card = ref.current;
    if (!arrive || !card) return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    card.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
    card.focus({ preventScroll: true });
    onArrived?.();
  }, [ref, arrive, onArrived]);
}

interface SkyPartProps {
  readonly sky: MomentSky;
  readonly period: string;
}

/**
 * The short line the polite live region announces: dashas only, working, or a
 * one-line "ready". Never the transits table, never the failure (that is an alert).
 */
function SkyStatus({ sky, period }: SkyPartProps): ReactElement | null {
  const { t } = useTranslation(['dashboard', 'chat']);
  if (sky.kind === 'dashas-only') {
    return <p data-testid="time-travel-moment-dashas-only" className="text-sm text-text-secondary">{t('dashboard:time_travel.dashas_only')}</p>;
  }
  if (sky.kind === 'working') {
    // The chat's own progress line: one string for one compute.
    return <p data-testid="time-travel-moment-working" className="text-sm text-text-secondary">{t('chat:time_travel.status_working', { period })}</p>;
  }
  if (sky.kind === 'ready') {
    return <p className="sr-only">{t('dashboard:time_travel.sky_ready', { period })}</p>;
  }
  return null;
}

interface SkyBodyProps {
  readonly sky: MomentSky;
  readonly onRetry: () => void;
}

/** What sits under the status line: the failure alert or the transits. */
function SkyBody({ sky, onRetry }: SkyBodyProps): ReactElement | null {
  const { t } = useTranslation('dashboard');
  if (sky.kind === 'failed') {
    return (
      <p data-testid="time-travel-moment-failed" role="alert" className="text-sm text-status-error">
        {t('time_travel.failed')}{' '}
        <button type="button" onClick={onRetry} className="min-h-11 underline">{t('time_travel.retry')}</button>
      </p>
    );
  }
  if (sky.kind !== 'ready') return null;
  return (
    <section data-testid="time-travel-moment-transits" aria-label={t('time_travel.transits_title')}>
      <h3 className="mb-2 text-sm font-semibold text-text-primary">{t('time_travel.transits_title')}</h3>
      {/* The card's own heading names the moment; no line may read as now. */}
      <TransitsPanel transitCtx={sky.transits} frame="moment" />
    </section>
  );
}

export function DashboardMomentCard({ asOf, dashas, birthYear, sky, onRetry, language, arrive, onArrived }: DashboardMomentCardProps): ReactElement {
  const { t } = useTranslation(['dashboard', 'predictive']);
  const cardRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useArrival(cardRef, arrive === true, onArrived);
  const period = formatPinLabel(asOf, language);
  const selected = dashas ? selectDashasForPeriod(dashas, momentPeriod(asOf), birthYear) : undefined;
  // Every row that overlaps the moment, in order: a Year can cross a boundary.
  const lords = (rows: readonly { readonly lord: string }[] | undefined): string =>
    rows?.length ? rows.map((row) => t(`predictive:graha.${row.lord.toLowerCase()}`)).join(' → ') : '—';
  return (
    <div ref={cardRef} tabIndex={-1} aria-labelledby={titleId} data-testid="time-travel-moment-card"
      className="mx-4 mt-3 scroll-mt-20 space-y-3 rounded-lg border border-accent-gold/30 p-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-gold/60">
      <h2 id={titleId} className="text-base font-semibold text-text-primary">{t('dashboard:time_travel.moment_title')}</h2>
      <dl data-testid="time-travel-moment-dasha" className="grid grid-cols-2 gap-2 text-sm">
        <dt>{t('dashboard:time_travel.maha')}</dt>
        <dd data-testid="time-travel-moment-maha">{lords(selected?.maha)}</dd>
        <dt>{t('dashboard:time_travel.antar')}</dt>
        <dd data-testid="time-travel-moment-antar">{lords(selected?.antar)}</dd>
      </dl>
      {/* One live region that stays mounted while its short text changes, so
          screen readers announce working → ready. The table and the failure
          (role="alert") sit outside it. */}
      <div data-testid="time-travel-moment-status" aria-live="polite">
        <SkyStatus sky={sky} period={period} />
      </div>
      <SkyBody sky={sky} onRetry={onRetry} />
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
  readonly arrive?: boolean;
  readonly onArrived?: () => void;
}

/** The card wired to the period sky. profileKey and birth match the chat's (Dashboard.tsx), so both share one compute. */
export function DashboardMoment({ asOf, chart, chartId, engine, birthYear, language, arrive, onArrived }: DashboardMomentProps): ReactElement {
  const stored = useChartLibraryStore((s) => (chartId ? s.charts[chartId] : undefined));
  const { sky, retry } = useMomentSky({
    asOf,
    chart,
    profileKey: stored?.profile_id ?? chartId ?? 'primary',
    birth: stored?.birth_data as ProcessedBirthData | undefined,
    engine,
  });
  return <DashboardMomentCard asOf={asOf} dashas={chart?.dashas} birthYear={birthYear} sky={sky} onRetry={retry} language={language}
    arrive={arrive} onArrived={onArrived} />;
}
