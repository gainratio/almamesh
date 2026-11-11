/**
 * VargaInspectorStrip & D60ShashtiamsaCard — high-precision divisional insights
 * computed deterministically on-device via `computeVargaDetail`.
 *
 * Pure presentation: renders Lagna birth-time cusp sensitivity in minutes and
 * the BPHS Ch. 6 60-Aṁśa breakdown for Ṣaṣṭyāṁśa (D60). Zero degree symbols
 * (`°`) are emitted so sign-placement varga invariants remain crisp.
 */

import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { DivisionalChartId, VargaDetailResult } from '@almamesh/browser/types';
import { Card } from '../../ui';
import { grahaName, signName } from '../../../lib/predictiveEventCopy';

const GRAHA_ORDER = [
  'sun', 'moon', 'mars', 'mercury', 'jupiter', 'venus', 'saturn', 'rahu', 'ketu',
] as const;

export function VargaSensitivityBar({
  chart,
  detail,
  onRectify,
}: {
  readonly chart: DivisionalChartId;
  readonly detail: VargaDetailResult;
  readonly onRectify?: (() => void) | undefined;
}): ReactElement {
  const { t } = useTranslation('predictive');
  const minutes = detail.sensitivity.approx_minutes_to_cusp.toFixed(1);
  const high = detail.sensitivity.high_time_sensitivity;

  return (
    <div
      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-ui-border/70 bg-background-darkest/60 px-3.5 py-2 text-xs"
      data-testid="varga-sensitivity-bar"
    >
      <div className="flex flex-wrap items-center gap-2 text-text-secondary">
        <span>
          {t('vargas.inspector.sensitivity_label', { minutes, chart })}
        </span>
        {high && (
          <span
            className="rounded-full border border-status-warning/40 bg-status-warning/10 px-2 py-0.5 font-medium text-status-warning"
            data-testid="varga-sensitivity-high"
          >
            {t('vargas.inspector.sensitivity_high')}
          </span>
        )}
      </div>
      {high && onRectify && (
        <button
          type="button"
          onClick={onRectify}
          className="font-medium text-accent-gold underline-offset-2 hover:text-accent-gold-bright hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-gold/60"
          data-testid="varga-rectify-cta"
        >
          {t('vargas.inspector.rectify_cta')} →
        </button>
      )}
    </div>
  );
}

export function D60ShashtiamsaCard({
  detail,
}: {
  readonly detail: VargaDetailResult;
}): ReactElement | null {
  const { t } = useTranslation('predictive');
  if (detail.chart !== 'D60' || !detail.lagna_shashtiamsa) return null;

  const rows = [
    {
      key: 'lagna',
      label: t('vargas.lagna'),
      sign: detail.lagna_sign,
      house: 1,
      amsa: detail.lagna_shashtiamsa,
    },
    ...GRAHA_ORDER.flatMap((key) => {
      const p = detail.placements[key];
      return p?.shashtiamsa
        ? [{ key, label: grahaName(t, p.graha), sign: p.sign, house: p.house, amsa: p.shashtiamsa }]
        : [];
    }),
  ];

  return (
    <Card
      title={t('vargas.inspector.d60_heading')}
      subtitle={t('vargas.inspector.d60_subtitle')}
      data-testid="d60-shashtiamsa-card"
    >
      <div className="overflow-x-auto">
        <table className="w-full text-sm" data-testid="d60-shashtiamsa-table">
          <thead>
            <tr className="border-b border-ui-border text-left text-xs uppercase tracking-wider text-text-tertiary">
              <th scope="col" className="py-2 pr-3 font-medium">{t('vargas.inspector.col_point')}</th>
              <th scope="col" className="py-2 pr-3 font-medium">{t('vargas.inspector.col_sign_house')}</th>
              <th scope="col" className="py-2 pr-3 font-medium">{t('vargas.inspector.col_amsa')}</th>
              <th scope="col" className="py-2 font-medium">{t('vargas.inspector.col_nature')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const saumya = row.amsa.nature === 'saumya';
              return (
                <tr key={row.key} className="border-b border-ui-border/50 last:border-0">
                  <td className="py-2 pr-3 font-medium text-text-primary">{row.label}</td>
                  <td className="py-2 pr-3 text-text-secondary">
                    {signName(t, row.sign)} · {t('vargas.inspector.house_short', { house: row.house })}
                  </td>
                  <td className="py-2 pr-3 font-mono text-xs text-text-primary">
                    #{row.amsa.number} · {row.amsa.name}
                  </td>
                  <td className="py-2">
                    <span
                      className={`inline-block rounded-full border px-2.5 py-0.5 text-xs font-medium ${
                        saumya
                          ? 'border-status-success/40 bg-status-success/10 text-status-success'
                          : 'border-status-warning/40 bg-status-warning/10 text-status-warning'
                      }`}
                    >
                      {saumya
                        ? t('vargas.inspector.nature_saumya')
                        : t('vargas.inspector.nature_krura')}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
