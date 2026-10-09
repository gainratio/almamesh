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
import { periodWindowMonths, type AgentToolContext, type PeriodRange } from '@almamesh/llm';
import type { ProcessedBirthData } from '@almamesh/shared-types';
import type { PredictiveRuntime } from '@almamesh/store';

import type { ChartEngineContextValue } from '../providers/chartEngineContext';
import { buildEnsurePredictiveInput } from './predictive';
import { withDeadline } from './deadline';
import { periodReferenceInstant, periodSkyCache, periodSkyDeadline, type PeriodSkyCache } from './periodSky';
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
      periodWindowMonths(period),
    );
    if (!predictiveInput) throw new PeriodSkyUnavailableError('incomplete_birth_data');
    // The deadline starts here, at tool entry, so a cold engine boot counts
    // against it too: the model gets `timeout`, never the agent's opaque cap.
    const work = readyEngine(input.engine).then((runtime) =>
      (input.cache ?? periodSkyCache()).load(predictiveInput, runtime, context.signal),
    );
    const contexts = await withDeadline(work, context.signal, periodSkyDeadline());
    return { ...input.chart, ...contexts };
  };
}

/**
 * The birth's local calendar year, for refusing periods before it. Never sent to
 * the model, and never the day: a day-precision refusal is a birth-date oracle.
 */
/** The birth instant's UTC year, for the birth-year sky gate (the engine computes in UTC). Never sent. */
export function birthUtcYearOf(birth: ProcessedBirthData | undefined): number | undefined {
  const stamp = birth?.birth_datetime_utc;
  return stamp && /^\d{4}-/.test(stamp) ? Number(stamp.slice(0, 4)) : undefined;
}

export function birthYearOf(birth: ProcessedBirthData | undefined): number | undefined {
  const stamp = birth?.birth_datetime_local || birth?.birth_datetime_utc;
  return stamp && /^\d{4}-\d{2}-\d{2}/.test(stamp) ? Number(stamp.slice(0, 4)) : undefined;
}
