/**
 * The sky for a Dashboard moment: the period-sky queue (periodSkyCache, via
 * createPeriodChartLoader), trimmed to the moment. Never usePredictiveStore,
 * which holds today's Life Atlas (lib/periodSky.ts header). No AI is loaded or
 * called: restrictTransitsToPeriod is a pure selector.
 */
import { useCallback, useEffect, useState } from 'react';
import { devicePolicy } from '@almamesh/browser';
import type { SiderealChart } from '@almamesh/browser/types';
import { restrictTransitsToPeriod, type PeriodRange } from '@almamesh/llm';
import type { ChatThreadAsOf, ProcessedBirthData, TransitCtx } from '@almamesh/shared-types';
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
  useEffect(() => {
    if (!skyAllowed || !chart) { setSky({ kind: 'dashas-only' }); return undefined; }
    const controller = new AbortController();
    const load = loader ?? createPeriodChartLoader({ chart, profileKey, birth, engine });
    setSky({ kind: 'working' });
    computeSky({ start, end }, granularity !== 'day', load, controller.signal)
      .then((next) => { if (!controller.signal.aborted) setSky(next); })
      .catch(() => { if (!controller.signal.aborted) setSky({ kind: 'failed' }); });
    return () => controller.abort();
  }, [start, end, granularity, chart, profileKey, birth, engine, loader, skyAllowed, attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { sky, retry };
}
