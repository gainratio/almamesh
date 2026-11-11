/**
 * One chat turn (chat tool layer redesign, 2026-10-14): the prompt, the two tools
 * (read_period, travel) and the typed answer, run through the seam's tool loop.
 * Dashboard and MeshEdge load this module on send (`await import('./chatTurn')`), so
 * the AI SDK and zod stay out of every page's first chunk.
 *
 * What the app knows rides in the prompt (today, the trip and its place); the model
 * reads any period with read_period and finishes with `answer`, checked against the
 * readings of this turn. A trip turn must read before it may answer.
 */
import { devicePolicy, type ChartEngine } from '@almamesh/browser';
import type { SiderealChart } from '@almamesh/browser/types';
import {
  buildChatMessages,
  formatNow,
  periodAnalysisInstant,
  pinRelative,
  sanitizeChartForLlm,
  selectSpecialistsForTurn,
  type AnalysisInstant,
  type ChatRectificationContext,
  type ChatTurn,
  type PinnedPrompt,
  type PromptLanguage,
  type ProviderConfig,
  type SanitizedMeshEdge,
  type ThreadFacts,
  type TurnAgentPlan,
} from '@almamesh/llm';
import { chatAnswerSpec, type GroundingReading } from '@almamesh/llm/answer';
import { ANSWER_TOOL_NAME, runToolTurn, TOOL_LOOP_LIMITS, type AgentStatusEvent, type AnswerSpec, type ToolCallEvent, type ToolContext, type ToolDef } from '@almamesh/llm/toolLoop';
import type { ChatThreadAsOf, ProcessedBirthData } from '@almamesh/shared-types';
import {
  getProfileMemoryFacts,
  listMembersOf,
  useProfilesStore,
  useRectificationRecordsStore,
  type CurrentPlace,
  type Profile,
} from '@almamesh/store';

import type { ChartEngineContextValue } from '../providers/chartEngineContext';
import { reportAgentToolFailure } from './agentToolDiagnostics';
import { viewerTimeZone } from './analysisInstant';
import { createFindBestWindowsTool, FIND_BEST_WINDOWS_TOOL_NAME } from './bestWindowsTool';
import { chatContextFor } from './chatContextBudget';
import { ensureCurrentPlanetaryContext } from './currentPlanetaryContext';
import { createSetCurrentLocationTool } from './locationTool';
import { createRememberFactTool } from './memoryTool';
import { createReadMeshMemberTool, READ_MESH_MEMBER_TOOL_NAME } from './meshChatTool';
import { createMoonWindowLoader } from './moonWindow';
import { birthYearOf, createPeriodChartLoader, readyEngine } from './periodChart';
import { createReadPeriodTool, isReadPeriodReading, readPeriodGrounding, readPeriodSpanLabel, readPeriodStatusLabel, type DevicePlace, type ReadPeriodArgs, type ReadPeriodInput } from './readPeriod';
import { READ_PERIOD_TOOL_NAME } from './periodReading';
import { formatPinLabel } from './timeTravelSheet';
import { claimsMove, travelGrant, type PendingTravel } from './travelIntent';
import { createTravelTool, TRAVEL_TOOL_NAME, travelPeriodLabel, travelStatusLabel, type TravelArgs } from './travelTool';
import type { TravelRecorder } from './travelSlot';
import { tripPin } from './tripContext';
import { createReadVargaTool, READ_VARGA_TOOL_NAME } from './vargaTool';
import { viewerTodayDay } from './viewerToday';

export interface ChatStatusLabels {
  readonly deciding: string;
  readonly answering: string;
  readonly complete: string;
  /** "Reading {{period}}…" in the page's language; English when absent. */
  readonly reading?: (period: string) => string;
  /** "Moving to {{period}}…" in the page's language; English when absent. */
  readonly moving?: (period: string) => string;
  /** "Back to today…" in the page's language; English when absent. */
  readonly returning?: string;
}

/** The status line for one read_period call: the span it reads. */
function readStatus(labels: ChatStatusLabels, args: ReadPeriodArgs, language: string): string {
  return labels.reading ? labels.reading(readPeriodSpanLabel(args, language)) : readPeriodStatusLabel(args, language);
}

