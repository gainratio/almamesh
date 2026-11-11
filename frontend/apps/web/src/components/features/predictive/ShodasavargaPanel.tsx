/**
 * ShodasavargaPanel — all 16 divisional charts (D1–D60) in the existing kundli
 * styles, generalizing what the D9-only view does today: pick a varga, reshape
 * it through `buildVargaGeometry` (pure, no astrology) and render the shared
 * North/South SVG. Below the chart: vargottama flags, the Ṣaḍvarga own-sign
 * tally and the Viṁśopaka 20-point composite, with `approximated` flags shown
 * honestly (≈ + footnote), never hidden.
 */

import { useMemo, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { DivisionalChartId, VargaCtxFull } from '@almamesh/shared-types';
import type { SiderealChart, VargaDetailResult } from '@almamesh/browser/types';
import { buildVargaGeometry, useChartStore } from '@almamesh/store';
import { Card } from '../../ui';
import { ChartStyleToggle } from '../../chart/ChartStyleToggle';
import { NorthIndianChartSVG } from '../../chart/NorthIndianChartSVG';
import { SouthIndianChartSVG } from '../../chart/SouthIndianChartSVG';
import { useVargaDetail } from '../../../hooks/useVargaDetail';
import { toVargaChart } from '../../../lib/predictive';
import { grahaName, signName } from '../../../lib/predictiveEventCopy';
import { D60ShashtiamsaCard, VargaSensitivityBar } from './VargaInspectorStrip';

/** BPHS Shodasavarga order. */
export const VARGA_ORDER: readonly DivisionalChartId[] = [
  'D1', 'D2', 'D3', 'D4', 'D7', 'D9', 'D10', 'D12',
  'D16', 'D20', 'D24', 'D27', 'D30', 'D40', 'D45', 'D60',
];

function VargaSelector({
  selected,
  onSelect,
  available,
}: {
  selected: DivisionalChartId;
  onSelect: (id: DivisionalChartId) => void;
  available: ReadonlySet<DivisionalChartId>;
}): ReactElement {
  const { t } = useTranslation('predictive');
  return (
    <div
      role="group"
      aria-label={t('vargas.select_label')}
      className="flex flex-wrap gap-1.5"
      data-testid="varga-selector"
    >
      {VARGA_ORDER.map((id) => {
        const active = id === selected;
        const present = available.has(id);
        return (
          <button
            key={id}
            type="button"
            onClick={() => onSelect(id)}
            disabled={!present}
            aria-pressed={active}
            title={`${t(`vargas.names.${id}`)} — ${t(`vargas.themes.${id}`)}`}
            className={`rounded-md border px-2.5 py-1 font-mono text-xs transition-colors duration-200 ${
              active
                ? 'border-accent-gold bg-accent-gold/10 text-accent-gold'
                : present
                  ? 'border-ui-border text-text-secondary hover:border-accent-gold/50 hover:text-text-primary'
                  : 'cursor-not-allowed border-ui-border/40 text-text-tertiary/50'
            }`}
            data-testid={`varga-select-${id}`}
          >
            {id}
          </button>
        );
      })}
    </div>
  );
}

export interface ShodasavargaPanelProps {
  readonly vargaCtxFull: VargaCtxFull;
  readonly siderealChart?: SiderealChart | null;
  readonly vargaDetailOverride?: VargaDetailResult | null;
  readonly onAskGuide?: (chart: DivisionalChartId, prompt: string) => void;
  readonly onRectify?: () => void;
}

/** The Shodasavarga gallery + classical strength tallies. */
export function ShodasavargaPanel({
  vargaCtxFull,
  siderealChart = null,
  vargaDetailOverride,
  onAskGuide,
  onRectify,
}: ShodasavargaPanelProps): ReactElement {
  const { t } = useTranslation('predictive');
  const displayStyle = useChartStore((state) => state.displayStyle);
  const [selected, setSelected] = useState<DivisionalChartId>('D9');
  const computedDetail = useVargaDetail(siderealChart, selected);
  const activeDetail =
    vargaDetailOverride !== undefined ? vargaDetailOverride : computedDetail;

  const available = useMemo(
    () => new Set(Object.keys(vargaCtxFull.charts) as DivisionalChartId[]),
    [vargaCtxFull],
  );

  const selectedChart = vargaCtxFull.charts[selected];
  const geometry = useMemo(
    () => (selectedChart ? buildVargaGeometry(toVargaChart(selectedChart)) : null),
    [selectedChart],
  );

  // Merge the Viṁśopaka score with the Ṣaḍvarga own-sign tally per graha.
  const ownSignByGraha = useMemo(() => {
    const map = new Map<string, { count: number; charts: readonly DivisionalChartId[] }>();
    for (const row of vargaCtxFull.shadvarga_own_sign) {
      map.set(row.graha, { count: row.own_sign_count, charts: row.charts_in_own_sign });
    }
    return map;
  }, [vargaCtxFull]);

  const anyApproximated = vargaCtxFull.vimshopaka.some((row) => row.approximated);
  const selectedName = t(`vargas.names.${selected}`);
  const selectedTheme = t(`vargas.themes.${selected}`);

  return (
    <div className="space-y-6" data-testid="shodasavarga-panel">
      <Card
        title={`${selected} · ${selectedName}`}
        subtitle={selectedTheme}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {onAskGuide && (
              <button
                type="button"
                onClick={() =>
                  onAskGuide(
                    selected,
                    t('vargas.inspector.ask_guide_prompt', {
                      chart: selected,
                      name: selectedName,
                      theme: selectedTheme,
                    }),
                  )
                }
                className="rounded-lg border border-accent-gold/40 bg-accent-gold/10 px-3 py-1.5 text-xs font-medium text-accent-gold transition-colors hover:border-accent-gold hover:bg-accent-gold/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-gold/60"
                data-testid="varga-ask-guide"
              >
                {t('vargas.inspector.ask_guide', { chart: selected })}
              </button>
            )}
            <ChartStyleToggle />
          </div>
        }
        data-testid="varga-chart-card"
      >
        <div className="mb-5">
          <VargaSelector selected={selected} onSelect={setSelected} available={available} />
        </div>
        {geometry && selectedChart ? (
          <div className="flex flex-col items-center gap-3">
            {displayStyle === 'north' ? (
              <NorthIndianChartSVG geometry={geometry} size={320} />
            ) : (
              <SouthIndianChartSVG
                geometry={geometry}
                size={320}
                centerTitle={selectedName}
                centerCode={selected}
              />
            )}
            <p className="text-sm text-text-secondary" data-testid="varga-lagna-line">
              {t('vargas.lagna_in', {
                sign: signName(t, selectedChart.lagna_sign),
                lord: grahaName(t, selectedChart.lagna_sign_lord),
              })}
            </p>
          </div>
        ) : (
          <p className="text-sm text-text-secondary" data-testid="varga-unavailable">
            {t('vargas.chart_unavailable')}
          </p>
        )}
      </Card>

      {activeDetail && activeDetail.chart === selected && selected !== 'D1' && (
        <VargaSensitivityBar chart={selected} detail={activeDetail} onRectify={onRectify} />
      )}

      {activeDetail && activeDetail.chart === 'D60' && selected === 'D60' && (
        <D60ShashtiamsaCard detail={activeDetail} />
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card
          title={t('vargas.vargottama_heading')}
          subtitle={t('vargas.vargottama_subtitle')}
          data-testid="vargottama-card"
        >
          {vargaCtxFull.vargottama.length === 0 ? (
            <p className="text-sm text-text-secondary">{t('vargas.vargottama_empty')}</p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {vargaCtxFull.vargottama.map((flag) => (
                <li
                  key={flag.point}
                  className="rounded-full border border-accent-gold/40 bg-accent-gold/10 px-3 py-1 text-sm text-accent-gold"
                >
                  {t('vargas.vargottama_point', {
                    point:
                      flag.point === 'lagna' ? t('vargas.lagna') : grahaName(t, flag.point),
                    sign: signName(t, flag.sign),
                  })}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card
          title={t('vargas.vimshopaka_heading')}
          subtitle={t('vargas.vimshopaka_subtitle')}
          data-testid="vimshopaka-card"
        >
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="vimshopaka-table">
            <thead>
              <tr className="border-b border-ui-border text-left text-xs uppercase tracking-wider text-text-tertiary">
                <th scope="col" className="py-2 pr-3 font-medium">{t('vargas.col_graha')}</th>
                <th scope="col" className="py-2 pr-3 font-medium">{t('vargas.col_score')}</th>
                <th scope="col" className="py-2 font-medium">{t('vargas.shadvarga_heading')}</th>
              </tr>
            </thead>
            <tbody>
              {vargaCtxFull.vimshopaka.map((row) => {
                const ownSign = ownSignByGraha.get(row.graha);
                return (
                  <tr key={row.graha} className="border-b border-ui-border/50 last:border-0">
                    <td className="py-2 pr-3 font-medium text-text-primary">
                      {grahaName(t, row.graha)}
                    </td>
                    <td className="py-2 pr-3 font-mono text-text-secondary">
                      {row.score}
                      {row.approximated && (
                        <span
                          className="ml-1 text-status-warning"
                          title={t('vargas.approximated')}
                          aria-label={t('vargas.approximated')}
                        >
                          ≈
                        </span>
                      )}
                    </td>
                    <td className="py-2 text-text-secondary">
                      {ownSign
                        ? `${t('vargas.own_signs', { count: ownSign.count })} (${ownSign.charts.join(', ')})`
                        : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            </table>
          </div>
          {anyApproximated && (
            <p className="mt-3 text-xs leading-relaxed text-text-tertiary" data-testid="vimshopaka-approx-note">
              {t('vargas.approx_note')}
            </p>
          )}
        </Card>
      </div>
    </div>
  );
}
