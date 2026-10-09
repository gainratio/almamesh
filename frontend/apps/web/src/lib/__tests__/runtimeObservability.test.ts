import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  BirthInput,
  MoonWindow,
  MoonWindowInput,
  PredictiveContexts,
  PredictiveInput,
  SiderealChart,
} from '@almamesh/browser'
import {
  clearRuntimeError,
  clearRuntimeGenerator,
  clearRuntimeMoonWindow,
  clearRuntimeResolvePlace,
  clearRuntimePredictive,
  publishPredictiveRequestKeys,
  publishRuntimeError,
  publishRuntimeGenerator,
  publishRuntimeMoonWindow,
  publishRuntimeResolvePlace,
  publishRuntimePredictive,
  publishRuntimeStage,
} from '../runtimeObservability'

afterEach(() => {
  clearRuntimeGenerator()
  clearRuntimePredictive()
  clearRuntimeMoonWindow()
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

  it('publishes and clears the predictive computer for the browser parity gate', async () => {
    const input = { datetimeUtc: '1990-01-15T12:00:00+00:00', windowMonths: 24 } as PredictiveInput
    const contexts = { strength_signer_public_key: 'k' } as PredictiveContexts
    const compute = vi.fn(async (_input: PredictiveInput): Promise<PredictiveContexts> => contexts)

    publishRuntimePredictive(compute)

    await expect(window.__almameshComputePredictive?.(input)).resolves.toBe(contexts)
    expect(compute).toHaveBeenCalledWith(input)

    clearRuntimePredictive()
    expect(window.__almameshComputePredictive).toBeUndefined()
  })

  it('publishes and clears the moon window computer for the browser parity gate', async () => {
    const input = { placeStartUtc: '2026-06-15T05:00:00+00:00', placeEndUtc: '2026-06-16T05:00:00+00:00' }
    const window_ = { at_place: {}, event: null } as unknown as MoonWindow
    const compute = vi.fn(async (_input: MoonWindowInput): Promise<MoonWindow> => window_)

    publishRuntimeMoonWindow(compute)

    await expect(window.__almameshComputeMoonWindow?.(input)).resolves.toBe(window_)
    expect(compute).toHaveBeenCalledWith(input)

    clearRuntimeMoonWindow()
    expect(window.__almameshComputeMoonWindow).toBeUndefined()
  })

  it('publishes and clears the place resolver for the memory-budget gate', async () => {
    const lookup = vi.fn(async (_query: string): Promise<unknown> => ({ status: 'found' }))

    publishRuntimeResolvePlace(lookup)

    await expect(window.__almameshResolvePlace?.('Bogotá')).resolves.toEqual({ status: 'found' })
    expect(lookup).toHaveBeenCalledWith('Bogotá')

    clearRuntimeResolvePlace()
    expect(window.__almameshResolvePlace).toBeUndefined()
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
