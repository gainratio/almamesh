/**
 * A today chat waits for the predictive layer (2026-10-14). A question sent before today's
 * predictive facts are computed went out with no ENGINE TIMING CONTEXT, so the model answered
 * blind. The send now waits (the status line says "Preparing your chart…") and goes out the moment
 * the facts are ready. If they fail, or take longer than PREDICTIVE_WAIT_MS, it answers from the
 * natal chart alone and says so in one short line.
 */

/** The predictive compute takes ~30 s on a good device; a weak one gets twice that. */
export const PREDICTIVE_WAIT_MS = 60_000;

export type PredictiveWait = 'ready' | 'natal_only';

export interface PredictiveWaitInput {
  /** Whether today's facts for this chart are computed (`currentTimelineInputState`). */
  readonly state: () => 'pending' | 'ready' | 'error';
  /** Called on every predictive store change; returns the unsubscribe. */
  readonly subscribe: (listener: () => void) => () => void;
  /** The turn's signal: a cancelled turn stops waiting. */
  readonly signal: AbortSignal;
  /** Shown once, only when the send has to wait. */
  readonly onWaiting: () => void;
  readonly timeoutMs?: number;
}

function settled(state: ReturnType<PredictiveWaitInput['state']>): PredictiveWait | undefined {
  if (state === 'ready') return 'ready';
  return state === 'error' ? 'natal_only' : undefined;
}

/** Resolves when the facts are ready ('ready'), failed or timed out ('natal_only'); rejects on abort. */
export function waitForPredictiveFacts(input: PredictiveWaitInput): Promise<PredictiveWait> {
  if (input.signal.aborted) return Promise.reject(input.signal.reason as Error);
  const now = settled(input.state());
  if (now) return Promise.resolve(now);
  input.onWaiting();
  return new Promise<PredictiveWait>((resolve, reject) => {
    const finish = (done: () => void) => {
      unsubscribe();
      clearTimeout(timer);
      input.signal.removeEventListener('abort', onAbort);
      done();
    };
    const onAbort = () => finish(() => reject(input.signal.reason as Error));
    const unsubscribe = input.subscribe(() => {
      const outcome = settled(input.state());
      if (outcome) finish(() => resolve(outcome));
    });
    const timer = setTimeout(() => finish(() => resolve('natal_only')), input.timeoutMs ?? PREDICTIVE_WAIT_MS);
    input.signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** The answer with its one short natal-only line above it. */
export function natalOnlyNoted(note: string, answer: string): string {
  return `_${note}_\n\n${answer}`;
}
