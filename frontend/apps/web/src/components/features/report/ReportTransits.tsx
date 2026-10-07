/**
 * ReportTransits — the printed "Transits & Timing" section: the gochara table,
 * the Sade Sati status panel, the slow-graha hits, the daśā×transit fusion
 * read and the 12-month timeline. Engine TransitCtx verbatim, locale-aware
 * dates, almanac styling.
 */

import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { TransitCtx, TransitPlacementData } from '@almamesh/shared-types';
import { formatDegree } from '../../../lib/reportData';
import { formatPredictiveDate, formatReferenceDay } from '../../../lib/predictive';
import {
  grahaName,
  sadeSatiPhaseName,
  signName,
  slowHitTargetLabel,
  timelineEventLabel,
} from '../../../lib/predictiveEventCopy';
import { ReportSectionHeading } from './ReportSectionHeading';
import { sectionNumeral } from '../../../lib/reportSections';

const GRAHA_ORDER = [
  'sun', 'moon', 'mars', 'mercury', 'jupiter', 'venus', 'saturn', 'rahu', 'ketu',
] as const;

interface ReportTransitsProps {
  readonly transitCtx: TransitCtx;
}

/** Transits & Timing, paper-themed for print. */
export function ReportTransits({ transitCtx }: ReportTransitsProps): ReactElement {
  const { t } = useTranslation('report');
  const { t: tp } = useTranslation('predictive');
  const placements = GRAHA_ORDER.map((g) => transitCtx.gochara.placements[g]).filter(
    (p): p is TransitPlacementData => p !== undefined,
  );
  const sadeSati = transitCtx.sade_sati;
  const fusion = transitCtx.fusion;
  const list = (names: readonly string[]): string =>
    names.length > 0 ? names.map((n) => grahaName(tp, n)).join(', ') : tp('fusion.none');

  return (
    <section className="report-section" data-testid="report-transits">
      <ReportSectionHeading index={sectionNumeral('transits')} title={t('transits.heading')} />
      <p className="report-note">
        {t('transits.as_of', { date: formatReferenceDay(transitCtx.gochara.instant) })}
      </p>

      {placements.length > 0 && (
        <table className="report-table" data-testid="report-gochara-table">
          <thead>
            <tr>
              <th scope="col">{tp('gochara.col_graha')}</th>
              <th scope="col">{tp('gochara.col_sign')}</th>
              <th scope="col">{tp('gochara.col_degree')}</th>
              <th scope="col">{tp('gochara.col_house_moon')}</th>
              <th scope="col">{tp('gochara.col_house_lagna')}</th>
              <th scope="col">{tp('gochara.col_motion')}</th>
            </tr>
          </thead>
          <tbody>
            {placements.map((p) => (
              <tr key={p.graha} className="report-avoid-break">
                <td>{grahaName(tp, p.graha)}</td>
                <td>{signName(tp, p.sign)}</td>
                <td>{formatDegree(p.sign_degrees)}</td>
                <td>{p.house_from_moon}</td>
                <td>{p.house_from_lagna}</td>
                <td>{p.is_retrograde ? tp('gochara.retrograde') : tp('gochara.direct')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3 className="report-subsection-title">{t('transits.sade_sati_heading')}</h3>
      <dl className="report-dasha-current report-avoid-break" data-testid="report-sade-sati">
        <div className="report-dasha-leg">
          <dt>{tp('sade_sati.heading')}</dt>
          <dd>{sadeSati.is_active ? tp('sade_sati.active') : tp('sade_sati.inactive')}</dd>
        </div>
        <div className="report-dasha-leg">
          <dt>{tp('sade_sati.natal_moon', { sign: signName(tp, sadeSati.natal_moon_sign) })}</dt>
          <dd>
            {sadeSati.is_active && sadeSati.current_phase !== 'none'
              ? tp('sade_sati.phase_label', {
                  phase: sadeSatiPhaseName(tp, sadeSati.current_phase),
                })
              : tp('sade_sati.phase.none')}
          </dd>
        </div>
        {sadeSati.cycle.map((segment) => (
          <div className="report-dasha-leg" key={`${segment.phase}-${segment.start}`}>
            <dt>
              {tp('sade_sati.phase_label', { phase: sadeSatiPhaseName(tp, segment.phase) })}
              {' · '}
              {tp('sade_sati.saturn_in', { sign: signName(tp, segment.saturn_sign) })}
            </dt>
            <dd>
              {tp('sade_sati.window', {
                start: formatPredictiveDate(segment.start),
                end: formatPredictiveDate(segment.end),
              })}
            </dd>
          </div>
        ))}
      </dl>

      {/* Slow-graha hits — the dated exact contacts of the slow movers to the
          natal points (engine `slow_hits` verbatim; previously never printed). */}
      <h3 className="report-subsection-title">{t('transits.slow_hits_heading')}</h3>
      {transitCtx.slow_hits.length === 0 ? (
        <p className="report-note">{tp('slow_hits.empty')}</p>
      ) : (
        <table className="report-table" data-testid="report-slow-hits">
          <thead>
            <tr>
              <th scope="col">{t('transits.col_date')}</th>
              <th scope="col">{t('transits.col_event')}</th>
              <th scope="col">{t('transits.col_tone')}</th>
            </tr>
          </thead>
          <tbody>
            {transitCtx.slow_hits.map((hit) => (
              <tr key={`${hit.graha}-${hit.kind}-${hit.exact}`} className="report-avoid-break">
                <td>{formatPredictiveDate(hit.exact)}</td>
                <td>
                  {grahaName(tp, hit.graha)} → {slowHitTargetLabel(tp, hit.natal_point)}
                </td>
                <td>{tp(`severity.${hit.severity}`)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3 className="report-subsection-title">{t('transits.fusion_heading')}</h3>
      <dl className="report-dasha-current report-avoid-break" data-testid="report-fusion">
        <div className="report-dasha-leg">
          <dt>{tp('fusion.maha_lord')}</dt>
          <dd>
            {grahaName(tp, fusion.maha_lord)} —{' '}
            {tp('fusion.house_from_moon', { house: fusion.maha_lord_transit_house_from_moon })}
          </dd>
        </div>
        <div className="report-dasha-leg">
          <dt>{tp('fusion.antar_lord')}</dt>
          <dd>{fusion.antar_lord ? grahaName(tp, fusion.antar_lord) : tp('fusion.none')}</dd>
        </div>
        <div className="report-dasha-leg">
          <dt>{tp('fusion.reinforcing')}</dt>
          <dd>{list(fusion.reinforcing)}</dd>
        </div>
        <div className="report-dasha-leg">
          <dt>{tp('fusion.afflicting')}</dt>
          <dd>{list(fusion.afflicting)}</dd>
        </div>
      </dl>

      <h3 className="report-subsection-title">{t('transits.timeline_heading')}</h3>
      {transitCtx.timeline.events.length === 0 ? (
        <p className="report-note">{tp('timeline.empty')}</p>
      ) : (
        <table className="report-table" data-testid="report-transit-timeline">
          <thead>
            <tr>
              <th scope="col">{t('transits.col_date')}</th>
              <th scope="col">{t('transits.col_event')}</th>
              <th scope="col">{t('transits.col_tone')}</th>
            </tr>
          </thead>
          <tbody>
            {transitCtx.timeline.events.map((event) => (
              <tr key={`${event.date}-${event.descriptor}`} className="report-avoid-break">
                <td>{formatPredictiveDate(event.date)}</td>
                <td>{timelineEventLabel(tp, event)}</td>
                <td>{tp(`severity.${event.severity}`)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
