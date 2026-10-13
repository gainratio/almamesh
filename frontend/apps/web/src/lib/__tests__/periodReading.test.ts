/** The period reading built from the backend goldens (testdata/period-reading, DELHI_BIRTH). */
import { describe, expect, it } from 'vitest';

import {
  buildPeriodDetail,
  buildPeriodReading,
  MAX_PERIOD_RESULT_BYTES,
  periodDetailSummary,
  periodReadingSummary,
  type ReadingFrame,
} from '../periodReading';
import { DELHI_BIRTH_LEAKS, periodReadingFixture, type PeriodReadingFixture } from './periodReadingFixtures';

const SINGAPORE = { label: 'Singapore', timezone: 'Asia/Singapore' };
const FRAMES: Record<PeriodReadingFixture, ReadingFrame> = {
  'delhi-2019-year': { period: { start: '2019-01-01', end: '2019-12-31', granularity: 'year', label: '2019', tense: 'past' }, place: SINGAPORE },
  'delhi-2019-05': { period: { start: '2019-05-01', end: '2019-05-31', granularity: 'month', label: 'May 2019', tense: 'past' }, place: SINGAPORE },
  'delhi-2027-01': { period: { start: '2027-01-01', end: '2027-01-31', granularity: 'month', label: 'January 2027', tense: 'future' }, place: { label: 'San Francisco', timezone: 'America/Los_Angeles' } },
  'delhi-2019-09-15-day': { period: { start: '2019-09-15', end: '2019-09-15', granularity: 'day', label: '15 September 2019', tense: 'past' }, place: SINGAPORE },
};
const NAMES = Object.keys(FRAMES) as PeriodReadingFixture[];
const reading = (name: PeriodReadingFixture) => buildPeriodReading(periodReadingFixture(name), FRAMES[name]);
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
const YEAR = periodReadingFixture('delhi-2019-year');
const YEAR_FRAME = FRAMES['delhi-2019-year'];
const within = (start: string, end: string, granularity: 'day' | 'month' | 'year' = 'month'): ReadingFrame =>
  ({ ...YEAR_FRAME, period: { ...YEAR_FRAME.period, start, end, granularity } });
const STRENGTH = {
  sunrise_utc_iso: '1990-01-15T01:40:00Z',
  ashtakavarga: {
    bhinna: { saturn: { planet: 'saturn', bindus: { aries: 3, taurus: 5, sagittarius: 1 }, total: 39 } },
    sarva: { bindus: { aries: 28, taurus: 31, sagittarius: 21 }, total: 337 },
  },
  shadbala: { planets: {} },
};

