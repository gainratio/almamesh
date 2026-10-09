/**
 * The ONE chat tool builder for Dashboard and MeshEdge (spec 2026-10-08,
 * "One tool builder"). It owns today's engine load, the period-sky load, the
 * router, and the one "today": the viewer's (device) zone for every page
 * (open question 1, decided 2026-10-08). Pages pass no zone.
 */
import type { SiderealChart } from '@almamesh/browser/types';
import {
  todayAnalysisInstant,
  type AgentTool,
  type AgentToolContext,
  type AnalysisInstant,
} from '@almamesh/llm';
import type { ProcessedBirthData } from '@almamesh/shared-types';

import type { ChartEngineContextValue } from '../providers/chartEngineContext';
import { viewerTimeZone } from './analysisInstant';
import { createChatAgentTools, shouldPreRunToday, viewerTodayDay } from './chatAgentTools';
import { ensureCurrentPlanetaryContext } from './currentPlanetaryContext';
import { birthDayOf, createPeriodChartLoader, readyEngine } from './periodChart';
import { TIMING_TOOL_NAME } from './timingTool';

export interface BuildChatToolsetInput {
  /** The natal chart engine loads (today, a period) merge their sky onto. */
  readonly chart: SiderealChart;
  /** The chart the prompt and `get_chart_facts` read; defaults to `chart`. */
  readonly promptChart?: SiderealChart;
  readonly chartAsOf: AnalysisInstant;
  /** The birth zone. Only `get_current_datetime`'s "chart" scope reads it. */
  readonly chartTimeZone: string;
  readonly profileKey: string;
  readonly birth: ProcessedBirthData | undefined;
  readonly engine: ChartEngineContextValue | null;
  /** Test seam only. Pages never pass it (pinned by chatToolsetWiring.test.ts). */
  readonly viewerZone?: () => string;
}

export interface PrepareOptions {
  readonly now: Date;
  readonly signal: AbortSignal;
  readonly onStatus?: (label: string) => void;
}

export interface PreparedChatContext {
  /** The chart to sanitize into the prompt. */
  readonly chart: SiderealChart;
  readonly asOf: AnalysisInstant;
  /** A today question whose engine facts could not be computed. */
  readonly currentContextUnavailable: boolean;
}

export interface ChatToolset {
  readonly tools: readonly AgentTool[];
  prepare(question: string, options: PrepareOptions): Promise<PreparedChatContext>;
}

/** Shown while today's facts compute, if the timing tool carries no label of its own. */
const TODAY_STATUS_FALLBACK = "Working out today's sky";

/** Run today's timing once, locally, so a today-question is grounded before the model answers. */
async function preRunToday(tools: readonly AgentTool[], options: PrepareOptions): Promise<boolean> {
  const timing = tools.find((tool) => tool.name === TIMING_TOOL_NAME);
  if (!timing) throw new Error('The timing tool is unavailable.');
  options.onStatus?.(timing.statusLabel ?? TODAY_STATUS_FALLBACK);
  try {
    await timing.execute({ section: 'transits' }, { now: new Date(options.now.getTime()), signal: options.signal });
    return true;
  } catch (error) {
    if (options.signal.aborted) throw error;
    return false;
  }
}

export function buildChatToolset(input: BuildChatToolsetInput): ChatToolset {
  const zone = input.viewerZone ?? viewerTimeZone;
  const natalPrompt = input.promptChart ?? input.chart;
  let todayChart: SiderealChart | undefined;

  const loadCurrentChart = async (context: AgentToolContext): Promise<SiderealChart> => {
    const runtime = await readyEngine(input.engine);
    todayChart = await ensureCurrentPlanetaryContext({
      chart: input.chart,
      profileKey: input.profileKey,
      birth: input.birth,
      // The viewer's day: the zone every "As of" prints in, so a today-question
      // about a chart computed today joins the Life Atlas's calculation.
      chartTimeZone: zone(),
      now: context.now,
      runtime,
      signal: context.signal,
    });
    return todayChart;
  };

  const tools = createChatAgentTools({
    chart: natalPrompt,
    chartAsOf: input.chartAsOf,
    chartTimeZone: input.chartTimeZone,
    birthDay: birthDayOf(input.birth),
    todayDay: (now) => viewerTodayDay(now, zone()),
    loadCurrentChart,
    loadPeriodChart: createPeriodChartLoader({
      chart: input.chart,
      profileKey: input.profileKey,
      birth: input.birth,
      engine: input.engine,
    }),
  });

  return {
    tools,
    async prepare(question, options) {
      // A small deterministic router: an undated today-question gets exact-day
      // engine facts before the model runs; a dated one is left to get_timing.
      const needsToday = shouldPreRunToday(question);
      const currentContextUnavailable = needsToday && !(await preRunToday(tools, options));
      return {
        chart: todayChart ?? natalPrompt,
        asOf: todayChart ? todayAnalysisInstant(options.now) : input.chartAsOf,
        currentContextUnavailable,
      };
    },
  };
}
