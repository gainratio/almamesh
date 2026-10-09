/**
 * Wait for engine work until the caller cancels or a deadline passes. The work
 * itself keeps running either way: a slow engine compute is never cancelled by
 * one impatient waiter, so a later ask can still join it.
 */
export interface DeadlineOptions {
  readonly timeoutMs: number;
  /** The error a waiter sees once `timeoutMs` passes. */
  readonly onTimeout: () => Error;
  /** The message used when the work rejects with something that is not an Error. */
  readonly failureMessage: string;
}

/** The signal's own reason when it is an Error, else a standard AbortError. */
export function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new DOMException('The operation was aborted', 'AbortError');
}

export function withDeadline<T>(work: Promise<T>, signal: AbortSignal, options: DeadlineOptions): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      settle();
    };
    const onAbort = (): void => finish(() => reject(abortReason(signal)));
    const timeout = setTimeout(() => finish(() => reject(options.onTimeout())), options.timeoutMs);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) =>
        finish(() => reject(error instanceof Error ? error : new Error(options.failureMessage))),
    );
  });
}
