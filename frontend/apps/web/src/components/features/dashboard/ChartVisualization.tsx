/**
 * ChartVisualization — the Dashboard observatory panel.
 *
 * Consumes the engine's raw `SiderealChart` directly, renders the lazy 3D
 * planetary force field, the interactive 2D Kundli plate (with instant D1 / D9 /
 * D10 / D60 switching), and the natal D1 planetary positions table.
 */

import { lazy, Suspense, useMemo, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { SiderealChart } from '@almamesh/browser/types';
import { buildChartGeometry, useChartStore } from '@almamesh/store';
import { Card } from '../../ui';
import { PlanetaryTable } from '../astrologer-view';
import { supportsWebGl, WebGlGate } from '../../WebGlGate';
import { DashboardKundliCard } from './DashboardKundliCard';

// Lazy so three.js + the force-field chunk stay out of first paint.
const ForceFieldExperience = lazy(() =>
  import('../../forcefield').then((m) => ({ default: m.ForceFieldExperience })),
);

/** Skeleton shown while the 3D force-field chunk loads. */
function ForceFieldSkeleton(): ReactElement {
  return (
    <div className="relative h-[420px] w-full overflow-hidden rounded-2xl border border-ui-border-dark bg-background-darkest">
      <div className="absolute inset-0 -translate-x-full animate-[shimmer_2s_infinite] bg-gradient-to-r from-transparent via-white/5 to-transparent" />
    </div>
  );
}

interface ChartVisualizationProps {
  /** The engine's raw, lossless chart output (the richest feed). */
  readonly siderealChart: SiderealChart | null;
  /** Optional loading state. */
  readonly isLoading?: boolean;
  /** Optional error message. */
  readonly error?: string | null;
  /** Rendered chart size in px (default 350). */
  readonly size?: number;
  /** Optional callback to open Birth-Time Rectification for sensitive vargas. */
  readonly onRectify?: () => void;
}

/** Loading skeleton with the chart's shimmer treatment. */
function LoadingState(): ReactElement {
  return (
    <div className="space-y-6">
      <div className="bg-background-darker border border-ui-border-dark rounded-2xl p-6 animate-pulse">
        <div className="h-6 w-48 bg-ui-border-dark rounded mb-6" />
        <div className="bg-background-darkest border border-ui-border-dark rounded-xl p-5 h-[400px] relative overflow-hidden">
          <div className="absolute inset-0 -translate-x-full animate-[shimmer_2s_infinite] bg-gradient-to-r from-transparent via-white/5 to-transparent" />
        </div>
      </div>
      <div className="bg-background-darker border border-ui-border-dark rounded-xl p-6 animate-pulse">
        <div className="h-6 w-64 bg-ui-border-dark rounded mb-4" />
        <div className="h-48 bg-ui-border-dark rounded relative overflow-hidden">
          <div className="absolute inset-0 -translate-x-full animate-[shimmer_2s_infinite] bg-gradient-to-r from-transparent via-white/5 to-transparent" />
        </div>
      </div>
    </div>
  );
}

/** Inline error banner. */
function ErrorState({ message }: { readonly message: string }): ReactElement {
  return (
    <div className="bg-background-darker border border-status-debilitated/30 rounded-2xl p-6 animate-pulse">
      <div className="flex items-center gap-3 text-status-debilitated">
        <svg className="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
        <span>{message}</span>
      </div>
    </div>
  );
}

/** Empty state when no chart is available. */
function EmptyState(): ReactElement {
  const { t } = useTranslation('dashboard');
  return (
    <div className="bg-background-darker border border-ui-border-dark rounded-2xl p-6">
      <div className="text-center py-12">
        <svg
          className="w-12 h-12 mx-auto text-text-muted-alt mb-4"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
          />
        </svg>
        <h3 className="text-base font-semibold text-text-body mb-2">
          {t('dashboard:chart_visualization.empty_title')}
        </h3>
        <p className="text-text-muted-alt">
          {t('dashboard:chart_visualization.empty_body')}
        </p>
      </div>
    </div>
  );
}

/**
 * Render the D1 chart (selected style) plus the planetary positions table.
 */
export function ChartVisualization({
  siderealChart,
  isLoading = false,
  error = null,
  size = 350,
  onRectify,
}: ChartVisualizationProps): ReactElement {
  const { t } = useTranslation('dashboard');
  // Shared cross-highlight: the 3D force field and the 2D kundli select together.
  const selectedPlanet = useChartStore((state) => state.selectedPlanet);
  const setSelectedPlanet = useChartStore((state) => state.setSelectedPlanet);

  // Asked once per mount; the gate also catches a scene that throws later.
  const webGl = useMemo(() => supportsWebGl(), []);
  const geometry = useMemo(
    () => (siderealChart ? buildChartGeometry(siderealChart) : null),
    [siderealChart],
  );

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error} />;
  if (!geometry || !siderealChart) return <EmptyState />;

  return (
    <div className="space-y-6" data-testid="chart-visualization">
      {/* Hero: the 3D planetary force field (centerpiece, lazy-loaded). */}
      <Card title={t('dashboard:chart_visualization.force_field_title')} className="print-no-break">
        <WebGlGate
          available={webGl}
          fallback={
            <p className="text-sm text-text-secondary" data-testid="force-field-unavailable">
              {t('dashboard:chart_visualization.force_field_unavailable')}
            </p>
          }
        >
          <Suspense fallback={<ForceFieldSkeleton />}>
            <ForceFieldExperience
              chart={siderealChart}
              selectedPlanet={selectedPlanet}
              onSelectPlanet={setSelectedPlanet}
            />
          </Suspense>
        </WebGlGate>
      </Card>

      <DashboardKundliCard
        siderealChart={siderealChart}
        d1Geometry={geometry}
        size={size}
        selectedPlanet={selectedPlanet}
        onSelectPlanet={setSelectedPlanet}
        onRectify={onRectify}
      />

      <PlanetaryTable
        geometry={geometry}
        selectedPlanet={selectedPlanet}
        onSelectPlanet={setSelectedPlanet}
      />
    </div>
  );
}
