/**
 * The sheet's pure parts (spec Part 3, "The button and the sheet"): defaults,
 * draft → pin, the year range, and the period label (Intl in the UI language).
 * Calendar strings only; no astrology, no clock reads.
 */
import type { ChatThreadAsOf } from '@almamesh/shared-types';

export type PinGranularity = ChatThreadAsOf['granularity'];

export interface SheetDraft {
  readonly granularity: PinGranularity;
  readonly day: string;
  readonly month: string;
  readonly year: number;
  readonly place?: ChatThreadAsOf['place'];
}

/** The ephemeris ends in 2052 (step A); the sheet offers nothing later. */
export const SHEET_LAST_YEAR = 2052;
const SHEET_FIRST_YEAR = 1900;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function sheetYears(birthYear?: number): number[] {
  const first = Math.max(SHEET_FIRST_YEAR, birthYear ?? SHEET_FIRST_YEAR);
  return Array.from({ length: SHEET_LAST_YEAR - first + 1 }, (_, index) => first + index);
}

export function sheetDefaults(today: string, current: ChatThreadAsOf | undefined, dayAllowed: boolean): SheetDraft {
  const anchor = current?.start ?? today;
  const base = { day: anchor, month: anchor.slice(0, 7), year: Number(anchor.slice(0, 4)) };
  if (!current) return { granularity: 'month', ...base };
  if (current.granularity === 'day' && !dayAllowed) return { granularity: 'month', ...base };
  return { granularity: current.granularity, ...base, ...(current.place ? { place: current.place } : {}) };
}

function lastDayOf(month: string): string {
  const [year, monthIndex] = month.split('-').map(Number);
  return new Date(Date.UTC(year, monthIndex, 0)).toISOString().slice(0, 10);
}

/** A real calendar day inside the sheet's years (1900..2052): '' and '2026-02-30' are not (toISOString throws on an invalid Date). */
function isRealDay(value: string): boolean {
  if (!DAY.test(value)) return false;
  const year = Number(value.slice(0, 4));
  if (year < SHEET_FIRST_YEAR || year > SHEET_LAST_YEAR) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === value;
}

/** The draft's calendar range, whether or not a Day draft has its place yet. */
export function rangeOfDraft(draft: SheetDraft): { readonly start: string; readonly end: string } | undefined {
  if (draft.granularity === 'year') return { start: `${draft.year}-01-01`, end: `${draft.year}-12-31` };
  if (draft.granularity === 'month') return { start: `${draft.month}-01`, end: lastDayOf(draft.month) };
  return isRealDay(draft.day) ? { start: draft.day, end: draft.day } : undefined;
}

export function asOfFromDraft(draft: SheetDraft): ChatThreadAsOf | undefined {
  const range = rangeOfDraft(draft);
  if (!range) return undefined;
  if (draft.granularity !== 'day') return { ...range, granularity: draft.granularity };
  return draft.place ? { ...range, granularity: 'day', place: draft.place } : undefined;
}

const LABEL_FORMAT: Readonly<Record<PinGranularity, Intl.DateTimeFormatOptions>> = {
  year: { year: 'numeric', timeZone: 'UTC' },
  month: { month: 'long', year: 'numeric', timeZone: 'UTC' },
  day: { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' },
};

export function formatPinLabel(asOf: Pick<ChatThreadAsOf, 'start' | 'granularity'>, language: string): string {
  // Noon UTC so no zone shifts the calendar day.
  return new Intl.DateTimeFormat(language, LABEL_FORMAT[asOf.granularity]).format(new Date(`${asOf.start}T12:00:00Z`));
}
