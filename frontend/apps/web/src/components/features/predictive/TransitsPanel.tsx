/**
 * TransitsPanel — "what's happening now / next 12 months", verbatim from the
 * engine's TransitCtx: current Gochara placements, Sade Sati status + cycle,
 * slow-planet hits/returns, the daśā×transit fusion read, and the 12-month
 * timeline in chronological order with locale-aware dates.
 */

import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  SadeSatiData,
  TransitCtx,
  TransitPlacementData,
} from '@almamesh/shared-types';
import { Badge, Card } from '../../ui';
import { formatDegree } from '../../../lib/reportData';
import {
  formatPredictiveDate,
  formatPredictiveWindowBound,
  formatReferenceDay,
} from '../../../lib/predictive';
import {
  grahaName,
  sadeSatiPhaseName,
  signName,
  slowHitTargetLabel,
  timelineEventLabel,
} from '../../../lib/predictiveEventCopy';
import { SeverityBadge } from './PredictiveBadges';

/** Engine emission order for the gochara table (Sun → Ketu). */
const GRAHA_ORDER = [
  'sun',
  'moon',
  'mars',
  'mercury',
  'jupiter',
  'venus',
  'saturn',
  'rahu',
  'ketu',
] as const;

function GocharaTable({ ctx, frame }: { ctx: TransitCtx; frame: TransitsFrame }): ReactElement {
  const { t } = useTranslation('predictive');
  const placements = GRAHA_ORDER.map((g) => ctx.gochara.placements[g]).filter(
    (p): p is TransitPlacementData => p !== undefined,
  );
  return (
    <Card
      title={frame === 'now' ? t('gochara.heading') : undefined}
      subtitle={t('gochara.subtitle', { date: formatReferenceDay(ctx.gochara.instant) })}
      data-testid="gochara-card"
    >
      <div className="overflow-x-auto">
        <table className="w-full text-sm" data-testid="gochara-table">
          <thead>
            <tr className="border-b border-ui-border text-left text-xs uppercase tracking-wider text-text-tertiary">
              <th scope="col" className="py-2 pr-3 font-medium">{t('gochara.col_graha')}</th>
              <th scope="col" className="py-2 pr-3 font-medium">{t('gochara.col_sign')}</th>
              <th scope="col" className="py-2 pr-3 font-medium">{t('gochara.col_degree')}</th>
              <th scope="col" className="py-2 pr-3 font-medium">{t('gochara.col_nakshatra')}</th>
              <th scope="col" className="py-2 pr-3 font-medium">{t('gochara.col_house_moon')}</th>
              <th scope="col" className="py-2 pr-3 font-medium">{t('gochara.col_house_lagna')}</th>
              <th scope="col" className="py-2 font-medium">{t('gochara.col_motion')}</th>
            </tr>
          </thead>
          <tbody>
            {placements.map((p) => (
              <tr key={p.graha} className="border-b border-ui-border/50 last:border-0">
                <td className="py-2 pr-3 font-medium text-text-primary">{grahaName(t, p.graha)}</td>
                <td className="py-2 pr-3 text-text-secondary">{signName(t, p.sign)}</td>
                <td className="py-2 pr-3 font-mono text-text-secondary">{formatDegree(p.sign_degrees)}</td>
                <td className="py-2 pr-3 text-text-secondary">
                  {t('gochara.nakshatra_pada', { nakshatra: p.nakshatra, pada: p.nakshatra_pada })}
                </td>
                <td className="py-2 pr-3 text-text-secondary">
                  {t('gochara.house_n', { house: p.house_from_moon })}
                </td>
                <td className="py-2 pr-3 text-text-secondary">
                  {t('gochara.house_n', { house: p.house_from_lagna })}
                </td>
                <td className="py-2 text-text-secondary">
                  {p.is_retrograde ? t('gochara.retrograde') : t('gochara.direct')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function SadeSatiCard({ data, frame }: { data: SadeSatiData; frame: TransitsFrame }): ReactElement {
  const { t } = useTranslation('predictive');
  return (
    <Card
      title={t('sade_sati.heading')}
      subtitle={t('sade_sati.natal_moon', { sign: signName(t, data.natal_moon_sign) })}
      actions={
        <Badge variant={data.is_active ? 'warning' : 'default'} data-testid="sade-sati-active">
          {data.is_active ? t('sade_sati.active') : t('sade_sati.inactive')}
        </Badge>
      }
      data-testid="sade-sati-card"
    >
      {data.is_active && data.current_phase !== 'none' && (
        <p className="mb-3 font-display text-base text-text-primary" data-testid="sade-sati-phase">
          {t('sade_sati.phase_label', { phase: sadeSatiPhaseName(t, data.current_phase) })}
        </p>
      )}
      {!data.is_active && (
        <p className="mb-3 text-sm leading-relaxed text-text-secondary">{t(frame === 'now' ? 'sade_sati.none_body' : 'sade_sati.none_body_moment')}</p>
      )}
      {data.cycle.length > 0 && (
        <ol className="space-y-2" data-testid="sade-sati-cycle">
          {data.cycle.map((segment) => {
            const isCurrent = data.is_active && segment.phase === data.current_phase;
            return (
              <li
                key={`${segment.phase}-${segment.start}`}
                className={`flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 rounded-md border px-3 py-2 text-sm ${
                  isCurrent
                    ? 'border-accent-gold/40 bg-accent-gold/5 text-text-primary'
                    : 'border-ui-border/60 text-text-secondary'
                }`}
                aria-current={isCurrent ? 'true' : undefined}
              >
                <span>
                  {t('sade_sati.phase_label', { phase: sadeSatiPhaseName(t, segment.phase) })}
                  {' · '}
                  {t('sade_sati.saturn_in', { sign: signName(t, segment.saturn_sign) })}
                </span>
                <span className="font-mono text-xs text-text-tertiary">
                  {t('sade_sati.window', {
                    start: formatPredictiveDate(segment.start),
                    end: formatPredictiveDate(segment.end),
                  })}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}

function SlowHitsCard({ ctx }: { ctx: TransitCtx }): ReactElement {
  const { t } = useTranslation('predictive');
  return (
    <Card title={t('slow_hits.heading')} data-testid="slow-hits-card">
      {ctx.slow_hits.length === 0 ? (
        <p className="text-sm text-text-secondary">{t('slow_hits.empty')}</p>
      ) : (
        <ul className="space-y-2">
          {ctx.slow_hits.map((hit) => (
            <li
              key={`${hit.graha}-${hit.kind}-${hit.exact}`}
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-md border border-ui-border/60 px-3 py-2 text-sm"
            >
              <span className="text-text-primary">
                {grahaName(t, hit.graha)} → {slowHitTargetLabel(t, hit.natal_point)}
                <span className="ml-2 text-xs text-text-tertiary">
                  {t('slow_hits.exact_on', { date: formatPredictiveDate(hit.exact) })}
                </span>
              </span>
              <SeverityBadge severity={hit.severity} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function FusionCard({ ctx, frame }: { ctx: TransitCtx; frame: TransitsFrame }): ReactElement {
  const { t } = useTranslation('predictive');
  const { fusion } = ctx;
  const list = (names: readonly string[]): string =>
    names.length > 0 ? names.map((n) => grahaName(t, n)).join(', ') : t('fusion.none');
  return (
    <Card
      title={t('fusion.heading')}
      subtitle={frame === 'now' ? t('fusion.subtitle') : undefined}
      actions={<SeverityBadge severity={fusion.severity} />}
      data-testid="fusion-card"
    >
      <p className="mb-3 text-sm leading-relaxed text-text-secondary">
        {t('fusion.house_from_moon', { house: fusion.maha_lord_transit_house_from_moon })}
        {' · '}
        {t('fusion.house_from_lagna', { house: fusion.maha_lord_transit_house_from_lagna })}
      </p>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs uppercase tracking-wider text-text-tertiary">{t('fusion.maha_lord')}</dt>
          <dd className="text-text-primary">{grahaName(t, fusion.maha_lord)}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wider text-text-tertiary">{t('fusion.antar_lord')}</dt>
          <dd className="text-text-primary">
            {fusion.antar_lord ? grahaName(t, fusion.antar_lord) : t('fusion.none')}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wider text-text-tertiary">{t('fusion.net_weight')}</dt>
          <dd className="font-mono text-text-primary">{fusion.net_weight}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wider text-text-tertiary">{t('fusion.reinforcing')}</dt>
          <dd className="text-text-secondary">{list(fusion.reinforcing)}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wider text-text-tertiary">{t('fusion.afflicting')}</dt>
          <dd className="text-text-secondary">{list(fusion.afflicting)}</dd>
        </div>
      </dl>
    </Card>
  );
}

function TimelineCard({ ctx }: { ctx: TransitCtx }): ReactElement {
  const { t } = useTranslation('predictive');
  const { timeline } = ctx;
  return (
    <Card
      title={t('timeline.heading')}
      subtitle={t('timeline.subtitle', {
        start: formatPredictiveWindowBound(timeline.window_start),
        end: formatPredictiveWindowBound(timeline.window_end),
      })}
      data-testid="transit-timeline"
    >
      {timeline.events.length === 0 ? (
        <p className="text-sm text-text-secondary">{t('timeline.empty')}</p>
      ) : (
        <ol className="relative space-y-0 border-l border-ui-border pl-5">
          {timeline.events.map((event) => (
            <li key={`${event.date}-${event.descriptor}`} className="relative pb-4 last:pb-0">
              <span
                className="absolute -left-[1.42rem] top-1.5 h-2 w-2 rounded-full border border-accent-gold bg-background-secondary"
                aria-hidden="true"
              />
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <div>
                  <span className="mr-3 font-mono text-xs text-text-tertiary">
                    {formatPredictiveDate(event.date)}
                  </span>
                  <span className="text-sm text-text-primary">{timelineEventLabel(t, event)}</span>
                </div>
                {event.severity === 'neutral' ? null : <SeverityBadge severity={event.severity} />}
              </div>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

/** Whether the panel shows today's sky or another moment's. */
export type TransitsFrame = 'now' | 'moment';

export interface TransitsPanelProps {
  readonly transitCtx: TransitCtx;
  /**
   * 'now' (default): the copy reads as today ("Current Sky", "today's sky").
   * 'moment': a host showing another moment under its own heading; every line
   * that would read as now is dropped or reworded.
   */
  readonly frame?: TransitsFrame;
}

/** The full Transits & Timing surface, engine TransitCtx rendered verbatim. */
export function TransitsPanel({ transitCtx, frame = 'now' }: TransitsPanelProps): ReactElement {
  return (
    <div className="space-y-6" data-testid="transits-panel">
      <GocharaTable ctx={transitCtx} frame={frame} />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <SadeSatiCard data={transitCtx.sade_sati} frame={frame} />
        <FusionCard ctx={transitCtx} frame={frame} />
      </div>
      <SlowHitsCard ctx={transitCtx} />
      <TimelineCard ctx={transitCtx} />
    </div>
  );
}
