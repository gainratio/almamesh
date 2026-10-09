/**
 * buildReportPdfData — the comprehensive report slices (Spec 062).
 *
 * Covers: the always-present houses rows; the all-mahā antar drill-down; the
 * optional transits / vargas (all 16 plates, 4-per-page chunking) / strength
 * (BAV matrix + six-component Ṣaḍbala) / domains slices — built ONLY when the
 * predictive contexts + translators are supplied (the PDF mirrors the web
 * report); the Birth Time Authority slice (raw margins stay hidden, while an
 * evidence-gated aggregate percentage may render); and a full-document smoke test.
 *
 * Localization runs through the REAL i18n catalogs (the same `t` the page
 * passes), so PDF copy is asserted against the shipped strings.
 * All data is SYNTHETIC (a "Reference Native", Bengaluru) — never real birth data.
 */

import { describe, it, expect } from 'vitest';
import { Children, isValidElement, type ReactNode } from 'react';
import type { SiderealChart } from '@almamesh/browser/types';
import type {
  DivisionalChartId,
  DomainsCtx,
  ProcessedBirthData,
  RectificationRecord,
  VargaChartFullData,
  VargaCtxFull,
  ZodiacSign,
} from '@almamesh/shared-types';
import i18n from '../../../i18n/config';
import { buildReportPdfData, type BuildReportPdfDataInput } from '../buildReportPdfData';
import { buildRectificationPdf } from '../buildRectificationPdf';
import { chunkVargaPlates, VARGA_PLATES_PER_PAGE } from '../sections/ReportPdfVargas';
import { ReportPdfDashaTables } from '../sections/ReportPdfDasha';
import { ReportDocument } from '../ReportDocument';
import type { ReportPdfLabels } from '../types';
import {
  DOMAINS_CTX,
  STRENGTH_CTX,
  TRANSIT_CTX,
  VARGA_CTX_FULL,
} from '../../../test/predictiveFixtures';
import type { StrengthProvenance } from '../../../lib/strengthProvenance';

function collectText(node: ReactNode): readonly string[] {
  if (typeof node === 'string' || typeof node === 'number') {
    return [String(node)];
  }
  if (!isValidElement<{ readonly children?: ReactNode }>(node)) {
    return [];
  }
  const props = node.props;
  if (typeof node.type === 'function') {
    const Component = node.type as (value: typeof props) => ReactNode;
    return collectText(Component(props));
  }
  return Children.toArray(props.children).flatMap((child) => collectText(child));
}

/* ── translators: the REAL i18n catalogs, exactly what ReportView passes ── */
const TRANSLATORS = {
  tr: i18n.getFixedT(null, 'report'),
  tp: i18n.getFixedT(null, 'predictive'),
};

/* ── a small-but-complete synthetic engine chart (Title-Case signs) ──────── */
function planet(name: string, house: number): SiderealChart['planets'][string] {
  return {
    name,
    longitude: 100.5,
    latitude: 0,
    distance: 1,
    speed: 1,
    is_retrograde: false,
    sign: 'Cancer',
    sign_degrees: 10.5,
    sign_lord: 'moon',
    nakshatra: 'Pushya',
    nakshatra_pada: 1,
    nakshatra_lord: 'saturn',
    house,
    dignity: 'neutral',
    is_combust: false,
    combustion_separation_deg: null,
    houses_ruled: [2],
    is_yogakaraka: false,
  } as SiderealChart['planets'][string];
}

const SIGNS = [
  'Aries', 'Taurus', 'Gemini', 'Cancer', 'Leo', 'Virgo',
  'Libra', 'Scorpio', 'Sagittarius', 'Capricorn', 'Aquarius', 'Pisces',
];

