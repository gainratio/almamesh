import { describe, expect, it } from 'vitest';
import type { ChartHouse, ChartPlanet } from '@almamesh/store';
import {
  computeCellTextLayout,
  NORTH_INDIAN_HOUSE_CELLS,
  type CellTextLayout,
} from '../sections/ReportPdfKundli';

const MONO_CHAR_WIDTH_RATIO = 0.62;

function planet(name: string, label: string, isRetrograde = false, signDegrees = 19.4): ChartPlanet {
  return {
    name,
    label,
    longitude: signDegrees,
    sign: 'Aries',
    signIndex: 0,
    signDegrees,
    house: 1,
    nakshatra: 'Ashwini',
    pada: 1,
    dignity: 'neutral',
    isRetrograde,
    isCombust: false,
    combustionSeparationDeg: null,
    housesRuled: [],
    isYogakaraka: false,
    color: '#111827',
  };
}

function house(houseNum: number, signIndex: number, planets: readonly ChartPlanet[]): ChartHouse {
  return {
    house: houseNum,
    sign: 'Aries',
    signIndex,
    planets: [...planets],
  };
}

function assertStrictlyInsideViewport(layout: CellTextLayout, size: number, isLagna: boolean): void {
  expect(layout.signY - layout.signFont).toBeGreaterThanOrEqual(0);
  expect(layout.signY).toBeLessThanOrEqual(size);
  if (isLagna) {
    expect(layout.lagnaY - layout.signFont).toBeGreaterThanOrEqual(0);
  }
  expect(layout.signX).toBeGreaterThan(0);
  expect(layout.signX).toBeLessThan(size);

  layout.rows.forEach((row) => {
    const halfW = (row.label.length * MONO_CHAR_WIDTH_RATIO * row.fontSize) / 2;
    expect(row.x - halfW, `left clip for "${row.label}"`).toBeGreaterThanOrEqual(0);
    expect(row.x + halfW, `right clip for "${row.label}"`).toBeLessThanOrEqual(size);
    expect(row.y - row.fontSize, `top clip for "${row.label}"`).toBeGreaterThanOrEqual(0);
    expect(row.y, `bottom clip for "${row.label}"`).toBeLessThanOrEqual(size);
  });
}

describe('ReportPdfKundli geometric bounds', () => {
  const samplePlanets = [
    planet('rahu', 'Ra', true, 19.8),
    planet('saturn', 'Sa', true, 28.1),
  ];

  it.each([160, 190, 200])(
    'keeps every sign numeral, La marker, and retrograde planet label inside [0, %i] for all 12 houses',
    (size) => {
      NORTH_INDIAN_HOUSE_CELLS.forEach((cell, index) => {
        const h = house(index + 1, (index + 10) % 12, samplePlanets);
        const isLagna = index === 0;
        const layout = computeCellTextLayout(h, cell, size, isLagna, true);
        assertStrictlyInsideViewport(layout, size, isLagna);
      });
    },
  );

  it('keeps dense varga and stellium stacks inside [0, size] across H1 (Lagna), H2 (top triangle), and H3 (side triangle)', () => {
    const densePlanets = [
      planet('sun', 'Su'),
      planet('moon', 'Mo'),
      planet('mars', 'Ma'),
      planet('mercury', 'Me'),
      planet('jupiter', 'Ju'),
      planet('venus', 'Ve'),
    ];
    for (const [cellIndex, isLagna] of [
      [0, true],
      [1, false],
      [2, false],
    ] as const) {
      const h = house(cellIndex + 1, 11, densePlanets);
      const layout = computeCellTextLayout(
        h,
        NORTH_INDIAN_HOUSE_CELLS[cellIndex]!,
        160,
        isLagna,
        false,
      );
      assertStrictlyInsideViewport(layout, 160, isLagna);
      if (isLagna) {
        expect(layout.lagnaX).toBeGreaterThan(0);
        expect(layout.lagnaX).toBeLessThan(160);
      }
    }
  });
});