/** The status line for one travel call: where the trip goes. */
function travelStatus(labels: ChatStatusLabels, args: TravelArgs, language: string): string {
  const period = travelPeriodLabel(args, language);
  const spoken = period === null ? labels.returning : labels.moving?.(period);
  return spoken ?? travelStatusLabel(args, language);
}

interface StatusStarts {
  readonly read: (args: ReadPeriodArgs) => void;
  readonly travel: (args: TravelArgs) => void;
}

/** A tool call as the transcript keeps it. A retried call is telemetry only and never becomes one. */
export interface ChatToolCall {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly result: unknown;
  readonly status: 'complete' | 'error' | 'skipped';
}

/** Test seams only; pages never pass them. */
export interface ChatTurnSeams extends Partial<Pick<ReadPeriodInput, 'loadPeriodChart' | 'loadCurrentChart' | 'loadMoonWindow' | 'lookup' | 'pick' | 'viewerZone' | 'periodSkyAllowed'>> {
  readonly fetchImpl?: typeof fetch;
}

export interface ChatTurnInput {
  readonly config: ProviderConfig;
  /** The natal chart every engine load merges its sky onto. */
  readonly chart: SiderealChart;
  /** The chart the prompt's facts read (the Dashboard adds the raw predictive contexts); default `chart`. */
  readonly promptChart?: SiderealChart;
  /** The chart's own analysis instant: a today thread's facts are as of it. */
  readonly chartAsOf: AnalysisInstant;
  readonly profileKey: string;
  readonly birth: ProcessedBirthData | undefined;
  readonly engine: ChartEngineContextValue | null;
  readonly question: string;
  readonly mode: 'layman' | 'expert';
  readonly language: PromptLanguage;
  readonly history: readonly ChatTurn[];
  readonly retrievedContext: readonly string[];
  readonly interpretationText?: string;
  readonly rectification?: ChatRectificationContext;
  readonly meshEdge?: SanitizedMeshEdge;
  /** The thread's time-travel trip; absent in a today thread. */
  readonly asOf?: ChatThreadAsOf;
  /**
   * Where the person lives now (Settings, `getCurrentPlace`): a today thread's place and
   * read_period's "home". Its label and zone reach the model; its coordinates only the
   * on-device Moon loader. Absent: a today thread reads at the viewer's zone, with no place.
   */
  readonly currentPlace?: CurrentPlace;
  readonly signal: AbortSignal;
  readonly labels: ChatStatusLabels;
  readonly onStatus?: (label: string | null) => void;
  /** Records a move; the chat hook applies it after the answer is saved. Absent: no travel tool. */
  readonly onTravel?: TravelRecorder;
  /**
   * A move the turn did not ask for, offered instead of refused: the chat shows a "Move to…?"
   * button under the answer (travelTool.ts offer). Absent: such a call is refused.
   */
  readonly onTravelOffer?: TravelRecorder;
  /**
   * The last answer's travel call returned needs_place (travelIntent.ts pendingTravelIn, read from
   * the saved tool result): this turn's place answer ("Delhi") may finish that call's `to`, only.
   */
  readonly pendingTravel?: PendingTravel;
  readonly onToolCall?: (call: ChatToolCall) => void;
  /** Default: the wall clock. */
  readonly now?: Date;
  readonly seams?: ChatTurnSeams;
}

/** A raw current prediction must not be relabelled as facts for another period. */
function natalOnly(chart: SiderealChart): SiderealChart {
  if (!chart.transit_context && !chart.strength_context && !chart.varga_context_full && !chart.domains_context) return chart;
  return { ...chart, transit_context: undefined, strength_context: undefined, varga_context_full: undefined, domains_context: undefined };
}

/** A failed engine is rebooted lazily, once per turn, and only when a tool needs it. */
function recoveringEngine(context: ChartEngineContextValue | null): ChartEngineContextValue | null {
  const failed = context?.error ? context : null;
  if (!failed) return context;
  let recovery: Promise<ChartEngine> | null = null;
  return { ...failed, engine: null, startBootstrap: () => {}, whenReady: () => recovery ??= failed.reboot() };
}

