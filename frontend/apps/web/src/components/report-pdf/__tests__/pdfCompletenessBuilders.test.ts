/**
 * The builders behind the four completeness fixes.
 *
 *   1. `ReportDocument` ALWAYS carries the Interpretation page — the section
 *      may say "no reading yet", but it never silently disappears.
 *   2. The five narrative section titles are INJECTED (pre-localized), not
 *      hardcoded English inside the PDF layer.
 *   3. `stability` markers survive the reshape into the yoga cards and the
 *      life-domain blocks (optional — absent markers change nothing).
 *   4. `integrated_yoga_narrative` reaches the PDF as ordered paragraphs.
 *
 * All data is SYNTHETIC. The i18n catalogs are the REAL shipped ones.
 */
import { describe, it, expect } from 'vitest';
import { Children, isValidElement } from 'react';
import type { SiderealChart } from '@almamesh/browser/types';
import type { ProcessedBirthData, VedicInterpretation } from '@almamesh/shared-types';
import i18n from '../../../i18n/config';
import { buildNarrative, buildYogaNarrative } from '../buildReportSections';
import { buildReportPdfData, type BuildReportPdfDataInput } from '../buildReportPdfData';
import { ReportDocument } from '../ReportDocument';
import { ReportPdfNarrative } from '../sections/ReportPdfNarrative';
import { domainClaimId, reportStabilityMarkers, yogaClaimId } from '../../../lib/stability';
import { DOMAINS_CTX } from '../../../test/predictiveFixtures';
import type { ReportPdfLabels } from '../types';

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
  planets: {
    sun: {
      name: 'sun',
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
      house: 4,
      dignity: 'neutral',
      is_combust: false,
      combustion_separation_deg: null,
      houses_ruled: [2],
      is_yogakaraka: false,
    },
  },
  houses: Object.fromEntries(
    Array.from({ length: 12 }, (_, i) => [
      String(i + 1),
      { house: i + 1, longitude: i * 30, sign: 'Aries', sign_lord: 'mars' },
    ]),
  ) as SiderealChart['houses'],
  dashas: {
    maha_dasha_sequence: [
      { lord: 'venus', start_date: '1985-01-01', end_date: '2005-01-01', duration_years: 20 },
    ],
    current_maha: {
      lord: 'venus',
      start_date: '1985-01-01',
      end_date: '2005-01-01',
      duration_years: 20,
    },
    current_antar: null,
    current_pratyantar: null,
  },
  yogas: [
    {
      name: 'gaja_kesari',
      display_name: 'Gaja Kesari Yoga (Jupiter in kendra from Moon)',
      category: 'raja',
      description: 'Jupiter sits in a kendra from the Moon.',
      effects: 'Reputation and steadiness.',
      grade: 'strong',
      strength_factors: [],
      planets_involved: ['jupiter', 'moon'],
      houses_involved: [1, 4],
      planetary_signature: 'jupiter|moon',
      formation_rules: [],
    },
  ] as unknown as SiderealChart['yogas'],
  navamsa: {
    name: 'D9',
    lagna_sign: 'Leo',
    lagna_sign_lord: 'sun',
    planets: { sun: { name: 'sun', sign: 'Aries', sign_lord: 'mars' } },
  },
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

const CHROME_LABELS = {
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
  narrativeAbsentNote: 'No reading generated yet.',
} as ReportPdfLabels;

function baseInput(): Omit<BuildReportPdfDataInput, 'interpretation'> {
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
    detailLabels: {
      dateOfBirth: 'Date of Birth',
      timeOfBirth: 'Time of Birth',
      placeOfBirth: 'Place of Birth',
      ascendant: 'Ascendant',
    },
    chromeLabels: CHROME_LABELS,
  };
}

const INTERPRETATION: VedicInterpretation = {
  summary: { layman: 'A balanced chart.', technical: 'A balanced chart.' },
  strengths: [{ title: 'Determination', layman: 'You push through.' }],
  challenges: [{ title: 'Doubt', layman: 'You second-guess.' }],
  life_themes: [{ title: 'Reversal', layman: 'What diminishes you matures you.' }],
  current_sky: [{ title: 'Saturn Antardasha', layman: 'A steady phase.' }],
  upcoming_periods: [{ title: 'Jupiter return', layman: 'An opening in 2027.' }],
  integrated_yoga_narrative: {
    layman: 'Your yogas cohere around patience.\n\nThey point one way.',
    technical: 'Gaja Kesari with an exalted Jupiter dominates the lattice.',
  },
};

/** Every `Page` child of the document tree, flattened. */
function documentPages(data: ReturnType<typeof buildReportPdfData>): readonly unknown[] {
  const doc = ReportDocument({ data }) as { readonly props: { readonly children?: unknown } };
  return Children.toArray(doc.props.children as never);
}

/** True when some page in the document renders the Interpretation section. */
function hasNarrativePage(data: ReturnType<typeof buildReportPdfData>): boolean {
  return documentPages(data).some((page) => {
    if (!isValidElement(page)) {
      return false;
    }
    return Children.toArray((page.props as { children?: unknown }).children as never).some(
      (child) => isValidElement(child) && child.type === ReportPdfNarrative,
    );
  });
}

