import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useChartLibraryStore } from '@almamesh/store'

// The prewarm hook reads the engine context; stub it so useChartCta resolves
// without a real provider mounted.
vi.mock('../providers/chartEngineContext', () => ({
  useChartEngine: () => ({ startBootstrap: vi.fn() }),
  useOptionalChartEngine: () => null,
}))

import { useChartCta } from './useChartCta'

const setHasChart = (hasChart: boolean) =>
  useChartLibraryStore.setState({
    charts: hasChart
      ? ({ saved: { chart_id: 'saved', person_name: 'Saved', is_primary: true } } as never)
      : {},
  })

describe('useChartCta', () => {
  beforeEach(() => {
    setHasChart(false)
  })

  it('routes a first-time visitor (no local chart) to onboarding with the generate label + prewarm intent', () => {
    const { result } = renderHook(() => useChartCta())

    expect(result.current.to).toBe('/onboarding')
    expect(result.current.labelKey).toBe('cta')
    expect(typeof result.current.intentProps.onPointerEnter).toBe('function')
    expect(typeof result.current.intentProps.onFocus).toBe('function')
    expect(typeof result.current.intentProps.onClick).toBe('function')
  })

  it('routes a returning visitor (has a local chart) straight to the dashboard with the returning label and no prewarm intent', () => {
    setHasChart(true)

    const { result } = renderHook(() => useChartCta())

    expect(result.current.to).toBe('/dashboard')
    expect(result.current.labelKey).toBe('ctaReturning')
    // No point warming the ~38 MB engine just to view a saved chart.
    expect(result.current.intentProps).toEqual({})
  })
})
