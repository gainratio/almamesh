/** The period reading built from the backend goldens (testdata/period-reading, DELHI_BIRTH). */
import { describe, expect, it } from 'vitest';

import {
  buildPeriodDetail,
  buildPeriodReading,
  MAX_PERIOD_RESULT_BYTES,
  PERIOD_TOOL_SUMMARIZERS,
  periodReadingSummary,
  READ_PERIOD_TOOL_NAME,
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
    // Spec 2026-10-15: each sub-lord carries its house from its parent (Rahu and Venus share Capricorn).
    expect(dashas.antar).toEqual([{ lord: 'rahu', start: '2019-05-01', end: '2019-05-31', from_parent: 1, relation: 'support' }]);
    expect(dashas.pratyantar).toEqual([{ lord: 'venus', start: '2019-05-01', end: '2019-05-31', from_parent: 1, relation: 'support' }]);
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
      natal: { house: 8, sign: 'capricorn', dignity: 'neutral', strength: 'weak', combust: true },
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
    // Two themes keep April under budget, so this reads the clipping alone, not a trim.
    const april = buildPeriodReading({ ...YEAR, themes: YEAR.themes.slice(0, 2) }, within('2019-04-01', '2019-04-30'));
    expect(april.sky.filter((span) => span.graha === 'jupiter').map((span) => [span.start, span.end]))
      .toEqual([['2019-04-01', '2019-04-10'], ['2019-04-10', '2019-04-22'], ['2019-04-22', '2019-04-30']]);
  });

  it('groups each dated window once across the themes it belongs to, only inside the period', () => {
    // 2026-10-14 (obstacles domain): Mars windows date only the obstacles theme; the Jupiter
    // ingresses belong to every other domain, and the 2019-04-22 one to obstacles too.
    // Domains list in theme order; spec 2026-10-15 re-ranked the themes (health first).
    const jupiter = ['health', 'education', 'family', 'relationships', 'spiritual', 'finances', 'career'];
    // No sky keeps the Year under budget, so this reads the grouping alone, not a trim.
    expect(buildPeriodReading({ ...YEAR, sky: [] }, YEAR_FRAME).windows).toEqual([
      { date: '2019-03-22', descriptor: 'transit.mars.ingress.taurus', severity: 'neutral', domains: ['obstacles'] },
      { date: '2019-03-29', descriptor: 'transit.jupiter.ingress.sagittarius', severity: 'neutral', domains: jupiter },
      { date: '2019-04-22', descriptor: 'transit.jupiter.ingress.scorpio', severity: 'neutral', domains: ['health', 'obstacles', 'education', 'family', 'relationships', 'spiritual', 'finances', 'career'] },
      { date: '2019-05-07', descriptor: 'transit.mars.ingress.gemini', severity: 'neutral', domains: ['obstacles'] },
      { date: '2019-11-05', descriptor: 'transit.jupiter.ingress.sagittarius', severity: 'neutral', domains: jupiter },
    ]);
    expect(buildPeriodReading(YEAR, within('2019-04-01', '2019-04-30')).windows.map((window) => window.date)).toEqual(['2019-04-22']);
    expect(reading('delhi-2019-05').windows).toEqual([{ date: '2019-05-07', descriptor: 'transit.mars.ingress.gemini', severity: 'neutral', domains: ['obstacles'] }]);
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
    expect(result.dashas.sookshma).toEqual({ lord: 'mars', start: '2019-09-15', end: '2019-09-18', from_parent: 4, relation: 'support' });
    expect(result.lords.find((lord) => lord.lord === 'mars')?.level).toEqual(['sookshma']);
    expect(result.panchang).toEqual({ tithi: 16, tithi_name: 'Pratipada', paksha: 'krishna', nakshatra: 'Uttara Bhadrapada', karana: 'Kaulava', yoga: 'Ganda', vara_utc: 'Sunday' });
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
    // 2026-10-14: with 8 themes the May 2019 digest cut Venus's natal detail (pratyantar lord of
    // the 5th and 12th, in the 8th), the facts behind its obstacles theme. The per-technique
    // agreement booleans go first now: each theme's confidence already counts them.
    const may = reading('delhi-2019-05');
    expect(may.trimmed?.[0]).toBe('theme agreement per technique');
    expect(may.trimmed ?? []).not.toContain('pratyantar-only lord natal detail');
    expect(may.themes).toHaveLength(8);
    expect(reading('delhi-2027-01').trimmed?.[0]).toBe('theme agreement per technique');
    const year = reading('delhi-2019-year');
    expect(year.trimmed?.slice(0, 2)).toEqual(['theme agreement per technique', 'pratyantar-only lord vargas and yogas']);
    // What the acceptance drive needs survives the Year cut: every dasha change, the first windows, lordships, confidence.
    expect(year.dashas.pratyantar).toHaveLength(5);
    expect(year.windows.map((window) => window.date)).toEqual(['2019-03-22', '2019-03-29', '2019-04-22']);
    expect(year.trimmed).toContain('windows beyond 3');
    expect(year.lords.every((lord) => lord.rules !== undefined && lord.functional !== undefined)).toBe(true);
    expect(year.themes.every((theme) => theme.factors.length > 0)).toBe(true);
  });

  // 2026-10-14: the Year cut whole themes before thinning the sky, so obstacles (the 5th theme)
  // vanished from 2019 while three Jupiter spans survived. A theme's verdict outranks sky detail.
  // Contract narrowed the same day (T3 A/B, deepseek x3: 0/3 with all 8 themes, 2/3 without the
  // low-confidence ones): a theme with 0-1 agreeing techniques goes once factors are down to one,
  // before the sky thins further. Obstacles and every medium/high theme stay.
  it('a Year keeps every medium- or high-confidence life area, obstacles with its factor', () => {
    const year = reading('delhi-2019-year');
    // Spec 2026-10-15: the graded dasha rule no longer flags spiritual and career for 2019 (their
    // running lords score 4 and 1 of 100), so both are low confidence and go with the other lows.
    expect(year.themes.map((theme) => theme.domain)).toEqual(['health', 'obstacles', 'education', 'family', 'relationships']);
    expect(year.themes.every((theme) => theme.confidence !== 'low')).toBe(true);
    expect(year.trimmed).toContain('low-confidence themes');
    expect(year.trimmed!.indexOf('low-confidence themes')).toBe(year.trimmed!.indexOf('theme factors beyond 1') + 1);
    expect(year.themes.find((theme) => theme.domain === 'obstacles')).toMatchObject({
      houses: [6, 8, 12], strength: 'strong', confidence: 'medium', factors: expect.arrayContaining(['Rahu (maha) occupies the 8th: unexpected setbacks']),
    });
    // A Month that fits keeps all eight, low confidence included.
    expect(reading('delhi-2019-05').themes).toHaveLength(8);
  });

  // Matrix 2026-10-14 (T3, deepseek): answers called a theme's strength_pct "confidence" ("strong
  // (75% confidence)"). A theme now names its strength in words and its confidence by name, with no
  // bare percentage beside them to misread.
  it('a theme states its strength in words and its confidence by name, with no percentage to misread', () => {
    for (const name of NAMES) {
      for (const theme of reading(name).themes) {
        expect(Object.keys(theme).filter((key) => key !== 'agreement')).toEqual(['domain', 'houses', 'direction', 'strength', 'confidence', 'factors']);
        expect(JSON.stringify({ ...theme, factors: [] })).not.toMatch(/_pct|%/);
      }
    }
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
      line: 'Rahu–Rahu–Venus · 8 themes',
      // One factor and its obstacles reading ("…: unexpected setbacks") are one factor: the one that says more.
      // Spec 2026-10-15 re-ranked the themes: obstacles (Rahu) now leads; career's Yogini factor drops out of the top 5.
      factors: ['Rahu (maha) occupies the 8th: unexpected setbacks', 'Venus (pratyantar) rules the 5th', 'Venus (pratyantar) is a karaka of relationships',
        'Venus (pratyantar) rules the 12th', 'Jupiter strength is 50% (strong)'],
    });
    expect(periodReadingSummary(reading('delhi-2019-year')).line).toBe('Rahu–Rahu–Ketu, 4 dasha changes · 5 themes');
    expect(periodReadingSummary(reading('delhi-2027-01')).line).toBe('Rahu–Mercury–Rahu · Ashtama Shani · 8 themes');
    expect(periodReadingSummary({ available: false, reason: 'timeout' })).toEqual({ line: 'Period reading unavailable (timeout)', factors: [] });
    expect(periodReadingSummary({ error: 'nope' })).toEqual({ line: 'Period reading failed: nope', factors: [] });
  });

  it('read_period\'s facts-note summary leads with the period and place; an ask says what it asked', () => {
    const summarize = PERIOD_TOOL_SUMMARIZERS[READ_PERIOD_TOOL_NAME]!;
    expect(Object.keys(PERIOD_TOOL_SUMMARIZERS)).toEqual(['read_period']);
    expect(summarize(reading('delhi-2019-05')).line).toBe('May 2019 · Singapore · Rahu–Rahu–Venus · 8 themes');
    expect(summarize({ status: 'place_not_chosen', ask: 'Ask the user which one they meant.' })).toEqual({ line: 'Asked the user (place_not_chosen)', factors: [] });
    expect(summarize({ available: false, reason: 'timeout' }).line).toBe('Period reading unavailable (timeout)');
  });
});

