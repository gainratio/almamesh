/**
 * The period loader behind `get_timing` (spec 2026-10-08, "Computing a
 * period's sky"): build the engine input for the period's first day and run it
 * through this tab's period-sky queue.
 *
 * The engine handed to the queue is the chart-engine context's `engine`: the
 * object `AlmaMeshRuntime.bootstrap()` returns, i.e. the booted worker wrapped
 * by `memoizeChartEngine` (packages/browser/src/pyodide/runtime.ts). Its memo
 * is what bounds retained period payloads to the device tier's pool.
 */
import type { SiderealChart } from '@almamesh/browser/types';
import type { AgentToolContext, PeriodRange } from '@almamesh/llm';
import type { ProcessedBirthData } from '@almamesh/shared-types';
import type { PredictiveRuntime } from '@almamesh/store';

import type { ChartEngineContextValue } from '../providers/chartEngineContext';
import { buildEnsurePredictiveInput } from './predictive';
import { periodReferenceInstant, periodSkyCache, type PeriodSkyCache } from './periodSky';
import { PeriodSkyUnavailableError } from './timingTool';

export interface PeriodChartLoaderInput {
  /** The natal chart the period's sky is merged onto. */
  readonly chart: SiderealChart;
  readonly profileKey: string;
  readonly birth: ProcessedBirthData | undefined;
  readonly engine: ChartEngineContextValue | null;
  /** Test seam; defaults to this tab's shared queue. */
  readonly cache?: PeriodSkyCache;
}

export type PeriodChartLoader = (period: PeriodRange, context: AgentToolContext) => Promise<SiderealChart>;

/**
 * The one engine wait every chat engine load goes through: start the boot if
 * it has not started, then use the ready engine or await the in-flight boot.
 */
export async function readyEngine(engine: ChartEngineContextValue | null): Promise<PredictiveRuntime> {
  if (!engine) throw new PeriodSkyUnavailableError('engine_unavailable');
  engine.startBootstrap();
  return engine.engine ?? (await engine.whenReady());
}

export function createPeriodChartLoader(input: PeriodChartLoaderInput): PeriodChartLoader {
  return async (period, context) => {
    const predictiveInput = buildEnsurePredictiveInput(
      input.profileKey,
      input.birth,
      periodReferenceInstant(period.start),
    );
    if (!predictiveInput) throw new PeriodSkyUnavailableError('incomplete_birth_data');
    const runtime = await readyEngine(input.engine);
    const contexts = await (input.cache ?? periodSkyCache()).load(predictiveInput, runtime, context.signal);
    return { ...input.chart, ...contexts };
  };
}

/** The birth's local calendar day, for refusing earlier periods. Never sent to the model. */
export function birthDayOf(birth: ProcessedBirthData | undefined): string | undefined {
  const stamp = birth?.birth_datetime_local || birth?.birth_datetime_utc;
  return stamp && /^\d{4}-\d{2}-\d{2}/.test(stamp) ? stamp.slice(0, 10) : undefined;
}
