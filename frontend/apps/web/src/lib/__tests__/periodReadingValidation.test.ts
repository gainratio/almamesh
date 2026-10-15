import { describe, expect, it } from 'vitest';

import { isCachedNatalLords, isCachedPeriodReading } from '../periodSkyValidation';
import { periodReadingFixture } from './periodReadingFixtures';

const seed = periodReadingFixture('delhi-2019-year');

function changed(path: string, value: unknown, remove = false): unknown {
  const copy = structuredClone(seed) as unknown as Record<string, unknown>;
  const parts = path.split('.');
  let parent = copy;
  for (const part of parts.slice(0, -1)) parent = parent[part] as Record<string, unknown>;
  const key = parts.at(-1)!;
  if (remove) delete parent[key];
  else parent[key] = value;
  return copy;
}

const REQUIRED = [
  'window', 'window.start', 'window.end',
  'dasha_spans', ...['level', 'lord', 'start', 'end'].map((field) => `dasha_spans.0.${field}`),
  'segments', ...['start', 'end', 'maha', 'antar', 'pratyantar', 'events'].map((field) => `segments.0.${field}`),
  'sky', ...['graha', 'start', 'end', 'sign', 'retro', 'from_moon', 'from_lagna', 'sav', 'bav', 'tags'].map((field) => `sky.0.${field}`),
  'transit_lords', 'double_transit',
  'themes', ...['domain', 'houses', 'direction', 'strength', 'strength_pct', 'confidence', 'agreement', 'factors', 'windows']
    .map((field) => `themes.0.${field}`),
  ...['date', 'descriptor', 'severity'].map((field) => `themes.0.windows.0.${field}`),
  'rules',
];

describe('period reading cache validation', () => {
  it('accepts the fixture reading, with or without its natal lords (a stored period row has none)', () => {
    expect(isCachedPeriodReading(seed)).toBe(true);
    const { natal_lords: _lords, ...slice } = seed;
    expect(isCachedPeriodReading(slice)).toBe(true);
    expect(isCachedNatalLords(seed.natal_lords)).toBe(true);
  });

  it.each(['delhi-2019-year', 'delhi-2019-05', 'delhi-2027-01', 'delhi-2019-09-15-day'] as const)('accepts the backend golden %s, Rahu and Ketu with a null BAV', (name) => {
    const reading = periodReadingFixture(name);
    expect(reading.sky.some((span) => span.bav === null)).toBe(true);
    expect(isCachedPeriodReading(reading)).toBe(true);
    expect(isCachedPeriodReading(changed('sky.0.bav', 9))).toBe(false);
  });

  it('accepts the optional reference-day parts as null or absent', () => {
    expect(isCachedPeriodReading(periodReadingFixture('delhi-2019-09-15-day'))).toBe(true);
    for (const key of ['sookshma', 'sandhi', 'yogini', 'panchang']) {
      expect(isCachedPeriodReading(changed(key, null)), key).toBe(true);
      expect(isCachedPeriodReading(changed(key, undefined, true)), key).toBe(true);
    }
  });

  it.each(REQUIRED)('rejects a reading missing %s', (path) => {
    expect(isCachedPeriodReading(changed(path, undefined, true))).toBe(false);
  });

  it.each([
    ['dasha_spans.0.level', 'sookshma'],
    ['dasha_spans.0.start', 'not a date'],
    ['segments.0.events', 'saturn.station.direct'],
    ['sky.0.from_moon', 13],
    ['themes.0.direction', 'great'],
    ['themes.0.confidence', 'certain'],
    ['themes.0.windows.0.severity', 'mild'],
    ['themes.0.factors', [7]],
    ['double_transit', [0]],
    ['sandhi', { level: 'pratyantar', date: '2019-11-14' }],
    ['transit_lords', { venus: { sign: 'aries' } }],
  ])('rejects a malformed %s', (path, value) => {
    expect(isCachedPeriodReading(changed(path, value))).toBe(false);
  });

  it('rejects malformed natal lords', () => {
    expect(isCachedNatalLords([])).toBe(false);
    expect(isCachedNatalLords({ saturn: { ...seed.natal_lords.saturn, house: 0 } })).toBe(false);
    expect(isCachedNatalLords({ saturn: { ...seed.natal_lords.saturn, functional: 'lucky' } })).toBe(false);
    expect(isCachedNatalLords({ saturn: { ...seed.natal_lords.saturn, rules: [13] } })).toBe(false);
  });
});

// Spec 2026-10-15: the classical dasha fields are optional (a row cached by an older engine has
// none) but, when present, typed: a corrupted row must not reach the chat tools.
describe('period reading cache validation: classical dasha fields', () => {
  it('accepts a row with none of them (cached by an older engine)', () => {
    for (const key of ['yogini_antar', 'dasha_spans.1.from_parent', 'dasha_spans.1.relation', 'themes.0.dasha', 'natal_lords.sun.strength']) {
      expect(isCachedPeriodReading(changed(key, undefined, true)), key).toBe(true);
    }
  });

  it.each([
    ['dasha_spans.1.relation', 'great'],
    ['dasha_spans.1.from_parent', 13],
    ['sookshma.relation', 'friendly'],
    ['yogini_antar', { lord: 'rahu' }],
    ['themes.0.dasha', { vimshottari: 101, yogini: 0, tone: null }],
    ['themes.0.dasha', { vimshottari: 50, yogini: 0, tone: 'great' }],
    ['natal_lords.sun.strength', 'mighty'],
  ])('rejects %s = %j', (path, value) => {
    expect(isCachedPeriodReading(changed(path, value))).toBe(false);
  });
});
