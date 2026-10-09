import type { ChartEngine } from '@almamesh/browser'
import type { PortableStatePersistence } from '@almamesh/store'
import type { SqliteMemoryProof } from './chatMemory'

export type RuntimeChartGenerator = ChartEngine['generateChart']
export type RuntimePredictiveComputer = ChartEngine['computePredictive']
export type RuntimeMoonWindowComputer = ChartEngine['computeMoonWindow']
export type RuntimePlaceResolver = (query: string) => Promise<unknown>

declare global {
  interface Window {
    __ALMAMESH_STAGE__?: string
    __ALMAMESH_ERROR__?: string
    __almameshGenerate?: RuntimeChartGenerator
    __almameshComputePredictive?: RuntimePredictiveComputer
    __almameshComputeMoonWindow?: RuntimeMoonWindowComputer
    __almameshResolvePlace?: RuntimePlaceResolver
    __almameshVerifySqliteMemory?: () => Promise<SqliteMemoryProof>
    __almameshPortableStatePersistence?: () => PortableStatePersistence
    __almameshPredictiveRequestKeys?: string[]
    __almameshPinnedThreads?: () => readonly PinnedThreadRow[]
  }
}

export const publishRuntimeStage = (stage: string): void => {
  window.__ALMAMESH_STAGE__ = stage
}

export const publishRuntimeError = (message: string): void => {
  window.__ALMAMESH_ERROR__ = message
}

export const clearRuntimeError = (): void => {
  delete window.__ALMAMESH_ERROR__
}

export const publishRuntimeGenerator = (generate: RuntimeChartGenerator): void => {
  window.__almameshGenerate = generate
}

export const clearRuntimeGenerator = (): void => {
  delete window.__almameshGenerate
}

/** Exit-gate builds only: lets the browser parity gate run the predictive entry directly. */
export const publishRuntimePredictive = (compute: RuntimePredictiveComputer): void => {
  window.__almameshComputePredictive = compute
}

export const clearRuntimePredictive = (): void => {
  delete window.__almameshComputePredictive
}

/** Exit-gate builds only: lets the browser parity gate run the moon window entry directly. */
export const publishRuntimeMoonWindow = (compute: RuntimeMoonWindowComputer): void => {
  window.__almameshComputeMoonWindow = compute
}

export const clearRuntimeMoonWindow = (): void => {
  delete window.__almameshComputeMoonWindow
}

/** Exit-gate builds only: lets the memory-budget lane run the first place lookup directly. */
export const publishRuntimeResolvePlace = (resolve: RuntimePlaceResolver): void => {
  window.__almameshResolvePlace = resolve
}

export const clearRuntimeResolvePlace = (): void => {
  delete window.__almameshResolvePlace
}

interface PredictiveRequestKeyState {
  readonly requestKey?: string
}

/** The slice of the predictive store this hook reads (a zustand store fits it). */
export interface PredictiveRequestKeySource {
  getState(): PredictiveRequestKeyState
  subscribe(listener: (state: PredictiveRequestKeyState) => void): () => void
}

/**
 * Publish every requestKey the predictive store (the Life Atlas slot) holds, in
 * order. A history, not the current value: a compute that borrows the slot and
 * hands it back would pass a before/after compare. Returns the unsubscribe.
 */
export const publishPredictiveRequestKeys = (store: PredictiveRequestKeySource): (() => void) => {
  const history: string[] = []
  window.__almameshPredictiveRequestKeys = history
  const record = (state: PredictiveRequestKeyState): void => {
    const key = state.requestKey ?? '(none)'
    if (history[history.length - 1] !== key) history.push(key)
  }
  record(store.getState())
  return store.subscribe(record)
}

export interface PinnedThreadRow {
  readonly id: string
  readonly as_of: unknown
}

/** Exit-gate builds only: lets the time-travel and backup suites compare pins field for field. */
export const publishPinnedThreads = (read: () => readonly PinnedThreadRow[]): void => {
  window.__almameshPinnedThreads = read
}
