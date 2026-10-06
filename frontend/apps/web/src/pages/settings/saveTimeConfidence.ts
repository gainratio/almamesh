import type { TimeConfidence } from '@almamesh/constants';
import { flushPortablePersistence, useChartLibraryStore, type StoredChart } from '@almamesh/store';

/** The chart-library operations a confidence save needs (injected in tests). */
export interface TimeConfidenceSaveDeps {
  readonly getChart: (chartId: string) => StoredChart | undefined;
  readonly saveChart: (chart: StoredChart) => void;
  /** Resolves once every queued write is durable; rejects if one failed. */
  readonly flush: () => Promise<void>;
}

export type TimeConfidenceSaveResult = 'saved' | 'not-saved';

function defaultDeps(): TimeConfidenceSaveDeps {
  const library = useChartLibraryStore.getState();
  return { getChart: library.getChart, saveChart: library.saveChart, flush: flushPortablePersistence };
}

/**
 * Save a new birth-time confidence on the stored chart WITHOUT regenerating:
 * confidence does not define the chart (it is not part of `chartId`). The
 * result is honest: `saved` only once the write is durable; on failure the
 * in-memory chart is restored so the page never shows an unsaved value.
 */
export async function saveTimeConfidence(
  chartId: string,
  timeConfidence: TimeConfidence,
  deps: TimeConfidenceSaveDeps = defaultDeps(),
): Promise<TimeConfidenceSaveResult> {
  const previous = deps.getChart(chartId);
  if (!previous) return 'not-saved';
  deps.saveChart({
    ...previous,
    birth_data: { ...previous.birth_data, birth_time_confidence: timeConfidence },
  } as StoredChart);
  try {
    await deps.flush();
    return 'saved';
  } catch {
    // The write never reached SQLite: put the old chart back and say so.
    deps.saveChart(previous);
    return 'not-saved';
  }
}