const CHART: SiderealChart = {
  ayanamsa_value: 23.86,
  lagna: {
    longitude: 5.4,
    sign: 'Aries',
    sign_degrees: 5.4,
    sign_lord: 'mars',
    nakshatra: 'Ashwini',
    nakshatra_pada: 2,
    nakshatra_lord: 'ketu',
  },
  planets: { sun: planet('sun', 4), ketu: planet('ketu', 4), saturn: planet('saturn', 10) },
  houses: Object.fromEntries(
    SIGNS.map((sign, i) => [
      String(i + 1),
      { house: i + 1, longitude: i * 30, sign, sign_lord: 'mars' },
    ]),
  ) as SiderealChart['houses'],
  dashas: {
    maha_dasha_sequence: [
      {
        lord: 'venus',
        start_date: '1985-01-01',
        end_date: '2005-01-01',
        duration_years: 20,
        antar_sequence: [
          { lord: 'venus', start_date: '1985-01-01', end_date: '1988-05-01', duration_years: 3.33 },
          { lord: 'sun', start_date: '1988-05-01', end_date: '1989-05-01', duration_years: 1 },
        ],
      },
      {
        lord: 'sun',
        start_date: '2005-01-01',
        end_date: '2011-01-01',
        duration_years: 6,
        antar_sequence: [
          { lord: 'sun', start_date: '2005-01-01', end_date: '2005-04-19', duration_years: 0.3 },
        ],
      },
    ],
    current_maha: {
      lord: 'venus',
      start_date: '1985-01-01',
      end_date: '2005-01-01',
      duration_years: 20,
    },
    current_antar: {
      lord: 'sun',
      start_date: '1988-05-01',
      end_date: '1989-05-01',
      duration_years: 1,
    },
    current_pratyantar: {
      lord: 'jupiter',
      start_date: '1988-11-01',
      end_date: '1989-01-01',
      duration_years: 0.17,
    },
    pratyantar_sequence: [
      { lord: 'sun', start_date: '1988-05-01', end_date: '1988-06-01', duration_years: 0.08 },
      { lord: 'moon', start_date: '1988-06-01', end_date: '1988-07-15', duration_years: 0.12 },
      { lord: 'mars', start_date: '1988-07-15', end_date: '1988-08-15', duration_years: 0.08 },
      { lord: 'rahu', start_date: '1988-08-15', end_date: '1988-10-01', duration_years: 0.13 },
      { lord: 'jupiter', start_date: '1988-11-01', end_date: '1989-01-01', duration_years: 0.17 },
      { lord: 'saturn', start_date: '1989-01-01', end_date: '1989-02-15', duration_years: 0.12 },
      { lord: 'mercury', start_date: '1989-02-15', end_date: '1989-03-15', duration_years: 0.08 },
      { lord: 'ketu', start_date: '1989-03-15', end_date: '1989-04-01', duration_years: 0.05 },
      { lord: 'venus', start_date: '1989-04-01', end_date: '1989-05-01', duration_years: 0.08 },
    ],
  },
  yogas: [],
  navamsa: null,
};

const BIRTH: ProcessedBirthData = {
  birth_datetime_utc: '1990-03-30T06:30:00Z',
  birth_datetime_local: '1990-03-30T12:00:00',
  birth_location_details: {
    city: 'Bengaluru',
    state: 'Karnataka',
    country: 'India',
    latitude: 12.97,
    longitude: 77.59,
    timezone: 'Asia/Kolkata',
  },
} as ProcessedBirthData;

const CHROME_LABELS: ReportPdfLabels = {
  preparedFor: 'Prepared for',
  birthDetailsTitle: 'Birth Details',
  birthDetailsEyebrow: 'Section I',
  birthDetailsIntro: 'intro',
  technicalNote: 'note',
  footerNote: 'AlmaMesh',
  planetsEyebrow: 'Section II',
  planetsTitle: 'Planets',
  planetsIntro: 'intro',
  colPlanet: 'Graha',
  colSign: 'Sign',
  colDegree: 'Degree',
  colNakshatra: 'Nakshatra',
  colHouse: 'Hse',
  colDignity: 'Dignity',
  colState: 'State',
  stateRetrograde: 'Retro (R)',
  lagnaRowName: 'Ascendant',
  housesEyebrow: 'Section III',
  housesTitle: 'Houses',
  housesIntro: 'intro',
  colHouseNumber: 'House',
  colHouseSign: 'Sign',
  colHouseLord: 'Sign Lord',
  colOccupants: 'Occupants',
  housesNote: 'Whole-sign houses.',
  chartsEyebrow: 'Section IV',
  chartsTitle: 'Kundli',
  chartsIntro: 'intro',
  dashaEyebrow: 'Section V',
  dashaTitle: 'Dasha',
  dashaIntro: 'intro',
  dashaCurrentLabel: 'Current',
  dashaCurrentMarker: 'Current',
  dashaSequenceLabel: 'Sequence',
  yogasEyebrow: 'Section VI',
  yogasTitle: 'Yogas',
  yogasIntro: 'intro',
  narrativeEyebrow: 'Section VII',
  narrativeTitle: 'Interpretation',
  narrativeIntro: 'intro',
};