describe('the period reading (get_period_reading)', () => {
  it('echoes the period and place it is bound to', () => {
    const result = reading('delhi-2019-05');
    expect(result.period).toEqual(FRAMES['delhi-2019-05'].period);
    expect(result.place).toEqual(SINGAPORE);
  });

  it('May 2019: one maha, antar and pratyantar, and the Yogini maha clipped to the month', () => {
    const { dashas } = reading('delhi-2019-05');
    expect(dashas.maha).toEqual([{ lord: 'rahu', start: '2019-05-01', end: '2019-05-31' }]);
    expect(dashas.antar).toEqual([{ lord: 'rahu', start: '2019-05-01', end: '2019-05-31' }]);
    expect(dashas.pratyantar).toEqual([{ lord: 'venus', start: '2019-05-01', end: '2019-05-31' }]);
    // The engine's Yogini span runs 2016-05-03 – 2021-05-03: never sent unclipped.
    expect(dashas.yogini_maha).toEqual({ name: 'bhadrika', lord: 'mercury', start: '2019-05-01', end: '2019-05-31' });
    expect(dashas.sandhi).toBeUndefined();
    // The engine computes a sookshma for the reference day; only a Day reading carries it.
    expect(dashas.sookshma).toBeUndefined();
  });

  it("May 2019 (the production 12-month run, bounded to May): names only May's running lords", () => {
    const result = reading('delhi-2019-05');
    const running = new Set(['rahu', 'venus', 'mercury']); // maha + antar Rahu, pratyantar Venus, Yogini Mercury
    const named = [
      ...result.lords.map((lord) => lord.lord),
      ...result.segments.flatMap((segment) => [segment.maha, segment.antar, segment.pratyantar]),
      ...result.themes.flatMap((theme) => theme.factors.flatMap((factor) => [...factor.matchAll(/\b([A-Z][a-z]+) \((?:maha|antar|pratyantar)\)/g)].map((match) => match[1]!.toLowerCase()))),
    ];
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((lord) => !running.has(lord))).toEqual([]);
    expect(JSON.stringify(result)).not.toMatch(/(Jupiter|Sun) \((antar|pratyantar)\)/);
  });

  it('joins the natal lords for the running lords only, with their levels, lordships and gochara', () => {
    const { lords } = reading('delhi-2019-05');
    expect(lords.map((lord) => [lord.lord, lord.level])).toEqual([['rahu', ['maha', 'antar']], ['venus', ['pratyantar']]]);
    expect(lords[1]).toEqual({
      lord: 'venus', level: ['pratyantar'], rules: [5, 12],
      natal: { house: 8, sign: 'capricorn', dignity: 'neutral', combust: true },
      functional: 'benefic', d9_sign: 'pisces', d10_sign: 'scorpio', yogas: ['Vipareeta Raja Yoga'],
      transit: { sign: 'pisces', from_moon: 8, from_lagna: 10, sav: 27, bav: 5, retro: false },
    });
    expect(lords[0]?.transit?.bav).toBeNull();
  });

  it('a running lord with no natal row still names its level, and invents nothing', () => {
    const source = periodReadingFixture('delhi-2019-05');
    const { venus: _venus, ...natal } = source.natal_lords;
    const { transit_lords: { venus: _transit, ...transit } } = source;
    const lords = buildPeriodReading({ ...source, natal_lords: natal, transit_lords: transit }, FRAMES['delhi-2019-05']).lords;
    expect(lords[1]).toEqual({ lord: 'venus', level: ['pratyantar'] });
  });

  it('clips segments and the slow sky to the period', () => {
    const result = reading('delhi-2019-05');
    expect(result.segments).toEqual([{ start: '2019-05-01', end: '2019-05-31', maha: 'rahu', antar: 'rahu', pratyantar: 'venus', events: ['2019-05-07 mars.ingress.gemini'] }]);
    expect(result.sky.map((span) => [span.graha, span.start, span.end, span.sign, span.tags])).toEqual([
      ['jupiter', '2019-05-01', '2019-05-31', 'scorpio', ['jupiter_from_moon_4']],
      ['saturn', '2019-05-01', '2019-05-31', 'sagittarius', []],
      ['rahu', '2019-05-01', '2019-05-31', 'gemini', []],
      ['ketu', '2019-05-01', '2019-05-31', 'sagittarius', []],
    ]);
    const april = buildPeriodReading(YEAR, within('2019-04-01', '2019-04-30'));
    expect(april.sky.filter((span) => span.graha === 'jupiter').map((span) => [span.start, span.end]))
      .toEqual([['2019-04-01', '2019-04-10'], ['2019-04-10', '2019-04-22'], ['2019-04-22', '2019-04-30']]);
  });

  it('groups each dated window once across the themes it belongs to, only inside the period', () => {
    const domains = ['education', 'family', 'health', 'spiritual', 'career', 'relationships'];
    expect(reading('delhi-2019-year').windows).toEqual([
      { date: '2019-03-29', descriptor: 'transit.jupiter.ingress.sagittarius', severity: 'neutral', domains },
      { date: '2019-04-22', descriptor: 'transit.jupiter.ingress.scorpio', severity: 'neutral', domains },
      { date: '2019-11-05', descriptor: 'transit.jupiter.ingress.sagittarius', severity: 'neutral', domains },
    ]);
    expect(buildPeriodReading(YEAR, within('2019-04-01', '2019-04-30')).windows.map((window) => window.date)).toEqual(['2019-04-22']);
    expect(reading('delhi-2019-05').windows).toEqual([]);
  });

  it('Year 2019: every pratyantar change in the year', () => {
    const { dashas, lords } = reading('delhi-2019-year');
    expect(dashas.maha).toEqual([{ lord: 'rahu', start: '2019-01-01', end: '2019-12-31' }]);
    expect(dashas.antar.map((span) => span.lord)).toEqual(['rahu']);
    expect(dashas.pratyantar.map((span) => [span.lord, span.start])).toEqual([
      ['ketu', '2019-01-01'], ['venus', '2019-02-05'], ['sun', '2019-07-19'], ['moon', '2019-09-07'], ['mars', '2019-11-28'],
    ]);
    expect(lords.map((lord) => lord.lord)).toEqual(['rahu', 'ketu', 'venus', 'sun', 'moon', 'mars']);
    expect(lords.find((lord) => lord.lord === 'venus')).toMatchObject({ rules: [5, 12], functional: 'benefic' });
  });

  it('a Day reads the day itself: one segment, no event from another day, the sookshma and the panchang', () => {
    // Contract change (2026-10-13): the engine now bounds a Day reading to the day, so the
    // segment no longer runs to the next change point and carries no later events
    // (Saturn's 2019-09-18 station and the Mars ingress were cited for a 15 September).
    const source = periodReadingFixture('delhi-2019-09-15-day');
    const result = buildPeriodReading({ ...source, themes: source.themes.slice(0, 2) }, FRAMES['delhi-2019-09-15-day']);
    expect(result.trimmed).toBeUndefined();
    expect(result.segments).toEqual([{ start: '2019-09-15', end: '2019-09-16', maha: 'rahu', antar: 'rahu', pratyantar: 'moon', events: [] }]);
    expect(result.next_change).toBeUndefined();
    // The sookshma started 2019-09-14 and ends 2019-09-18: the day's next dasha change.
    expect(result.dashas.sookshma).toEqual({ lord: 'mars', start: '2019-09-15', end: '2019-09-18' });
    expect(result.lords.find((lord) => lord.lord === 'mars')?.level).toEqual(['sookshma']);
    expect(result.panchang).toEqual({ tithi: 16, tithi_name: 'Pratipada', paksha: 'krishna', nakshatra: 'Uttara Bhadrapada', karana: 'Kaulava', yoga: 'Ganda', vara: 'Sunday' });
    expect(reading('delhi-2019-05').panchang).toBeUndefined();
  });

  it('a Day with a later segment names that change point', () => {
    const result = buildPeriodReading({ ...YEAR, themes: [] }, within('2019-03-20', '2019-03-20', 'day'));
    expect(result.segments.map((segment) => [segment.start, segment.end])).toEqual([['2019-03-20', '2019-03-29']]);
    expect(result.next_change).toEqual({ date: '2019-03-29', maha: 'rahu', antar: 'rahu', pratyantar: 'venus', events: ['2019-03-29 jupiter.ingress.sagittarius', '2019-04-10 jupiter.station.retrograde'] });
  });

  it.each(NAMES)('%s stays under 4 KB of JSON', (name) => {
    expect(MAX_PERIOD_RESULT_BYTES).toBe(4096);
    expect(bytes(reading(name))).toBeLessThan(4096);
  });

  // 2026-10-13 P1 drive: a Month cut its dated change points first ('segment events'), so the
  // model could not say when January 2027 shifted. Change points now outrank secondary detail.
  it('keeps a Month\'s dated change points ahead of secondary detail', () => {
    const month = reading('delhi-2027-01');
    expect(month.segments.flatMap((segment) => segment.events)).toEqual(['2027-01-10 mars.station.retrograde', '2027-01-24 jupiter.ingress.cancer']);
    expect(month.trimmed ?? []).not.toContain('segment events');
    expect(month.lords.every((lord) => lord.rules !== undefined)).toBe(true);
  });

  it('cuts only what it must, cheapest first, and names each cut', () => {
    expect(reading('delhi-2019-05').trimmed).toBeUndefined();
    expect(reading('delhi-2027-01').trimmed).toEqual(['theme factors beyond 2']);
    const year = reading('delhi-2019-year');
    expect(year.trimmed?.slice(0, 2)).toEqual(['pratyantar-only lord natal detail', 'theme factors beyond 2']);
    // What the acceptance drive needs survives the Year cut: every dasha change, every window, lordships, confidence.
    expect(year.dashas.pratyantar).toHaveLength(5);
    expect(year.windows).toHaveLength(3);
    expect(year.lords.every((lord) => lord.rules !== undefined && lord.functional !== undefined)).toBe(true);
    expect(year.themes.length).toBeGreaterThanOrEqual(3);
    expect(year.themes.every((theme) => theme.factors.length > 0)).toBe(true);
  });

  it('an oversized reading is cut deterministically and still fits', () => {
    const wide = { ...YEAR, themes: [...YEAR.themes, ...YEAR.themes].map((theme) => ({ ...theme, factors: [...theme.factors, ...theme.factors] })) };
    const result = buildPeriodReading(wide, YEAR_FRAME);
    expect(bytes(result)).toBeLessThan(4096);
    expect(result.trimmed?.length).toBeGreaterThan(0);
    expect(buildPeriodReading(wide, YEAR_FRAME)).toEqual(result);
  });

  it('when even every cut is not enough, falls back to the dashas, lords and theme verdicts', () => {
    const huge = { ...YEAR, sky: Array.from({ length: 40 }, (_, index) => ({ ...YEAR.sky[0]!, graha: `g${index}` })) };
    const result = buildPeriodReading(huge, YEAR_FRAME);
    expect(bytes(result)).toBeLessThan(4096);
    expect(result).toMatchObject({ sky: [], segments: [], windows: [], trimmed: ['everything but the dashas, lords and theme verdicts'] });
    expect(result.dashas.pratyantar).toHaveLength(5);
  });

  it.each(NAMES)('%s carries no birth date, time, coordinates or datetime_utc', (name) => {
    const text = JSON.stringify(reading(name));
    for (const leak of DELHI_BIRTH_LEAKS) expect(text).not.toContain(leak);
  });

  it('copies only the fields it names: an extra engine field never reaches the model', () => {
    const source = periodReadingFixture('delhi-2019-05');
    const tainted = { ...source, birth_datetime_utc: '1990-01-15T12:00:00Z', segments: source.segments.map((segment) => ({ ...segment, latitude: 28.6139 })) };
    const text = JSON.stringify(buildPeriodReading(tainted as typeof source, FRAMES['delhi-2019-05']));
    expect(text).not.toContain('1990-01-15');
    expect(text).not.toContain('28.6139');
  });

  it('summarizes in one line plus up to 5 distinct cited factors', () => {
    expect(periodReadingSummary(reading('delhi-2019-05'))).toEqual({
      line: 'Rahu–Rahu–Venus · 6 themes',
      factors: ['Venus (pratyantar) rules the 5th', 'Venus (pratyantar) rules the 12th', 'Jupiter transits the 6th from the lagna',
        'Venus (pratyantar) is a karaka of relationships', 'Yogini Bhadrika (Mercury) is a karaka of career'],
    });
    expect(periodReadingSummary(reading('delhi-2019-year')).line).toBe('Rahu–Rahu–Ketu, 4 dasha changes · 3 themes');
    expect(periodReadingSummary(reading('delhi-2027-01')).line).toBe('Rahu–Mercury–Rahu · Ashtama Shani · 6 themes');
    expect(periodReadingSummary({ available: false, reason: 'timeout' })).toEqual({ line: 'Period reading unavailable (timeout)', factors: [] });
    expect(periodReadingSummary({ error: 'nope' })).toEqual({ line: 'Period reading failed: nope', factors: [] });
  });
});

