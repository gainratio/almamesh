/**
 * `travel(to, place)` (chat tool layer redesign, 2026-10-14): move this conversation and the
 * Dashboard to a day, month or year, or back to today. The date is plain at the precision the user
 * said; the place is a city name resolved on the device like read_period's (readPeriod.ts). A call
 * records into the turn's TravelSlot (travelSlot.ts); nothing moves until the answer is saved.
 */
import { defineTool, z, type ToolContext, type ToolDef } from '@almamesh/llm/toolLoop';
import type { ChatThreadAsOf } from '@almamesh/shared-types';
import { chatAsOfProblem } from '@almamesh/store';
import { NEEDS_PLACE, OUTSIDE_RANGE, READ_PERIOD_TIMEOUT_MS, resolveChatPlace, type PlaceAsk, type PlaceOutcome, type PlaceResolverInput, type ReadPeriodAsk } from './readPeriod';
import { formatPinLabel, periodAsOfFromDraft, type SheetDraft } from './timeTravelSheet';
import { draftFromToolArgs, TIME_TRAVEL_STATUS_LABEL, TRAVEL_DATE_ERROR as DATE_ERROR, type TravelRecorder } from './travelSlot';

export const TRAVEL_TOOL_NAME = 'travel';

export interface TravelArgs {
  readonly to: string;
  readonly place: string | null;
}

export interface TravelToolInput extends PlaceResolverInput {
  /** Read for the before-birth check only. Never echoed. */
  readonly birthYear: number | undefined;
  readonly language: string;
  readonly record: TravelRecorder;
  /** The turn's own message asks to move, or finishes a move the last turn asked for (travelIntent.ts); otherwise a call is refused. */
  readonly travelAsked: boolean;
}

export interface TravelQueued {
  readonly status: 'queued';
  readonly action: 'travel' | 'back_to_today';
  readonly period_label?: string;
  readonly place_label?: string;
  readonly time_zone?: string;
}

/** A call on a turn whose message asked for no move: nothing moves, the model reads instead. */
export interface TravelRefused {
  readonly status: 'refused';
  readonly reason: 'not_asked';
  readonly note: string;
}

export type TravelResult = TravelQueued | PlaceAsk | ReadPeriodAsk | TravelRefused;

/**
 * dashboard.agentic.real 2026-10-15 (GPT Luna): "outlook today?" in a September 2017 trip read
 * today, then travelled back to today and ended the trip. A question about another time is
 * answered in place; only an explicit request moves the conversation. travel-guard-live 2026-10-15:
 * after the refusal DeepSeek still told the user it had moved, so the note forbids the claim and
 * names how the user can move (chatTurn.ts also sends such an answer back).
 */
export const TRAVEL_NOT_ASKED: TravelRefused = {
  status: 'refused',
  reason: 'not_asked',
  note: 'The user did not ask to move this conversation, so it stays where it is. Answer their question here: read the time they asked about with read_period. Do not say the conversation moved or the trip ended. If they want to move, they can use the Time travel control, or say "back to today" or "take me to May 2019".',
};

const TO = /^(today|\d{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?)?)$/;

const DESCRIPTION = [
  'Move this conversation and the Dashboard to a day, month or year (a time-travel trip), or back to today.',
  'Only when the user asks to move ("take me to ...", "back to today") in this message, or the last one if you asked where; a question about another time, today included, is answered here with read_period.',
  'The move happens after your answer. Call it at most once per turn.',
  'Examples: "take me to May 2019 in Vadodara" -> {"to":"2019-05","place":"Vadodara"}.',
  '"back to today" or "leave this trip" -> {"to":"today","place":null}.',
].join(' ');

const PERIOD_OF_LENGTH: Readonly<Record<number, 'day' | 'month' | 'year'>> = { 4: 'year', 7: 'month', 10: 'day' };

/** A real calendar day: 2019-02-30 is not one. */
function isCalendarDay(day: string): boolean {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, date)).getUTCDate() === date;
}

/** The sheet's draft for a YYYY / YYYY-MM / YYYY-MM-DD, or undefined when it is not a real date in range. */
function draftOf(to: string): SheetDraft | undefined {
  const period = PERIOD_OF_LENGTH[to.length];
  if (!period || (period === 'day' && !isCalendarDay(to))) return undefined;
  return draftFromToolArgs(period, to);
}

const ARGS_SCHEMA: z.ZodType<TravelArgs> = z
  .object({
    to: z.string().regex(TO, 'to must be "today", YYYY, YYYY-MM or YYYY-MM-DD').describe('"today", or YYYY, YYYY-MM or YYYY-MM-DD.'),
    place: z.string().min(2).max(80).nullable()
      .describe('A city as the user said it, e.g. "Pune", or "trip" / "home". null keeps this thread\'s place.'),
  })
  .strict()
  .superRefine((args, ctx) => {
    if (args.to === 'today') {
      // Today is where the user lives now: "home" says nothing more, any other place is refused.
      if (args.place !== null && args.place.trim().toLowerCase() !== 'home') ctx.addIssue({ code: 'custom', message: 'to "today" takes no place: send place null', path: ['place'] });
      return;
    }
    if (TO.test(args.to) && !draftOf(args.to)) ctx.addIssue({ code: 'custom', message: DATE_ERROR, path: ['to'] });
  });