/** Today's chart for read_period's single "today", computed once per turn instant. */
function currentChartLoader(input: ChatTurnInput, engine: ChartEngineContextValue | null, zone: () => string): ReadPeriodInput['loadCurrentChart'] {
  let cached: { readonly at: number; readonly chart: SiderealChart } | undefined;
  return async (context) => {
    if (cached?.at === context.now.getTime()) return cached.chart;
    const runtime = await readyEngine(engine);
    const chart = await ensureCurrentPlanetaryContext({
      chart: input.chart, profileKey: input.profileKey, birth: input.birth, chartTimeZone: zone(), now: context.now, runtime, signal: context.signal,
    });
    cached = { at: context.now.getTime(), chart };
    return chart;
  };
}

/**
 * A thrown tool error is reported on this device (a stale chunk raises the update notice), then
 * rethrown to the loop. An error after the turn was cancelled is rethrown only.
 */
function reported<I>(tool: ToolDef<I>, before?: (args: I) => void): ToolDef<I> {
  return {
    ...tool,
    execute: async (args: I, context: ToolContext) => {
      before?.(args);
      try {
        return await tool.execute(args, context);
      } catch (error) {
        // A turn the user cancelled is not a failing tool.
        if (!context.signal.aborted) reportAgentToolFailure(error);
        throw error;
      }
    },
  };
}

function resolveProfileTarget(profileKey: string): { profileId: string | undefined; profile: Profile | undefined } {
  const store = useProfilesStore.getState();
  const profileId = store.profiles[profileKey] ? profileKey : (store.activeProfileId ?? undefined);
  return { profileId, profile: profileId ? store.profiles[profileId] : undefined };
}

function persistResolvedPlace(profileId: string | undefined, place: DevicePlace): void {
  if (!profileId || place.latitude === undefined || place.longitude === undefined) return;
  const store = useProfilesStore.getState();
  if (!store.profiles[profileId]) return;
  store.setCurrentPlace(profileId, {
    label: place.label,
    timezone: place.timezone,
    latitude: place.latitude,
    longitude: place.longitude,
  });
}

function natalMoonOf(chart: SiderealChart) {
  const moon = chart.planets?.moon;
  return moon?.sign && moon?.nakshatra ? { sign: moon.sign, nakshatra: moon.nakshatra } : undefined;
}

interface TurnLocationRef {
  readonly profileId: string | undefined;
  readonly getHomePlace: () => DevicePlace | undefined;
  readonly setHomePlace: (place: DevicePlace) => void;
}

function extraTurnTools(
  input: ChatTurnInput,
  recommended: ReadonlySet<string>,
  loc: TurnLocationRef,
  engine: ChartEngineContextValue | null,
  zone: () => string,
  periodLoader: NonNullable<ReadPeriodInput['loadPeriodChart']>,
): ToolDef<unknown>[] {
  const seams = input.seams ?? {};
  const out: ToolDef<unknown>[] = [];
  if (recommended.has('set_current_location')) {
    out.push(reported(createSetCurrentLocationTool({
      profileId: loc.profileId,
      getHomePlace: loc.getHomePlace,
      setTurnHomePlace: loc.setHomePlace,
      ...(seams.lookup ? { lookup: seams.lookup } : {}),
      ...(seams.pick ? { pick: seams.pick } : {}),
    })) as ToolDef<unknown>);
  }
  if (recommended.has('read_varga')) {
    out.push(reported(createReadVargaTool({ chart: input.chart, engine, profileId: loc.profileId })) as ToolDef<unknown>);
  }
  if (recommended.has('find_best_windows')) {
    out.push(reported(createFindBestWindowsTool({ chart: input.chart, viewerZone: zone, loadPeriodChart: periodLoader })) as ToolDef<unknown>);
  }
  if (recommended.has('read_mesh_member') && !input.meshEdge) {
    out.push(reported(createReadMeshMemberTool({ engine, viewerZone: zone })) as ToolDef<unknown>);
  }
  if (recommended.has('remember_fact')) {
    out.push(reported(createRememberFactTool({ profileId: loc.profileId })) as ToolDef<unknown>);
  }
  return out;
}

