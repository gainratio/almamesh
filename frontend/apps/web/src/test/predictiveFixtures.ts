/**
 * Typed predictive-context fixtures for component tests — built strictly from
 * `@almamesh/shared-types` so a contract drift breaks compilation, not just a
 * runtime assertion. Values are plausible engine output, NOT computed here.
 */

import type {
  AshtakavargaData,
  BalaValueData,
  DomainsCtx,
  KalaBalaData,
  LifeDomain,
  LifeDomainForecastData,
  PlanetName,
  PlanetShadbalaData,
  SthanaBalaData,
  StrengthCtx,
  StrengthAssayData,
  TransitCtx,
  VargaChartFullData,
  VargaCtxFull,
  ZodiacSign,
} from '@almamesh/shared-types';

export const ALL_SIGNS: readonly ZodiacSign[] = [
  'aries',
  'taurus',
  'gemini',
  'cancer',
  'leo',
  'virgo',
  'libra',
  'scorpio',
  'sagittarius',
  'capricorn',
  'aquarius',
  'pisces',
];

function bindusOf(values: readonly number[]): Record<ZodiacSign, number> {
  const out = {} as Record<ZodiacSign, number>;
  ALL_SIGNS.forEach((sign, i) => {
    out[sign] = values[i] ?? 0;
  });
  return out;
}

/** SAV bindus per sign — sums to the canonical 337. */
export const SAV_BINDUS = bindusOf([28, 30, 25, 29, 27, 30, 28, 26, 29, 30, 27, 28]);

export const TRANSIT_CTX: TransitCtx = {
  instant: '2026-06-09T00:00:00Z',
  gochara: {
    instant: '2026-06-09T00:00:00Z',
    transit_ayanamsa: 24.27,
    placements: {
      saturn: {
        graha: 'saturn',
        longitude: 335.42,
        sign: 'pisces',
        sign_degrees: 5.42,
        nakshatra: 'Uttara Bhadrapada',
        nakshatra_pada: 1,
        is_retrograde: false,
        house_from_lagna: 1,
        house_from_moon: 3,
        natal_sign_occupied: 'gemini',
      },
      jupiter: {
        graha: 'jupiter',
        longitude: 75.1,
        sign: 'gemini',
        sign_degrees: 15.1,
        nakshatra: 'Ardra',
        nakshatra_pada: 3,
        is_retrograde: true,
        house_from_lagna: 4,
        house_from_moon: 6,
        natal_sign_occupied: 'aquarius',
      },
    },
  },
  sade_sati: {
    is_active: true,
    current_phase: 'peak',
    natal_moon_sign: 'pisces',
    cycle: [
      { phase: 'rising', saturn_sign: 'aquarius', start: '2023-01-17', end: '2025-03-29' },
      { phase: 'peak', saturn_sign: 'pisces', start: '2025-03-29', end: '2027-06-02' },
      { phase: 'setting', saturn_sign: 'aries', start: '2027-06-02', end: '2029-08-08' },
    ],
    cycle_start: '2023-01-17',
    cycle_end: '2029-08-08',
  },
  slow_hits: [
    {
      graha: 'saturn',
      kind: 'return',
      natal_point: 'natal_saturn',
      exact: '2026-09-12T04:00:00Z',
      severity: 'challenging',
    },
    {
      graha: 'jupiter',
      kind: 'sign_ingress',
      natal_point: 'moon',
      exact: '2026-10-26T12:00:00Z',
      severity: 'supportive',
    },
  ],
  fusion: {
    instant: '2026-06-09T00:00:00Z',
    maha_lord: 'saturn',
    antar_lord: 'mercury',
    maha_lord_transit_house_from_moon: 3,
    maha_lord_transit_house_from_lagna: 1,
    reinforcing: ['jupiter'],
    afflicting: ['mars'],
    net_weight: -0.5,
    severity: 'neutral',
  },
  timeline: {
    window_start: '2026-06-09',
    window_end: '2027-06-09',
    events: [
      {
        date: '2026-10-26',
        kind: 'sign_ingress',
        graha: 'jupiter',
        from_sign: 'gemini',
        to_sign: 'cancer',
        from_lord: null,
        to_lord: null,
        sade_sati_phase: null,
        severity: 'supportive',
        descriptor: 'jupiter.ingress.cancer',
        station_direction: null,
        station_sign: null,
      },
      {
        date: '2027-02-14',
        kind: 'dasha_change',
        graha: null,
        from_sign: null,
        to_sign: null,
        from_lord: 'mercury',
        to_lord: 'ketu',
        sade_sati_phase: null,
        severity: 'neutral',
        descriptor: 'dasha.antar.mercury_to_ketu',
        station_direction: null,
        station_sign: null,
      },
    ],
  },
};