/**
 * A trip with no place of its own (no city named, no trip to stay on): every trip needs a place and
 * none is assumed (071faf4f), not even where the user lives now, which may not be where they lived then.
 */
export const TRAVEL_NEEDS_PLACE: ReadPeriodAsk = { status: 'needs_place', ask: 'Ask where the user lived (or will be) then.' };

/** "home" said outright is the current place; no place (or "trip") is only this thread's own trip place. */
function travelPlaces(input: TravelToolInput, place: string | null): PlaceResolverInput {
  const keyword = place?.trim().toLowerCase();
  return keyword === 'home' ? input : { ...input, homePlace: undefined };
}

/** A place a trip can pin: it needs coordinates (a looked-up city or the trip's own pin). */
function pinnable(where: PlaceOutcome): ChatThreadAsOf['place'] {
  if (where.kind !== 'place') return undefined;
  const { label, timezone, latitude, longitude } = where.place;
  return latitude === undefined || longitude === undefined ? undefined : { label, timezone, latitude, longitude };
}

/** The validated trip; the schema already refused a bad date, so a failure here is a broken input, thrown. */
function tripAsOf(draft: SheetDraft | undefined, place: ChatThreadAsOf['place']): ChatThreadAsOf {
  const asOf = draft ? periodAsOfFromDraft({ ...draft, ...(place ? { place } : {}) }) : undefined;
  if (!asOf || chatAsOfProblem(asOf)) throw new Error(DATE_ERROR);
  return asOf;
}

function queued(asOf: ChatThreadAsOf, language: string): TravelQueued {
  const place = asOf.place ? { place_label: asOf.place.label, time_zone: asOf.place.timezone } : {};
  return { status: 'queued', action: 'travel', period_label: formatPinLabel(asOf, language), ...place };
}

async function travelTo(input: TravelToolInput, args: TravelArgs, context: ToolContext): Promise<TravelResult> {
  context.signal.throwIfAborted();
  if (args.to === 'today') {
    input.record({ kind: 'back_to_today' });
    return { status: 'queued', action: 'back_to_today' };
  }
  const draft = draftOf(args.to);
  if (input.birthYear !== undefined && Number(args.to.slice(0, 4)) < input.birthYear) return OUTSIDE_RANGE;
  const where = await resolveChatPlace(args.place, travelPlaces(input, args.place), context.signal);
  if (where.kind === 'ask') return where.result;
  const place = pinnable(where);
  if (!place) return draft?.granularity === 'day' ? NEEDS_PLACE : TRAVEL_NEEDS_PLACE;
  const asOf = tripAsOf(draft, place);
  context.signal.throwIfAborted();
  input.record({ kind: 'travel', asOf });
  return queued(asOf, input.language);
}

/** "May 2019" for a trip, in the page's language; null for "back to today". */
export function travelPeriodLabel(args: Pick<TravelArgs, 'to'>, language: string): string | null {
  const draft = args.to === 'today' ? undefined : draftOf(args.to);
  return draft ? formatPinLabel({ start: draft.day, granularity: draft.granularity }, language) : null;
}

/** "Moving to May 2019…" / "Back to today…": the English status line for one call. */
export function travelStatusLabel(args: Pick<TravelArgs, 'to'>, language: string): string {
  const period = travelPeriodLabel(args, language);
  return period === null ? 'Back to today…' : `Moving to ${period}…`;
}

function isQueuedReturn(result: unknown): boolean {
  const queued = result as Partial<TravelQueued> | null | undefined;
  return queued?.status === 'queued' && queued.action === 'back_to_today';
}

/** A second move in one turn: neutral, never an error row (the loop also stops offering travel). */
export const ALREADY_TRAVELLED_NOTE = 'Already travelled this turn; the move happens after your answer.';
const ALREADY_TRAVELLED = { status: 'skipped', note: ALREADY_TRAVELLED_NOTE } as const;

/** One tool per turn (chatTurn.ts builds it per turn): after one queued move, later calls move nothing. */
export function createTravelTool(input: TravelToolInput): ToolDef<TravelArgs> {
  let moved = false;
  const record: TravelRecorder = (action) => {
    moved = true;
    input.record(action);
  };
  return defineTool({
    name: TRAVEL_TOOL_NAME,
    description: DESCRIPTION,
    input: ARGS_SCHEMA,
    // A named city may open the picker; its wait is read_period's.
    timeoutMs: READ_PERIOD_TIMEOUT_MS,
    statusLabel: TIME_TRAVEL_STATUS_LABEL,
    overLimitNote: ALREADY_TRAVELLED_NOTE,
    // A trip turn reads before it answers; going back to today leaves nothing to read, only a confirmation.
    unlocksAnswer: isQueuedReturn,
    execute: async (args, context) => {
      if (!input.travelAsked) return TRAVEL_NOT_ASKED;
      return moved ? ALREADY_TRAVELLED : travelTo({ ...input, record }, args, context);
    },
  });
}
