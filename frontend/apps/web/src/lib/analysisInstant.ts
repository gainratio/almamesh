import type { SiderealChart } from '@almamesh/browser/types';
import { chartAnalysisInstant, todayAnalysisInstant, type AnalysisInstant } from '@almamesh/llm';
import type { AstronomicalCalculations } from '@almamesh/shared-types';

/** The parts of a stored chart that record when it was computed. */
export interface StoredChartInstantSource {
  readonly sidereal_chart?: SiderealChart;
  readonly astronomical_calculations: Partial<
    Pick<AstronomicalCalculations, 'calculation_timestamp'>
  >;
}

function isParseableInstant(value: string | undefined): value is string {
  return value !== undefined && !Number.isNaN(Date.parse(value));
}

/**
 * The ONE analysis instant for a stored chart: its snapshot's reference_date,
 * or (for a chart stored before snapshots) its stored calculation instant.
 * UI, PDF and every AI prompt read this; none reads the wall clock.
 *
 * The oldest backups carry a chart that records NEITHER. Those get an honest,
 * labelled "today" basis (what every prompt used before snapshots existed)
 * rather than a throw that would lock the user out of chat and readings for
 * data they restored. `today` is only read on that legacy path.
 */
export function storedChartAnalysisInstant(
  stored: StoredChartInstantSource,
  today: () => Date = () => new Date(),
): AnalysisInstant {
  if (!stored.sidereal_chart) {
    throw new Error('analysis instant: the stored chart has no engine output');
  }
  const recorded = stored.astronomical_calculations.calculation_timestamp;
  if (stored.sidereal_chart.snapshot === undefined && !isParseableInstant(recorded)) {
    return todayAnalysisInstant(today());
  }
  return chartAnalysisInstant(stored.sidereal_chart, recorded);
}
