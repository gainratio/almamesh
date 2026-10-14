/**
 * The legacy `time_travel` tool of the old toolset (chatToolset.ts). Task 6 of the chat tool layer
 * redesign deletes it with chatToolset.ts; the chat's new move is `travel` (travelTool.ts).
 */
import {
  BEFORE_BIRTH_MESSAGE, endsBeforeBirthYear, NEEDS_PLACE_ERROR, PLACE_REF_ARG_PATTERN, PLACE_REF_ERROR,
  type AgentJsonObject, type AgentTool,
} from '@almamesh/llm';
import type { ChatThreadAsOf } from '@almamesh/shared-types';
import { chatAsOfProblem } from '@almamesh/store';
import type { PlaceReader } from './timingPlaces';
import { PLACE_LOOKUP_TIMEOUT_MS } from './placeTool';
import { formatPinLabel, periodAsOfFromDraft } from './timeTravelSheet';
import { draftFromToolArgs, TIME_TRAVEL_STATUS_LABEL, TRAVEL_DATE_ERROR as DATE_ERROR, type TravelRecorder } from './travelSlot';

export const TIME_TRAVEL_TOOL_NAME = 'time_travel';
export const TIME_TRAVEL_DATE_PATTERN = '^\\d{4}(-\\d{2}(-\\d{2})?)?$';
const PERIODS = ['day', 'month', 'year'] as const;
const PLACE_PATTERN = new RegExp(PLACE_REF_ARG_PATTERN);

export interface TimeTravelToolInput {
  readonly birthYear: number | undefined;
  readonly placeFromRef: PlaceReader;
  readonly language: string;
  readonly record: TravelRecorder;
  /** The trip the user is on: a Month/Year move with no place_ref keeps it (every trip has a place). */
  readonly currentPlace?: ChatThreadAsOf['place'];
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
  let place: ChatThreadAsOf['place'] = period === 'day' ? undefined : input.currentPlace;
  if (args.place_ref !== undefined) {
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
    description: 'Move the conversation and Dashboard when the user asks to go to a day, month or year. Use action travel with period and date. A day needs place_ref from resolve_place; a month or year keeps the current trip place unless you pass place_ref. For "back to today", "return to now" or "today again", use action back_to_today with no other arguments. The move is queued and applied after this answer is saved; subsequent messages use that moment. To read a period without moving, use get_timing.',
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
