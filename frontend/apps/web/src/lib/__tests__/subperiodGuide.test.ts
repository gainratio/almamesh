import { findLaymanJargon } from '@almamesh/llm/layman-jargon';
import { reflectionIssues } from '@almamesh/llm/reflection';
import type { TransitCtx } from '@almamesh/shared-types';
import { beforeEach, describe, expect, it } from 'vitest';
import i18n from '../../i18n/config';
import { formatPredictiveWindowBound } from '../predictive';
import { buildSubperiodGuide, type SubperiodPlanetFact } from '../subperiodGuide';

const LORDS = ['sun', 'moon', 'mars', 'mercury', 'jupiter', 'venus', 'saturn', 'rahu', 'ketu'] as const;

const SAMPLE_PLANETS: Readonly<Record<string, SubperiodPlanetFact>> = {
  sun: { house: 1, sign: 'aries', houses_ruled: [5], dignity: 'exalted', is_combust: false },
  moon: { house: 4, sign: 'cancer', houses_ruled: [4], dignity: 'own_sign' },
  mars: { house: 4, sign: 'cancer', houses_ruled: [4, 9], dignity: 'debilitated', is_yogakaraka: true },
  mercury: { house: 12, sign: 'pisces', houses_ruled: [3, 6], dignity: 'debilitated', is_retrograde: true, is_combust: true },
  jupiter: { house: 9, sign: 'sagittarius', houses_ruled: [9, 12], dignity: 'own' },
  venus: { house: 10, sign: 'pisces', houses_ruled: [2, 7], dignity: 'exalted', is_yogakaraka: true, is_retrograde: true },
  saturn: { house: 8, sign: 'scorpio', houses_ruled: [10, 11], dignity: 'enemy' },
  rahu: { house: 6, sign: 'scorpio', houses_ruled: [], dignity: 'neutral', is_retrograde: true },
  ketu: { house: 11, sign: 'taurus', houses_ruled: [], dignity: 'neutral', is_retrograde: true },
};

const SAMPLE_TRANSITS = {
  instant: '2026-04-01T00:00:00Z',
  gochara: { instant: '2026-04-01T00:00:00Z', transit_ayanamsa: 24.2, placements: {} },
  sade_sati: {
    is_active: true,
    current_phase: 'peak',
    natal_moon_sign: 'pisces',
    cycle: [
      { phase: 'rising', saturn_sign: 'aquarius', start: '2023-01-17', end: '2025-03-29' },
      { phase: 'peak', saturn_sign: 'pisces', start: '2025-03-29', end: '2027-06-03' },
    ],
    cycle_start: '2023-01-17',
    cycle_end: '2030-04-17',
  },
  slow_hits: [
    { graha: 'jupiter', kind: 'return', natal_point: 'moon', exact: '2025-03-29T00:00:00Z', severity: 'supportive' },
    { graha: 'saturn', kind: 'return', natal_point: 'lagna', exact: '2029-01-10T00:00:00Z', severity: 'challenging' },
  ],
  fusion: {
    instant: '2026-04-01T00:00:00Z',
    maha_lord: 'saturn',
    antar_lord: 'venus',
    maha_lord_transit_house_from_moon: 1,
    maha_lord_transit_house_from_lagna: 10,
    reinforcing: [],
    afflicting: [],
    net_weight: 0,
    severity: 'neutral',
  },
  timeline: {
    window_start: '2025-01-01',
    window_end: '2027-01-01',
    events: [
      {
        date: '2025-03-29',
        kind: 'sade_sati_phase',
        graha: 'saturn',
        from_sign: null,
        to_sign: null,
        from_lord: null,
        to_lord: null,
        sade_sati_phase: 'peak',
        severity: 'challenging',
        descriptor: 'sade_sati.peak',
      },
      {
        date: '2026-07-11',
        kind: 'station',
        graha: 'saturn',
        from_sign: null,
        to_sign: null,
        from_lord: null,
        to_lord: null,
        sade_sati_phase: null,
        station_direction: 'retrograde',
        station_sign: 'pisces',
        severity: 'neutral',
        descriptor: 'saturn.station.retrograde',
      },
    ],
  },
} as unknown as TransitCtx;

beforeEach(async () => {
  await i18n.changeLanguage('en');
});

