/** Records a per-turn move. The chat hook applies it after the answer is saved. */
import {
  BEFORE_BIRTH_MESSAGE, endsBeforeBirthYear, NEEDS_PLACE_ERROR, PLACE_REF_ARG_PATTERN, PLACE_REF_ERROR,
  type AgentJsonObject, type AgentTool,
} from '@almamesh/llm';
import type { ChatThreadAsOf } from '@almamesh/shared-types';
import { chatAsOfProblem } from '@almamesh/store';
import type { PlaceReader } from './timingPlaces';
import { PLACE_LOOKUP_TIMEOUT_MS } from './placeTool';
import { formatPinLabel, periodAsOfFromDraft, SHEET_LAST_YEAR, type SheetDraft } from './timeTravelSheet';

export const TIME_TRAVEL_TOOL_NAME = 'time_travel';
export const TIME_TRAVEL_STATUS_LABEL = 'Preparing time travel';
export const TIME_TRAVEL_DATE_PATTERN = '^\\d{4}(-\\d{2}(-\\d{2})?)?$';
export type TravelAction = { readonly kind: 'travel'; readonly asOf: ChatThreadAsOf } | { readonly kind: 'back_to_today' };
export type TravelRecorder = (action: TravelAction) => void;
export interface TravelSlot { readonly record: TravelRecorder; take(): TravelAction | undefined; }
const DATE_FOR = { day: /^\d{4}-\d{2}-\d{2}$/, month: /^\d{4}-\d{2}$/, year: /^\d{4}$/ } as const;
const PERIODS = ['day', 'month', 'year'] as const;
const PLACE_PATTERN = new RegExp(PLACE_REF_ARG_PATTERN);
const DATE_ERROR = `Use a real date from 1900 through ${SHEET_LAST_YEAR}: YYYY-MM-DD for a day, YYYY-MM for a month, YYYY for a year.`;

export function createTravelSlot(): TravelSlot {
  let pending: TravelAction | undefined;
  return {
    record: (action) => { pending = action.kind === 'travel' ? { kind: 'travel', asOf: structuredClone(action.asOf) } : { kind: 'back_to_today' }; },
    take: () => { const value = pending; pending = undefined; return value; },
  };
}

export function draftFromToolArgs(period: 'day' | 'month' | 'year', date: string, place?: ChatThreadAsOf['place']): SheetDraft | undefined {
  if (!DATE_FOR[period].test(date)) return undefined;
  const year = Number(date.slice(0, 4));
  if (year < 1900 || year > SHEET_LAST_YEAR) return undefined;
  if (period !== 'year' && (Number(date.slice(5, 7)) < 1 || Number(date.slice(5, 7)) > 12)) return undefined;
  if (period === 'year') return { granularity: 'year', day: `${date}-01-01`, month: `${date}-01`, year };
  if (period === 'month') return { granularity: 'month', day: `${date}-01`, month: date, year };
  return { granularity: 'day', day: date, month: date.slice(0, 7), year, ...(place ? { place } : {}) };
}

export interface TimeTravelToolInput {
  readonly birthYear: number | undefined;
  readonly placeFromRef: PlaceReader;
  readonly language: string;
  readonly record: TravelRecorder;
}

async function travel(input: TimeTravelToolInput, args: AgentJsonObject, signal: AbortSignal): Promise<AgentJsonObject> {
  signal.throwIfAborted();
  if (Object.keys(args).some((key) => !['action', 'period', 'date', 'place_ref'].includes(key))) return { error: 'Unknown time travel argument.' };
  if (args.action === 'back_to_today') {
    if (args.period !== undefined || args.date !== undefined || args.place_ref !== undefined) return { error: 'Back to today takes no date or place.' };
    input.record({ kind: 'back_to_today' });
    return { status: 'queued', action: 'back_to_today' };
  }
  if (args.action !== 'travel') return { error: 'action must be travel or back_to_today' };
  const period = PERIODS.find((value) => value === args.period);
  if (!period || typeof args.date !== 'string') return { error: DATE_ERROR };
  // Reject invalid ranges before a possibly cold place lookup.
  const base = draftFromToolArgs(period, args.date);
  if (!base) return { error: DATE_ERROR };
  if (period === 'day' && args.place_ref === undefined) return { error: NEEDS_PLACE_ERROR };
  let place: ChatThreadAsOf['place'];
  if (args.place_ref !== undefined) {
    if (period !== 'day') return { error: 'Only a day needs a place.' };
    if (typeof args.place_ref !== 'string' || !/^city:\d{1,6}$/.test(args.place_ref) || !PLACE_PATTERN.test(args.place_ref)) return { error: PLACE_REF_ERROR };
    const found = await input.placeFromRef(args.place_ref);
    signal.throwIfAborted();
    if (!found) return { error: PLACE_REF_ERROR };
    place = { label: found.summary.label, timezone: found.summary.timezone, latitude: found.latitude, longitude: found.longitude };
  }
  const asOf = periodAsOfFromDraft({ ...base, ...(place ? { place } : {}) });
  if (!asOf || chatAsOfProblem(asOf)) return { error: DATE_ERROR };
  if (endsBeforeBirthYear(asOf, input.birthYear)) return { error: BEFORE_BIRTH_MESSAGE };
  signal.throwIfAborted();
  input.record({ kind: 'travel', asOf });
  return {
    status: 'queued', action: 'travel', period_label: formatPinLabel(asOf, input.language),
    ...(asOf.place ? { place_label: asOf.place.label, time_zone: asOf.place.timezone } : {}),
  };
}

export function createTimeTravelTool(input: TimeTravelToolInput): AgentTool {
  return {
    name: TIME_TRAVEL_TOOL_NAME,
    description: 'Move the conversation and Dashboard when the user asks to go to a day, month or year. Use action travel with period and date. A day needs place_ref from resolve_place. For "back to today", "return to now" or "today again", use action back_to_today with no other arguments. The move is queued and applied after this answer is saved; subsequent messages use that moment. To read a period without moving, use get_timing.',
    statusLabel: TIME_TRAVEL_STATUS_LABEL,
    timeoutMs: PLACE_LOOKUP_TIMEOUT_MS,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['travel', 'back_to_today'] },
        period: { type: 'string', enum: [...PERIODS] },
        date: { type: 'string', pattern: TIME_TRAVEL_DATE_PATTERN },
        place_ref: { type: 'string', pattern: '^city:\\d{1,6}$' },
      },
      required: ['action'], additionalProperties: false,
    },
    execute: (args, context) => travel(input, args, context.signal),
  };
}
