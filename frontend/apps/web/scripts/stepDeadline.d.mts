export declare class DeadlineError extends Error {
  readonly check: string
  readonly step: string
  readonly ms: number
  constructor(check: string, ms: number, step: string)
}

export interface DeadlineContext {
  readonly step: <T>(label: string, stepFn: () => Promise<T> | T) => Promise<T>
  readonly signal: AbortSignal
}

export interface DeadlineOptions {
  readonly log?: (line: string) => void
}

export function withDeadline<T>(
  name: string,
  ms: number,
  fn: (context: DeadlineContext) => Promise<T> | T,
  options?: DeadlineOptions,
): Promise<T>
