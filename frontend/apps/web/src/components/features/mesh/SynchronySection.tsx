/**
 * SynchronySection — "Together in time": the two charts' Vimśottarī timelines
 * joined over an explicit window, as a dual-track list.
 *
 * Each engine segment is one slice where BOTH charts' mahā+antar legs are
 * constant: dates on the left, your track and theirs side by side. The window
 * bounds are UTC midnight and print as that UTC day; interior cuts are antar
 * start instants and print in the viewer's zone, like the Periods panel. Shared lords — the same graha timing both lives at once — glow gold
 * and get their own line; a simultaneous boundary is noted quietly. The window
 * control re-derives the edge (seconds, on-device); both daśā-year conventions
 * are declared underneath, verbatim.
 */

import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type {
  DashaSynchronyData,
  MeshEdgeCtx,
  PlanetName,
  SynchronySegmentData,
} from '@almamesh/shared-types';

import { Badge, Card } from '../../ui';
import { MESH_WINDOW_YEARS, type MeshWindowYears } from '../../../lib/mesh';
import { formatPredictiveDate, formatPredictiveWindowBound } from '../../../lib/predictive';
import { grahaName } from '../../../lib/predictiveEventCopy';

export interface SynchronySectionProps {
  readonly edge: MeshEdgeCtx;
  readonly memberName: string;
  readonly years: MeshWindowYears;
  readonly onYearsChange: (years: MeshWindowYears) => void;
}

/**
 * A synchrony cut as a display date. The window bounds are UTC midnight, so
 * they print as that UTC day; an interior cut is an antar start instant with a
 * real time of day, so it prints in the viewer's zone (the Periods rule).
 */
function formatCut(iso: string, synchrony: DashaSynchronyData): string {
  const instant = Date.parse(iso);
  const isBound =
    instant === Date.parse(synchrony.window_start) || instant === Date.parse(synchrony.window_end);
  return isBound ? formatPredictiveWindowBound(iso) : formatPredictiveDate(iso);
}

/** The now → +N years control (explicit window, never a silent default). */
function WindowControl({
  years,
  onYearsChange,
}: Pick<SynchronySectionProps, 'years' | 'onYearsChange'>): ReactElement {
  const { t } = useTranslation('mesh');
  return (
    <div
      role="group"
      aria-label={t('synchrony.years_label')}
      className="inline-flex divide-x divide-ui-border overflow-hidden rounded-lg border border-ui-border"
    >
      {MESH_WINDOW_YEARS.map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={years === option}
          onClick={() => onYearsChange(option)}
          data-testid={`mesh-window-${option}y`}
          className={`px-3 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-gold/60 ${
            years === option
              ? 'bg-accent-gold/10 font-medium text-accent-gold'
              : 'text-text-secondary hover:text-text-primary'
          }`}
        >
          {t(`synchrony.years.${option}`)}
        </button>
      ))}
    </div>
  );
}

/** One person's leg pair, shared lords highlighted in gold. */
function Track({
  label,
  maha,
  antar,
  sharedLords,
}: {
  label: string;
  maha: PlanetName;
  antar: PlanetName;
  sharedLords: readonly PlanetName[];
}): ReactElement {
  const { t } = useTranslation(['mesh', 'astrology', 'predictive']);
  const lordClass = (lord: PlanetName): string =>
    sharedLords.includes(lord) ? 'font-medium text-accent-gold' : 'font-medium text-text-primary';
  return (
    <div className="min-w-0">
      <p className="text-[10px] uppercase tracking-[0.18em] text-text-tertiary">{label}</p>
      <p className="mt-0.5 text-sm leading-relaxed text-text-secondary">
        <span className={lordClass(maha)}>{grahaName(t, maha)}</span>{' '}
        <span className="text-xs text-text-tertiary">{t('astrology:dasha.maha')}</span>
        {' · '}
        <span className={lordClass(antar)}>{grahaName(t, antar)}</span>{' '}
        <span className="text-xs text-text-tertiary">{t('astrology:dasha.antar')}</span>
      </p>
    </div>
  );
}

function SegmentRow({
  segment,
  synchrony,
  memberName,
  t,
}: {
  segment: SynchronySegmentData;
  synchrony: DashaSynchronyData;
  memberName: string;
  t: TFunction;
}): ReactElement {
  const shared = segment.shared_lords;
  return (
    <li
      className="grid grid-cols-1 items-baseline gap-x-6 gap-y-1.5 py-3 sm:grid-cols-[minmax(10rem,auto)_1fr_1fr]"
      data-testid="mesh-synchrony-segment"
    >
      <span className="font-mono text-xs text-text-tertiary">
        {t('mesh:synchrony.window', {
          start: formatCut(segment.start, synchrony),
          end: formatCut(segment.end, synchrony),
        })}
      </span>
      <Track
        label={t('mesh:synchrony.you')}
        maha={segment.a_maha}
        antar={segment.a_antar}
        sharedLords={shared}
      />
      <Track label={memberName} maha={segment.b_maha} antar={segment.b_antar} sharedLords={shared} />
      {shared.length > 0 && (
        <p
          className="flex items-center gap-1.5 text-xs text-accent-gold sm:col-span-3"
          data-testid="mesh-shared-window"
        >
          <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-accent-gold" />
          {t('mesh:synchrony.shared_lords', {
            lords: shared.map((lord) => grahaName(t, lord)).join(' · '),
          })}
        </p>
      )}
      {segment.simultaneous_boundary && (
        <p className="text-xs text-text-tertiary sm:col-span-3">
          {t('mesh:synchrony.boundary_note')}
        </p>
      )}
    </li>
  );
}

export function SynchronySection({
  edge,
  memberName,
  years,
  onYearsChange,
}: SynchronySectionProps): ReactElement {
  const { t } = useTranslation(['mesh', 'astrology', 'predictive']);
  const { synchrony } = edge;
  return (
    <Card
      title={t('mesh:synchrony.heading')}
      subtitle={t('mesh:synchrony.window', {
        start: formatPredictiveWindowBound(synchrony.window_start),
        end: formatPredictiveWindowBound(synchrony.window_end),
      })}
      actions={
        <div className="flex items-center gap-3">
          <Badge className="hidden sm:inline-flex">{t('mesh:synchrony.badge')}</Badge>
          <WindowControl years={years} onYearsChange={onYearsChange} />
        </div>
      }
      data-testid="mesh-synchrony"
    >
      {synchrony.segments.length > 0 ? (
        <ul className="divide-y divide-ui-border/60">
          {synchrony.segments.map((segment) => (
            <SegmentRow
              key={`${segment.start}-${segment.end}`}
              segment={segment}
              synchrony={synchrony}
              memberName={memberName}
              t={t}
            />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-text-tertiary">{t('mesh:synchrony.empty')}</p>
      )}
      <p className="mt-4 border-t border-ui-border/60 pt-3 text-xs leading-relaxed text-text-tertiary">
        {t('mesh:synchrony.conventions', {
          a: t(`predictive:convention.${synchrony.convention_a}`),
          b: t(`predictive:convention.${synchrony.convention_b}`),
          name: memberName,
        })}
        {' · '}
        {synchrony.basis}
      </p>
    </Card>
  );
}
