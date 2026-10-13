/**
 * The ONE chat tool builder for Dashboard and MeshEdge (spec 2026-10-08,
 * "One tool builder"). It owns today's engine load, the period-sky load, the
 * router, and the one "today": the viewer's (device) zone for every page
 * (open question 1, decided 2026-10-08). Pages pass no zone.
 */
import { devicePolicy, type ChartEngine } from '@almamesh/browser';
import type { SiderealChart } from '@almamesh/browser/types';
import {
  AGENT_LIMITS,
  periodAnalysisInstant,
  pinRelative,
  todayAnalysisInstant,
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
import { parseExplicitTimingPeriod } from './timingQuestion';
import { createTimeTravelTool, type TravelRecorder } from './timeTravelTool';
import { formatPinLabel } from './timeTravelSheet';
import { DEFAULT_PLACE_LABEL, natalSummary, tripContext, tripPin, tripToolResult } from './tripContext';

/** A trip's context tools (plan 2026-10-13): bound to the trip, no arguments. */
export const NATAL_SUMMARY_TOOL_NAME = 'get_natal_summary';
export const TRIP_CONTEXT_TOOL_NAME = 'get_trip_context';
const NO_ARGS = { type: 'object', properties: {}, additionalProperties: false } as const;

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
}

interface PrepareOptions {
  readonly now: Date;
  readonly signal: AbortSignal;
  readonly onStatus?: (label: string) => void;
}

interface PreparedChatContext {
  /** The chart to sanitize into the prompt. */
  readonly chart: SiderealChart;
  readonly asOf: AnalysisInstant;
  /** A today question whose engine facts could not be computed. */
  readonly currentContextUnavailable: boolean;
  /** The selected or explicitly requested period and its tense for this prompt. */
  readonly pinned?: PinnedPrompt;
  /** Sanitized engine results supplied even when the model elects no tools. Empty for a trip. */
  readonly timingFacts: readonly { readonly tool: typeof TIMING_TOOL_NAME; readonly result: unknown }[];
  /** 'required' on a trip's first round: it grounds itself through its tools before it answers. */
  readonly toolChoice: 'auto' | 'required';
  /** The tool the agent loop runs itself if the provider refuses 'required'. */
  readonly groundingTool?: string;
  /** A trip's rounds stay 'required' until each of these has run once (the brief's grounding tools). */
  readonly requiredTools?: readonly string[];
}

export interface ChatToolset {
  readonly tools: readonly AgentTool[];
  prepare(question: string, options: PrepareOptions): Promise<PreparedChatContext>;
}

/** Shown while today's facts compute, if the timing tool carries no label of its own. */
const TODAY_STATUS_FALLBACK = "Working out today's sky";
// Reserve room for the two tool labels and JSON wrappers as well as their results.
const GROUNDING_RESULT_CHARS = Math.min(AGENT_LIMITS.maxResultChars, Math.floor((AGENT_LIMITS.maxAggregateResultChars - 512) / 2));

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

function oversizedTimingFact(result: unknown, section: 'dashas' | 'transits') {
  const source = result as { period?: { start?: unknown; end?: unknown; basis?: unknown; days?: unknown }; notes?: unknown } | null;
  const period = source?.period;
  const safePeriod = period && typeof period.start === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(period.start)
    && typeof period.end === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(period.end)
    && (period.basis === 'period' || period.basis === 'today') && Number.isSafeInteger(period.days)
    ? { start: period.start, end: period.end, basis: period.basis, days: period.days }
    : undefined;
  const notes = Array.isArray(source?.notes)
    ? source.notes.filter((note): note is string => typeof note === 'string' && note.length <= 512).slice(0, 8)
    : [];
  return { ...(safePeriod ? { period: safePeriod } : {}), section, shown: section,
    notes: [...notes, 'This local result was too large to include safely; no partial planetary facts are supplied.'],
    data: { available: false, reason: 'result_too_large' },
  };
}

/** Read sanitized, bounded engine facts before the model can elect to skip tools. */
async function timingFact(timing: AgentTool, section: 'dashas' | 'transits', options: PrepareOptions): Promise<unknown> {
  try {
    const result = await timing.execute({ section }, { now: new Date(options.now.getTime()), signal: options.signal });
    const encoded = JSON.stringify(result);
    return typeof encoded === 'string' && encoded.length <= GROUNDING_RESULT_CHARS
      ? result
      : oversizedTimingFact(result, section);
  } catch (error) {
    if (options.signal.aborted) throw error;
    return { section, notes: ['This local timing calculation could not complete; other supplied sections remain usable.'],
      data: { available: false, reason: 'local_calculation_failed' } };
  }
}

