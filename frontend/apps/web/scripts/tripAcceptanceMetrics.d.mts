export interface TripAcceptanceLine {
  readonly model: string
  readonly question: string
  readonly pass: boolean
  readonly rounds?: number
  readonly calls?: number
  readonly validFirstTry?: number
  readonly retries?: number
  readonly errorRows?: number
}

export interface ModelMetrics {
  readonly model: string
  readonly questions: number
  readonly passed: number
  /** Lines that carry the loop fields; older lines count toward `passed` only. */
  readonly measured: number
  readonly roundsPerQuestion: number | null
  readonly callsPerQuestion: number | null
  readonly firstTryValidPct: number | null
  readonly retriesPerQuestion: number | null
  readonly errorRowsPerQuestion: number | null
}

export function modelMetrics(lines: readonly TripAcceptanceLine[]): ModelMetrics[]
export function formatModelMetrics(metrics: readonly ModelMetrics[]): string
