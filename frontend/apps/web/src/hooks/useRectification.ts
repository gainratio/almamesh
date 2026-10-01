/**
 * useRectification — orchestration hook for the event-based birth-time
 * rectification wizard.
 *
 * Responsibilities:
 *  - Builds a `RectificationInput` from the profile's stored chart + structured
 *    life events (DST-aware UTC offset via dayjs; always pins `referenceDate`).
 *  - Calls `useRectificationStore.run(engine, input)` and exposes the store's
 *    `{ status, result, error }` through `state`.
 *  - Predictive gating: sets `useRectificationGate.active = true` while mounted
 *    so `usePredictiveLayer({ auto: true })` does not race the single serial
 *    Pyodide worker with a ~30s predictive job.
 *  - Cancel-on-unmount: if the component unmounts mid-run, the result is NOT
 *    left in the store — `reset()` is called immediately after the store's run
 *    completes.
 *  - Retry: calls `engineCtx.reboot()` (engine recovery) then re-runs with the
 *    same mode using the fresh engine — never a dead end.
 *
 * Guards surfaced to the wizard:
 *  - `engineReady`: false → show "engine warming" state, disable Run button.
 *  - `hasEnoughEvents`: false → prompt user to add a structured life event.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import {
  useChartLibraryStore,
  useLifeEventsStore,
  useRectificationStore,
  isStructuredLifeEvent,
  type LifeEvent,
  type RectificationRuntime,
  type StoredChart,
} from '@almamesh/store';
import { safeWarn } from '@almamesh/shared-types';
import type {
  ProcessedBirthData,
  RectificationEventInput,
  RectificationMode,
  RectificationResult,
} from '@almamesh/shared-types';
import type { TimeConfidence } from '@almamesh/constants';
import type { RectificationInput } from '@almamesh/browser/types';
import { engineErrorCode as engineErrorCodeOf } from '../lib/engineLifecycle';
import { useOptionalChartEngine } from '../providers/chartEngineContext';
import { predictiveReferenceInstant } from '../lib/predictive';
import { useRectificationGate } from '../lib/rectificationGate';

// Extend dayjs once; idempotent if another module already extended it.
dayjs.extend(utc);
dayjs.extend(timezone);

// ---------------------------------------------------------------------------
// Pure helpers (module-level for testability)
// ---------------------------------------------------------------------------

/**
 * Find the primary stored chart for `profileId` and reconstruct a minimal
 * birth description the hook needs to build the wire input.
 */
function birthDescForProfile(
  charts: Readonly<Record<string, StoredChart>>,
  profileId: string,
): {
  date: string;
  effectiveTime: string;
  latitude: number;
  longitude: number;
  tz: string;
} | null {
  const candidates = Object.values(charts).filter((c) => c.profile_id === profileId);
  const primary = candidates.find((c) => c.is_primary) ?? candidates[0];
  const birth = primary?.birth_data as ProcessedBirthData | undefined;
  const loc = birth?.birth_location_details;
  if (!birth || !loc) return null;

  const localDt = birth.birth_datetime_local ?? '';
  // Use the rectified time if present (birth_time_original = entered; effective is in localDt)
  const effectiveTime = localDt.split('T')[1]?.slice(0, 5) ?? '';
  if (!effectiveTime || !localDt.split('T')[0]) return null;

  return {
    date: localDt.split('T')[0] ?? '',
    effectiveTime,
    latitude: loc.latitude,
    longitude: loc.longitude,
    tz: loc.timezone ?? 'UTC',
  };
}

/**
 * Map store life events to the engine's wire format.
 *
 * Exported as a pure function so it can be unit-tested independently of the
 * hook.  Unstructured events (missing `date` or `category`) are filtered out;
 * events without an explicit `precision` default to `'exact'`.
 */
export function toWireEvents(events: readonly LifeEvent[]): RectificationEventInput[] {
  return events
    .filter(isStructuredLifeEvent)
    .map((e): RectificationEventInput => ({
      date: e.date,
      category: e.category!,
      precision: e.precision ?? 'exact',
    }));
}