describe('buildSubperiodGuide', () => {
  it('passes LAYMAN_JARGON and fixes UTC-midnight rollback, zero-length Sade Sati touch, and duplicate sade_sati_phase', () => {
    const guide = buildSubperiodGuide({
      mahaLord: 'saturn',
      subLord: 'venus',
      level: 'antar',
      startDate: '2025-03-29',
      endDate: '2027-01-31',
      audience: 'layman',
      planets: SAMPLE_PLANETS,
      yogas: [{ display_name: 'Malavya Yoga', planets_involved: ['venus'] }],
      transitCtx: SAMPLE_TRANSITS,
      t: i18n.t,
    });

    const combined = [guide.meaning, ...guide.bullets].join(' ');
    expect(findLaymanJargon(combined)).toEqual([]);
    // UTC-midnight 2025-03-29T00:00:00Z renders as Mar 29 (never rolled back to Mar 28 west of GMT).
    expect(combined).toContain(formatPredictiveWindowBound('2025-03-29T00:00:00Z'));
    expect(combined).not.toContain('Mar 28');
    expect(combined).not.toContain('03/28/2025');
    // Zero-length Rising touch (end === 2025-03-29 === startDate) is skipped; active Peak phase is selected once.
    expect(combined).toContain('Peak');
    expect(combined).not.toContain('Rising');
    expect(guide.bullets.filter((b) => b.includes('Peak'))).toHaveLength(1);
  });

  it('enforces half-open [startDate, endDate) on full ISO instants so handover events never double-count', () => {
    const transits = {
      ...SAMPLE_TRANSITS,
      sade_sati: { ...SAMPLE_TRANSITS.sade_sati, is_active: false, cycle: [] },
      timeline: { window_start: '2026-01-01', window_end: '2027-01-01', events: [] },
      slow_hits: [
        { graha: 'jupiter', kind: 'return', natal_point: 'moon', exact: '2026-05-14T10:00:00Z', severity: 'supportive' },
      ],
    } as unknown as TransitCtx;

    const outgoing = buildSubperiodGuide({
      mahaLord: 'saturn',
      subLord: 'venus',
      level: 'antar',
      startDate: '2023-12-01T04:00:00Z',
      endDate: '2026-05-14T10:00:00Z',
      audience: 'astrologer',
      transitCtx: transits,
      t: i18n.t,
    });
    const incoming = buildSubperiodGuide({
      mahaLord: 'saturn',
      subLord: 'sun',
      level: 'antar',
      startDate: '2026-05-14T10:00:00Z',
      endDate: '2027-04-20T00:00:00Z',
      audience: 'astrologer',
      transitCtx: transits,
      t: i18n.t,
    });

    expect(outgoing.bullets.some((b) => b.includes('Sky aspect'))).toBe(false);
    expect(incoming.bullets.some((b) => b.includes('Sky aspect'))).toBe(true);
  });

  it('respects classical integrity: no nodal label on classical planets, debilitated overrides yogakaraka, no retro on Rahu/Ketu, and both retro+combust kept', () => {
    // 1. Classical planet without houses_ruled never says "nodal".
    const legacyVenus = buildSubperiodGuide({
      mahaLord: 'saturn',
      subLord: 'venus',
      level: 'antar',
      startDate: '2025-01-01',
      endDate: '2026-01-01',
      audience: 'astrologer',
      planets: { venus: { house: 10, sign: 'pisces' } },
      t: i18n.t,
    });
    expect(legacyVenus.bullets.join(' ')).toContain('House 10 (Pisces).');
    expect(legacyVenus.bullets.join(' ')).not.toContain('nodal');

    // 2. Debilitated Yogakaraka (Mars in Cancer) asks for patience, never "steady footing".
    const debilMars = buildSubperiodGuide({
      mahaLord: 'sun',
      subLord: 'mars',
      level: 'antar',
      startDate: '2025-01-01',
      endDate: '2026-01-01',
      audience: 'layman',
      planets: SAMPLE_PLANETS,
      t: i18n.t,
    });
    expect(debilMars.bullets.join(' ')).toContain('extra patience');
    expect(debilMars.bullets.join(' ')).not.toContain('steady footing');

    // 3. Mean Rahu (is_retrograde: true) never claims backward motion at birth.
    const rahuLayman = buildSubperiodGuide({
      mahaLord: 'saturn',
      subLord: 'rahu',
      level: 'antar',
      startDate: '2025-01-01',
      endDate: '2026-01-01',
      audience: 'layman',
      planets: SAMPLE_PLANETS,
      t: i18n.t,
    });
    expect(rahuLayman.bullets.join(' ')).not.toContain('backward');

    // 4. Simultaneous retrograde + combust Mercury keeps BOTH notes.
    const retroCombust = buildSubperiodGuide({
      mahaLord: 'saturn',
      subLord: 'mercury',
      level: 'antar',
      startDate: '2025-01-01',
      endDate: '2026-01-01',
      audience: 'layman',
      planets: SAMPLE_PLANETS,
      t: i18n.t,
    });
    expect(retroCombust.bullets.join(' ')).toContain('backward motion');
    expect(retroCombust.bullets.join(' ')).toContain('solar proximity');

    // 5. Missing planet with yoga does not fabricate "even footing" in layman.
    const missingPlanet = buildSubperiodGuide({
      mahaLord: 'saturn',
      subLord: 'venus',
      level: 'antar',
      startDate: '2025-01-01',
      endDate: '2026-01-01',
      audience: 'layman',
      planets: null,
      yogas: [{ display_name: 'Malavya Yoga', planets_involved: ['venus'] }],
      t: i18n.t,
    });
    expect(missingPlanet.bullets).toHaveLength(1);
  });

  it('passes reflectionIssues() across all 4 locales and findLaymanJargon() on every English layman output', async () => {
    for (const lang of ['en', 'hi', 'es', 'pt'] as const) {
      await i18n.changeLanguage(lang);
      for (const audience of ['layman', 'astrologer'] as const) {
        for (const mahaLord of LORDS) {
          for (const subLord of LORDS) {
            const antar = buildSubperiodGuide({
              mahaLord,
              subLord,
              level: 'antar',
              startDate: '2025-03-29',
              endDate: '2027-01-31',
              audience,
              planets: SAMPLE_PLANETS,
              transitCtx: SAMPLE_TRANSITS,
              t: i18n.t,
            });
            for (const text of [antar.meaning, ...antar.bullets]) {
              expect(text).not.toContain('subperiod.');
              expect(reflectionIssues(text), `${lang}/${audience}/${mahaLord}-${subLord}: ${text}`).toEqual([]);
              if (lang === 'en' && audience === 'layman') {
                expect(findLaymanJargon(text), `${mahaLord}-${subLord}: ${text}`).toEqual([]);
              }
            }
          }
        }
      }
    }
  });
});
