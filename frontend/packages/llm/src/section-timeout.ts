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

/** No-progress cap for one report section: no token for this long. */
export const REPORT_SECTION_IDLE_TIMEOUT_MS = 120_000;

/**
 * Local endpoints only: the cap on waiting for a section's FIRST token. A
 * single-slot local server may queue the section, load the model cold, or
 * prefill a long prompt slowly; none of that is a stall. The idle cap starts
 * only after the first token, and this generous cap still bounds a true hang.
 */
export const REPORT_LOCAL_FIRST_TOKEN_TIMEOUT_MS = 900_000;

export type SectionTimeoutKind = "total" | "idle" | "first_token";

const TIMEOUT_MESSAGES: Readonly<Record<SectionTimeoutKind, string>> = {
  total: "no result within",
  idle: "no progress for",
  first_token: "no first token within",
};

/** A report section ran past its cap. The message never carries prompt text. */
export class SectionTimeoutError extends Error {
  public readonly kind: SectionTimeoutKind;
  public readonly limitMs: number;

  constructor(kind: SectionTimeoutKind, limitMs: number) {
    super(`Section timed out: ${TIMEOUT_MESSAGES[kind]} ${limitMs} ms`);
    this.name = "SectionTimeoutError";
    this.kind = kind;
    this.limitMs = limitMs;
  }
}

/**
 * The caps for one section; an absent cap is off. With `firstTokenMs` set, the
 * idle cap starts at the first sign of life (the first `touch`) and the
 * first-token cap covers the wait before it. Without it, idle runs from launch.
 */
export interface SectionTimeLimits {
  readonly totalMs?: number;
  readonly idleMs?: number;
  readonly firstTokenMs?: number;
}

/** What the guarded work gets: the signal to send, and a call per sign of life. */
export interface SectionDeadlineContext {
  readonly signal: AbortSignal;
  readonly touch: () => void;
}

type Timer = ReturnType<typeof setTimeout> | undefined;

/**
 * Run `work` under the caps. On a hit, `work`'s request is aborted and the
 * result rejects with a SectionTimeoutError at once, even if the request
 * ignores its signal. A caller abort aborts the request and rejects at once
 * with the caller's reason. Every timer is cleared when the call settles.
 */
export function withSectionDeadline<T>(
  limits: SectionTimeLimits,
  callerSignal: AbortSignal | undefined,
  work: (context: SectionDeadlineContext) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let fail: (reason: unknown) => void = () => undefined;
  const expired = new Promise<never>((_, reject) => {
    fail = reject;
  });
  let total: Timer;
  let idle: Timer;
  let firstToken: Timer;
  const clearAll = (): void => {
    clearTimeout(total);
    clearTimeout(idle);
    clearTimeout(firstToken);
  };
  const stop = (reason: unknown): void => {
    clearAll();
    fail(reason);
    controller.abort(reason);
  };
  const trip = (kind: SectionTimeoutKind, ms: number): void => stop(new SectionTimeoutError(kind, ms));
  const arm = (kind: SectionTimeoutKind, ms: number | undefined): Timer =>
    ms === undefined ? undefined : setTimeout(() => trip(kind, ms), ms);
  const onCallerAbort = (): void => stop(callerSignal?.reason);

  let started = limits.firstTokenMs === undefined;
  const touch = (): void => {
    if (controller.signal.aborted) return;
    clearTimeout(firstToken);
    started = true;
    clearTimeout(idle);
    idle = arm("idle", limits.idleMs);
  };
  total = arm("total", limits.totalMs);
  if (started) idle = arm("idle", limits.idleMs);
  else firstToken = arm("first_token", limits.firstTokenMs);
  if (callerSignal?.aborted) onCallerAbort();
  else callerSignal?.addEventListener("abort", onCallerAbort, { once: true });

  const running = work({ signal: controller.signal, touch });
  // After a cap or abort settles the call, the request may still reject; nobody awaits it.
  running.catch(() => undefined);
  return Promise.race([running, expired]).finally(() => {
    clearAll();
    callerSignal?.removeEventListener("abort", onCallerAbort);
  });
}
