/**
 * PeriodsPanel — the Vimśottarī explorer: the chart's full 120-year daśā tree
 * as a quiet typographic drill-down, enriched with plain-language ("For You")
 * and technical ("For Astrologer") sub-period meaning descriptions and bullet
 * points of themes & dated sky aspects inside each sub-period.
 *
 * Data is the NATAL chart's engine-emitted dasha + planet payload (renders
 * instantly with zero compute), optionally enriched with dated `TransitCtx`
 * events when the predictive layer is ready. Older stored charts without depth
 * fields degrade to the plain mahā table plus an honest note.
 */

import { useMemo, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { TransitCtx } from '@almamesh/shared-types';

import { Card, Disclosure } from '../../ui';
import { cn } from '../../ui/cn';
import {
  durationParts,
  type DashaTreeRow,
  type DashaTreeSource,
} from '../../../lib/dashaPeriods';
import { formatPredictiveDate, sortSlowHits } from '../../../lib/predictive';
import { grahaName } from '../../../lib/predictiveEventCopy';
import {
  buildSubperiodGuide,
  type SubperiodAudience,
  type SubperiodPlanetFact,
  type SubperiodYogaFact,
} from '../../../lib/subperiodGuide';
import type { SlowHitItem } from '../../../lib/subperiodSky';
import { useContentModeStore } from '../../../stores/contentMode';
import { SubperiodGuideBlock } from './SubperiodGuideBlock';

export interface PeriodsPanelProps {
  /** The natal `sidereal_chart.dashas` payload; absent on older stored charts. */
  readonly dashas?: DashaTreeSource;
  /** Verbatim natal `sidereal_chart.planets` map for chart-specific house/dignity context. */
  readonly planets?: Readonly<Record<string, SubperiodPlanetFact>> | null;
  /** Verbatim natal `sidereal_chart.yogas` list for yoga-activation context. */
  readonly yogas?: readonly SubperiodYogaFact[] | null;
  /** Optional lazy predictive `TransitCtx` for dated transits/hits inside sub-period spans. */
  readonly transitCtx?: TransitCtx;
}

interface GuideEnv {
  readonly audience: SubperiodAudience;
  readonly planets?: Readonly<Record<string, SubperiodPlanetFact>> | null;
  readonly yogas?: readonly SubperiodYogaFact[] | null;
  readonly transitCtx?: TransitCtx;
  readonly sortedHits?: readonly SlowHitItem[];
}

/** True when `row` is the same dated period as `leg` (lord + start). */
function isLeg(row: DashaTreeRow, leg: DashaTreeRow | null): boolean {
  return leg !== null && row.lord === leg.lord && row.start_date === leg.start_date;
}

/** "19 y" · "3 y 2 m" · "6 m" · "15 d" — display units for an engine span. */
function durationLabel(t: TFunction, durationYears: number): string {
  const parts = durationParts(durationYears);
  const out: string[] = [];
  if (parts.years > 0) out.push(t('periods.dur_years', { count: parts.years }));
  if (parts.months > 0) out.push(t('periods.dur_months', { count: parts.months }));
  if (out.length === 0) out.push(t('periods.dur_days', { count: parts.days }));
  return out.join(' ');
}

/** One aligned period line: wraps cleanly on 390px mobile, 3-column grid on `sm+`. */
function PeriodLine({
  row,
  running,
  emphasis = false,
}: {
  row: DashaTreeRow;
  running: boolean;
  emphasis?: boolean;
}): ReactElement {
  const { t } = useTranslation('predictive');
  return (
    <span className="flex min-w-0 flex-1 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-2 sm:grid sm:grid-cols-[minmax(7rem,max-content)_1fr_auto] sm:gap-x-4">
      <span
        className={cn(
          'font-medium',
          emphasis ? 'text-[0.95rem] text-text-primary' : 'text-sm text-text-primary',
        )}
      >
        {grahaName(t, row.lord)}
        {running && (
          <span className="ml-2 align-middle text-[10px] font-medium uppercase tracking-[0.18em] text-accent-gold">
            {t('periods.running')}
          </span>
        )}
      </span>
      <span className="font-mono text-xs text-text-secondary">
        {formatPredictiveDate(row.start_date)} – {formatPredictiveDate(row.end_date)}
      </span>
      <span className="justify-self-end whitespace-nowrap font-mono text-xs text-text-tertiary">
        {durationLabel(t, row.duration_years)}
      </span>
    </span>
  );
}

/** The pratyantar list of the running antar, each expandable for its short-window guide. */
function PratyantarList({
  rows,
  currentPratyantar,
  mahaLord,
  antarLord,
  env,
}: {
  rows: readonly DashaTreeRow[];
  currentPratyantar: DashaTreeRow | null;
  mahaLord: string;
  antarLord: string;
  env: GuideEnv;
}): ReactElement {
  const { t } = useTranslation('predictive');
  return (
    <ol
      className="ml-2 border-l border-ui-border/60 pl-4"
      aria-label={t('periods.pratyantars_of', { lord: grahaName(t, antarLord) })}
      data-testid="dasha-tree-pds"
    >
      {rows.map((pd, index) => {
        const running = isLeg(pd, currentPratyantar);
        const guide = buildSubperiodGuide({
          mahaLord,
          subLord: pd.lord,
          parentAntarLord: antarLord,
          level: 'pratyantar',
          startDate: pd.start_date,
          endDate: pd.end_date,
          audience: env.audience,
          planets: env.planets,
          yogas: env.yogas,
          transitCtx: env.transitCtx,
          sortedHits: env.sortedHits,
          t,
        });
        return (
          <li
            key={`${pd.lord}-${index}`}
            data-testid={`dasha-tree-pd-${pd.lord}`}
            aria-current={running ? 'true' : undefined}
            className={cn(
              'border-b border-ui-border/30 last:border-0',
              running && '-ml-[calc(1rem+1px)] border-l-2 border-l-accent-gold/70 bg-accent-gold/[0.05] pl-[calc(1rem-1px)]',
            )}
          >
            <Disclosure
              defaultOpen={running}
              summary={<PeriodLine row={pd} running={running} />}
              triggerClassName="rounded-none"
              contentClassName="pb-3 pt-1"
            >
              <SubperiodGuideBlock guide={guide} testid={`subperiod-guide-pd-${pd.lord}`} />
            </Disclosure>
          </li>
        );
      })}
    </ol>
  );
}

/** One mahā row; expandable onto its antar-daśās and each antar's meaning + aspect bullets. */
function MahaItem({
  maha,
  dashas,
  env,
}: {
  readonly maha: DashaTreeRow;
  readonly dashas: DashaTreeSource;
  readonly env: GuideEnv;
}): ReactElement {
  const { t } = useTranslation(['predictive', 'astrology']);
  const running = isLeg(maha, dashas.current_maha);
  const antars = maha.antar_sequence ?? null;
  const pratyantars = dashas.pratyantar_sequence ?? null;

  const antarList =
    antars && antars.length > 0 ? (
      <ol
        className="ml-2 border-l border-ui-border/60 pl-4 pb-2"
        aria-label={t('periods.antars_of', { lord: grahaName(t, maha.lord) })}
        data-testid={`dasha-tree-antars-${maha.lord}`}
      >
        {antars.map((antar, index) => {
          const antarRunning = running && isLeg(antar, dashas.current_antar);
          const hasPds = antarRunning && pratyantars !== null && pratyantars.length > 0;
          const guide = buildSubperiodGuide({
            mahaLord: maha.lord,
            subLord: antar.lord,
            level: 'antar',
            startDate: antar.start_date,
            endDate: antar.end_date,
            audience: env.audience,
            planets: env.planets,
            yogas: env.yogas,
            transitCtx: env.transitCtx,
            sortedHits: env.sortedHits,
            t,
          });
          return (
            <li
              key={`${antar.lord}-${index}`}
              data-testid={`dasha-tree-antar-${maha.lord}-${antar.lord}`}
              aria-current={antarRunning ? 'true' : undefined}
              className={cn(
                'border-b border-ui-border/30 last:border-0',
                antarRunning &&
                  '-ml-[calc(1rem+1px)] border-l-2 border-l-accent-gold/70 bg-accent-gold/[0.05] pl-[calc(1rem-1px)]',
              )}
            >
              <Disclosure
                defaultOpen={antarRunning}
                summary={<PeriodLine row={antar} running={antarRunning} />}
                triggerClassName="rounded-none"
                contentClassName="space-y-3 pb-3 pt-1"
              >
                {/* When running PDs are shown below, YouAreHerePath already displays the running Antar guide at the top. */}
                {!hasPds && (
                  <SubperiodGuideBlock
                    guide={guide}
                    testid={`subperiod-guide-antar-${maha.lord}-${antar.lord}`}
                  />
                )}
                {hasPds && (
                  <PratyantarList
                    rows={pratyantars}
                    currentPratyantar={dashas.current_pratyantar}
                    mahaLord={maha.lord}
                    antarLord={antar.lord}
                    env={env}
                  />
                )}
              </Disclosure>
            </li>
          );
        })}
        {running && (
          <li className="py-2 text-[11px] italic leading-relaxed text-text-tertiary">
            {t('periods.pd_note')}
          </li>
        )}
      </ol>
    ) : null;

  return (
    <li
      data-testid={`dasha-tree-maha-${maha.lord}`}
      aria-current={running ? 'true' : undefined}
      className={cn(
        'border-b border-ui-border/50 last:border-0',
        running && '-ml-5 border-l-2 border-l-accent-gold/80 bg-accent-gold/[0.04] pl-[1.125rem]',
      )}
    >
      {antarList ? (
        <Disclosure defaultOpen={running} summary={<PeriodLine row={maha} running={running} emphasis />} triggerClassName="rounded-none">
          {antarList}
        </Disclosure>
      ) : (
        <PeriodLine row={maha} running={running} emphasis />
      )}
    </li>
  );
}

/** The "you are here" band: running stack + next boundary + labeled active Antardaśā guide. */
function YouAreHerePath({ dashas, env }: { dashas: DashaTreeSource; env: GuideEnv }): ReactElement | null {
  const { t } = useTranslation(['predictive', 'astrology']);
  const legs: ReadonlyArray<{ row: DashaTreeRow; level: 'maha' | 'antar' | 'pratyantar' }> = [
    dashas.current_maha ? ({ row: dashas.current_maha, level: 'maha' } as const) : null,
    dashas.current_antar ? ({ row: dashas.current_antar, level: 'antar' } as const) : null,
    dashas.current_pratyantar ? ({ row: dashas.current_pratyantar, level: 'pratyantar' } as const) : null,
  ].filter((leg): leg is { row: DashaTreeRow; level: 'maha' | 'antar' | 'pratyantar' } => leg !== null);

  if (legs.length === 0) return null;
  const innermost = legs[legs.length - 1]!;
  const activeAntar = dashas.current_maha && dashas.current_antar ? dashas.current_antar : null;
  const activeGuide =
    dashas.current_maha && activeAntar
      ? buildSubperiodGuide({
          mahaLord: dashas.current_maha.lord,
          subLord: activeAntar.lord,
          level: 'antar',
          startDate: activeAntar.start_date,
          endDate: activeAntar.end_date,
          audience: env.audience,
          planets: env.planets,
          yogas: env.yogas,
          transitCtx: env.transitCtx,
          sortedHits: env.sortedHits,
          t,
        })
      : null;

  return (
    <section
      className="border-l-2 border-accent-gold/70 pl-4"
      data-testid="dasha-tree-path"
      aria-label={t('periods.you_are_here')}
    >
      <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-text-tertiary">
        {t('periods.you_are_here')}
      </p>
      <p className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1 font-display text-xl leading-tight text-text-primary">
        {legs.map((leg, index) => (
          <span key={leg.level} className="whitespace-nowrap">
            {index > 0 && <span className="mr-3 text-text-tertiary">→</span>}
            {grahaName(t, leg.row.lord)}{' '}
            <span className="text-sm text-text-tertiary">{t(`astrology:dasha.${leg.level}`)}</span>
          </span>
        ))}
      </p>
      <p className="mt-1 font-mono text-xs text-text-secondary">
        {t('periods.path_until', { date: formatPredictiveDate(innermost.row.end_date) })}
      </p>
      {activeGuide && activeAntar && (
        <SubperiodGuideBlock
          guide={activeGuide}
          kicker={t('subperiod.current_antar_kicker', {
            lord: grahaName(t, activeAntar.lord),
            start: formatPredictiveDate(activeAntar.start_date),
            end: formatPredictiveDate(activeAntar.end_date),
          })}
          testid="periods-current-subperiod-guide"
          className="mt-3 max-w-3xl"
        />
      )}
    </section>
  );
}

/** The Periods tab: you-are-here band + convention note + the 120-year tree. */
export function PeriodsPanel({ dashas, planets, yogas, transitCtx }: PeriodsPanelProps): ReactElement {
  const { t } = useTranslation('predictive');
  const contentMode = useContentModeStore((s) => s.contentMode);
  const audience: SubperiodAudience = contentMode === 'technical' ? 'astrologer' : 'layman';
  const sortedHits = useMemo(
    () => (transitCtx ? sortSlowHits(transitCtx.slow_hits) : undefined),
    [transitCtx],
  );
  const env: GuideEnv = { audience, planets, yogas, transitCtx, sortedHits };

  if (!dashas || dashas.maha_dasha_sequence.length === 0) {
    return (
      <Card title={t('periods.title')} data-testid="periods-panel">
        <p className="max-w-prose text-sm leading-relaxed text-text-secondary" data-testid="periods-unavailable">
          {t('periods.unavailable')}
        </p>
      </Card>
    );
  }

  const hasDepth = dashas.maha_dasha_sequence.some((row) => (row.antar_sequence?.length ?? 0) > 0);

  return (
    <div className="space-y-6" data-testid="periods-panel">
      <YouAreHerePath dashas={dashas} env={env} />

      <Card title={t('periods.title')} subtitle={t('periods.subtitle')}>
        {dashas.convention && (
          <p className="mb-4 text-xs italic text-text-tertiary" data-testid="periods-convention">
            {t('periods.convention_note', {
              convention: t(`convention.${dashas.convention}`),
            })}
          </p>
        )}

        {!hasDepth && (
          <p
            className="mb-4 max-w-prose text-xs leading-relaxed text-text-tertiary"
            data-testid="periods-no-depth"
          >
            {t('periods.no_depth')}
          </p>
        )}

        <ol className="ml-5" data-testid="dasha-tree">
          {dashas.maha_dasha_sequence.map((maha, index) => (
            <MahaItem key={`${maha.lord}-${index}`} maha={maha} dashas={dashas} env={env} />
          ))}
        </ol>
      </Card>
    </div>
  );
}
