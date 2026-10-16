export interface TripAcceptanceLine {
  readonly model: string
  readonly question: string
  readonly pass: boolean
  readonly rounds?: number
  /** Every call, the answer included. */
  readonly calls?: number
  readonly validFirstTry?: number
  readonly retries?: number
  readonly errorRows?: number
  /** read_period and travel calls only. */
  readonly toolCalls?: number
  readonly toolValidFirstTry?: number
  /** 1 when the first answer submission was accepted, else 0. */
  readonly answerValidFirstTry?: number
  readonly answerRetries?: number
}

export interface ModelMetrics {
  readonly model: string
  readonly questions: number
  readonly passed: number
  /** Lines that carry the loop fields; older lines count toward `passed` only. */
  readonly measured: number
  /** Lines that carry the tool/answer split. */
  readonly split: number
  readonly roundsPerQuestion: number | null
  readonly toolCallsPerQuestion: number | null
  readonly toolFirstTryValidPct: number | null
  readonly answerFirstTryValidPct: number | null
  readonly retriesPerQuestion: number | null
  readonly answerRetriesPerQuestion: number | null
  readonly errorRowsPerQuestion: number | null
}

export function modelMetrics(lines: readonly TripAcceptanceLine[]): ModelMetrics[]
export function formatModelMetrics(metrics: readonly ModelMetrics[]): string