function baseInput(): BuildReportPdfDataInput {
  return {
    personName: 'Asha Rao',
    audienceLabel: 'For You',
    subtitle: 'subtitle',
    kicker: 'kicker',
    generatedAt: '1990-03-30T06:30:00Z',
    birth: BIRTH,
    lagna: CHART.lagna,
    chart: { ayanamsa_value: CHART.ayanamsa_value },
    sidereal: CHART,
    audience: 'you',
    chartCaptions: { rasi: 'Rasi', navamsa: 'Navamsa' },
    formatAntarHeading: (lord) => `Antar-dasas of the ${lord} Maha-dasa`,
    formatPratyantarHeading: (lord) => `Pratyantar-dasas of the ${lord} Antar-dasa`,
    detailLabels: {
      dateOfBirth: 'Date of Birth',
      timeOfBirth: 'Time of Birth',
      placeOfBirth: 'Place of Birth',
      ascendant: 'Ascendant',
    },
    chromeLabels: CHROME_LABELS,
  };
}

const RECORD: RectificationRecord = {
  profileId: 'profile-1',
  confirmedAt: '2026-05-01T12:00:00.000Z',
  mode: 'window',
  band: 'consistent',
  margin: 0.8125, // display-only in the store — must NEVER reach the PDF data
  originalTime: '',
  originalSign: null,
  rectifiedTime: '06:10',
  rectifiedSign: 'taurus',
  supportingEventIds: ['evt-1'],
};

/** The full-emission varga fixture: all sixteen charts present. */
const ALL_16: readonly DivisionalChartId[] = [
  'D1', 'D2', 'D3', 'D4', 'D7', 'D9', 'D10', 'D12',
  'D16', 'D20', 'D24', 'D27', 'D30', 'D40', 'D45', 'D60',
];
function varga(chart: DivisionalChartId, lagnaSign: ZodiacSign): VargaChartFullData {
  return {
    chart,
    lagna_sign: lagnaSign,
    lagna_sign_lord: 'mars',
    placements: {
      saturn: { graha: 'saturn', sign: 'capricorn', sign_lord: 'saturn', is_combust: false },
    },
  };
}
const FULL_16_CTX: VargaCtxFull = {
  ...VARGA_CTX_FULL,
  charts: Object.fromEntries(ALL_16.map((id) => [id, varga(id, 'aries')])) as VargaCtxFull['charts'],
};

const DOMAINS_WITH_ASSAY: DomainsCtx = {
  ...DOMAINS_CTX,
  forecasts: {
    ...DOMAINS_CTX.forecasts,
    career: {
      ...DOMAINS_CTX.forecasts.career,
      strength_assay: {
        schema: 'assay.result/v1',
        method: { id: 'minimum', version: 'almamesh.domain-strength.v1' },
        score: 0.5357,
        interval: null,
        clamp: 'reject',
        intercept: null,
        weight_total: null,
        components: [
          {
            id: 'shadbala_pct', raw: 82.5, normalized: 0.825, declared_weight: null,
            operation: 'add', coefficient: 1, contribution: 0.825, contribution_interval: null,
          },
          {
            id: 'sav_pct', raw: 53.57, normalized: 0.5357, declared_weight: null,
            operation: 'add', coefficient: 1, contribution: 0.5357, contribution_interval: null,
          },
        ],
        inputs_hash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        selected_component_id: 'sav_pct',
      },
    },
  },
};

const COMPREHENSIVE = {
  translators: TRANSLATORS,
  transitCtx: TRANSIT_CTX,
  vargaCtxFull: FULL_16_CTX,
  strengthCtx: STRENGTH_CTX,
  domainsCtx: DOMAINS_WITH_ASSAY,
};

describe('buildReportPdfData — houses (always present)', () => {
  it('builds 12 house rows with sign, lord and grouped occupants', () => {
    const data = buildReportPdfData(baseInput());
    expect(data.houses).toHaveLength(12);
    expect(data.houses[0]).toEqual({
      house: '1',
      sign: 'Aries',
      signLord: 'Mars',
      occupants: '—',
    });
    expect(data.houses[3].occupants).toBe('Sun, Ketu'); // canonical graha order
    expect(data.houses[9].occupants).toBe('Saturn');
  });
});

