// Per-section time caps for report sections.
//
// A live run (2026-10-10) hung for 40 minutes on a stalled provider: the
// reading never finished and never failed. Each report section now runs under
// a deadline. A remote endpoint gets a total wall-clock cap; a streamed section
// also gets an idle cap (no tokens for that long). A local endpoint gets the
// idle cap only, so a weak device that is still writing is never cut off.
// A hit aborts that section's request and fails only that section.

/** Total wall-clock cap for one remote report section. */
export const REPORT_SECTION_TIMEOUT_MS = 300_000;

/** No-progress cap for one streamed report section: no token for this long. */
export const REPORT_SECTION_IDLE_TIMEOUT_MS = 120_000;

export type SectionTimeoutKind = "total" | "idle";

/** A report section ran past its cap. The message never carries prompt text. */
export class SectionTimeoutError extends Error {
  public readonly kind: SectionTimeoutKind;
  public readonly limitMs: number;

  constructor(kind: SectionTimeoutKind, limitMs: number) {
    super(
      kind === "total"
        ? `Section timed out: no result within ${limitMs} ms`
        : `Section timed out: no progress for ${limitMs} ms`,
    );
    this.name = "SectionTimeoutError";
    this.kind = kind;
    this.limitMs = limitMs;
  }
}

/** The caps for one section; an absent cap is off. */
export interface SectionTimeLimits {
  readonly totalMs?: number;
  readonly idleMs?: number;
}

/** What the guarded work gets: the signal to send, and a call per sign of life. */
export interface SectionDeadlineContext {
  readonly signal: AbortSignal;
  readonly touch: () => void;
}

/** A signal that aborts when the caller's does, or when this section's cap fires. */
function chainedController(callerSignal: AbortSignal | undefined): { controller: AbortController; release: () => void } {
  const controller = new AbortController();
  if (!callerSignal) return { controller, release: () => undefined };
  const forward = (): void => controller.abort(callerSignal.reason);
  if (callerSignal.aborted) forward();
  else callerSignal.addEventListener("abort", forward, { once: true });
  return { controller, release: () => callerSignal.removeEventListener("abort", forward) };
}

/**
 * Run `work` under the caps. On a hit, `work`'s request is aborted and the
 * result rejects with a SectionTimeoutError at once, even if the request
 * ignores its signal. A caller abort passes through unchanged.
 */
export function withSectionDeadline<T>(
  limits: SectionTimeLimits,
  callerSignal: AbortSignal | undefined,
  work: (context: SectionDeadlineContext) => Promise<T>,
): Promise<T> {
  const { controller, release } = chainedController(callerSignal);
  let fail: (error: SectionTimeoutError) => void = () => undefined;
  const expired = new Promise<never>((_, reject) => {
    fail = reject;
  });
  const trip = (kind: SectionTimeoutKind, ms: number): void => {
    const error = new SectionTimeoutError(kind, ms);
    fail(error);
    controller.abort(error);
  };
  const total = limits.totalMs === undefined ? undefined : setTimeout(() => trip("total", limits.totalMs ?? 0), limits.totalMs);
  let idle: ReturnType<typeof setTimeout> | undefined;
  const touch = (): void => {
    if (limits.idleMs === undefined) return;
    clearTimeout(idle);
    idle = setTimeout(() => trip("idle", limits.idleMs ?? 0), limits.idleMs);
  };
  touch();
  const running = work({ signal: controller.signal, touch });
  // After a cap fires the aborted request may still reject; nobody awaits it.
  running.catch(() => undefined);
  return Promise.race([running, expired]).finally(() => {
    clearTimeout(total);
    clearTimeout(idle);
    release();
  });
}