/**
 * Build the camelCase wire payload from the birth description + events.
 *
 * Exported as a pure function so it can be unit-tested independently of the
 * hook. Spec 062: `anchorConfidence` is sent explicitly but ALWAYS matches the
 * engine's per-mode default ('about' for cusp — a recorded time exists;
 * 'unknown' for window), so explicit and absent are byte-identical.
 * `spanMinutes` (the honest "somewhere between HH:MM and HH:MM" window bound)
 * is threaded only when the caller supplies it — absent keeps the current
 * full-day behavior.
 */
export function buildWireInput(
  birth: NonNullable<ReturnType<typeof birthDescForProfile>>,
  events: readonly RectificationEventInput[],
  mode: RectificationMode,
  spanMinutes?: number,
): RectificationInput {
  const tzd = dayjs.tz(`${birth.date}T${birth.effectiveTime}`, birth.tz);
  return {
    datetimeUtc: tzd.utc().toISOString(),
    latitude: birth.latitude,
    longitude: birth.longitude,
    utcOffsetMinutes: tzd.utcOffset(),
    events,
    mode,
    anchorConfidence: mode === 'window' ? 'unknown' : 'about',
    ...(spanMinutes !== undefined ? { spanMinutes } : {}),
    // Always pin referenceDate — omitting it makes the engine use wall clock
    // (non-deterministic, breaks reproducibility across re-runs).
    referenceDate: predictiveReferenceInstant(),
  };
}

/**
 * Pick the rectification mode that best matches what the engine can do for
 * this profile's birth time:
 *
 *  - `'window'`  when time is unknown or a rough estimate — the engine ranks
 *                all 12 rising signs across the whole day (no sub-minute claim).
 *  - `'cusp'`    when time is reasonably known (exact / approximate), including
 *                the near-cusp case where comparing the two adjacent candidates
 *                is still meaningful.
 *
 * Falls back to `'cusp'` when confidence is absent (no stored chart, older
 * bundle without the field, etc.) — cusp mode is the safer default because it
 * makes no day-span assumption.
 */
function detectRectificationMode(
  charts: Readonly<Record<string, StoredChart>>,
  profileId: string,
): RectificationMode {
  const candidates = Object.values(charts).filter((c) => c.profile_id === profileId);
  const primary = candidates.find((c) => c.is_primary) ?? candidates[0];
  if (primary == null) return 'cusp';

  const birth = primary.birth_data as ProcessedBirthData | undefined;
  const timeConf = birth?.birth_time_confidence as TimeConfidence | undefined;

  if (timeConf === 'unknown' || timeConf === 'rough') return 'window';
  return 'cusp';
}

/**
 * How long to wait (ms) for a cold engine boot before we stop saying "warming
 * up" and offer an explicit reset-and-reload. A first-time cold boot (sync the
 * ~38 MB bundle + boot Pyodide + heavy compute) can legitimately take a minute
 * or two, so this is intentionally generous — past it, something is likely
 * wrong and the user should be given a recovery action rather than an endless
 * spinner.
 */
const ENGINE_WARM_TIMEOUT_MS = 75_000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface UseRectificationState {
  readonly status: 'idle' | 'loading' | 'ready' | 'error';
  readonly result: RectificationResult | null;
  readonly error: string | null;
}