describe('buildReportPdfData — all-mahā antar tables', () => {
  it('emits one antar table per mahā carrying depth, with localized headings', () => {
    const data = buildReportPdfData(baseInput());
    expect(data.dasha.antarTables).toHaveLength(2);
    expect(data.dasha.antarTables[0].heading).toBe('Antar-dasas of the Venus Maha-dasa');
    expect(data.dasha.antarTables[0].periods).toHaveLength(2);
    expect(data.dasha.antarTables[1].heading).toBe('Antar-dasas of the Sun Maha-dasa');
  });

  it('marks the running antar ONLY inside the running mahā', () => {
    const data = buildReportPdfData(baseInput());
    const flat = data.dasha.antarTables.flatMap((t) => t.periods);
    const running = flat.filter((p) => p.isCurrent);
    expect(running).toHaveLength(1);
    expect(running[0].lord).toBe('Sun');
    // The Sun ANTAR inside Venus mahā is current — the Sun mahā's own Sun antar
    // must NOT be marked (different mahā).
    expect(data.dasha.antarTables[1].periods.every((p) => !p.isCurrent)).toBe(true);
  });

  it("exports every pratyantar period for the running antar", () => {
    const data = buildReportPdfData(baseInput());

    expect(data.dasha.antarTables[0]).toMatchObject({
      pratyantarTable: {
        heading: 'Pratyantar-dasas of the Sun Antar-dasa',
        periods: [
          { lord: 'Sun', isCurrent: false },
          { lord: 'Moon', isCurrent: false },
          { lord: 'Mars', isCurrent: false },
          { lord: 'Rahu', isCurrent: false },
          { lord: 'Jupiter', isCurrent: true },
          { lord: 'Saturn', isCurrent: false },
          { lord: 'Mercury', isCurrent: false },
          { lord: 'Ketu', isCurrent: false },
          { lord: 'Venus', isCurrent: false },
        ],
      },
    });
  });

  it("renders the running antar's localized pratyantar table", () => {
    const data = buildReportPdfData(baseInput());
    const text = collectText(
      ReportPdfDashaTables({ tables: data.dasha.antarTables, currentMarker: 'Current' }),
    );

    expect(text).toContain('Pratyantar-dasas of the Sun Antar-dasa');
    expect(text).toContain('Venus');
    expect(text).toContain('May 1989');
  });
});

describe('buildReportPdfData — comprehensive slices mirror the web report', () => {
  it('omits every comprehensive slice when no contexts were computed', () => {
    const data = buildReportPdfData(baseInput());
    expect(data.transits).toBeUndefined();
    expect(data.vargas).toBeUndefined();
    expect(data.strength).toBeUndefined();
    expect(data.domains).toBeUndefined();
    expect(data.rectification).toBeUndefined();
  });

  it('builds the transits slice: gochara, sade sati, slow hits, fusion, timeline', () => {
    const data = buildReportPdfData({ ...baseInput(), comprehensive: COMPREHENSIVE });
    const transits = data.transits;
    expect(transits).toBeDefined();
    expect(transits?.gochara.rows).toHaveLength(2); // saturn + jupiter placements
    expect(transits?.slowHits.rows).toHaveLength(2);
    // Slow-hit copy matches the web report ('→' maps to ASCII '->' for the
    // latin-subset print fonts). It mapped to an em dash until reading a real
    // export showed what that costs: an em dash turns every DIRECTIONAL
    // statement into an ambiguous range. "Saturn — natal Saturn" reads as a
    // span; the line means a transit arriving ON a natal point.
    expect(transits?.slowHits.rows[0].cells[1]).toBe('Saturn -> natal Saturn');
    expect(transits?.slowHits.rows[0].cells[2]).toBe('Challenging');
    expect(transits?.timeline.rows).toHaveLength(2);
    expect(transits?.sadeSati.length).toBeGreaterThanOrEqual(2);
  });

  it('builds all sixteen varga plates in canonical order, chunked 4 per page', () => {
    const data = buildReportPdfData({ ...baseInput(), comprehensive: COMPREHENSIVE });
    const vargas = data.vargas;
    expect(vargas?.plates.map((p) => p.id)).toEqual([...ALL_16]);
    // Sign-precision geometry only — a degree readout would be fabricated.
    expect(vargas?.plates.every((p) => p.geometry.precision === 'sign')).toBe(true);
    const pages = chunkVargaPlates(vargas?.plates ?? []);
    expect(pages).toHaveLength(16 / VARGA_PLATES_PER_PAGE);
    expect(pages.every((page) => page.length === VARGA_PLATES_PER_PAGE)).toBe(true);
  });

  it('builds the strength slice: SAV cells, BAV matrix + totals, six-component Ṣaḍbala', () => {
    const data = buildReportPdfData({ ...baseInput(), comprehensive: COMPREHENSIVE });
    const strength = data.strength;
    expect(strength?.savCells).toHaveLength(12);
    expect(strength?.savHeading).toContain('337');
    // BAV: 12 sign rows + an emphasised totals row; fixture grahas Jupiter+Saturn.
    expect(strength?.bav.rows).toHaveLength(13);
    expect(strength?.bav.rows[12].emphasis).toBe(true);
    expect(strength?.bav.rows[12].cells).toEqual(['Total', '56', '39']);
    // Ṣaḍbala: ten columns, two-decimal formatting (never the raw float).
    expect(strength?.shadbala.headers).toHaveLength(10);
    const saturn = strength?.shadbala.rows.find((r) => r.cells[0].includes('Saturn'));
    expect(saturn?.cells).toContain('165.00');
    expect(saturn?.cells).toContain('6.13');
    expect(JSON.stringify(strength)).not.toContain('6.128260954302394');
  });

  it('builds the seven domain blocks with dated windows', () => {
    const data = buildReportPdfData({ ...baseInput(), comprehensive: COMPREHENSIVE });
    expect(data.domains?.blocks).toHaveLength(7);
    expect(data.domains?.blocks.every((b) => b.windows.length === 2)).toBe(true);
  });
});

