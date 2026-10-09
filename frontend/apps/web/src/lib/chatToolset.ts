/**
 * The ONE chat tool builder for Dashboard and MeshEdge (spec 2026-10-08,
 * "One tool builder"). It owns today's engine load, the period-sky load, the
 * router, and the one "today": the viewer's (device) zone for every page
 * (open question 1, decided 2026-10-08). Pages pass no zone.
 */
import { devicePolicy } from '@almamesh/browser';
import type { SiderealChart } from '@almamesh/browser/types';
import {
  periodAnalysisInstant,
  pinRelative,
  todayAnalysisInstant,
  type AgentTool,
  type AgentToolContext,
  type AnalysisInstant,
  type PinnedPrompt,
} from '@almamesh/llm';
import type { ChatThreadAsOf, ProcessedBirthData } from '@almamesh/shared-types';

import type { ChartEngineContextValue } from '../providers/chartEngineContext';
import { viewerTimeZone } from './analysisInstant';
import { createChatAgentTools, shouldPreRunToday, viewerTodayDay } from './chatAgentTools';
import { ensureCurrentPlanetaryContext } from './currentPlanetaryContext';
import { createMoonWindowLoader } from './moonWindow';
import { birthUtcYearOf, birthYearOf, createPeriodChartLoader, readyEngine } from './periodChart';
import { pinnedPlaceReader, pinnedTiming } from './pinnedPeriod';
import { createResolvePlaceTool } from './placeTool';
import type { PlaceReader } from './timingPlaces';
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
  /** Test seam only (pinned as above). Default: this device's `devicePolicy().periodSkyComputeAllowed`. */
  readonly periodSkyAllowed?: boolean;
  /** Test seam only (pinned as above). Default: the offline city list (geo/placeLookup.ts). */
  readonly placeFromRef?: PlaceReader;
  /** A time-travel thread's pin: tools default to it and the router warms it (spec Part 3). */
  readonly pinned?: ChatThreadAsOf;
}

interface PrepareOptions {
  readonly now: Date;
  readonly signal: AbortSignal;
  readonly onStatus?: (label: string) => void;
  /** Localized 'Working out the sky for <period>…' shown when the pinned pre-run computes. */
  readonly pinnedStatus?: string;
}

interface PreparedChatContext {
  /** The chart to sanitize into the prompt. */
  readonly chart: SiderealChart;
  readonly asOf: AnalysisInstant;
  /** A today question whose engine facts could not be computed. */
  readonly currentContextUnavailable: boolean;
  /** Set only for a pinned thread: the period and its tense for the prompt. */
  readonly pinned?: PinnedPrompt;
}

export interface ChatToolset {
  readonly tools: readonly AgentTool[];
  prepare(question: string, options: PrepareOptions): Promise<PreparedChatContext>;
}

/** Shown while today's facts compute, if the timing tool carries no label of its own. */
const TODAY_STATUS_FALLBACK = "Working out today's sky";

/**
 * Re-read a place_ref from the offline city list. A dynamic import, so tz-lookup
 * and the geo module never enter the chat chunk that every tier parses.
 */
const lazyPlaceFromRef: PlaceReader = (ref) => import('./geo/placeLookup').then((geo) => geo.placeFromRef(ref));

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

/** Warm the pinned period's sky (plan Ruling 8). Failures are the model's to see through get_timing. */
async function preRunPin(tools: readonly AgentTool[], options: PrepareOptions): Promise<void> {
  const timing = tools.find((tool) => tool.name === TIMING_TOOL_NAME);
  if (!timing) throw new Error('The timing tool is unavailable.');
  const args = { section: 'transits' };
  // A fixed tool label (dashas only, needs a place) wins: the engine will not run.
  options.onStatus?.(timing.statusLabelFor?.(args) ?? options.pinnedStatus ?? timing.statusLabel ?? TODAY_STATUS_FALLBACK);
  try {
    await timing.execute(args, { now: new Date(options.now.getTime()), signal: options.signal });
  } catch (error) {
    if (options.signal.aborted) throw error;
  }
}

/** A pinned thread never pre-runs today (spec router table: "Pinned | Anything | The pinned period"). */
async function preparePinned(
  tools: readonly AgentTool[],
  pinned: ChatThreadAsOf,
  chart: SiderealChart,
  viewerZone: string,
  options: PrepareOptions,
): Promise<PreparedChatContext> {
  await preRunPin(tools, options);
  const period = { start: pinned.start, end: pinned.end };
  const relative = pinRelative(period, viewerTodayDay(options.now, viewerZone));
  return {
    chart,
    asOf: periodAnalysisInstant(pinned.start, pinned.end),
    currentContextUnavailable: false,
    pinned: { ...period, relative },
  };
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

  const pinned = input.pinned;
  const baseReader = input.placeFromRef ?? lazyPlaceFromRef;
  const reader = pinned ? pinnedPlaceReader(pinned, baseReader) : baseReader;

  // lite/minimal: no place tool and no needs_place; the city data is never loaded there.
  const skyAllowed = input.periodSkyAllowed ?? devicePolicy().periodSkyComputeAllowed;
  const agentTools = createChatAgentTools({
    chart: natalPrompt,
    chartAsOf: input.chartAsOf,
    chartTimeZone: input.chartTimeZone,
    birthYear: birthYearOf(input.birth),
    birthUtcYear: birthUtcYearOf(input.birth),
    todayDay: (now) => viewerTodayDay(now, zone()),
    loadCurrentChart,
    loadPeriodChart: createPeriodChartLoader({
      chart: input.chart,
      profileKey: input.profileKey,
      birth: input.birth,
      engine: input.engine,
    }),
    periodSkyAllowed: skyAllowed,
    ...(pinned ? { pinned: pinnedTiming(pinned) } : {}),
    // Only a full device reads places: lite never gets a path to the city data.
    ...(skyAllowed
      ? { loadMoonWindow: createMoonWindowLoader(input.engine), placeFromRef: reader }
      : {}),
  });
  const tools = skyAllowed ? [...agentTools, createResolvePlaceTool()] : agentTools;

  return {
    tools,
    async prepare(question, options) {
      if (pinned) return preparePinned(tools, pinned, natalPrompt, zone(), options);
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
