/**
 * Pure adapter helpers between `SiderealChart`, the Worker's `VargaDetailInput` /
 * `VargaDetailResult`, and the store's `VargaChart` geometry input.
 *
 * Zero astrology math and zero `@almamesh/llm` / `zod` imports so static
 * surfaces (`ChartVisualization`, `ShodasavargaPanel`) stay lazy-chat-clean.
 */

import type {
  DivisionalChartId,
  SiderealChart,
  VargaDetailInput,
  VargaDetailResult,
} from '@almamesh/browser/types';
import type { VargaChart, VargaPlanet } from '@almamesh/store';
import { titleCaseToken } from './predictive';

/** Build the deterministic Worker input from a stored `SiderealChart`, or `null` if incomplete. */
export function buildVargaDetailInput(
  chart: SiderealChart,
  division: DivisionalChartId,
): VargaDetailInput | null {
  if (typeof chart.lagna?.longitude !== 'number') return null;
  const planets: Record<string, { longitude: number; isCombust?: boolean }> = {};
  for (const [key, planet] of Object.entries(chart.planets ?? {})) {
    if (typeof planet?.longitude === 'number') {
      planets[key.toLowerCase()] = {
        longitude: planet.longitude,
        ...(typeof planet.is_combust === 'boolean' ? { isCombust: planet.is_combust } : {}),
      };
    }
  }
  return {
    chart: division,
    lagnaLongitude: chart.lagna.longitude,
    planets,
  };
}

/** Reshape a `VargaDetailResult` into `VargaChart` for `buildVargaGeometry`. */
export function vargaDetailToVargaChart(detail: VargaDetailResult): VargaChart {
  const planets: Record<string, VargaPlanet> = {};
  for (const [key, placement] of Object.entries(detail.placements)) {
    planets[key] = {
      name: placement.graha,
      sign: titleCaseToken(placement.sign),
      sign_lord: placement.sign_lord,
      is_combust: placement.is_combust,
    };
  }
  return {
    name: detail.chart,
    lagna_sign: titleCaseToken(detail.lagna_sign),
    lagna_sign_lord: detail.lagna_sign_lord,
    planets,
  };
}
