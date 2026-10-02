/**
 * Live-timer tracking for the unit suite.
 *
 * A timer that outlives its test file fires after Vitest tears the DOM
 * environment down, where `window`/`requestAnimationFrame` no longer exist.
 * The test files all pass, but Vitest reports an unhandled error and the gate
 * goes red at random (it depends on how long the worker survives teardown).
 *
 * `installLiveTimerTracking` wraps the global timer functions so every
 * still-pending interval, timeout and animation-frame callback is known,
 * together with the stack that created it. It must run from the setup file,
 * before any module under test is imported: libraries such as GSAP's
 * ScrollTrigger arm their timers at import time.
 */

export type LiveTimerKind = 'interval' | 'timeout' | 'animationFrame';

export interface LiveTimer {
  readonly kind: LiveTimerKind;
  readonly createdAt: string;
}

type Handle = unknown;
type TimerFn = (handler: unknown, ...rest: unknown[]) => Handle;
type ClearFn = (handle: Handle) => void;

const live = new Map<Handle, LiveTimer>();
let installed = false;

function creationSite(): string {
  const stack = new Error().stack ?? '';
  return stack.split('\n').slice(3, 9).join('\n');
}

function trackScheduler(target: typeof globalThis, name: string, kind: LiveTimerKind, oneShot: boolean): void {
  const original = Reflect.get(target, name) as TimerFn | undefined;
  if (typeof original !== 'function') return;
  const wrapped: TimerFn = function (this: unknown, handler, ...rest) {
    if (typeof handler !== 'function') return original.call(this, handler, ...rest);
    const record: LiveTimer = { kind, createdAt: creationSite() };
    let handle: Handle;
    const callback = oneShot
      ? function (this: unknown, ...args: unknown[]) {
          live.delete(handle);
          return (handler as (...a: unknown[]) => unknown).apply(this, args);
        }
      : handler;
    handle = original.call(this, callback, ...rest);
    live.set(handle, record);
    return handle;
  };
  Reflect.set(target, name, wrapped);
}

function trackCanceller(target: typeof globalThis, name: string): void {
  const original = Reflect.get(target, name) as ClearFn | undefined;
  if (typeof original !== 'function') return;
  const wrapped: ClearFn = function (this: unknown, handle) {
    live.delete(handle);
    original.call(this, handle);
  };
  Reflect.set(target, name, wrapped);
}

/** Wrap the global timer APIs once per worker. Safe to call repeatedly. */
export function installLiveTimerTracking(target: typeof globalThis = globalThis): void {
  if (installed) return;
  installed = true;
  trackScheduler(target, 'setInterval', 'interval', false);
  trackScheduler(target, 'setTimeout', 'timeout', true);
  trackScheduler(target, 'requestAnimationFrame', 'animationFrame', true);
  trackCanceller(target, 'clearInterval');
  trackCanceller(target, 'clearTimeout');
  trackCanceller(target, 'cancelAnimationFrame');
}

/** Pending timers of the given kinds, with the stack that created each. */
export function liveTimers(kinds: readonly LiveTimerKind[] = ['interval', 'timeout', 'animationFrame']): LiveTimer[] {
  return [...live.values()].filter((timer) => kinds.includes(timer.kind));
}

function calledFromOurCode(timer: LiveTimer): boolean {
  const caller = timer.createdAt.split('\n')[0] ?? '';
  return !caller.includes('/node_modules/');
}

/**
 * Timers that may fire after the DOM environment is torn down:
 * - every live interval (an interval always fires again), and
 * - live timeouts scheduled directly by our code.
 *
 * Not counted: animation-frame callbacks (happy-dom cancels its own frame
 * queue on teardown, so they cannot fire afterwards) and timeouts scheduled
 * inside a library (e.g. TanStack Query's cache GC), which never touch
 * `window`.
 */
export function teardownHazards(): LiveTimer[] {
  return liveTimers().filter(
    (timer) => timer.kind === 'interval' || (timer.kind === 'timeout' && calledFromOurCode(timer)),
  );
}

/** Human-readable report for an assertion message. */
export function describeLiveTimers(timers: readonly LiveTimer[]): string {
  return timers.map((t, i) => `#${i + 1} ${t.kind} created at:\n${t.createdAt}`).join('\n\n');
}
