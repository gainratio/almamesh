/**
 * A chat turn's time-travel move: a tool records it during the turn and the chat hook
 * (useChatThread.ts) applies it after the answer is saved. Kept free of the AI seam so the
 * eager chat hook does not pull the tool loop into the first chunk.
 */
import type { ChatThreadAsOf } from '@almamesh/shared-types';
import { SHEET_LAST_YEAR, type SheetDraft } from './timeTravelSheet';

export const TIME_TRAVEL_STATUS_LABEL = 'Preparing time travel';
export const TRAVEL_DATE_ERROR = `Use a real date from 1900 through ${SHEET_LAST_YEAR}: YYYY-MM-DD for a day, YYYY-MM for a month, YYYY for a year.`;
export type TravelAction = { readonly kind: 'travel'; readonly asOf: ChatThreadAsOf } | { readonly kind: 'back_to_today' };
export type TravelRecorder = (action: TravelAction) => void;
export interface TravelSlot { readonly record: TravelRecorder; take(): TravelAction | undefined; }
const DATE_FOR = { day: /^\d{4}-\d{2}-\d{2}$/, month: /^\d{4}-\d{2}$/, year: /^\d{4}$/ } as const;

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
