import type { ChartEngine } from '@almamesh/browser'
import type { PortableStatePersistence } from '@almamesh/store'
import type { SqliteMemoryProof } from './chatMemory'

export type RuntimeChartGenerator = ChartEngine['generateChart']

declare global {
  interface Window {
    __ALMAMESH_STAGE__?: string
    __ALMAMESH_ERROR__?: string
    __almameshGenerate?: RuntimeChartGenerator
    __almameshVerifySqliteMemory?: () => Promise<SqliteMemoryProof>
    __almameshPortableStatePersistence?: () => PortableStatePersistence
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
