import { describe, expect, it } from 'vitest';

import transitGolden from '../../../../../../backend/tests/fixtures/transit_golden_de421.json';
import predictiveGolden from '../../../../../../backend/tests/fixtures/predictive_golden_de421.json';
import { isCachedTransitContext } from '../periodSkyValidation';

const seed = transitGolden['2019-11-09T17:45:00+00:00'];

function changed(path: string, value: unknown, remove = false): unknown {
  const copy: unknown = structuredClone(seed);
  const parts = path.split('.');
  let parent = copy as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) parent = parent[part] as Record<string, unknown>;
  const key = parts.at(-1)!;
  if (remove) delete parent[key];
  else parent[key] = value;
  return copy;
}

const requiredPaths = [
  'instant', 'gochara', 'gochara.instant', 'gochara.transit_ayanamsa', 'gochara.placements',
  ...[
    'graha', 'longitude', 'sign', 'sign_degrees', 'nakshatra', 'nakshatra_pada',
    'is_retrograde', 'house_from_lagna', 'house_from_moon', 'natal_sign_occupied',
  ].map((field) => `gochara.placements.sun.${field}`),
  'sade_sati', 'sade_sati.is_active', 'sade_sati.current_phase', 'sade_sati.natal_moon_sign',
  'sade_sati.cycle', 'sade_sati.cycle_start', 'sade_sati.cycle_end',
  ...['phase', 'saturn_sign', 'start', 'end'].map((field) => `sade_sati.cycle.0.${field}`),
  'slow_hits',
  ...['graha', 'kind', 'natal_point', 'exact', 'severity'].map((field) => `slow_hits.0.${field}`),
  'fusion',
  ...[
    'instant', 'maha_lord', 'antar_lord', 'maha_lord_transit_house_from_moon',
    'maha_lord_transit_house_from_lagna', 'reinforcing', 'afflicting', 'net_weight', 'severity',
  ].map((field) => `fusion.${field}`),
  'timeline', 'timeline.window_start', 'timeline.window_end', 'timeline.events',
  ...[
    'date', 'kind', 'graha', 'from_sign', 'to_sign', 'from_lord', 'to_lord',
    'sade_sati_phase', 'severity', 'descriptor',
  ].map((field) => `timeline.events.0.${field}`),
];

