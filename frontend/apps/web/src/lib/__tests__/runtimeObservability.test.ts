import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BirthInput, SiderealChart } from '@almamesh/browser'
import {
  clearRuntimeError,
  clearRuntimeGenerator,
  publishPredictiveRequestKeys,
  publishRuntimeError,
  publishRuntimeGenerator,
  publishRuntimeStage,
} from '../runtimeObservability'

afterEach(() => {
  clearRuntimeGenerator()
})

describe('runtime observability', () => {
  it('publishes typed stage and error values for browser gates', () => {
    publishRuntimeStage('ready')
    publishRuntimeError('signature failed')

    expect(window.__ALMAMESH_STAGE__).toBe('ready')
    expect(window.__ALMAMESH_ERROR__).toBe('signature failed')
    clearRuntimeError()
    expect(window.__ALMAMESH_ERROR__).toBeUndefined()
  })

  it('publishes and clears the engine generator with its real input/output contract', async () => {
    const birth: BirthInput = {
      datetimeUtc: '1990-03-30T06:30:00Z',
      latitude: 12.97,
      longitude: 77.59,
      referenceDate: '2025-01-01T00:00:00+00:00',
    }
    const chart = { ayanamsa_value: 23.86 } as SiderealChart
    const generate = vi.fn(async (_birth: BirthInput): Promise<SiderealChart> => chart)

    publishRuntimeGenerator(generate)

    await expect(window.__almameshGenerate?.(birth)).resolves.toBe(chart)
    expect(generate).toHaveBeenCalledWith(birth)

    clearRuntimeGenerator()
    expect(window.__almameshGenerate).toBeUndefined()
  })

  it('records every predictive requestKey the store holds, so a borrowed slot shows even if handed back', () => {
    let state: { requestKey?: string } = { requestKey: 'today' }
    const listeners = new Set<(next: { requestKey?: string }) => void>()
    const store = {
      getState: () => state,
      subscribe: (listener: (next: { requestKey?: string }) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    }
    const set = (requestKey?: string) => {
      state = requestKey === undefined ? {} : { requestKey }
      for (const listener of listeners) listener(state)
    }

    const stop = publishPredictiveRequestKeys(store)
    set('today')
    set('june-2019')
    set(undefined)
    set('today')
    stop()
    set('after-stop')

    expect(window.__almameshPredictiveRequestKeys).toEqual(['today', 'june-2019', '(none)', 'today'])
  })
})
