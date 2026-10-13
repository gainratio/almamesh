/**
 * The ONE chat tool builder for Dashboard and MeshEdge (spec 2026-10-08,
 * "One tool builder"). It owns today's engine load, the period-sky load, the
 * router, and the one "today": the viewer's (device) zone for every page
 * (open question 1, decided 2026-10-08). Pages pass no zone.
 */
import { devicePolicy, type ChartEngine } from '@almamesh/browser';
import type { SiderealChart } from '@almamesh/browser/types';
import {
  PERIOD_READING_TOOL_NAME,
  periodAnalysisInstant,
  pinRelative,
  todayAnalysisInstant,
  type AgentJsonObject,
  type AgentTool,
  type AgentToolContext,
  type AnalysisInstant,
  type PinnedPrompt,
  TRIP_GROUNDING_TOOLS,
} from '@almamesh/llm';
import type { ChatThreadAsOf, ProcessedBirthData } from '@almamesh/shared-types';

import type { ChartEngineContextValue } from '../providers/chartEngineContext';
import { viewerTimeZone } from './analysisInstant';
import { createChatAgentTools, hasExplicitCurrentDay, mentionsPeriodComparison, shouldPreRunToday, viewerTodayDay } from './chatAgentTools';
import { ensureCurrentPlanetaryContext } from './currentPlanetaryContext';
import { createMoonWindowLoader } from './moonWindow';
import { birthUtcYearOf, birthYearOf, createPeriodChartLoader, readyEngine } from './periodChart';
import { pinnedPlaceReader, pinnedTiming } from './pinnedPeriod';
import { createResolvePlaceTool } from './placeTool';
import type { PlaceReader } from './timingPlaces';
import { TIMING_TOOL_NAME } from './timingTool';
import { parseExplicitTimingPeriod, type ExplicitTimingPeriod } from './timingQuestion';
import { createTimeTravelTool, type TravelRecorder } from './timeTravelTool';
import { formatPinLabel } from './timeTravelSheet';
import { natalSummary, tripContext, tripPin, tripToolResult } from './tripContext';

/** A trip's context tools (plan 2026-10-13): bound to the trip, no arguments. */
export const NATAL_SUMMARY_TOOL_NAME = 'get_natal_summary';
export const TRIP_CONTEXT_TOOL_NAME = 'get_trip_context';
const NO_ARGS = { type: 'object', properties: {}, additionalProperties: false } as const;
type GroundingCall = { readonly name: string; readonly args: AgentJsonObject };
/** A trip grounded by the app itself: the period reading (period, place, dashas, sky, themes) and the natal chart. */
const TRIP_GROUNDING_CALLS: readonly GroundingCall[] = TRIP_GROUNDING_TOOLS.map((name) => ({ name, args: {} }));
/** A today question grounds the same way, through the reading bound to today at the viewer's place. */
const TODAY_GROUNDING_CALLS: readonly GroundingCall[] = [{ name: PERIOD_READING_TOOL_NAME, args: {} }];

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
  /** Present only for a live chat turn; records a move without mutating mid-answer. */
  readonly onTravel?: TravelRecorder;
  readonly language?: string;
  /** Test seam only (pinned as above): each replaces the built tool of its name, or joins the list. */
  readonly toolOverrides?: readonly AgentTool[];
}

interface PrepareOptions {
  readonly now: Date;
  readonly signal: AbortSignal;
  readonly onStatus?: (label: string) => void;
}

/** A question that names no single supported period: the model must ask, never pick one. */
export interface TimingClarification {
  readonly reason: Extract<ExplicitTimingPeriod, { kind: 'unresolved' }>['reason'];
  /** Appended to the system prompt by the page. Instructions only, no engine facts. */
  readonly note: string;
}

interface PreparedChatContext {
  /** The chart to sanitize into the prompt. */
  readonly chart: SiderealChart;
  readonly asOf: AnalysisInstant;
  /** The selected or explicitly requested period and its tense for this prompt. */
  readonly pinned?: PinnedPrompt;
  /** Present when the question's dates need clarifying before any timing is read. */
  readonly clarification?: TimingClarification;
  /** 'required' on a trip's or a today question's first round: it grounds itself through its tools before it answers. */
  readonly toolChoice: 'auto' | 'required';
  /** The tool the agent loop runs itself if the provider refuses 'required'. */
  readonly groundingTool?: string;
  /** The rounds stay 'required' until each of these has run once (the grounding tools). */
  readonly requiredTools?: readonly string[];
  /** What the agent loop runs itself if a required round gets no tool call. */
  readonly groundingCalls?: readonly GroundingCall[];
}

export interface ChatToolset {
  readonly tools: readonly AgentTool[];
  prepare(question: string, options: PrepareOptions): Promise<PreparedChatContext>;
}

/**
 * Re-read a place_ref from the offline city list. A dynamic import, so tz-lookup
 * and the geo module never enter the chat chunk that every tier parses.
 */
const lazyPlaceFromRef: PlaceReader = (ref) => import('./geo/placeLookup').then((geo) => geo.placeFromRef(ref));