function varga(
  chart: VargaChartFullData['chart'],
  lagnaSign: ZodiacSign,
  saturnSign: ZodiacSign,
): VargaChartFullData {
  return {
    chart,
    lagna_sign: lagnaSign,
    lagna_sign_lord: 'mars',
    placements: {
      // Saturn is combust in D1; the engine carries that onto every varga.
      saturn: { graha: 'saturn', sign: saturnSign, sign_lord: 'saturn', is_combust: true },
      jupiter: { graha: 'jupiter', sign: 'pisces', sign_lord: 'jupiter', is_combust: false },
    },
  };
}

export const VARGA_CTX_FULL: VargaCtxFull = {
  charts: {
    D1: varga('D1', 'aries', 'capricorn'),
    D9: varga('D9', 'scorpio', 'aquarius'),
    D10: varga('D10', 'leo', 'capricorn'),
  },
  vargottama: [{ point: 'jupiter', sign: 'pisces' }],
  shadvarga_own_sign: [
    { graha: 'saturn', own_sign_count: 3, charts_in_own_sign: ['D1', 'D2', 'D9'] },
  ],
  vimshopaka: [
    { graha: 'saturn', score: 14.25, approximated: true },
    { graha: 'jupiter', score: 16.5, approximated: false },
  ],
};

function bala(virupas: number, approximated = false): BalaValueData {
  return { virupas, citation: 'BPHS 27', approximated, note: approximated ? 'approximated' : null };
}

function sthana(): SthanaBalaData {
  return {
    uccha: bala(30),
    saptavargaja: bala(45, true),
    ojayugma: bala(15),
    kendradi: bala(60),
    drekkana: bala(15),
    total_virupas: 165,
  };
}

function kala(): KalaBalaData {
  return {
    nathonnatha: bala(30),
    paksha: bala(40),
    tribhaga: bala(0),
    abda: bala(15),
    masa: bala(0),
    vara: bala(0),
    hora: bala(60),
    ayana: bala(24, true),
    yuddha: bala(0),
    total_virupas: 169,
  };
}

function shadbalaPlanet(planet: PlanetName, rupas: number, meets: boolean): PlanetShadbalaData {
  return {
    planet,
    sthana: sthana(),
    dig: bala(28),
    kala: kala(),
    cheshta: bala(33, true),
    naisargika: bala(8.57),
    drik: bala(-4.2),
    total_virupas: rupas * 60,
    total_rupas: rupas,
    required_rupas: 5,
    meets_minimum: meets,
  };
}

const ASHTAKAVARGA: AshtakavargaData = {
  bhinna: {
    saturn: { planet: 'saturn', bindus: bindusOf([3, 4, 2, 4, 3, 4, 3, 2, 4, 4, 3, 3]), total: 39 },
    jupiter: { planet: 'jupiter', bindus: bindusOf([5, 4, 5, 4, 5, 4, 5, 4, 5, 4, 5, 6]), total: 56 },
  },
  sarva: { bindus: SAV_BINDUS, total: 337 },
};

export const STRENGTH_CTX: StrengthCtx = {
  sunrise_utc_iso: '1990-01-15T01:12:00Z',
  ashtakavarga: ASHTAKAVARGA,
  shadbala: {
    planets: {
      // Engine-realistic full-precision float: the UI must FORMAT for display
      // (a raw 6.128260954302394 once leaked onto the Strength tab).
      saturn: shadbalaPlanet('saturn', 6.128260954302394, true),
      jupiter: shadbalaPlanet('jupiter', 4.8, false),
    },
  },
};

