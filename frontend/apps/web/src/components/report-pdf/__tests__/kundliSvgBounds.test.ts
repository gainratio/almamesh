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

  layout.labels.forEach((label, index) => {
    const halfW = (label.length * MONO_CHAR_WIDTH_RATIO * layout.planetFont) / 2;
    const baselineY = layout.firstPlanetY + index * layout.lineH;
    expect(layout.planetX - halfW, `left clip for "${label}"`).toBeGreaterThanOrEqual(0);
    expect(layout.planetX + halfW, `right clip for "${label}"`).toBeLessThanOrEqual(size);
    expect(baselineY - layout.planetFont, `top clip for "${label}"`).toBeGreaterThanOrEqual(0);
    expect(baselineY, `bottom clip for "${label}"`).toBeLessThanOrEqual(size);
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

  it('keeps dense varga stacks (6 planets in top outer triangle H2) inside [0, size]', () => {
    const densePlanets = [
      planet('sun', 'Su'),
      planet('moon', 'Mo'),
      planet('mars', 'Ma'),
      planet('mercury', 'Me'),
      planet('jupiter', 'Ju'),
      planet('venus', 'Ve'),
    ];
    const h2 = house(2, 11, densePlanets);
    const layout = computeCellTextLayout(h2, NORTH_INDIAN_HOUSE_CELLS[1]!, 160, false, false);
    assertStrictlyInsideViewport(layout, 160, false);
  });
});
