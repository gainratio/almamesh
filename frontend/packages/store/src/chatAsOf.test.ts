import { describe, expect, it } from 'vitest';

import { chatAsOfProblem, isChatThreadAsOf } from './chatAsOf';

const BOGOTA = { label: 'Bogotá, Colombia', timezone: 'America/Bogota', latitude: 4.711, longitude: -74.0721 };
const YEAR = { start: '2027-01-01', end: '2027-12-31', granularity: 'year' } as const;
const MONTH = { start: '2026-06-01', end: '2026-06-30', granularity: 'month' } as const;
const DAY = { start: '2026-06-15', end: '2026-06-15', granularity: 'day', place: BOGOTA } as const;

describe('chatAsOfProblem', () => {
  it.each([
    ['a Year pin', YEAR],
    ['a Month pin', MONTH],
    ['a leap February', { start: '2028-02-01', end: '2028-02-29', granularity: 'month' }],
    ['a Day pin with a place', DAY],
    ['the first year', { start: '1900-01-01', end: '1900-12-31', granularity: 'year' }],
    ['the last year', { start: '2099-01-01', end: '2099-12-31', granularity: 'year' }],
  ])('accepts %s', (_label, value) => {
    expect(chatAsOfProblem(value)).toBeUndefined();
    expect(isChatThreadAsOf(value)).toBe(true);
  });

  it.each([
    ['not an object', 'June 2026', 'as_of'],
    ['an array', [], 'as_of'],
    ['an extra key', { ...YEAR, birth_place: 'Delhi' }, 'as_of'],
    ['a non-day start', { ...YEAR, start: '2027-1-1' }, 'as_of.start'],
    ['an impossible day', { ...DAY, start: '2026-02-30', end: '2026-02-30' }, 'as_of.start'],
    ['a year before 1900', { start: '1899-01-01', end: '1899-12-31', granularity: 'year' }, 'as_of.start'],
    ['a year after 2099', { start: '2100-01-01', end: '2100-12-31', granularity: 'year' }, 'as_of.start'],
    ['an unknown granularity', { ...MONTH, granularity: 'week' }, 'as_of.granularity'],
    ['a month not starting on the 1st', { ...MONTH, start: '2026-06-02' }, 'as_of.start'],
    ['a month ending early', { ...MONTH, end: '2026-06-29' }, 'as_of.end'],
    ['a non-leap 29 February', { start: '2027-02-01', end: '2027-02-29', granularity: 'month' }, 'as_of.end'],
    ['a year ending early', { ...YEAR, end: '2027-12-30' }, 'as_of.end'],
    ['a day spanning two days', { ...DAY, end: '2026-06-16' }, 'as_of.end'],
    ['a Day pin with no place', { start: '2026-06-15', end: '2026-06-15', granularity: 'day' }, 'as_of.place'],
    ['a Month pin with a place', { ...MONTH, place: BOGOTA }, 'as_of.place'],
    ['a place with an extra key', { ...DAY, place: { ...BOGOTA, altitude: 2640 } }, 'as_of.place'],
    ['an empty label', { ...DAY, place: { ...BOGOTA, label: '' } }, 'as_of.place.label'],
    ['a long label', { ...DAY, place: { ...BOGOTA, label: 'x'.repeat(121) } }, 'as_of.place.label'],
    ['an empty zone', { ...DAY, place: { ...BOGOTA, timezone: '' } }, 'as_of.place.timezone'],
    ['a bad zone', { ...DAY, place: { ...BOGOTA, timezone: 'Mars/Olympus' } }, 'as_of.place.timezone'],
    ['latitude 91', { ...DAY, place: { ...BOGOTA, latitude: 91 } }, 'as_of.place.latitude'],
    ['a string latitude', { ...DAY, place: { ...BOGOTA, latitude: '4.7' } }, 'as_of.place.latitude'],
    ['longitude -181', { ...DAY, place: { ...BOGOTA, longitude: -181 } }, 'as_of.place.longitude'],
    ['a NaN longitude', { ...DAY, place: { ...BOGOTA, longitude: Number.NaN } }, 'as_of.place.longitude'],
  ])('refuses %s, naming the field', (_label, value, field) => {
    expect(chatAsOfProblem(value)).toBe(field);
    expect(isChatThreadAsOf(value)).toBe(false);
  });
});