describe('the period detail digests (get_period_detail)', () => {
  const detail = (section: string, key?: string, source = YEAR, frame = YEAR_FRAME) =>
    buildPeriodDetail({ reading: source, strength: STRENGTH }, frame, section, key);
  const DAY = periodReadingFixture('delhi-2019-09-15-day');
  const DAY_FRAME = FRAMES['delhi-2019-09-15-day'];

  it('lord: its natal and transit context, every span it runs and the factors that cite it', () => {
    expect(detail('lord', 'venus')).toMatchObject({
      section: 'lord', key: 'venus',
      facts: { lord: 'venus', rules: [5, 12], functional: 'benefic', natal: { house: 8, sign: 'capricorn', retro: true, vargottama: false },
        runs: [{ level: 'pratyantar', start: '2019-02-05', end: '2019-07-19' }], sky: [] },
      factors: ['Venus (pratyantar) rules the 5th', 'Venus (pratyantar) is a karaka of relationships'],
    });
    const jupiter = detail('lord', 'jupiter');
    if (!('facts' in jupiter)) throw new Error('expected facts');
    expect((jupiter.facts as { sky: unknown[] }).sky).toHaveLength(6);
    expect((jupiter.facts as { runs: unknown[] }).runs).toEqual([]);
    expect(jupiter.factors.length).toBeGreaterThan(0);
    expect(jupiter.factors.every((factor) => factor.includes('Jupiter'))).toBe(true);
  });

  it('segment: that segment, the sky over it and the windows inside it', () => {
    const result = detail('segment', '2019-03-29');
    expect(result).toMatchObject({
      facts: { segment: { start: '2019-03-29', end: '2019-04-22', pratyantar: 'venus', events: ['2019-03-29 jupiter.ingress.sagittarius', '2019-04-10 jupiter.station.retrograde'] } },
    });
    if (!('factors' in result)) throw new Error('expected factors');
    expect(result.factors).toContain('2019-03-29 career.transit.jupiter.ingress.sagittarius (neutral)');
    expect(result.factors.every((factor) => factor.startsWith('2019-03-29'))).toBe(true);
  });

  it('bindus: one ashtakavarga row per sign, for a graha or the SAV', () => {
    expect(detail('bindus', 'saturn')).toMatchObject({ facts: { key: 'saturn', bindus: { aries: 3, taurus: 5, sagittarius: 1 }, total: 39 } });
    const sav = detail('bindus', 'sav');
    expect(sav).toMatchObject({ facts: { key: 'sav', total: 337 } });
    if (!('factors' in sav)) throw new Error('expected factors');
    expect(sav.factors).toContain('Saturn in sagittarius: SAV 21, BAV 1');
    expect(sav.factors).toContain('Rahu in gemini: SAV 29');
  });

  it('panchang: the reference day, only for a Day period', () => {
    expect(detail('panchang', undefined, DAY, DAY_FRAME)).toMatchObject({ facts: { tithi_name: 'Pratipada', vara: 'Sunday' } });
    expect(detail('panchang')).toEqual({ error: 'panchang is computed for a single day; this period is 2019.' });
    expect(detail('panchang', undefined, { ...DAY, panchang: null }, DAY_FRAME)).toEqual({ error: 'panchang is unavailable for this day.' });
  });

  it('dashas: every span in the period, down to sookshma for a Day', () => {
    expect(detail('dashas', undefined, DAY, DAY_FRAME)).toMatchObject({ facts: { sookshma: { lord: 'mars', end: '2019-09-18' } } });
    expect(detail('dashas')).toMatchObject({ facts: { spans: expect.arrayContaining([{ level: 'pratyantar', lord: 'moon', start: '2019-09-07', end: '2019-11-28' }]) } });
  });

  it('refuses an unknown section or key with a retry hint, never a guess', () => {
    expect(detail('houses')).toEqual({ error: 'section must be one of: lord, segment, bindus, panchang, dashas' });
    expect(detail('lord', 'pluto')).toEqual({ error: 'key must be one of: sun, moon, mars, mercury, jupiter, venus, saturn, rahu, ketu' });
    expect(detail('lord')).toEqual({ error: 'key must be one of: sun, moon, mars, mercury, jupiter, venus, saturn, rahu, ketu' });
    expect(detail('segment', '2019-02-30')).toMatchObject({ error: expect.stringMatching(/^key must be a segment start date/) });
    expect(detail('bindus', 'pluto')).toMatchObject({ error: expect.stringMatching(/^key must be sav or one of/) });
    expect(detail('bindus', 'rahu')).toEqual({ error: 'no ashtakavarga row for rahu.' });
    expect(buildPeriodDetail({ reading: YEAR }, YEAR_FRAME, 'bindus', 'saturn')).toEqual({ error: 'ashtakavarga is unavailable for this chart.' });
  });

  it.each(['lord:rahu', 'lord:jupiter', 'segment:2019-01-01', 'bindus:sav', 'dashas:'])('%s stays under 4 KB and carries no birth data', (spec) => {
    const [section, key] = spec.split(':');
    const result = detail(section!, key || undefined);
    expect(bytes(result)).toBeLessThan(4096);
    for (const leak of DELHI_BIRTH_LEAKS) expect(JSON.stringify(result)).not.toContain(leak);
  });

  it('an oversized detail is halved deterministically until it fits, and says what it cut', () => {
    const many = { ...YEAR, sky: Array.from({ length: 80 }, () => YEAR.sky[0]!) };
    const result = detail('lord', 'jupiter', many);
    expect(bytes(result)).toBeLessThan(4096);
    expect(result).toMatchObject({ trimmed: ['sky'] });
  });

  it('summarizes a detail in one line', () => {
    expect(periodDetailSummary(detail('lord', 'venus'))).toEqual({ line: 'Venus in detail · 1 dasha spans', factors: ['Venus (pratyantar) rules the 5th', 'Venus (pratyantar) is a karaka of relationships'] });
    expect(periodDetailSummary(detail('bindus', 'sav')).line).toBe('Ashtakavarga SAV · total 337');
    expect(periodDetailSummary(detail('bindus', 'saturn')).line).toBe('Ashtakavarga Saturn · total 39');
    expect(periodDetailSummary(detail('segment', '2019-03-29')).line).toBe('Segment 2019-03-29 – 2019-04-22 · Rahu–Rahu–Venus');
    expect(periodDetailSummary(detail('panchang', undefined, DAY, DAY_FRAME)).line).toBe('Panchang Pratipada (krishna) · Uttara Bhadrapada · Sunday');
    expect(periodDetailSummary(detail('dashas')).line).toBe('Dashas · 7 spans');
    expect(periodDetailSummary(detail('houses'))).toEqual({ line: 'Period detail failed: section must be one of: lord, segment, bindus, panchang, dashas', factors: [] });
    expect(periodDetailSummary({ available: false, reason: 'timeout' }).line).toBe('Period detail unavailable (timeout)');
  });
});
