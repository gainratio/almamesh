/**
 * Local-first chart read helper.
 *
 * The on-device chart library (`@almamesh/store` chartLibrary, OPFS SQLite)
 * stores the adapted `ChartData`. The legacy UI pages consume the richer
 * `BirthChartGenerationResponse` the backend used to return, so this maps the
 * persisted primary chart into that shape. One place owns the mapping; every
 * page that used to call `getUserPrimaryChart()` now calls this instead.
 */

import {
  useChartLibraryStore,
  whenChartLibraryHydrated,
  whenChartLibraryPersisted,
} from '@almamesh/store'
import type { BirthChartGenerationResponse } from '@almamesh/shared-types'

/** The "no chart on this device" response, shaped like the backend's miss. */
function emptyPrimaryChart(): BirthChartGenerationResponse {
  return {
    success: false,
    message: 'No chart found on this device.',
    person_name: '',
    chart_data_stored: false,
    generated_at: new Date(0).toISOString(),
  }
}

/**
 * Read the device's primary chart as a `BirthChartGenerationResponse`.
 *
 * The library store rehydrates from portable SQLite asynchronously, so on a fresh
 * document load (PWA reopen / hard refresh) it is still empty at first render.
 * We `await whenChartLibraryHydrated()` before reading — otherwise the read
 * returns a false "no chart" miss that strands the dashboard on an infinite
 * loading spinner. It then awaits any queued library write, so the dashboard
 * never shows a chart that a reload would lose. Returns a benign "no chart"
 * response when none exists.
 */
export async function readLocalPrimaryChart(): Promise<BirthChartGenerationResponse> {
  await whenChartLibraryHydrated()
  await whenChartLibraryPersisted()
  const primary = useChartLibraryStore.getState().getPrimaryChart()
  if (!primary) {
    return emptyPrimaryChart()
  }
  const { person_name, is_primary, chart_id, profile_id, ...chartData } = primary
  void is_primary
  void profile_id
  return {
    success: true,
    message: 'Chart loaded from device.',
    person_name,
    chart_id,
    chart_data: chartData,
    chart_data_stored: true,
    generated_at: chartData.astronomical_calculations.calculation_timestamp,
  }
}
