import { describe, expect, it } from 'vitest';

import { cityDisplayName, placeRegion, cityMatchRank, placeQualifiersMatch, placeTokens, splitPlaceQuery, type CityRow } from './cityMatch';

function row(n: string, s: string | undefined, c: string, cc: string, p: number): CityRow {
  return { n, ...(s ? { s } : {}), c, cc, lat: 0, lon: 0, p };
}

const NOVATO = row('Novato', 'California', 'United States', 'US', 55_530);
const NOVATOR = row('Novator', 'Vologda Oblast', 'Russia', 'RU', 20_000);
const PORTLAND_OR = row('Portland', 'Oregon', 'United States', 'US', 652_503);
const PORTLAND_ME = row('Portland', 'Maine', 'United States', 'US', 66_881);
const VADODARA = row('Vadodara', 'Gujarat', 'India', 'IN', 1_409_476);
const TORONTO = row('Toronto', 'Ontario', 'Canada', 'CA', 2_600_000);

function rank(city: CityRow, query: string): number {
  return cityMatchRank(city, placeTokens(query));
}

describe('splitPlaceQuery', () => {
  it('splits the city from comma qualifiers, folded', () => {
    expect(splitPlaceQuery('Novato, CA')).toEqual({ city: 'novato', qualifiers: ['ca'] });
    expect(splitPlaceQuery('San José, Costa Rica')).toEqual({ city: 'san jose', qualifiers: ['costa', 'rica'] });
    expect(splitPlaceQuery('  Springfield  ')).toEqual({ city: 'springfield', qualifiers: [] });
  });
});

describe('cityMatchRank: a trailing state or country qualifier filters', () => {
  it.each(['novato, ca', 'Novato, CA', 'novato california', 'Novato, California, USA', 'novato, united states'])(
    'keeps Novato, California for %j',
    (query) => expect(rank(NOVATO, query)).toBeGreaterThanOrEqual(0),
  );

  it('ranks an exact city name under a comma qualifier as exact', () => {
    expect(rank(NOVATO, 'novato, ca')).toBe(3);
  });

  it('drops Novator, Russia for "novato, ca"', () => {
    expect(rank(NOVATOR, 'novato, ca')).toBe(-1);
  });

  it('tells Portland, OR from Portland, ME by the state code', () => {
    expect(rank(PORTLAND_OR, 'Portland, OR')).toBe(3);
    expect(rank(PORTLAND_ME, 'Portland, OR')).toBe(-1);
    expect(rank(PORTLAND_ME, 'Portland, ME')).toBe(3);
    expect(rank(PORTLAND_OR, 'Portland, ME')).toBe(-1);
    expect(rank(PORTLAND_ME, 'portland maine')).toBeGreaterThanOrEqual(0);
  });

  it('never ignores a qualifier that names no state or country', () => {
    expect(rank(PORTLAND_OR, 'Portland, ZZ')).toBe(-1);
    expect(rank(NOVATO, 'novato, nevada')).toBe(-1);
  });

  it('matches a state name for any country, and a Canadian province code', () => {
    expect(rank(VADODARA, 'vadodara gujarat')).toBeGreaterThanOrEqual(0);
    expect(rank(VADODARA, 'Vadodara, India')).toBe(3);
    expect(rank(TORONTO, 'Toronto, ON')).toBe(3);
    expect(rank(TORONTO, 'Toronto, CA')).toBe(3);
  });
});

describe('cityMatchRank: whole words before a qualifier', () => {
  const NEWBURGH = row('Newburgh', 'New York', 'United States', 'US', 28_000);
  const NYC = row('New York City', 'New York', 'United States', 'US', 8_800_000);
  const CARAGA_SF = row('San Francisco', 'Caraga', 'Philippines', 'PH', 70_000);
  it('never reads one word of a state name as the state: "Sao Paulo" is not São Carlos', () => {
    expect(rank(row('São Carlos', 'São Paulo', 'Brazil', 'BR', 250_000), 'Sao Paulo')).toBe(-1);
    expect(rank(row('New Rochelle', 'New York', 'United States', 'US', 80_000), 'new york usa')).toBe(-1);
    expect(rank(row('San José', 'Alajuela', 'Costa Rica', 'CR', 30_000), 'san jose, costa ri')).toBe(3);
  });

  it('reads "new york usa" as New York City, never Newburgh', () => {
    expect(rank(NYC, 'new york usa')).toBe(2);
    expect(rank(NEWBURGH, 'new york usa')).toBe(-1);
  });
  it('needs a whole code for a short qualifier: "CA" is not Caraga', () => {
    expect(rank(CARAGA_SF, 'San Francisco, CA')).toBe(-1);
    expect(rank(NOVATO, 'novato, cal')).toBe(3);
  });
});

describe('cityMatchRank: a bare name', () => {
  it('lists a country, but never a whole state, for a name alone', () => {
    expect(rank(NOVATO, 'united states')).toBe(0);
    expect(rank(NOVATO, 'california')).toBe(-1);
  });
});

describe('placeQualifiersMatch (online results)', () => {
  const illinois = { state: 'Illinois', country: 'United States', countryCode: 'US' };
  it('accepts a state code, state name or country, and refuses another state', () => {
    expect(placeQualifiersMatch(illinois, ['il'])).toBe(true);
    expect(placeQualifiersMatch(illinois, ['illinois', 'usa'])).toBe(true);
    expect(placeQualifiersMatch(illinois, [])).toBe(true);
    expect(placeQualifiersMatch(illinois, ['mo'])).toBe(false);
  });
});

describe('cityDisplayName', () => {
  it('reads City, State, Country, and skips a missing state', () => {
    expect(cityDisplayName(NOVATO)).toBe('Novato, California, United States');
    expect(cityDisplayName(row('Singapore', undefined, 'Singapore', 'SG', 1))).toBe('Singapore, Singapore');
  });

  it('skips a state that only repeats the city name', () => {
    expect(cityDisplayName(row('Shanghai', 'Shanghai', 'China', 'CN', 1))).toBe('Shanghai, China');
    expect(placeRegion('Istanbul', 'Istanbul', 'Türkiye')).toBe('Türkiye');
    expect(placeRegion('Bogotá', 'Bogota D.C.', 'Colombia')).toBe('Colombia');
    expect(placeRegion('Novato', 'California', 'United States')).toBe('California, United States');
  });
});