describe('buildReportPdfData — domain-strength provenance withholds tampered %s', () => {
  it('builds sibling Assay calculation and Avow verification panels for each domain', () => {
    const data = buildReportPdfData({ ...baseInput(), comprehensive: COMPREHENSIVE });
    const career = data.domains?.blocks.find((b) => b.name === 'Career');

    expect(career?.assay).toEqual({
      heading: 'How calculated — Assay',
      method: 'The headline is the lower of the two normalized 0–100 inputs; higher is stronger.',
      components: [
        { label: 'Sadbala', value: '82.50%' },
        { label: 'Astakavarga', value: '53.57%' },
        { label: 'Headline (lower of the two)', value: '53.57%' },
      ],
    });
    expect(career?.avow).toEqual({
      heading: 'What verified — Avow',
      status: 'Unavailable',
      scope: 'Avow checks this strength summary for tamper evidence and integrity since this engine boot — not correctness or identity.',
    });
  });

  it('renders every domain\'s numeric percentages when no provenance is supplied', () => {
    const data = buildReportPdfData({ ...baseInput(), comprehensive: COMPREHENSIVE });
    const career = data.domains?.blocks.find((b) => b.name === 'Career');
    expect(career?.band).toMatch(/%/);
    expect(career?.strengthAxes).toMatch(/%/);
  });

  it("withholds ONLY the failed domain's %s, with an honest note — others untouched", () => {
    const provenance: StrengthProvenance = {
      verified: new Set(['finances', 'health', 'relationships', 'spiritual', 'education', 'family']),
      failed: ['career'],
      signerPublicKey: 'test-signer',
    };
    const data = buildReportPdfData({
      ...baseInput(),
      comprehensive: { ...COMPREHENSIVE, provenance },
    });
    const career = data.domains?.blocks.find((b) => b.name === 'Career');
    const finances = data.domains?.blocks.find((b) => b.name === 'Finances');

    // The withheld domain: no digits anywhere (no fabricated-looking % left
    // behind), but the band/tier label survives and an honest note is present.
    expect(career?.band).not.toMatch(/\d/);
    expect(career?.strengthAxes).not.toMatch(/\d/);
    expect(career?.band).toContain('Strong');
    expect(career?.strengthAxes.length).toBeGreaterThan(0);
    expect(career?.avow.status).toBe('Failed');
    expect(career?.assay.components).toEqual([]);
    expect(career?.assay.method).toContain('withheld');
    expect(JSON.stringify(career?.assay)).not.toMatch(/82\.50|53\.57/);

    // An unrelated verified domain keeps its normal numeric rendering.
    expect(finances?.band).toMatch(/%/);
    expect(finances?.strengthAxes).toMatch(/%/);
  });

  it('changes only Avow status when every domain verifies; calculated figures stay identical', () => {
    const allVerified: StrengthProvenance = {
      verified: new Set(Object.keys(DOMAINS_CTX.forecasts)),
      failed: [],
      signerPublicKey: 'test-signer',
    };
    const withProvenance = buildReportPdfData({
      ...baseInput(),
      comprehensive: { ...COMPREHENSIVE, provenance: allVerified },
    });
    const withoutProvenance = buildReportPdfData({ ...baseInput(), comprehensive: COMPREHENSIVE });

    const verifiedBlocks = withProvenance.domains?.blocks ?? [];
    const unavailableBlocks = withoutProvenance.domains?.blocks ?? [];
    expect(verifiedBlocks.every((block) => block.avow.status === 'Verified')).toBe(true);
    expect(unavailableBlocks.every((block) => block.avow.status === 'Unavailable')).toBe(true);
    expect(
      verifiedBlocks.map(({ avow: _avow, ...block }) => block),
    ).toEqual(unavailableBlocks.map(({ avow: _avow, ...block }) => block));
  });
});

