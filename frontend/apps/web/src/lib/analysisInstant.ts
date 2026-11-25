import type { SiderealChart } from '@almamesh/browser/types';
import { chartAnalysisInstant, todayAnalysisInstant, type AnalysisInstant } from '@almamesh/llm';
import type { AstronomicalCalculations, ProcessedBirthData } from '@almamesh/shared-types';

import { predictiveReferenceInstant } from './predictive';

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

/** A stored chart plus the birth place whose calendar its analysis day is read in. */
export interface StoredChartDaySource {
  readonly sidereal_chart?: SiderealChart;
  /** Optional: a damaged or pre-P4 row may carry none; it then records no instant. */
  readonly astronomical_calculations?: Partial<
    Pick<AstronomicalCalculations, 'calculation_timestamp' | 'snapshot'>
  >;
  readonly birth_data?: Partial<Pick<ProcessedBirthData, 'birth_location_details'>>;
}

/** The chart's own recorded instant (snapshot first), or undefined when it records none. */
function recordedInstant(stored: StoredChartDaySource): string | undefined {
  const candidate =
    stored.sidereal_chart?.snapshot?.reference_date ??
    stored.astronomical_calculations?.snapshot?.reference_date ??
    stored.astronomical_calculations?.calculation_timestamp;
  return isParseableInstant(candidate) ? candidate : undefined;
}

/**
 * The viewer's timezone: the calendar every "As of" is printed in. The footer,
 * the report cover, the PDF and the prompt's `as_of` all print the instant's
 * date in this zone (#274), so the analysis DAY is read in it too.
 */
export function viewerTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** True when the chart records its own analysis instant (a snapshot or a calculation time). */
export function storedChartRecordsInstant(stored: StoredChartDaySource): boolean {
  return recordedInstant(stored) !== undefined;
}

/**
 * The ONE exact analysis instant for a stored chart: its snapshot's
 * `reference_date`, or its stored calculation timestamp, falling back to
 * `fallbackInstant` only for legacy backups that record neither.
 *
 * Passing the chart's EXACT instant (not UTC midnight of its calendar day) to
 * the predictive layer guarantees that `domains_context` and `transit_context`
 * evaluate the exact same active Mahā / Antar / Pratyantar daśā as
 * `sidereal_chart` — even on the day of an intra-day daśā rollover.
 */
export function storedChartReferenceInstant(
  stored: StoredChartDaySource,
  fallbackInstant: string,
): string {
  return recordedInstant(stored) ?? fallbackInstant;
}

/**
 * The ONE analysis DAY for a stored chart: the calendar day of its analysis
 * instant, as the UTC-midnight `predictiveReferenceInstant` the engine takes.
 * Used for day-boundary staleness checks (`useChartReanchor`) so a returning
 * visitor re-anchors once per calendar day in the viewer's timezone.
 */
export function storedChartReferenceDay(stored: StoredChartDaySource, todayDay: string): string {
  const instant = recordedInstant(stored);
  if (instant === undefined) {
    return todayDay;
  }
  return predictiveReferenceInstant(new Date(instant), viewerTimeZone());
}
