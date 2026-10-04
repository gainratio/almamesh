import { describe, expect, it } from 'vitest';

import { cuspInfo, degreesToNearestCusp } from '../lagnaCusp';

const ZODIAC = [
  'Aries',
  'Taurus',
  'Gemini',
  'Cancer',
  'Leo',
  'Virgo',
  'Libra',
  'Scorpio',
  'Sagittarius',
  'Capricorn',
  'Aquarius',
  'Pisces',
] as const;

// --- degreesToNearestCusp ---------------------------------------------------
describe('degreesToNearestCusp', () => {
  it('is the distance to the lower boundary near the start of a sign', () => {
    expect(degreesToNearestCusp(0)).toBe(0);
    expect(degreesToNearestCusp(1.2)).toBeCloseTo(1.2, 6);
  });

  it('is the distance to the upper boundary near the end of a sign', () => {
    expect(degreesToNearestCusp(29.9)).toBeCloseTo(0.1, 6);
    expect(degreesToNearestCusp(27)).toBe(3);
  });

  it('is maximal (15) at the exact middle of a sign', () => {
    expect(degreesToNearestCusp(15)).toBe(15);
  });
});

// --- cuspInfo ---------------------------------------------------------------
describe('cuspInfo', () => {
  it('flags the PREVIOUS sign at the lower boundary (0°)', () => {
    const info = cuspInfo('Taurus', 0);
    expect(info).not.toBeNull();
    expect(info?.neighbourSign).toBe('Aries');
    expect(info?.degrees).toBe(0);
  });

  it('flags the previous sign just inside the threshold (3°)', () => {
    const info = cuspInfo('Taurus', 3);
    expect(info).not.toBeNull();
    expect(info?.neighbourSign).toBe('Aries');
    expect(info?.degrees).toBe(3);
  });

  it('returns null in the middle of a sign (15°)', () => {
    expect(cuspInfo('Taurus', 15)).toBeNull();
  });

  it('flags the NEXT sign near the upper boundary (27°)', () => {
    const info = cuspInfo('Aquarius', 27);
    expect(info).not.toBeNull();
    expect(info?.neighbourSign).toBe('Pisces');
    expect(info?.degrees).toBe(3);
  });

  it('flags the next sign very close to the upper boundary (29.9°)', () => {
    const info = cuspInfo('Aquarius', 29.9);
    expect(info).not.toBeNull();
    expect(info?.neighbourSign).toBe('Pisces');
    expect(info?.degrees).toBeCloseTo(0.1, 6);
  });

  it('the reference-native case: Leo 0.04° is ~0.04° from the Cancer cusp', () => {
    const info = cuspInfo('Leo', 0.04);
    expect(info?.neighbourSign).toBe('Cancer');
    expect(info?.degrees).toBeCloseTo(0.04, 6);
  });

  it('wraps Aries↔Pisces at the lower boundary (Aries 0° → Pisces)', () => {
    const info = cuspInfo('Aries', 0.5);
    expect(info?.neighbourSign).toBe('Pisces');
    expect(info?.degrees).toBeCloseTo(0.5, 6);
  });

  it('wraps Pisces↔Aries at the upper boundary (Pisces 29.5° → Aries)', () => {
    const info = cuspInfo('Pisces', 29.5);
    expect(info?.neighbourSign).toBe('Aries');
    expect(info?.degrees).toBeCloseTo(0.5, 6);
  });

  it.each(ZODIAC)('derives both neighbouring signs for any %s legacy chart', (sign) => {
    const index = ZODIAC.indexOf(sign);
    const previous = ZODIAC[(index - 1 + ZODIAC.length) % ZODIAC.length];
    const next = ZODIAC[(index + 1) % ZODIAC.length];

    expect(cuspInfo(sign, 0.75)).toEqual({ neighbourSign: previous, degrees: 0.75 });
    expect(cuspInfo(sign, 29.25)).toEqual({ neighbourSign: next, degrees: 0.75 });
  });

  it('accepts a custom threshold', () => {
    expect(cuspInfo('Taurus', 4, 3)).toBeNull();
    expect(cuspInfo('Taurus', 4, 5)?.neighbourSign).toBe('Aries');
  });

  it('returns null for an unknown sign name rather than throwing', () => {
    expect(cuspInfo('NotASign', 1)).toBeNull();
  });
});

// --- engine cusp fields (single source of truth) ----------------------------
// When the engine supplies its own cusp measurement, these helpers CONSUME it
// verbatim (the engine is authoritative) and only fall back to the local TS
// computation when those fields are absent (older bundles / stored charts).
describe('cuspInfo with engine cusp fields', () => {
  it('uses the engine adjacent sign + distance verbatim, not the local recompute', () => {
    // signDegrees (0.04) would locally give 0.04; the engine distance (0.043) wins.
    const info = cuspInfo('Leo', 0.04, 3, {
      lagna_adjacent_sign: 'Cancer',
      lagna_cusp_distance_deg: 0.043,
      is_near_cusp: true,
    });
    expect(info).not.toBeNull();
    expect(info?.neighbourSign).toBe('Cancer');
    expect(info?.degrees).toBeCloseTo(0.043, 6);
  });

  it('returns null when the engine distance is outside the threshold (mid-sign)', () => {
    expect(
      cuspInfo('Cancer', 16.121, 3, {
        lagna_adjacent_sign: 'Leo',
        lagna_cusp_distance_deg: 13.879,
        is_near_cusp: false,
      }),
    ).toBeNull();
  });

  it('still honours a custom threshold against the engine distance', () => {
    const engine = { lagna_adjacent_sign: 'Aries', lagna_cusp_distance_deg: 4 };
    expect(cuspInfo('Taurus', 4, 3, engine)).toBeNull();
    expect(cuspInfo('Taurus', 4, 5, engine)?.neighbourSign).toBe('Aries');
  });

  it('falls back to the local TS computation when engine fields are absent', () => {
    expect(cuspInfo('Aquarius', 27, 3, {})?.neighbourSign).toBe('Pisces');
  });
});

describe('degreesToNearestCusp with the engine distance', () => {
  it('returns the engine distance verbatim when provided', () => {
    expect(degreesToNearestCusp(0.04, 0.043)).toBeCloseTo(0.043, 6);
  });

  it('falls back to the local measurement when the engine distance is absent', () => {
    expect(degreesToNearestCusp(27)).toBe(3);
  });
});