function turnTools(
  input: ChatTurnInput,
  pin: ChatThreadAsOf | undefined,
  starts: StatusStarts,
  loc: TurnLocationRef,
  recommended: ReadonlySet<string>,
): ToolDef<unknown>[] {
  const seams = input.seams ?? {};
  const zone = seams.viewerZone ?? viewerTimeZone;
  const engine = recoveringEngine(input.engine);
  const skyAllowed = seams.periodSkyAllowed ?? devicePolicy().periodSkyComputeAllowed;
  const periodLoader = seams.loadPeriodChart ?? createPeriodChartLoader({ chart: input.chart, profileKey: input.profileKey, birth: input.birth, engine });
  const places = {
    homePlace: loc.getHomePlace(),
    getHomePlace: loc.getHomePlace,
    ...(seams.lookup ? { lookup: seams.lookup } : {}),
    ...(seams.pick ? { pick: seams.pick } : {}),
  };
  const read = createReadPeriodTool({
    ...places,
    threadPlace: pin?.place,
    onResolvedHomePlace: loc.setHomePlace,
    birth: input.birth, chart: input.chart, language: input.language, viewerZone: zone, periodSkyAllowed: skyAllowed,
    loadPeriodChart: periodLoader,
    loadCurrentChart: seams.loadCurrentChart ?? currentChartLoader(input, engine, zone),
    ...(skyAllowed ? { loadMoonWindow: seams.loadMoonWindow ?? createMoonWindowLoader(engine, natalMoonOf(input.chart)) } : {}),
  });
  // travel's null place keeps the trip's own place, never an old trip's birth-place fallback.
  const travel = input.onTravel
    ? [createTravelTool({
      ...places, threadPlace: input.asOf?.place, birthYear: birthYearOf(input.birth), language: input.language, record: input.onTravel,
      grant: travelGrant(input.question, input.pendingTravel),
      ...(input.onTravelOffer ? { offer: input.onTravelOffer } : {}),
    })]
    : [];
  // Under budget pressure a reading goes out as its grounding facts: what the answer is checked against.
  const compactRead = { ...reported(read, starts.read), compact: (result: unknown) => (isReadPeriodReading(result) ? readPeriodGrounding(result, input.language) : result) };
  return [
    compactRead,
    ...travel.map((tool) => reported(tool, starts.travel)),
    ...extraTurnTools(input, recommended, loc, engine, zone, periodLoader),
  ] as ToolDef<unknown>[];
}

interface Framed {
  readonly chart: SiderealChart;
  readonly asOf: AnalysisInstant;
  readonly pinned?: PinnedPrompt;
  readonly thread: ThreadFacts;
  readonly plan: TurnAgentPlan;
}

const PLACE_PROMPT_RE =
  /\b(?:where\s+(?:do\s+you\s+live|are\s+you)|current\s+(?:city|location)|what\s+city\s+are\s+you\s+in|nearest\s+larger\s+city|dónde\s+vives|onde\s+você\s+mora)\b/iu;

function planTurnFor(
  input: ChatTurnInput,
  pin: ChatThreadAsOf | undefined,
  profile: Profile | undefined,
  profileId: string | undefined,
): { readonly plan: TurnAgentPlan; readonly extras: Partial<ThreadFacts> } {
  const store = useProfilesStore.getState();
  const memoryNotes = getProfileMemoryFacts(profile).map((f) => `[${f.category}] ${f.text}`);
  const isRectified = Boolean(
    input.rectification || (profileId && useRectificationRecordsStore.getState().getRecord(profileId)),
  );
  const lastAssistant = [...input.history].reverse().find((t) => t.role === 'assistant')?.content ?? '';
  const lastAssistantAskedPlace = !input.pendingTravel && PLACE_PROMPT_RE.test(lastAssistant);
  const plan = selectSpecialistsForTurn(input.question, {
    hasHomePlace: Boolean(input.currentPlace),
    hasTrip: Boolean(pin),
    hasMeshEdge: Boolean(input.meshEdge),
    hasMeshMembers: listMembersOf(store.profiles).length > 0,
    isRectified,
    lastAssistantAskedPlace,
  });
  return {
    plan,
    extras: {
      ...(memoryNotes.length > 0 ? { memoryNotes } : {}),
      ...(plan.specialistBlock ? { specialistBlock: plan.specialistBlock } : {}),
      ...(plan.enforceRelationshipFence ? { enforceRelationshipFence: true } : {}),
    },
  };
}

