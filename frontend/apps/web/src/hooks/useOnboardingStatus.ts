import { useChartLibraryStore } from '@almamesh/store'

/**
 * Determines routing based on whether a chart exists locally.
 *
 * Single local user, no auth: resolves synchronously from the boot-hydrated
 * SQLite-backed chart store and stays reactive to later chart changes.
 * `isLoading` is retained in the contract so callers can keep their
 * loading-fallback branch; it is always `false` today.
 */
export function useOnboardingStatus(): { hasChart: boolean; isLoading: boolean } {
  const hasChart = useChartLibraryStore((state) => Object.keys(state.charts).length > 0)
  return { hasChart, isLoading: false }
}