/** A raw current prediction must not be relabelled as facts for another period. */
function natalOnly(chart: SiderealChart): SiderealChart {
  if (!chart.transit_context && !chart.strength_context && !chart.varga_context_full && !chart.domains_context) return chart;
  return { ...chart, transit_context: undefined, strength_context: undefined, varga_context_full: undefined, domains_context: undefined };
}

function clarificationFor(reason: TimingClarification['reason']): TimingClarification {
  return {
    reason,
    note: `TIMING CLARIFICATION (${reason}): the question does not name one supported calendar period. `
      + 'Ask for one explicit month and year, a year, or an ISO date before you interpret timing. '
      + 'Do not use the saved trip period and do not invent a range.',
  };
}

/**
 * The grounding fields for a turn whose first rounds must call these tools.
 * A missing tool fails loudly here, never as a silently ungrounded answer.
 */
function requiredGrounding(tools: readonly AgentTool[], calls: readonly GroundingCall[]) {
  for (const call of calls) {
    if (!tools.some((tool) => tool.name === call.name)) throw new Error(`The ${call.name} tool is unavailable.`);
  }
  return {
    toolChoice: 'required' as const,
    groundingTool: calls[0]!.name,
    requiredTools: calls.map((call) => call.name),
    groundingCalls: calls,
  };
}

/** The test seam: an override replaces the built tool of its name, or joins the list. */
function withOverrides(built: readonly AgentTool[], overrides: readonly AgentTool[] | undefined): AgentTool[] {
  if (!overrides) return [...built];
  const replaced = built.map((tool) => overrides.find((override) => override.name === tool.name) ?? tool);
  return [...replaced, ...overrides.filter((override) => !built.some((tool) => tool.name === override.name))];
}

/** A trip turn: tools bound to the trip, the brief's inputs, and no pre-computed facts. */
function preparePinned(
  pinned: ChatThreadAsOf,
  chart: SiderealChart,
  tools: readonly AgentTool[],
  scope: { readonly viewerZone: string; readonly language: string; readonly now: Date },
): PreparedChatContext {
  const { viewerZone, language, now } = scope;
  const period = { start: pinned.start, end: pinned.end };
  const relative = pinRelative(period, viewerTodayDay(now, viewerZone));
  // Every trip names its place and zone (tripPin filled an old trip's from the birth place, unmarked).
  const place = pinned.place ? { place: { label: pinned.place.label, timezone: pinned.place.timezone } } : {};
  return {
    chart: natalOnly(chart),
    asOf: periodAnalysisInstant(pinned.start, pinned.end),
    pinned: { ...period, relative, granularity: pinned.granularity, label: formatPinLabel(pinned, language), ...place },
    ...requiredGrounding(tools, TRIP_GROUNDING_CALLS),
  };
}

