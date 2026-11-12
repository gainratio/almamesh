/**
 * The period loader behind `read_period` (spec 2026-10-08, "Computing a
 * period's sky"): build the engine input for the period's first day and run it
 * through this tab's period-sky queue. The reading is bounded to the period's
 * last day, so its themes and segments are the period's own.
 *
 * The engine handed to the queue is the chart-engine context's `engine`: the
 * object `AlmaMeshRuntime.bootstrap()` returns, i.e. the booted worker wrapped
 * by `memoizeChartEngine` (packages/browser/src/pyodide/runtime.ts). Its memo
 * is what bounds retained period payloads to the device tier's pool.
 */
import type { ChartEngine } from '@almamesh/browser';
import type { SiderealChart } from '@almamesh/browser/types';
import { periodWindowMonths, type PeriodRange } from '@almamesh/llm';
import type { ToolContext } from '@almamesh/llm/toolLoop';
import type { ProcessedBirthData } from '@almamesh/shared-types';

import type { ChartEngineContextValue } from '../providers/chartEngineContext';
import { withDeadline } from './deadline';
import { periodReferenceInstant, periodSkyCache, periodSkyDeadline, type PeriodSkyCache } from './periodSky';
import { buildEnsurePredictiveInput } from './predictive';
import { followTransientRetries } from './resolveReadyEngine';
import { isRecoverableWorkerFailure } from './transientBootFailure';

export type PeriodSkyFailure = 'engine_unavailable' | 'timeout' | 'incomplete_birth_data';

export class PeriodSkyUnavailableError extends Error {
  constructor(readonly reason: PeriodSkyFailure) {
    super(`The period sky is unavailable: ${reason}`);
    this.name = 'PeriodSkyUnavailableError';
  }
}

export interface PeriodChartLoaderInput {
  /** The natal chart the period's sky is merged onto. */
  readonly chart: SiderealChart;
  readonly profileKey: string;
  readonly birth: ProcessedBirthData | undefined;
  readonly engine: ChartEngineContextValue | null;
  /** Test seam; defaults to this tab's shared queue. */
  readonly cache?: PeriodSkyCache;
}

export type PeriodChartLoader = (period: PeriodRange, context: ToolContext) => Promise<SiderealChart>;

const TURN_ENGINES = new WeakMap<ChartEngineContextValue, Promise<ChartEngine> | null>();
const REBOOTABLE_ENGINES = new WeakSet<ChartEngineContextValue>();

function canReboot(ctx: ChartEngineContextValue): boolean {
  return REBOOTABLE_ENGINES.has(ctx) || (!TURN_ENGINES.has(ctx) && typeof (ctx as Partial<ChartEngineContextValue>).reboot === 'function');
}

async function resolveBootedEngine(context: ChartEngineContextValue): Promise<ChartEngine> {
  if (context.engine) return context.engine;
  if (context.error && canReboot(context)) return context.reboot();
  context.startBootstrap();
  try {
    return await followTransientRetries(context.whenReady);
  } catch (error) {
    if (canReboot(context) && (context.error || isRecoverableWorkerFailure(error))) {
      return context.reboot();
    }
    throw error;
  }
}

function createRebootRunner(initial: ChartEngine, context: ChartEngineContextValue) {
  let current = initial;
  let recovery: Promise<ChartEngine> | null = null;
  const run = async <T>(op: (eng: ChartEngine) => Promise<T>): Promise<T> => {
    const used = current;
    try {
      return await op(used);
    } catch (error) {
      if (used !== initial || (!context.error && !isRecoverableWorkerFailure(error))) throw error;
      recovery ??= context.reboot().then((fresh) => { current = fresh; return fresh; });
      return op(await recovery);
    }
  };
  return { getCurrent: () => current, run };
}

function withOneWorkerReboot(initial: ChartEngine, context: ChartEngineContextValue): ChartEngine {
  if (!canReboot(context)) return initial;
  const { getCurrent, run } = createRebootRunner(initial, context);
  return {
    ...(initial.identity ? { identity: () => getCurrent().identity?.() ?? initial.identity!() } : {}),
    meta: () => getCurrent().meta(),
    generateChart: (input) => run((eng) => eng.generateChart(input)),
    computePredictive: (input, options) => run((eng) => eng.computePredictive(input, options)),
    computeMoonWindow: (input) => run((eng) => eng.computeMoonWindow(input)),
    computeMeshEdge: (input) => run((eng) => eng.computeMeshEdge(input)),
    computeRectification: (input) => run((eng) => eng.computeRectification(input)),
    computeVargaDetail: (input) => run((eng) => eng.computeVargaDetail(input)),
  };
}

/** Live getter proxy over a ref-held `ChartEngineContextValue` so multi-second chat turns see mid-turn crashes/reboots. */
export function liveChartEngine(read: () => ChartEngineContextValue | null): ChartEngineContextValue | null {
  const initial = read();
  if (!initial) return null;
  const proxy: ChartEngineContextValue = {
    get engine() { return read()?.engine ?? null; },
    get stage() { return read()?.stage ?? null; },
    get error() { return read()?.error ?? null; },
    get meta() { return read()?.meta ?? null; },
    lastProgressAt: () => read()?.lastProgressAt?.() ?? 0,
    startBootstrap: () => read()?.startBootstrap(),
    whenReady: () => (read() ?? initial).whenReady(),
    reboot: () => (read() ?? initial).reboot(),
  };
  if (canReboot(initial)) REBOOTABLE_ENGINES.add(proxy);
  return proxy;
}

/** Scope one shared, crash-resilient `readyEngine` across all tools within a single chat turn. */
export function scopeTurnEngine(context: ChartEngineContextValue | null): ChartEngineContextValue | null {
  if (!context) return null;
  const scoped: ChartEngineContextValue = {
    get engine() { return context.engine; },
    get stage() { return context.stage; },
    get error() { return context.error; },
    get meta() { return context.meta; },
    ...(context.lastProgressAt ? { lastProgressAt: context.lastProgressAt } : {}),
    startBootstrap: () => context.startBootstrap(),
    whenReady: () => context.whenReady(),
    reboot: () => context.reboot(),
  };
  TURN_ENGINES.set(scoped, null);
  if (canReboot(context)) REBOOTABLE_ENGINES.add(scoped);
  return scoped;
}

/**
 * The one engine wait every chat/period engine load goes through: background
 * moment effects (`!TURN_ENGINES.has(engine)`) await `whenReady` without auto-rebooting;
 * explicit user chat turns (`scopeTurnEngine`) follow transient boots and reboot once on crash.
 */
export async function readyEngine(engine: ChartEngineContextValue | null): Promise<ChartEngine> {
  if (!engine) throw new PeriodSkyUnavailableError('engine_unavailable');
  if (!TURN_ENGINES.has(engine)) {
    engine.startBootstrap();
    return engine.engine ?? (await engine.whenReady());
  }
  let pending = TURN_ENGINES.get(engine) ?? null;
  if (!pending) {
    pending = resolveBootedEngine(engine).then(
      (raw) => withOneWorkerReboot(raw, engine),
      (err) => { TURN_ENGINES.set(engine, null); throw err; },
    );
    TURN_ENGINES.set(engine, pending);
  }
  return pending;
}

export function createPeriodChartLoader(input: PeriodChartLoaderInput): PeriodChartLoader {
  return async (period, context) => {
    const predictiveInput = buildEnsurePredictiveInput(
      input.profileKey,
      input.birth,
      periodReferenceInstant(period.start),
      { windowMonths: periodWindowMonths(period), readingEnd: period.end },
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