export const ALL_DOMAINS: readonly LifeDomain[] = [
  'career',
  'finances',
  'health',
  'relationships',
  'spiritual',
  'education',
  'family',
];

function strengthAssay(shadbalaPct: number, savPct: number): StrengthAssayData {
  const selectedId = shadbalaPct <= savPct ? 'shadbala_pct' : 'sav_pct';
  const component = (id: string, raw: number): StrengthAssayData['components'][number] => ({
    id,
    raw,
    normalized: raw / 100,
    declared_weight: null,
    operation: 'add',
    coefficient: 1,
    contribution: raw / 100,
    contribution_interval: null,
  });
  return {
    schema: 'assay.result/v1',
    method: { id: 'minimum', version: 'almamesh.domain-strength.v1' },
    score: Math.min(shadbalaPct, savPct) / 100,
    interval: null,
    clamp: 'reject',
    intercept: null,
    weight_total: null,
    components: [
      component('shadbala_pct', shadbalaPct),
      component('sav_pct', savPct),
    ],
    inputs_hash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    selected_component_id: selectedId,
  };
}

function forecast(domain: LifeDomain): LifeDomainForecastData {
  const shadbalaPct = domain === 'health' ? 38.0 : 82.5;
  const savPct = domain === 'health' ? 30.0 : 53.57;
  return {
    domain,
    houses: [
      {
        house: 10,
        sign: 'capricorn',
        lord: 'saturn',
        lord_house: 3,
        lord_sign: 'gemini',
        lord_dignity: 'neutral',
        rule: 'house_lord_placement',
      },
    ],
    karakas: [
      {
        graha: 'saturn',
        house: 3,
        sign: 'gemini',
        dignity: 'neutral',
        is_retrograde: false,
        rule: 'naisargika_karaka',
      },
    ],
    varga: {
      chart: 'D10',
      graha: 'saturn',
      sign: 'capricorn',
      sign_lord: 'saturn',
      same_sign_as_d1: true,
      vargottama: false,
      rule: 'defining_varga',
    },
    strength_summary: {
      key_graha: 'saturn',
      // Full precision on purpose — display layers must render 2 decimals.
      key_graha_rupas: 6.128260954302394,
      key_graha_meets_minimum: true,
      sav_bindus: 30,
      band: domain === 'health' ? 'weak' : 'strong',
      shadbala_pct: shadbalaPct,
      sav_pct: savPct,
      strength_pct: Math.min(shadbalaPct, savPct),
      strength_tier: 'model',
      approximated: domain === 'career',
      note: 'strength summary',
    },
    strength_assay: strengthAssay(shadbalaPct, savPct),
    current_emphasis: {
      active_dasha_significator: domain === 'career',
      dasha_levels: domain === 'career' ? ['maha', 'antar'] : [],
      matched_dasha_lords: domain === 'career' ? ['saturn'] : [],
      under_sade_sati: true,
      transit_severity: 'neutral',
      approximated: true,
      note: 'coarse vote-sum heuristic',
      rule: 'emphasis_rule',
    },
    upcoming_windows: [
      {
        date: '2026-10-26',
        source: 'transit',
        kind: 'sign_ingress',
        trigger: 'jupiter',
        severity: 'supportive',
        descriptor: 'jupiter.ingress.cancer',
      },
      {
        date: '2027-02-14',
        source: 'dasha',
        kind: 'dasha_change',
        trigger: 'ketu',
        severity: 'neutral',
        descriptor: 'dasha.antar.ketu',
      },
    ],
  };
}

function allForecasts(): Record<LifeDomain, LifeDomainForecastData> {
  const out = {} as Record<LifeDomain, LifeDomainForecastData>;
  for (const domain of ALL_DOMAINS) {
    out[domain] = forecast(domain);
  }
  return out;
}

export const DOMAINS_CTX: DomainsCtx = {
  instant: '2026-06-09T00:00:00Z',
  forecasts: allForecasts(),
};