async function preRunToday(tools: readonly AgentTool[], options: PrepareOptions) {
  const timing = tools.find((tool) => tool.name === TIMING_TOOL_NAME);
  if (!timing) throw new Error('The timing tool is unavailable.');
  options.onStatus?.(timing.statusLabel ?? TODAY_STATUS_FALLBACK);
  const transits = await timingFact(timing, 'transits', options);
  const dashas = await timingFact(timing, 'dashas', options);
  const unavailable = (transits as { data?: { available?: boolean } } | null)?.data?.available === false;
  return { unavailable, timingFacts: [dashas, transits].map((result) => ({ tool: TIMING_TOOL_NAME as typeof TIMING_TOOL_NAME, result })) };
}

/** A trip turn: tools bound to the trip, the brief's inputs, and no pre-computed facts. */
function preparePinned(
  pinned: ChatThreadAsOf,
  chart: SiderealChart,
  viewerZone: string,
  language: string,
  now: Date,
): PreparedChatContext {
  const period = { start: pinned.start, end: pinned.end };
  const relative = pinRelative(period, viewerTodayDay(now, viewerZone));
  // tripPin already relabelled a default/birth place; it reaches the model with no zone.
  const place = !pinned.place ? {}
    : pinned.place.label === DEFAULT_PLACE_LABEL
      ? { place: { label: DEFAULT_PLACE_LABEL, source: 'default' as const } }
      : { place: { label: pinned.place.label, timezone: pinned.place.timezone, source: 'trip' as const } };
  return {
    chart: natalOnly(chart),
    asOf: periodAnalysisInstant(pinned.start, pinned.end),
    currentContextUnavailable: false,
    pinned: { ...period, relative, granularity: pinned.granularity, label: formatPinLabel(pinned, language), ...place },
    timingFacts: [],
    toolChoice: 'required',
    groundingTool: TRIP_CONTEXT_TOOL_NAME,
    requiredTools: TRIP_GROUNDING_TOOLS,
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
      })] : []),
    ];
  };
  let tools = makeTools(pinned);
  let hasPrepared = false;

  return {
    get tools() { return tools; },
    async prepare(question, options) {
      // Each turn starts from the selected pin. A question-specific context
      // neither records a movement nor changes later undated follow-ups.
      if (hasPrepared) tools = makeTools(pinned);
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
        tools = makeTools(undefined);
        return {
          chart: natalOnly(natalPrompt),
          asOf: input.chartAsOf,
          currentContextUnavailable: false,
          timingFacts: [{ tool: TIMING_TOOL_NAME, result: {
            status: 'needs_clarification',
            notes: ['The question does not identify one supported calendar period. Ask for one explicit month and year, year, or ISO date before interpreting timing. Do not substitute the saved pin or invent a range.'],
            data: { available: false, reason: explicit.reason },
          } }],
          toolChoice: 'auto',
        };
      }
      if (!explicitToday && explicit.kind === 'period') {
        const { start, end } = explicit.period;
        const questionPin: ChatThreadAsOf = pinned && pinned.start === start && pinned.end === end
          ? pinned
          : { start, end, granularity: start === end ? 'day' : start.slice(5) === '01-01' && end.slice(5) === '12-31' ? 'year' : 'month' };
        tools = makeTools(tripPin(questionPin, input.birth), natalPrompt, periodAnalysisInstant(start, end));
        return preparePinned(tripPin(questionPin, input.birth), natalPrompt, zone(), language, options.now);
      }
      if (pinned && !explicitToday) return preparePinned(pinned, natalPrompt, zone(), language, options.now);
      if (pinned) tools = makeTools(undefined);
      // A small deterministic router: an undated today-question gets exact-day
      // engine facts before the model runs, as do explicit current-day questions.
      const needsToday = shouldPreRunToday(question);
      const prepared = needsToday ? await preRunToday(tools, options) : undefined;
      const currentChart = needsToday && todayChartNowMs === options.now.getTime() ? todayChart : undefined;
      if (currentChart) tools = makeTools(undefined, currentChart, todayAnalysisInstant(options.now));
      return {
        chart: currentChart ?? (needsToday ? natalOnly(natalPrompt) : natalPrompt),
        asOf: currentChart ? todayAnalysisInstant(options.now) : input.chartAsOf,
        currentContextUnavailable: prepared?.unavailable ?? false,
        timingFacts: prepared?.timingFacts ?? [],
        toolChoice: 'auto',
      };
    },
  };
}
