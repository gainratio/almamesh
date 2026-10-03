/**
 * Synchronous chart-routing helpers.
 *
 * The application boot barrier awaits the canonical SQLite-backed chart store's
 * hydration before React renders. Route guards can therefore inspect the live
 * in-memory store synchronously without maintaining a second durable flag.
 */

import { useChartLibraryStore } from '@almamesh/store'

/**
 * True when the hydrated library contains any chart on this device. Use the
 * unscoped list: a chart owned by another profile still makes this a returning
 * installation and must not route to first-run onboarding.
 */
export function hasLocalChart(): boolean {
  return useChartLibraryStore.getState().listAllCharts().length > 0
}