/** The prompt's frame: a trip reads its natal chart at its own period; a today thread as of the chart. */
function frameOf(
  input: ChatTurnInput,
  pin: ChatThreadAsOf | undefined,
  now: Date,
  profile: Profile | undefined,
  profileId: string | undefined,
): Framed {
  const zone = (input.seams?.viewerZone ?? viewerTimeZone)();
  const facts = input.promptChart ?? input.chart;
  const today = formatNow(now, zone);
  const { plan, extras } = planTurnFor(input, pin, profile, profileId);
  if (!pin) {
    const home = input.currentPlace ? { home: { place: input.currentPlace.label, timezone: input.currentPlace.timezone } } : {};
    return { chart: facts, asOf: input.chartAsOf, thread: { now: today, ...home, ...extras }, plan };
  }
  const period = { start: pin.start, end: pin.end };
  const trip = pin.place ? { trip: { label: formatPinLabel(pin, input.language), place: pin.place.label, timezone: pin.place.timezone } } : {};
  return {
    chart: natalOnly(facts),
    asOf: periodAnalysisInstant(pin.start, pin.end),
    pinned: { ...period, relative: pinRelative(period, viewerTodayDay(now, zone)), granularity: pin.granularity },
    thread: { now: today, ...trip, ...extras },
    plan,
  };
}

/** Tools whose status line names their span ("Reading Jun – Dec 2019…", "Moving to May 2019…"). */
const SPAN_TOOLS: ReadonlySet<string> = new Set([READ_PERIOD_TOOL_NAME, TRAVEL_TOOL_NAME]);
const COMPOUND_READ_TOOLS: ReadonlySet<string> = new Set([
  READ_VARGA_TOOL_NAME,
  FIND_BEST_WINDOWS_TOOL_NAME,
  READ_MESH_MEMBER_TOOL_NAME,
]);

/**
 * The status line: the running tool stays up while the model reads its result. A read or a
 * trip names its span when it starts; the loop's generic label for it (which can land before
 * or after that) is never shown.
 */
function statusSink(input: ChatTurnInput) {
  let toolLabel: string | null = null;
  const spans = new Map<string, string>();
  const show = (label: string) => {
    toolLabel = label;
    input.onStatus?.(label);
  };
  const showSpan = (toolName: string, label: string) => {
    spans.set(toolName, label);
    show(label);
  };
  const onEvent = (event: AgentStatusEvent) => {
    if (event.phase === 'using_tool' && SPAN_TOOLS.has(event.toolName)) {
      const label = spans.get(event.toolName);
      return label === undefined ? undefined : show(label);
    }
    if (event.phase === 'using_tool') return show(event.label);
    if (event.phase === 'deciding') spans.clear(); // each round's call names its own span
    if (event.phase === 'deciding' && event.round > 1 && toolLabel !== null) return undefined;
    if (event.phase !== 'deciding') toolLabel = null;
    input.onStatus?.(input.labels[event.phase]);
    return undefined;
  };
  const starts: StatusStarts = {
    read: (args) => showSpan(READ_PERIOD_TOOL_NAME, readStatus(input.labels, args, input.language)),
    travel: (args) => showSpan(TRAVEL_TOOL_NAME, travelStatus(input.labels, args, input.language)),
  };
  return { starts, onEvent };
}

/** What the model told the user to correct: the conversation is where it was. */
export const MOVE_NOT_MADE =
  'This conversation did not move this turn (no travel was queued). Do not say it moved, left the trip or went back to today; answer where it is. ' +
  'If the user wants to move, they can use the Time travel control, or say "back to today" or "take me to May 2019".';

/** Every string in the answer, joined: the claim can sit in any field. */
function answerText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(answerText).join(' ');
  return typeof value === 'object' && value !== null ? Object.values(value).map(answerText).join(' ') : '';
}

