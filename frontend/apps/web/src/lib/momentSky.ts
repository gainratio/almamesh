/**
 * The sky for a Dashboard moment: the period-sky queue (periodSkyCache, via
 * createPeriodChartLoader), trimmed to the moment. Never usePredictiveStore,
 * which holds today's Life Atlas (lib/periodSky.ts header). No AI is loaded or
 * called: restrictTransitsToPeriod is a pure selector.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { devicePolicy } from '@almamesh/browser';
import type { SiderealChart } from '@almamesh/browser/types';
import { restrictTransitsToPeriod, type PeriodRange } from '@almamesh/llm';
import { safeError, type ChatThreadAsOf, type ProcessedBirthData, type TransitCtx } from '@almamesh/shared-types';
import { toTransitCtx } from '@almamesh/store';

import type { ChartEngineContextValue } from '../providers/chartEngineContext';
import { createPeriodChartLoader, type PeriodChartLoader } from './periodChart';

export type MomentSky =
  | { readonly kind: 'dashas-only' }
  | { readonly kind: 'working' }
  | { readonly kind: 'ready'; readonly transits: TransitCtx }
  | { readonly kind: 'failed' };

export interface MomentSkyInput {
  readonly asOf: ChatThreadAsOf;
  readonly chart: SiderealChart | null;
  readonly profileKey: string;
  readonly birth: ProcessedBirthData | undefined;
  readonly engine: ChartEngineContextValue | null;
  /** Test seam. Default devicePolicy().periodSkyComputeAllowed. */
  readonly skyAllowed?: boolean;
  /** Test seam. Default createPeriodChartLoader. */
  readonly loader?: PeriodChartLoader;
}

export function momentPeriod(asOf: ChatThreadAsOf): PeriodRange {
  return { start: asOf.start, end: asOf.end };
}

async function computeSky(period: PeriodRange, multiDay: boolean, load: PeriodChartLoader, signal: AbortSignal): Promise<MomentSky> {
  const sky = await load(period, { now: new Date(), signal });
  if (!sky.transit_context) return { kind: 'failed' };
  const transits = toTransitCtx(restrictTransitsToPeriod(sky.transit_context, period, multiDay).context);
  return transits ? { kind: 'ready', transits } : { kind: 'failed' };
}

export function useMomentSky(input: MomentSkyInput): { readonly sky: MomentSky; retry(): void } {
  const { chart, profileKey, birth, engine, loader } = input;
  // The sky depends only on the dates (plan ruling 6: a Day's place is a chat-tool
  // feature), so the effect keys on these primitives, not on the asOf object.
  const { start, end, granularity } = input.asOf;
  const skyAllowed = input.skyAllowed ?? devicePolicy().periodSkyComputeAllowed;
  const [sky, setSky] = useState<MomentSky>(skyAllowed ? { kind: 'working' } : { kind: 'dashas-only' });
  const [attempt, setAttempt] = useState(0);
  // Provider boot stages change during recovery. Only a different requested
  // moment/profile/chart (or unmount) makes the user's pending Retry stale.
  const request = useMemo(() => ({ start, end, granularity, chart, profileKey, birth, loader, skyAllowed }),
    [start, end, granularity, chart, profileKey, birth, loader, skyAllowed]);
  const activeRequest = useRef<typeof request | null>(null);
  const publishedEngine = useRef(engine?.engine);
  const pendingRecovery = useRef<Promise<void> | null>(null);
  useEffect(() => {
    activeRequest.current = request;
    return () => { activeRequest.current = null; };
  }, [request]);
  useEffect(() => { publishedEngine.current = engine?.engine; }, [engine?.engine]);
  useEffect(() => {
    if (!skyAllowed || !chart) { setSky({ kind: 'dashas-only' }); return undefined; }
    const controller = new AbortController();
    const load = loader ?? createPeriodChartLoader({ chart, profileKey, birth, engine });
    setSky({ kind: 'working' });
    computeSky({ start, end }, granularity !== 'day', load, controller.signal)
      .then((next) => { if (!controller.signal.aborted) setSky(next); })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        safeError('time_travel.moment_sky_failed', cause);
        setSky({ kind: 'failed' });
      });
    return () => controller.abort();
  }, [start, end, granularity, chart, profileKey, birth, engine, loader, skyAllowed, attempt]);
  const retry = useCallback(() => {
    if (!chart || !skyAllowed || pendingRecovery.current !== null) return;
    const requested = activeRequest.current;
    if (requested === null) return;
    if (!engine?.error) { setAttempt((n) => n + 1); return; }
    setSky({ kind: 'working' });
    const recovery = Promise.resolve().then(() => engine.reboot()).then((fresh) => {
      // reboot publishes the fresh engine context before resolving. The usual
      // effect owns calculation/cancellation; never resume an old moment here.
      // If the published context already changed, its effect is doing this
      // computation. Do not start a second one after that calculation settles.
      if (activeRequest.current === requested && publishedEngine.current !== fresh) setAttempt((n) => n + 1);
    }).catch(() => {
      if (activeRequest.current === requested) setSky({ kind: 'failed' });
    }).finally(() => {
      if (pendingRecovery.current === recovery) pendingRecovery.current = null;
    });
    pendingRecovery.current = recovery;
  }, [chart, skyAllowed, engine]);
  return { sky, retry };
}
