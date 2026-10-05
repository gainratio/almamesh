import type { SiderealChart } from '@almamesh/browser/types';
import { chartAnalysisInstant, type AnalysisInstant } from '@almamesh/llm';
import type { AstronomicalCalculations } from '@almamesh/shared-types';

/** The parts of a stored chart that record when it was computed. */
export interface StoredChartInstantSource {
  readonly sidereal_chart?: SiderealChart;
  readonly astronomical_calculations: Pick<AstronomicalCalculations, 'calculation_timestamp'>;
}

/**
 * The ONE analysis instant for a stored chart: its snapshot's reference_date,
 * or (for a chart stored before snapshots) its stored calculation instant.
 * UI, PDF and every AI prompt read this; none reads the wall clock.
 */
export function storedChartAnalysisInstant(stored: StoredChartInstantSource): AnalysisInstant {
  if (!stored.sidereal_chart) {
    throw new Error('analysis instant: the stored chart has no engine output');
  }
  return chartAnalysisInstant(
    stored.sidereal_chart,
    stored.astronomical_calculations.calculation_timestamp,
  );
}