export interface UseRectificationResult {
  readonly state: UseRectificationState;
  /** True when the Pyodide engine is booted and ready. */
  readonly engineReady: boolean;
  /**
   * The engine bootstrap failure message, if the engine failed to boot (from
   * the runtime provider's `error`). Distinct from `state.error`, which is a
   * rectification COMPUTE failure. Non-null here means the warming surface must
   * offer a reset-and-reload, never a silent permanent spinner.
   */
  readonly engineError: string | null;
  /** The engine failure's stable `EngineOperationError.code` (e.g. 'rollback'). */
  readonly engineErrorCode: string | null;
  /**
   * The current bootstrap stage (`'syncing' | 'reassembling' | 'booting-engine'
   * | …`) for an honest "what's happening" sub-label while warming, or null.
   */
  readonly engineStage: string | null;
  /**
   * True when no stored chart with birth-location details could be found for
   * this profile (e.g. a legacy chart missing `profile_id`). The wizard must
   * show an explicit "we couldn't find your birth details" message instead of
   * spinning forever.
   */
  readonly missingBirth: boolean;
  /**
   * True once the engine has been warming for longer than is reasonable
   * (`ENGINE_WARM_TIMEOUT_MS`) without becoming ready — the cue to surface a
   * reset-and-reload recovery action. Resets to false the moment the engine
   * becomes ready.
   */
  readonly warmingTimedOut: boolean;
  /** True when the profile has ≥ 1 life event with both a date and a category. */
  readonly hasEnoughEvents: boolean;
  /**
   * The mode the wizard should use for this profile, derived from
   * `birth_time_confidence`:
   *  - `'window'` for unknown / rough birth times (whole-day sign ranking)
   *  - `'cusp'`   for exact / approximate times (two-candidate comparison)
   */
  readonly detectedMode: RectificationMode;
  /**
   * Kick off a rectification run with the given mode. No-op if not ready.
   * `spanMinutes` (optional, Spec 062) bounds the WINDOW-mode search to an
   * honest user-stated window around the recorded time; omit for the current
   * full-day behavior.
   */
  readonly run: (mode: RectificationMode, spanMinutes?: number) => Promise<void>;
  /** Reset the store to idle (clears any previous result or error). */
  readonly reset: () => void;
  /**
   * Reboot the engine (recovery path for a failed bootstrap) then re-run
   * with the same mode. Ensures there is never a permanent dead-end after
   * an engine failure — the engine-recovery invariant.
   */
  readonly retry: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useRectification(profileId: string): UseRectificationResult {
  const engineCtx = useOptionalChartEngine();
  const engine = engineCtx?.engine ?? null;
  const engineError = engineCtx?.error?.message ?? null;
  const engineErrorCode = engineErrorCodeOf(engineCtx?.error ?? null);
  const engineStage = engineCtx?.stage?.kind ?? null;

  // Latest engine context, mirrored into a ref so the one-shot mount effect
  // (eager warm / recover) can read it without re-subscribing.
  const engineCtxRef = useRef(engineCtx);
  engineCtxRef.current = engineCtx;

  // Birth description from the chart library (reactive: re-derives if charts update).
  const charts = useChartLibraryStore((s) => s.charts);
  const birth = useMemo(() => birthDescForProfile(charts, profileId), [charts, profileId]);
  const missingBirth = birth === null;

  // Mode auto-detection: derived from birth_time_confidence in the stored chart.
  const detectedMode = useMemo(
    () => detectRectificationMode(charts, profileId),
    [charts, profileId],
  );

  // Rectification store state (reactive selectors).
  const status = useRectificationStore((s) => s.status);
  const result = useRectificationStore((s) => s.result);
  const storeError = useRectificationStore((s) => s.error);

  // Reactive guard: re-evaluates when the profile's events change.
  const hasEnoughEvents = useLifeEventsStore(
    (s) => (s.eventsByProfile[profileId] ?? []).filter(isStructuredLifeEvent).length >= 1,
  );

  // cancelledRef: set to true on unmount so a mid-flight run's completion
  // triggers an immediate reset() rather than leaving stale results in the store.
  const cancelledRef = useRef(false);
  // Track the last mode + span so retry() can re-run with the same arguments.
  const lastModeRef = useRef<RectificationMode | null>(null);
  const lastSpanMinutesRef = useRef<number | undefined>(undefined);

  // warmingTimedOut: true once the engine has been warming past the generous
  // timeout without booting — the cue to offer reset-and-reload. The single
  // serial Pyodide worker can take a minute or two on a cold first boot, so the
  // wait is honest until this flips.
  // The budget is an IDLE budget: every bootstrap report arrives as a new
  // `stage` object (bundle bytes, a verified file, Pyodide bytes), and each one
  // restarts the timer. A slow link that keeps moving never reads as stuck.
  const [warmingTimedOut, setWarmingTimedOut] = useState(false);
  const latestStage = engineCtx?.stage ?? null;
  useEffect(() => {
    if (engine !== null) {
      setWarmingTimedOut(false);
      return;
    }
    const id = setTimeout(() => setWarmingTimedOut(true), ENGINE_WARM_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [engine, latestStage]);

  // Gate + cancel-on-unmount lifecycle + fresh-visit hygiene + eager warm.
  useEffect(() => {
    cancelledRef.current = false;
    useRectificationGate.getState().setActive(true);

    // Fresh wizard ⇒ fresh computation. The rectification store is a global,
    // transient singleton: a previous completed run leaves it `ready` with that
    // run's result. Clear it on mount so a later visit (new profile / new
    // events) recomputes instead of flashing the previous result.
    useRectificationStore.getState().reset();

    // Eagerly warm the engine the moment the wizard opens, so it is likely
    // ready by the time the user finishes entering events — never wait for the
    // Run click. A pre-existing failed boot is recovered in-app via reboot().
    const ctx = engineCtxRef.current;
    if (ctx !== null && ctx.engine === null) {
      if (ctx.error !== null) {
        // Best-effort: the Run click has its own recovery path, but never
        // swallow the failure silently — leave a trace for diagnosis.
        void ctx.reboot().catch((error: unknown) => {
          safeWarn('engine.prewarm_failed', error);
        });
      } else {
        ctx.startBootstrap();
      }
    }

    return () => {
      cancelledRef.current = true;
      useRectificationGate.getState().setActive(false);
    };
    // One-shot on mount: deps intentionally empty; engine context is read via a
    // ref so this never re-subscribes.
  }, []);

  /**
   * Shared run logic — takes the engine explicitly so retry() can inject a
   * fresh engine from reboot() without relying on the stale closure value.
   */
  const executeRun = useCallback(
    async (
      runtimeEngine: RectificationRuntime,
      mode: RectificationMode,
      spanMinutes?: number,
    ): Promise<void> => {
      if (birth === null) return;

      const wireEvents = toWireEvents(useLifeEventsStore.getState().getEvents(profileId));

      if (wireEvents.length < 1) return;

      const wireInput = buildWireInput(birth, wireEvents, mode, spanMinutes);

      // Reset the cancelled flag at the start of every run (important for
      // remounted wizards and for the retry path after a previous cancellation).
      cancelledRef.current = false;
      await useRectificationStore.getState().run(runtimeEngine, wireInput);

      // If the component unmounted while the engine was running, the store was
      // already written (status: 'ready'/'error') — undo that write so the
      // persisted chart is never touched and the store is left clean.
      if (cancelledRef.current) {
        useRectificationStore.getState().reset();
      }
    },
    [birth, profileId],
  );

  const run = useCallback(
    async (mode: RectificationMode, spanMinutes?: number): Promise<void> => {
      // Record the requested mode + span FIRST — even if the engine is still
      // warming — so a later retry() (after the engine recovers) re-runs with
      // these arguments rather than no-opping because they were never captured.
      lastModeRef.current = mode;
      lastSpanMinutesRef.current = spanMinutes;
      if (engine === null) return; // guard: engine not ready
      await executeRun(engine, mode, spanMinutes);
    },
    [engine, executeRun],
  );

  const reset = useCallback(() => {
    useRectificationStore.getState().reset();
  }, []);

  const retry = useCallback(async (): Promise<void> => {
    if (engineCtx === null) return;
    // Fall back to the detected mode when the user never managed to trigger a
    // run (engine errored before the Run button became live) — there is always
    // a mode to recompute with, so recovery is never a dead-end.
    const mode = lastModeRef.current ?? detectedMode;
    let freshEngine: RectificationRuntime;
    try {
      // reboot() resets the provider state to { engine: null, error: null }
      // and runs a fresh bootstrap; resolves with the new ready engine.
      freshEngine = await engineCtx.reboot();
    } catch {
      // Reboot itself failed — stay in error state; the user can try again.
      return;
    }
    if (cancelledRef.current) return;
    await executeRun(freshEngine, mode, lastSpanMinutesRef.current);
  }, [engineCtx, executeRun, detectedMode]);

  return {
    state: { status, result, error: storeError },
    engineReady: engine !== null,
    engineError,
    engineErrorCode,
    engineStage,
    missingBirth,
    warmingTimedOut,
    hasEnoughEvents,
    detectedMode,
    run,
    reset,
    retry,
  };
}
