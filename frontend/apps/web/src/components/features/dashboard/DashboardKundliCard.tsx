/**
 * DashboardKundliCard — the 2D Kundli plate on the Dashboard with instant
 * switching between D1 (Rāśi), D9 (Navāṁśa), D10 (Daśāṁśa), and D60 (Ṣaṣṭyāṁśa).
 *
 * Zero astrology math in TypeScript: D1 uses `buildChartGeometry`, D9 uses
 * `siderealChart.navamsa` (0ms) or `computeVargaDetail`, and D10/D60 read from
 * `varga_context_full` or the deterministic Python `computeVargaDetail` RPC.
 */

import { useMemo, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { DivisionalChartId, SiderealChart } from '@almamesh/browser/types';
import {
  buildVargaGeometry,
  useChartStore,
  type ChartGeometry,
} from '@almamesh/store';
import { Card } from '../../ui';
import { ChartStyleToggle } from '../../chart/ChartStyleToggle';
import { NorthIndianChartSVG } from '../../chart/NorthIndianChartSVG';
import { SouthIndianChartSVG } from '../../chart/SouthIndianChartSVG';
import { useVargaDetail } from '../../../hooks/useVargaDetail';
import { useOptionalChartEngine } from '../../../providers/chartEngineContext';
import { toVargaChart } from '../../../lib/predictive';
import { vargaDetailToVargaChart } from '../../../lib/vargaDetailClient';
import { grahaName, signName } from '../../../lib/predictiveEventCopy';
import { VargaSensitivityBar } from '../predictive/VargaInspectorStrip';

const QUICK_VARGAS: readonly ('D1' | 'D9' | 'D10' | 'D60')[] = ['D1', 'D9', 'D10', 'D60'];

export interface DashboardKundliCardProps {
  readonly siderealChart: SiderealChart;
  readonly d1Geometry: ChartGeometry;
  readonly size: number;
  readonly selectedPlanet: string | null;
  readonly onSelectPlanet: (planet: string | null) => void;
  readonly onRectify?: () => void;
}

export function DashboardKundliCard({
  siderealChart,
  d1Geometry,
  size,
  selectedPlanet,
  onSelectPlanet,
  onRectify,
}: DashboardKundliCardProps): ReactElement {
  const { t: tDash } = useTranslation('dashboard');
  const { t: tPred } = useTranslation('predictive');
  const displayStyle = useChartStore((s) => s.displayStyle);
  const engineReady = Boolean(useOptionalChartEngine()?.engine);
  const [division, setDivision] = useState<'D1' | 'D9' | 'D10' | 'D60'>('D1');

  const vargaDetail = useVargaDetail(
    siderealChart,
    division === 'D1' ? null : (division as DivisionalChartId),
  );

  const canSelect = (id: 'D1' | 'D9' | 'D10' | 'D60'): boolean => {
    if (id === 'D1') return true;
    if (id === 'D9' && siderealChart.navamsa) return true;
    if (siderealChart.varga_context_full?.charts?.[id]) return true;
    return engineReady;
  };

  const activeGeometry = useMemo((): ChartGeometry | null => {
    if (division === 'D1') return d1Geometry;
    if (vargaDetail && vargaDetail.chart === division) {
      return buildVargaGeometry(vargaDetailToVargaChart(vargaDetail));
    }
    const fromFull = siderealChart.varga_context_full?.charts?.[division];
    if (fromFull) {
      return buildVargaGeometry(toVargaChart(fromFull as Parameters<typeof toVargaChart>[0]));
    }
    if (division === 'D9' && siderealChart.navamsa) {
      return buildVargaGeometry(siderealChart.navamsa);
    }
    return null;
  }, [division, d1Geometry, siderealChart, vargaDetail]);

  const vargaName = tPred(`vargas.names.${division}`);
  const title =
    division === 'D1'
      ? tDash('chart_visualization.kundli_title')
      : `${division} · ${vargaName}`;

  return (
    <Card
      title={title}
      subtitle={division === 'D1' ? undefined : tPred(`vargas.themes.${division}`)}
      actions={<ChartStyleToggle />}
      className="print-container print-no-break"
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 print:hidden">
        <div
          role="group"
          aria-label={tPred('vargas.inspector.dashboard_switcher_label')}
          className="flex flex-wrap gap-1.5"
          data-testid="dashboard-varga-switcher"
        >
          {QUICK_VARGAS.map((id) => {
            const active = id === division;
            const enabled = canSelect(id);
            return (
              <button
                key={id}
                type="button"
                disabled={!enabled}
                aria-pressed={active}
                onClick={() => setDivision(id)}
                title={`${tPred(`vargas.names.${id}`)} — ${tPred(`vargas.themes.${id}`)}`}
                className={`rounded-md border px-2.5 py-1 font-mono text-xs transition-colors ${
                  active
                    ? 'border-accent-gold bg-accent-gold/10 text-accent-gold'
                    : enabled
                      ? 'border-ui-border text-text-secondary hover:border-accent-gold/50 hover:text-text-primary'
                      : 'cursor-not-allowed border-ui-border/40 text-text-tertiary/50'
                }`}
                data-testid={`dashboard-varga-${id}`}
              >
                {id} · {tPred(`vargas.names.${id}`)}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-col items-center gap-3 print-chart-box">
        {activeGeometry ? (
          displayStyle === 'north' ? (
            <NorthIndianChartSVG
              geometry={activeGeometry}
              selectedPlanet={selectedPlanet}
              onSelectPlanet={onSelectPlanet}
              size={size}
            />
          ) : (
            <SouthIndianChartSVG
              geometry={activeGeometry}
              selectedPlanet={selectedPlanet}
              onSelectPlanet={onSelectPlanet}
              size={size}
              {...(division === 'D1'
                ? {}
                : { centerCode: division, centerTitle: vargaName })}
            />
          )
        ) : (
          <div className="h-[300px] w-[300px] animate-pulse rounded-xl border border-ui-border-dark bg-background-darkest" />
        )}

        {division !== 'D1' && vargaDetail && vargaDetail.chart === division && (
          <div className="w-full max-w-xl space-y-2">
            <p className="text-center text-xs text-text-secondary" data-testid="dashboard-varga-lagna">
              {tPred('vargas.lagna_in', {
                sign: signName(tPred, vargaDetail.lagna_sign),
                lord: grahaName(tPred, vargaDetail.lagna_sign_lord),
              })}
              {division === 'D60' && vargaDetail.lagna_shashtiamsa
                ? ` · #${vargaDetail.lagna_shashtiamsa.number} ${vargaDetail.lagna_shashtiamsa.name}`
                : ''}
            </p>
            <VargaSensitivityBar
              chart={division as DivisionalChartId}
              detail={vargaDetail}
              onRectify={onRectify}
            />
          </div>
        )}
      </div>
    </Card>
  );
}