describe('the period detail digests (read_period close-ups)', () => {
  const detail = (section: string, key?: string, source = YEAR, frame = YEAR_FRAME) =>
    buildPeriodDetail({ reading: source, strength: STRENGTH }, frame, section, key);
  const DAY = periodReadingFixture('delhi-2019-09-15-day');
  const DAY_FRAME = FRAMES['delhi-2019-09-15-day'];

  it('lord: its natal and transit context, every span it runs and the factors that cite it', () => {
    expect(detail('lord', 'venus')).toMatchObject({
      section: 'lord', key: 'venus',
      facts: { lord: 'venus', rules: [5, 12], functional: 'benefic', natal: { house: 8, sign: 'capricorn', retro: true, vargottama: false },
        runs: [{ level: 'pratyantar', start: '2019-02-05', end: '2019-07-19' }], sky: [] },
      // Theme order (spec 2026-10-15): obstacles, then education, family, relationships.
      factors: ['Venus (pratyantar) occupies the 8th', 'Venus (pratyantar) rules the 12th: losses and expenses', 'Venus (pratyantar) rules the 5th', 'Venus (pratyantar) is a karaka of relationships'],
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
    // The engine's vara is the UTC weekday of the reference instant, not the local day-lord: say so.
    const panchang = detail('panchang', undefined, DAY, DAY_FRAME);
    expect(panchang).toMatchObject({ facts: { tithi_name: 'Pratipada', vara_utc: 'Sunday' } });
    expect(panchang).not.toHaveProperty('facts.vara');
    if (!('factors' in panchang)) throw new Error('expected factors');
    expect(panchang.factors).toContain('vara (UTC weekday, not the local day-lord) Sunday');
    expect(detail('panchang')).toEqual({ error: 'panchang is computed for a single day; this period is 2019.' });
    expect(detail('panchang', undefined, { ...DAY, panchang: null }, DAY_FRAME)).toEqual({ error: 'panchang is unavailable for this day.' });
  });

  it('dashas: every span in the period, down to sookshma for a Day', () => {
    expect(detail('dashas', undefined, DAY, DAY_FRAME)).toMatchObject({ facts: { sookshma: { lord: 'mars', end: '2019-09-18' } } });
    expect(detail('dashas')).toMatchObject({ facts: { spans: expect.arrayContaining([{ level: 'pratyantar', lord: 'moon', start: '2019-09-07', end: '2019-11-28' }]) } });
  });

  // Live drive 2026-10-14: the model asked for segment "2019-09-17", a date inside a segment rather than
  // its start, and got an error row. A date inside the period names exactly one segment: read that one.
  it('segment: a date inside a segment reads the segment that contains it', () => {
    expect(detail('segment', '2019-04-10')).toMatchObject({ facts: { segment: { start: '2019-03-29', end: '2019-04-22' } } });
  });

  // Matrix 2026-10-14 (T3, deepseek run 3): get_period_detail {section: "segments"} was an error row.
  // The plural names its section, and a segment with no key lists every segment in the period.
  it('segments: the plural reads the segment section; with no key it lists every segment in the period', () => {
    const all = detail('segments');
    expect(all).toMatchObject({ section: 'segment' });
    if (!('facts' in all)) throw new Error('expected facts');
    const segments = (all.facts as { segments: { start: string; pratyantar: string }[] }).segments;
    expect(segments.map((segment) => [segment.start, segment.pratyantar])[0]).toEqual(['2019-01-01', 'ketu']);
    expect(segments.length).toBeGreaterThan(5);
    expect(detail('segment')).toMatchObject({ section: 'segment', facts: { segments } });
    expect(detail('segments', '2019-04-10')).toMatchObject({ section: 'segment', facts: { segment: { start: '2019-03-29' } } });
    expect(detail('lords', 'venus')).toMatchObject({ section: 'lord', facts: { lord: 'venus' } });
    expect(bytes(all)).toBeLessThan(4096);
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

});

// Spec 2026-10-15 (classical dasha rules): the engine places each sub-lord from its parent lord,
// grades each lord's strength, runs Yogini antars and gives each theme a dasha tone. The tool
// copies the span relations, lord strengths and the Yogini antar by name. The theme's graded
// scores stay out (a bare number beside a verdict was read as a confidence percentage on
// 2026-10-14); the agreement booleans and confidence carry the threshold.
describe('the classical dasha facts in the period reading', () => {
  it('an antar and a pratyantar carry their house from the parent lord; a maha does not', () => {
    const full = buildPeriodReading(periodReadingFixture('delhi-2027-01'), FRAMES['delhi-2027-01'], { budgetBytes: 1_000_000 }).dashas;
    expect(full.maha[0]).toEqual({ lord: 'rahu', start: '2027-01-01', end: '2027-01-31' });
    expect(full.antar[0]).toMatchObject({ lord: 'mercury', from_parent: 12, relation: 'friction' });
    expect(full.pratyantar[0]).toMatchObject({ lord: 'rahu', from_parent: 2, relation: 'neutral' });
    // At 4 KB the antar's placement (BPHS) stays; the pratyantar's (an AlmaMesh extension) is cut
    // after the pratyantar lord's natal detail and before a theme's second factor.
    const fitted = reading('delhi-2027-01');
    expect(fitted.dashas.antar[0]).toMatchObject({ from_parent: 12, relation: 'friction' });
    expect(fitted.trimmed).toContain('pratyantar placements');
  });

  it('a running lord carries its strength band beside its natal dignity', () => {
    const venus = reading('delhi-2019-05').lords.find((lord) => lord.lord === 'venus');
    expect(venus?.natal).toEqual({ house: 8, sign: 'capricorn', dignity: 'neutral', strength: 'weak', combust: true });
  });

  it('the Yogini antar is clipped to the period beside the Yogini maha', () => {
    const { dashas } = reading('delhi-2019-05');
    expect(dashas.yogini_antar).toEqual({ name: 'sankata', lord: 'rahu', start: '2019-05-01', end: '2019-05-31' });
  });

  it('a theme carries neither the graded scores nor the tone: its confidence and factors already speak', () => {
    // Measured 2026-10-15: a per-theme tone cost ~220 B and was cut first in every golden at 4 KB,
    // so it never reached the model; the scores and tone stay in the engine output for the UI and eval.
    const themes = buildPeriodReading(periodReadingFixture('delhi-2019-05'), FRAMES['delhi-2019-05'], { budgetBytes: 1_000_000 }).themes;
    expect(themes.length).toBe(8);
    expect(JSON.stringify(themes)).not.toMatch(/dasha|"vimshottari":\d|tone/);
  });

  it('an older cached reading without the classical fields still builds, with none invented', () => {
    const source = periodReadingFixture('delhi-2019-05');
    const old = {
      ...source,
      yogini_antar: undefined,
      dasha_spans: source.dasha_spans.map(({ level, lord, start, end }) => ({ level, lord, start, end })),
      themes: source.themes.map(({ dasha: _dasha, ...theme }) => theme),
      natal_lords: Object.fromEntries(Object.entries(source.natal_lords).map(([graha, { strength: _s, ...lord }]) => [graha, lord])),
    };
    const result = buildPeriodReading(old, FRAMES['delhi-2019-05'], { budgetBytes: 1_000_000 });
    expect(result.dashas.antar[0]).toEqual({ lord: 'rahu', start: '2019-05-01', end: '2019-05-31' });
    expect(result.dashas).not.toHaveProperty('yogini_antar');
    expect(result.lords.every((lord) => lord.natal?.strength === undefined)).toBe(true);
  });
});
