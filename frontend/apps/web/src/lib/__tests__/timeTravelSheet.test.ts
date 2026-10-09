import { describe, expect, it } from 'vitest';

import { asOfFromDraft, formatPinLabel, sheetDefaults, sheetYears, SHEET_LAST_YEAR } from '../timeTravelSheet';

const BOGOTA = { label: 'Bogotá, Colombia', timezone: 'America/Bogota', latitude: 4.711, longitude: -74.0721 };

describe('timeTravelSheet', () => {
  it('defaults to Month and the current month, with no place', () => {
    expect(sheetDefaults('2026-10-09', undefined, true)).toEqual({
      granularity: 'month', day: '2026-10-09', month: '2026-10', year: 2026,
    });
  });

  it('prefills Change from the current pin, and falls back to Month for a Day pin on a weak device', () => {
    const day = { start: '2026-06-15', end: '2026-06-15', granularity: 'day', place: BOGOTA } as const;
    expect(sheetDefaults('2026-10-09', day, true)).toEqual({
      granularity: 'day', day: '2026-06-15', month: '2026-06', year: 2026, place: BOGOTA,
    });
    expect(sheetDefaults('2026-10-09', day, false)).toEqual({
      granularity: 'month', day: '2026-06-15', month: '2026-06', year: 2026,
    });
  });

  it('prefills Change from a Month pin, which carries no place', () => {
    const june = { start: '2026-06-01', end: '2026-06-30', granularity: 'month' } as const;
    expect(sheetDefaults('2026-10-09', june, true)).toEqual({ granularity: 'month', day: '2026-06-01', month: '2026-06', year: 2026 });
  });

  it('turns a draft into a pin', () => {
    const draft = { day: '2026-06-15', month: '2028-02', year: 2027 };
    expect(asOfFromDraft({ ...draft, granularity: 'year' })).toEqual({ start: '2027-01-01', end: '2027-12-31', granularity: 'year' });
    expect(asOfFromDraft({ ...draft, granularity: 'month' })).toEqual({ start: '2028-02-01', end: '2028-02-29', granularity: 'month' });
    expect(asOfFromDraft({ ...draft, month: '2026-12', granularity: 'month' })).toEqual({ start: '2026-12-01', end: '2026-12-31', granularity: 'month' });
    expect(asOfFromDraft({ ...draft, granularity: 'day', place: BOGOTA })).toEqual({
      start: '2026-06-15', end: '2026-06-15', granularity: 'day', place: BOGOTA,
    });
  });

  it('never makes a Day pin without a place or a real day', () => {
    expect(asOfFromDraft({ granularity: 'day', day: '2026-06-15', month: '2026-06', year: 2026 })).toBeUndefined();
    expect(asOfFromDraft({ granularity: 'day', day: '1899-12-31', month: '2026-06', year: 2026, place: BOGOTA })).toBeUndefined();
    expect(asOfFromDraft({ granularity: 'day', day: '2053-01-01', month: '2026-06', year: 2026, place: BOGOTA })).toBeUndefined();
    expect(asOfFromDraft({ granularity: 'day', day: '2026-13-45', month: '2026-06', year: 2026, place: BOGOTA })).toBeUndefined();
    expect(asOfFromDraft({ granularity: 'day', day: '', month: '2026-06', year: 2026, place: BOGOTA })).toBeUndefined();
  });

  it('offers years from the birth year (or 1900) to 2052', () => {
    expect(SHEET_LAST_YEAR).toBe(2052);
    expect(sheetYears(1990)[0]).toBe(1990);
    expect(sheetYears(1990).at(-1)).toBe(2052);
    expect(sheetYears(undefined)[0]).toBe(1900);
  });

  it('labels a pin in the UI language with Intl, never by hand', () => {
    expect(formatPinLabel({ start: '2027-01-01', granularity: 'year' }, 'en')).toBe('2027');
    expect(formatPinLabel({ start: '2026-06-01', granularity: 'month' }, 'en')).toBe('June 2026');
    expect(formatPinLabel({ start: '2026-06-01', granularity: 'month' }, 'es')).toBe('junio de 2026');
    expect(formatPinLabel({ start: '2026-06-01', granularity: 'month' }, 'pt')).toBe('junho de 2026');
    expect(formatPinLabel({ start: '2026-06-15', granularity: 'day' }, 'en')).toBe(
      new Intl.DateTimeFormat('en', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
        new Date('2026-06-15T12:00:00Z'),
      ),
    );
  });
});