describe('buildRectificationPdf — legacy record without aggregate confidence', () => {
  it('carries entered/working clocks, mode, band and confirm date without exposing raw margin', () => {
    const slice = buildRectificationPdf({
      record: { ...RECORD, originalTime: '07:30', originalSign: 'aquarius' },
      events: [{ date: '2015-06-20', category: 'marriage', summary: 'Married in Bengaluru' }],
      t: TRANSLATORS.tr,
    });
    const values = slice.facts.map((f) => f.value);
    expect(values[0]).toContain('07:30');
    expect(values[0]).toContain('Aquarius');
    expect(values[1]).toContain('06:10');
    expect(values[1]).toContain('Taurus');
    expect(values[3]).toBe('Consistent'); // rectify:band.* reused verbatim
    expect(slice.events.rows).toHaveLength(1);
    // Date-only event dates print as the WRITTEN calendar date (no UTC-reparse
    // day rollback west of GMT).
    expect(slice.events.rows[0].cells[0]).toBe('06/20/2015');
    expect(slice.events.rows[0].cells[1]).toBe('Marriage');
    expect(slice.events.rows[0].cells[2]).toBe('Married in Bengaluru');
    // Raw margin stays hidden; this legacy fixture has no confidencePct, so the
    // builder must not invent an aggregate percentage.
    const serialized = JSON.stringify(slice);
    expect(serialized).not.toContain('0.8125');
    expect(serialized).not.toContain('%');
  });

  it('renders the honest "Not recorded" entered time when the clock was unknown', () => {
    const slice = buildRectificationPdf({ record: RECORD, events: [], t: TRANSLATORS.tr });
    expect(slice.facts[0].value).toBe('Not recorded');
    expect(slice.events.rows).toHaveLength(0);
    expect(slice.caveat).toContain('resolves the rising sign, not the exact minute');
  });

  it('threads through buildReportPdfData untouched', () => {
    const slice = buildRectificationPdf({ record: RECORD, events: [], t: TRANSLATORS.tr });
    const data = buildReportPdfData({ ...baseInput(), rectification: slice });
    expect(data.rectification).toBe(slice);
  });
});

describe('ReportDocument — full comprehensive render', () => {
  it('renders without throwing with every comprehensive section present', () => {
    const slice = buildRectificationPdf({ record: RECORD, events: [], t: TRANSLATORS.tr });
    const data = buildReportPdfData({
      ...baseInput(),
      comprehensive: COMPREHENSIVE,
      rectification: slice,
    });
    expect(() => ReportDocument({ data })).not.toThrow();
    const text = collectText(ReportDocument({ data })).join(' ');
    expect(text).toContain('How calculated — Assay');
    expect(text).toContain('What verified — Avow');
    expect(text).toContain('Unavailable');
  });

  it('still renders the natal-only document (no comprehensive data)', () => {
    const data = buildReportPdfData(baseInput());
    expect(() => ReportDocument({ data })).not.toThrow();
  });
});

describe('buildReportPdfData — strength sunrise in the birthplace zone', () => {
  it('prints the Kalabala sunrise on the birth zone\'s calendar and clock', () => {
    // STRENGTH_CTX sunrise 1990-01-15T01:12Z = 06:42 Jan 15 in Asia/Kolkata
    // (the fixture birth zone); a viewer west of UTC would see Jan 14.
    const data = buildReportPdfData({ ...baseInput(), comprehensive: COMPREHENSIVE });
    const note = data.strength?.sunriseNote ?? '';
    expect(note).toMatch(/Jan 15, 1990/);
    expect(note).toMatch(/6:42/);
    expect(note).toMatch(/Asia\/Kolkata/);
  });
});