export function buildChatToolset(input: BuildChatToolsetInput): ChatToolset {
  const zone = input.viewerZone ?? viewerTimeZone;
  const natalPrompt = input.promptChart ?? input.chart;
  // Each submitted question owns a toolset. Recover lazily if this explicit
  // turn needs calculations after an engine failure, sharing one fresh boot
  // across its tools. Construction/natal-only questions never start a reboot,
  // and a failed recovery is not replayed within the same turn.
  const failedEngine = input.engine?.error ? input.engine : null;
  let recovery: Promise<ChartEngine> | null = null;
  const engine = failedEngine ? {
    ...failedEngine,
    engine: null,
    startBootstrap: () => {},
    whenReady: () => recovery ??= failedEngine.reboot(),
  } : input.engine;
  let todayChart: SiderealChart | undefined;
  let todayChartNowMs: number | undefined;

  const loadCurrentChart = async (context: AgentToolContext): Promise<SiderealChart> => {
    if (todayChart && todayChartNowMs === context.now.getTime()) return todayChart;
    const runtime = await readyEngine(engine);
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
    todayChartNowMs = context.now.getTime();
    return todayChart;
  };

  // An old trip with no place reads the birth place (tripContext.ts).
  const pinned = input.pinned ? tripPin(input.pinned, input.birth) : undefined;
  const language = input.language ?? 'en';
  const baseReader = input.placeFromRef ?? lazyPlaceFromRef;

  const skyAllowed = input.periodSkyAllowed ?? devicePolicy().periodSkyComputeAllowed;
  const tripTools = (activePin: ChatThreadAsOf): AgentTool[] => [
    {
      name: NATAL_SUMMARY_TOOL_NAME,
      description: 'Read the natal chart summary for this person: lagna, Moon sign and nakshatra, planets by sign and house, yogas. Identifier-free. No arguments.',
      statusLabel: 'Reading the natal chart',
      parameters: NO_ARGS,
      execute: () => natalSummary(natalOnly(input.chart)),
    },
    {
      name: TRIP_CONTEXT_TOOL_NAME,
      description: "Read this time-travel trip: its period (start, end, granularity, tense, label), the place the user lived then (label and time zone), today's date, and the dasha periods that cover it. No arguments.",
      statusLabel: 'Reading this trip',
      parameters: NO_ARGS,
      execute: (_args, context) => tripToolResult(tripContext({
        chart: input.chart, asOf: activePin, today: viewerTodayDay(context.now, zone()), birth: input.birth, language,
      })),
    },
  ];
  const makeTools = (activePin: ChatThreadAsOf | undefined, promptChart = natalPrompt, chartAsOf = input.chartAsOf) => {
    const reader = activePin ? pinnedPlaceReader(activePin, baseReader) : baseReader;
    const agentTools = createChatAgentTools({
      chart: promptChart,
      chartAsOf,
      chartTimeZone: input.chartTimeZone,
      birthYear: birthYearOf(input.birth),
      birthUtcYear: birthUtcYearOf(input.birth),
      todayDay: (now) => viewerTodayDay(now, zone()),
      loadCurrentChart,
      loadPeriodChart: createPeriodChartLoader({
        chart: input.chart,
        profileKey: input.profileKey,
        birth: input.birth,
        engine,
      }),
      periodSkyAllowed: skyAllowed,
      ...(activePin ? { pinned: pinnedTiming(activePin) } : {}),
      ...(skyAllowed
        ? { loadMoonWindow: createMoonWindowLoader(engine), placeFromRef: reader }
        : {}),
    });
    const trip = activePin ? tripTools(activePin) : [];
    return [
      ...trip,
      // A trip reads its natal chart through get_natal_summary; the today-only lookups stay off it.
      ...(activePin ? agentTools.filter((tool) => tool.name === TIMING_TOOL_NAME) : agentTools),
      ...(skyAllowed ? [createResolvePlaceTool()] : []),
      ...(input.onTravel ? [createTimeTravelTool({
        birthYear: birthYearOf(input.birth), placeFromRef: baseReader,
        language: input.language ?? 'en', record: input.onTravel,
        // The thread's own trip place (not an old trip's birth-place fallback).
        ...(input.pinned?.place ? { currentPlace: input.pinned.place } : {}),
      })] : []),
    ];
  };
  // Every build goes through the test seam; pages never pass toolOverrides.
  const toolsFor = (...args: Parameters<typeof makeTools>) => withOverrides(makeTools(...args), input.toolOverrides);
  let tools = toolsFor(pinned);
  let hasPrepared = false;

  return {
    get tools() { return tools; },
    async prepare(question, options) {
      // Each turn starts from the selected pin. A question-specific context
      // neither records a movement nor changes later undated follow-ups.
      if (hasPrepared) tools = toolsFor(pinned);
      hasPrepared = true;
      let explicit = parseExplicitTimingPeriod(question);
      const currentDay = hasExplicitCurrentDay(question);
      // A comparison still needs its other period when that period's literal
      // dates are unsupported; today's presence must not discard that request.
      if (currentDay && explicit.kind !== 'none' && mentionsPeriodComparison(question)) {
        explicit = { kind: 'unresolved', reason: 'ambiguous_period' };
      } else if (currentDay && explicit.kind === 'period') {
        const today = viewerTodayDay(options.now, zone());
        if (today < explicit.period.start || today > explicit.period.end) {
          explicit = { kind: 'unresolved', reason: 'ambiguous_period' };
        }
      }
      // An explicit current-day question has its own context; it does not move the UI pin.
      const explicitToday = currentDay
        && !(explicit.kind === 'unresolved' && explicit.reason === 'ambiguous_period');
      if (!explicitToday && explicit.kind === 'unresolved') {
        tools = toolsFor(undefined);
        return {
          chart: natalOnly(natalPrompt),
          asOf: input.chartAsOf,
          clarification: clarificationFor(explicit.reason),
          toolChoice: 'auto',
        };
      }
      const scope = { viewerZone: zone(), language, now: options.now };
      if (!explicitToday && explicit.kind === 'period') {
        const { start, end } = explicit.period;
        // Another period asked inside a trip keeps the trip's place and zone, not the birth place.
        const questionPin: ChatThreadAsOf = pinned && pinned.start === start && pinned.end === end
          ? pinned
          : { start, end, granularity: start === end ? 'day' : start.slice(5) === '01-01' && end.slice(5) === '12-31' ? 'year' : 'month',
            ...(pinned?.place ? { place: pinned.place } : {}) };
        tools = toolsFor(tripPin(questionPin, input.birth), natalPrompt, periodAnalysisInstant(start, end));
        return preparePinned(tripPin(questionPin, input.birth), natalPrompt, tools, scope);
      }
      if (pinned && !explicitToday) return preparePinned(pinned, natalPrompt, tools, scope);
      if (pinned) tools = toolsFor(undefined);
      // A small deterministic router: an undated today question, or an explicit
      // current-day one, must read the period reading for today before it answers.
      // Nothing is pre-computed into the prompt, and stored transits never pose as today's.
      if (!shouldPreRunToday(question)) return { chart: natalPrompt, asOf: input.chartAsOf, toolChoice: 'auto' };
      return {
        chart: natalOnly(natalPrompt),
        asOf: todayAnalysisInstant(options.now),
        ...requiredGrounding(tools, TODAY_GROUNDING_CALLS),
      };
    },
  };
}