describe('Defect 1 — the Interpretation page is unconditional', () => {
  it('keeps the Interpretation page when no interpretation was generated', () => {
    const data = buildReportPdfData({ ...baseInput(), interpretation: undefined });
    expect(data.narrative).toBeUndefined();
    expect(hasNarrativePage(data)).toBe(true);
  });

  it('still carries the Interpretation page when a narrative exists', () => {
    const data = buildReportPdfData({ ...baseInput(), interpretation: INTERPRETATION });
    expect(hasNarrativePage(data)).toBe(true);
  });
});

describe('Defect 2 — narrative section titles are injected, not hardcoded', () => {
  const TITLES = {
    currentSky: 'AHORA-SENTINEL',
    strengths: 'FORTALEZAS-SENTINEL',
    challenges: 'DESAFIOS-SENTINEL',
    lifeThemes: 'TEMAS-SENTINEL',
    roadAhead: 'CAMINO-SENTINEL',
  };

  it('uses every injected title verbatim', () => {
    const sections = buildNarrative(INTERPRETATION, 'you', TITLES);
    const titles = sections.map((section) => section.title);
    for (const expected of Object.values(TITLES)) {
      expect(titles, expected).toContain(expected);
    }
  });

  it('emits NO hardcoded English title once localized titles are injected', () => {
    const sections = buildNarrative(INTERPRETATION, 'you', TITLES);
    const titles = sections.map((section) => section.title);
    for (const english of [
      'Strengths',
      'Challenges',
      'Life Themes',
      "What's Active Now & Next",
      'The Road Ahead',
    ]) {
      expect(titles, english).not.toContain(english);
    }
  });

  it('falls back to English when no titles are injected (old callers keep working)', () => {
    const titles = buildNarrative(INTERPRETATION, 'you').map((section) => section.title);
    expect(titles).toContain('Strengths');
    expect(titles).toContain('The Road Ahead');
  });

  it('threads the titles through buildReportPdfData', () => {
    const data = buildReportPdfData({
      ...baseInput(),
      interpretation: INTERPRETATION,
      narrativeTitles: TITLES,
    });
    const titles = (data.narrative ?? []).map((section) => section.title);
    expect(titles).toContain('FORTALEZAS-SENTINEL');
    expect(titles).not.toContain('Strengths');
  });
});

describe('Defect 3 — stability markers survive the reshape', () => {
  const stability = reportStabilityMarkers(
    [
      { claimId: yogaClaimId('gaja_kesari'), houseDependent: true },
      ...Object.keys(DOMAINS_CTX.forecasts).map((domain) => ({
        claimId: domainClaimId(domain),
        houseDependent: true,
      })),
    ],
    true, // near-cusp → every house-dependent verdict is birth-time SENSITIVE
  );
  const formatStability = (marker: { readonly holdsUnderBoth: boolean }): string =>
    i18n.t(marker.holdsUnderBoth ? 'report:stability.stable' : 'report:stability.sensitive');

  it('carries the yoga stability flag onto the yoga card', () => {
    const data = buildReportPdfData({
      ...baseInput(),
      interpretation: undefined,
      stability,
      formatStability,
    });
    expect(data.yogas[0]?.stability).toBe('birth-time sensitive');
  });

  it('carries the domain stability flag onto every domain block', () => {
    const data = buildReportPdfData({
      ...baseInput(),
      interpretation: undefined,
      stability,
      formatStability,
      comprehensive: {
        translators: { tr: i18n.getFixedT(null, 'report'), tp: i18n.getFixedT(null, 'predictive') },
        domainsCtx: DOMAINS_CTX,
      },
    });
    const blocks = data.domains?.blocks ?? [];
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.every((block) => block.stability === 'birth-time sensitive')).toBe(true);
  });

  it('leaves both undefined when no markers were supplied (older payloads)', () => {
    const data = buildReportPdfData({
      ...baseInput(),
      interpretation: undefined,
      comprehensive: {
        translators: { tr: i18n.getFixedT(null, 'report'), tp: i18n.getFixedT(null, 'predictive') },
        domainsCtx: DOMAINS_CTX,
      },
    });
    expect(data.yogas[0]?.stability).toBeUndefined();
    expect(data.domains?.blocks.every((block) => block.stability === undefined)).toBe(true);
  });
});

describe('Defect 4 — integrated_yoga_narrative reaches the PDF', () => {
  it('splits the woven yoga story into ordered paragraphs for the audience voice', () => {
    const paragraphs = buildYogaNarrative(INTERPRETATION, 'you');
    expect(paragraphs).toEqual([
      'Your yogas cohere around patience.',
      'They point one way.',
    ]);
  });

  it('resolves the technical voice for the astrologer audience', () => {
    expect(buildYogaNarrative(INTERPRETATION, 'astrologer')?.join(' ')).toContain(
      'dominates the lattice',
    );
  });

  it('is undefined when the reading omits the woven narrative', () => {
    const bare: VedicInterpretation = {
      summary: { layman: 'x' },
      strengths: [],
      challenges: [],
      life_themes: [],
    };
    expect(buildYogaNarrative(bare, 'you')).toBeUndefined();
  });

  it('threads onto ReportPdfData through buildReportPdfData', () => {
    const data = buildReportPdfData({ ...baseInput(), interpretation: INTERPRETATION });
    expect(data.yogaNarrative?.[0]).toBe('Your yogas cohere around patience.');
  });

  it('is undefined on a natal-only report', () => {
    const data = buildReportPdfData({ ...baseInput(), interpretation: undefined });
    expect(data.yogaNarrative).toBeUndefined();
  });
});
