/**
 * DashboardYogasCard — deterministic Observatory panel explaining the classical
 * yogas formed in the natal D1 chart in plain language, with zero AI dependency.
 */

import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { YogaDashaActivation, YogaData, YogaGrade } from '@almamesh/browser/types';
import { Badge, Card, type BadgeProps } from '../../ui';
import { formatYogaFormation, formatYogaMeaning } from '../../../lib/yogaGlossary';
import { hasStrength, yogaStrength } from '../../../lib/yogaStrength';

interface DashboardYogasCardProps {
  readonly yogas: readonly YogaData[];
}

function gradeVariant(grade: YogaGrade): NonNullable<BadgeProps['variant']> {
  if (grade === 'strong') return 'brass';
  if (grade === 'moderate') return 'lapis';
  return 'default';
}

function activationVariant(
  status: YogaDashaActivation['status'],
): NonNullable<BadgeProps['variant']> {
  if (status === 'direct') return 'brass';
  if (status === 'indirect') return 'lapis';
  return 'default';
}

function DashboardYogaRow({ yoga }: { readonly yoga: YogaData }): ReactElement {
  const { t: tr } = useTranslation('report');
  const meaning = formatYogaMeaning(yoga, tr);
  const formation = formatYogaFormation(yoga);
  const gradeLabel = tr(`yogas.grade.${yoga.grade}`);
  const badgeText = hasStrength(yoga) ? `${yogaStrength(yoga).pct}% · ${gradeLabel}` : gradeLabel;

  return (
    <li className="py-3.5 first:pt-0 last:pb-0" data-testid="dashboard-yoga-item">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="font-display text-base text-text-primary">
          {yoga.display_name || yoga.name}
        </h4>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant={gradeVariant(yoga.grade)}>{badgeText}</Badge>
          {yoga.dasha_activation ? (
            <Badge variant={activationVariant(yoga.dasha_activation.status)}>
              {tr(`yogas.activation.status.${yoga.dasha_activation.status}`)}
            </Badge>
          ) : null}
        </div>
      </div>
      {meaning ? (
        <p className="mt-1.5 text-sm leading-relaxed text-text-body" data-testid="dashboard-yoga-meaning">
          <span className="font-medium text-text-primary">{tr('yogas.meaning_label')}:</span>{' '}
          {meaning}
        </p>
      ) : null}
      {formation.basis ? (
        <p className="mt-1 text-xs leading-relaxed text-text-secondary" data-testid="dashboard-yoga-basis">
          <span className="font-medium text-text-secondary">{tr('yogas.formation_label')}:</span>{' '}
          {formation.basis}
          {formation.sources ? (
            <>
              {' — '}
              <cite className="italic text-text-muted-alt">{formation.sources}</cite>
            </>
          ) : null}
        </p>
      ) : null}
    </li>
  );
}

/** Render the deterministic formed-yogas card inside the Dashboard observatory. */
export function DashboardYogasCard({ yogas }: DashboardYogasCardProps): ReactElement {
  const { t } = useTranslation('dashboard');
  const { t: tr } = useTranslation('report');

  return (
    <Card
      title={t('dashboard:chart_visualization.yogas_title')}
      subtitle={t('dashboard:chart_visualization.yogas_subtitle')}
      className="print-no-break"
      data-testid="dashboard-yogas-card"
    >
      {yogas.length === 0 ? (
        <p className="text-sm text-text-secondary">{t('dashboard:chart_visualization.yogas_empty')}</p>
      ) : (
        <>
          <p
            className="mb-4 text-xs leading-relaxed text-text-secondary"
            data-testid="dashboard-yogas-primer"
          >
            {tr('yogas.primer')}
          </p>
          <ul role="list" className="divide-y divide-ui-border">
            {yogas.map((yoga) => (
              <DashboardYogaRow
                key={`${yoga.name}-${yoga.planetary_signature}`}
                yoga={yoga}
              />
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}