/**
 * travel-guard-live 2026-10-15 (DeepSeek v4.1 flash, 3 of 20 runs): the trip stayed put and the
 * answer said "We've stepped out of September 2017". On a turn that queued no move, an answer
 * claiming one is sent back once; a second claim is kept rather than failing the turn.
 */
function withoutFalseMoveClaim<A>(spec: AnswerSpec<A>, moved: () => boolean): AnswerSpec<A> {
  let sentBack = false;
  const schema = spec.schema.superRefine((value, ctx) => {
    if (sentBack || moved() || !claimsMove(answerText(value))) return;
    sentBack = true;
    ctx.addIssue({ code: 'custom', message: MOVE_NOT_MADE, path: [] });
  });
  return { ...spec, schema };
}

/** Yields the answer as cumulative markdown snapshots: each one replaces the last. */
export async function* runChatTurn(input: ChatTurnInput): AsyncGenerator<string> {
  const now = input.now ?? new Date();
  const { contextTokens, promptBudget, telemetry } = await chatContextFor(input.config, input.signal, input.seams?.fetchImpl);
  const { profileId, profile } = resolveProfileTarget(input.profileKey);
  let turnHomePlace: DevicePlace | undefined = input.currentPlace;
  const loc: TurnLocationRef = {
    profileId,
    getHomePlace: () => turnHomePlace,
    setHomePlace: (place) => {
      turnHomePlace = place;
      persistResolvedPlace(profileId, place);
    },
  };
  // An old trip with no place reads the birth place (tripContext.ts).
  const pin = input.asOf ? tripPin(input.asOf, input.birth) : undefined;
  const frame = frameOf(input, pin, now, profile, profileId);
  const messages = buildChatMessages(
    sanitizeChartForLlm(frame.chart, frame.asOf), input.question, input.mode, input.history, input.retrievedContext,
    input.interpretationText, input.language, input.meshEdge, input.rectification, promptBudget, frame.pinned, frame.thread,
  );
  const readings: GroundingReading[] = [];
  let hasCompoundReads = false;
  const status = statusSink(input);
  let moved = false;
  const onTravel: TravelRecorder | undefined = input.onTravel && ((action) => {
    moved = true;
    input.onTravel?.(action);
  });
  const onToolCall = (event: ToolCallEvent) => {
    telemetry.onToolCall(event);
    if (event.toolName === READ_PERIOD_TOOL_NAME && event.status === 'complete' && isReadPeriodReading(event.result)) readings.push(readPeriodGrounding(event.result, input.language));
    if (event.status === 'complete' && COMPOUND_READ_TOOLS.has(event.toolName)) hasCompoundReads = true;
    if (event.status === 'retried' || event.toolName === ANSWER_TOOL_NAME) return;
    const args = (event.args ?? {}) as Readonly<Record<string, unknown>>;
    input.onToolCall?.({ toolCallId: event.toolCallId, toolName: event.toolName, args, result: event.result, status: event.status });
  };
  const answerGrounding = () => ({ readings, ...(hasCompoundReads ? { hasCompoundReads: true } : {}) });
  const recommended = new Set(frame.plan.recommendedTools);
  const turnLimits = {
    maxRounds: TOOL_LOOP_LIMITS.maxRounds,
    maxCallsPerTool: { ...TOOL_LOOP_LIMITS.maxCallsPerTool, travel: 1 },
  };
  yield* runToolTurn({
    config: input.config,
    ...(contextTokens !== undefined ? { contextTokens } : {}),
    messages,
    tools: turnTools({ ...input, ...(onTravel ? { onTravel } : {}) }, pin, status.starts, loc, recommended),
    answer: withoutFalseMoveClaim(chatAnswerSpec(answerGrounding, { voice: input.mode, language: input.language }), () => moved),
    limits: turnLimits,
    readFirst: pin !== undefined,
    now,
    signal: input.signal,
    ...(input.seams?.fetchImpl ? { fetchImpl: input.seams.fetchImpl } : {}),
    onStatus: status.onEvent,
    onToolCall,
    onRound: telemetry.onRound,
  });
}
