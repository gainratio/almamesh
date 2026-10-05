/**
 * An awaitable request to regenerate the primary chart.
 *
 * `appEvents.emit('birth-info-changed')` is fire-and-forget: the caller cannot
 * know when the chart exists. Onboarding used to emit and navigate in the same
 * millisecond, so a reload before the worker replied lost the chart for good
 * (prod 6a89c0e, 2026-10-05). A page that must not leave until the chart is
 * saved calls `requestRegeneration(event)` and awaits it instead.
 *
 * The app's ONE regeneration subscriber (`useRegenerationSubscription`)
 * registers itself as the runner, so there is still exactly one place that
 * computes. Requests made before it registers are held and run on registration.
 */

import type { BirthInfoChanged } from './events';

/** Applies one event; resolves once the new chart is saved (in memory). */
export type RegenerationRunner = (event: BirthInfoChanged) => Promise<void>;

interface HeldRequest {
  readonly event: BirthInfoChanged;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
}

let runner: RegenerationRunner | null = null;
let held: HeldRequest[] = [];

/**
 * Become the runner. Returns the unregister function. Any requests held while
 * no runner existed are handed over in order.
 */
export function registerRegenerationRunner(next: RegenerationRunner): () => void {
  runner = next;
  const pending = held;
  held = [];
  for (const request of pending) {
    next(request.event).then(request.resolve, request.reject);
  }
  return () => {
    if (runner === next) {
      runner = null;
    }
  };
}

/** Regenerate for `event`; resolves when the runner has applied it, rejects on failure. */
export function requestRegeneration(event: BirthInfoChanged): Promise<void> {
  if (runner !== null) {
    return runner(event);
  }
  return new Promise<void>((resolve, reject) => {
    held.push({ event, resolve, reject });
  });
}