describe('cached transit runtime contract', () => {
  it.each(Object.entries(transitGolden))('accepts the real transit golden %s', (_key, value) => {
    expect(isCachedTransitContext(value)).toBe(true);
  });

  it.each(Object.entries(predictiveGolden))('accepts the real predictive golden %s', (_key, value) => {
    expect(isCachedTransitContext(value.transit_context)).toBe(true);
  });

  it('rejects the null fusion weight that would crash TransitsPanel.toFixed', () => {
    expect(isCachedTransitContext(changed('fusion.net_weight', null))).toBe(false);
  });

  it.each(requiredPaths)('rejects a missing required field: %s', (path) => {
    expect(isCachedTransitContext(changed(path, undefined, true))).toBe(false);
  });

  it.each([
    ['gochara.placements.sun.graha', null],
    ['gochara.placements.sun.longitude', '12'],
    ['gochara.placements.sun.sign', {}],
    ['gochara.placements.sun.sign_degrees', null],
    ['gochara.placements.sun.nakshatra', []],
    ['gochara.placements.sun.natal_sign_occupied', 1],
    ['gochara.placements.sun.is_retrograde', 1],
    ['sade_sati.is_active', 'false'],
    ['sade_sati.natal_moon_sign', false],
    ['sade_sati.cycle.0.saturn_sign', null],
    ['slow_hits.0.graha', 4],
    ['slow_hits.0.natal_point', {}],
    ['fusion.maha_lord', null],
    ['fusion.antar_lord', 0],
    ['timeline.events.0.graha', {}],
    ['timeline.events.0.from_sign', 3],
    ['timeline.events.0.to_sign', false],
    ['timeline.events.0.from_lord', []],
    ['timeline.events.0.to_lord', {}],
    ['timeline.events.0.descriptor', null],
    ['timeline.events.0.station_sign', false],
  ])('rejects malformed scalar %s', (path, value) => {
    expect(isCachedTransitContext(changed(path as string, value))).toBe(false);
  });

  it.each([
    'gochara.transit_ayanamsa', 'gochara.placements.sun.longitude',
    'gochara.placements.sun.sign_degrees', 'fusion.net_weight',
  ])('rejects non-finite numeric field %s', (path) => {
    for (const value of [NaN, Infinity, -Infinity]) {
      expect(isCachedTransitContext(changed(path, value))).toBe(false);
    }
  });

  it.each([
    ['gochara.placements.sun.longitude', [-1, 360]],
    ['gochara.placements.sun.sign_degrees', [-1, 30]],
    ['gochara.placements.sun.nakshatra_pada', [0, 5, 1.5, '1', null]],
    ['gochara.placements.sun.house_from_lagna', [0, 13, 1.5, '1', null]],
    ['gochara.placements.sun.house_from_moon', [0, 13, 1.5, '1', null]],
    ['fusion.maha_lord_transit_house_from_moon', [0, 13, 1.5, '1', null]],
    ['fusion.maha_lord_transit_house_from_lagna', [0, 13, 1.5, '1', null]],
    ['fusion.net_weight', [-1.01, 1.01]],
  ] as const)('rejects out-of-range numeric field %s', (path, values) => {
    for (const value of values) expect(isCachedTransitContext(changed(path, value))).toBe(false);
  });

  it.each([
    'sade_sati.current_phase', 'sade_sati.cycle.0.phase', 'slow_hits.0.kind',
    'slow_hits.0.severity', 'fusion.severity', 'timeline.events.0.kind',
    'timeline.events.0.sade_sati_phase', 'timeline.events.0.severity',
    'timeline.events.0.station_direction',
  ])('rejects unknown closed enum %s', (path) => {
    for (const value of ['unknown', 0, {}]) expect(isCachedTransitContext(changed(path, value))).toBe(false);
  });

  it.each([
    'instant', 'gochara.instant', 'sade_sati.cycle_start', 'sade_sati.cycle_end',
    'sade_sati.cycle.0.start', 'sade_sati.cycle.0.end', 'slow_hits.0.exact',
    'fusion.instant', 'timeline.window_start', 'timeline.window_end', 'timeline.events.0.date',
  ])('rejects malformed datetime %s', (path) => {
    for (const value of ['invalid', '2026-02-30T00:00:00Z', '2026-13-01T00:00:00Z', '2026-01-01', 'June 9, 2026', 0, {}]) {
      expect(isCachedTransitContext(changed(path, value))).toBe(false);
    }
  });

  it.each([
    'sade_sati.cycle', 'slow_hits', 'fusion.reinforcing', 'fusion.afflicting', 'timeline.events',
  ])('rejects malformed collection %s', (path) => {
    for (const value of [null, {}, 'array', [null], [0]]) {
      expect(isCachedTransitContext(changed(path, value))).toBe(false);
    }
  });

  it.each(['gochara', 'gochara.placements', 'gochara.placements.sun', 'sade_sati', 'fusion', 'timeline'])('rejects malformed record %s', (path) => {
    for (const value of [null, [], 'object', 0]) expect(isCachedTransitContext(changed(path, value))).toBe(false);
  });

  it('accepts older events without optional station fields and explicit null station fields', () => {
    const context = structuredClone(seed);
    for (const event of context.timeline.events) {
      delete (event as { station_direction?: unknown }).station_direction;
      delete (event as { station_sign?: unknown }).station_sign;
    }
    expect(isCachedTransitContext(context)).toBe(true);
    expect(isCachedTransitContext(changed('timeline.events.0.station_direction', null))).toBe(true);
    expect(isCachedTransitContext(changed('timeline.events.0.station_sign', null))).toBe(true);
    expect(isCachedTransitContext(changed('timeline.events.0.station_direction', 'direct'))).toBe(true);
    expect(isCachedTransitContext(changed('timeline.events.0.station_direction', 'retrograde'))).toBe(true);
  });

  it('preserves the documented open vocabulary for planet/sign/nakshatra names', () => {
    for (const path of [
      'gochara.placements.sun.graha', 'gochara.placements.sun.sign',
      'gochara.placements.sun.nakshatra', 'gochara.placements.sun.natal_sign_occupied',
      'sade_sati.natal_moon_sign', 'sade_sati.cycle.0.saturn_sign',
      'slow_hits.0.graha', 'fusion.maha_lord', 'fusion.antar_lord',
      'timeline.events.0.graha', 'timeline.events.0.from_sign', 'timeline.events.0.to_sign',
      'timeline.events.0.from_lord', 'timeline.events.0.to_lord', 'timeline.events.0.station_sign',
    ]) expect(isCachedTransitContext(changed(path, 'future-name'))).toBe(true);
  });

  it('accepts nullable schema values and empty collections', () => {
    for (const path of ['sade_sati.cycle_start', 'sade_sati.cycle_end', 'fusion.antar_lord',
      'timeline.events.0.graha', 'timeline.events.0.from_sign', 'timeline.events.0.to_sign',
      'timeline.events.0.from_lord', 'timeline.events.0.to_lord', 'timeline.events.0.sade_sati_phase']) {
      expect(isCachedTransitContext(changed(path, null))).toBe(true);
    }
    for (const path of ['sade_sati.cycle', 'slow_hits', 'fusion.reinforcing', 'fusion.afflicting', 'timeline.events']) {
      expect(isCachedTransitContext(changed(path, []))).toBe(true);
    }
    expect(isCachedTransitContext(changed('gochara.placements', {}))).toBe(true);
  });

  it('accepts both backend UTC formats, including fractional seconds and leap days', () => {
    for (const value of ['2024-02-29T23:59:59.123456Z', '2026-06-09T12:00:00+00:00']) {
      expect(isCachedTransitContext(changed('instant', value))).toBe(true);
    }
  });

  it.each([null, undefined, [], {}, false, 'context'])('rejects a malformed top-level context: %s', (value) => {
    expect(isCachedTransitContext(value)).toBe(false);
  });
});
