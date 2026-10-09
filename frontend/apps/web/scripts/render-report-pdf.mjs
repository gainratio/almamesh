/**
 * render-report-pdf.mjs — eye-inspection harness for the @react-pdf report.
 *
 * Renders the FULL COMPREHENSIVE document (cover · birth details · planets ·
 * houses · D1+D9 kundli · Vimshottari daśā with every mahā's antars · yogas ·
 * interpretation · transits · all sixteen varga plates · strength · domains ·
 * Birth Time Authority) to a real PDF using realistic fixtures, WITHOUT a
 * browser. @react-pdf runs natively under Node, so this writes
 * `.report-out/sample-report.pdf` for visual review at every stage.
 *
 *   bun run report:pdf:sample
 *
 * The natal fixture is built from a REAL engine chart for the reference native,
 * 08 Aug 1988, RECTIFIED to 06:14 IST, Bengaluru (`.report-out/reference_chart.json`,
 * produced by `uv run almamesh-chart "1988-08-08T06:14:00+05:30" 12.9716 77.5946`).
 * The chart is reshaped by the SAME `buildReportSections` helpers the React app
 * uses, so the kundli geometry, planet table, houses, dasha, and yogas are
 * authentic — not hand-mocked. The comprehensive sections render from the shared
 * SYNTHETIC predictive fixtures (`src/test/predictiveFixtures.ts`) through the
 * SAME `buildComprehensiveSections` builders + the REAL en catalogs, so the
 * layout under inspection is the shipping one. The cover / birth-details /
 * interpretation strings are authored literals.
 *
 * Fonts are registered from the on-disk `public/fonts/*.ttf` (the same files the
 * browser serves from `/fonts/*`) — zero network egress, byte-identical glyphs.
 *
 * NOTE: this MUST run under Node (not Bun): fontkit cannot subset the instanced
 * variable .ttf faces under Bun's loader (blank glyphs). `bun run report:pdf:sample`
 * shells out to `node --import tsx` for exactly this reason.
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { Font, renderToFile } from '@react-pdf/renderer';
import i18next from 'i18next';

/**
 * The report-pdf builders must stay plain-Node loadable: no React panel
 * modules, no stylesheets, no engine runtime (`?worker` imports). The unit gate
 * runs this script (`reportPdfSampleScript.test.ts`), so a Vite-only import
 * reaching the builders fails CI instead of silently breaking this harness.
 */
const { ReportDocument } = await import('../src/components/report-pdf/ReportDocument.tsx');
const {
  buildCharts,
  buildD1Geometry,
  buildDasha,
  buildHouses,
  buildNarrative,
  buildPlanetRows,
  buildYogaNarrative,
  buildYogas,
} = await import('../src/components/report-pdf/buildReportSections.ts');
const { buildDomainsSection, buildStrengthSection, buildTransitsSection, buildVargasSection } =
  await import('../src/components/report-pdf/buildComprehensiveSections.ts');
const { buildRectificationPdf } = await import(
  '../src/components/report-pdf/buildRectificationPdf.ts'
);
const { glyphSafe } = await import('../src/components/report-pdf/glyphSafe.ts');
const { domainClaimId, reportStabilityMarkers, yogaClaimId } = await import(
  '../src/lib/stability.ts'
);
const { cuspInfo } = await import('../src/lib/lagnaCusp.ts');
const { DOMAINS_CTX, STRENGTH_CTX, TRANSIT_CTX, VARGA_CTX_FULL } = await import(
  '../src/test/predictiveFixtures.ts'
);
const { default: enReport } = await import('../src/locales/en/report.json');
const { default: enPredictive } = await import('../src/locales/en/predictive.json');
const { default: enRectify } = await import('../src/locales/en/rectify.json');

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, '..');
const FONT_DIR = resolve(APP_ROOT, 'public/fonts');
// `REPORT_OUT_DIR` / `REPORT_CHART_FILE` override the defaults so the unit gate
// (`reportPdfSampleScript.test.ts`) can run this exact script on the committed
// Bengaluru reference chart without the Python engine.
const OUT_DIR = resolve(process.env.REPORT_OUT_DIR ?? resolve(APP_ROOT, '.report-out'));
const CHART_FILE = resolve(process.env.REPORT_CHART_FILE ?? resolve(OUT_DIR, 'reference_chart.json'));

// `REPORT_FIXTURE=natal-only` renders the graceful natal-only degradation: the
// deterministic halves (cover · birth details · planets · kundli · dasha · yogas)
// with NO interpretation. The Interpretation section still PRINTS — carrying a
// short honest note that no AI reading has been generated — so the artifact
// never silently hides a section. Any other value renders the full report.
const FIXTURE = process.env.REPORT_FIXTURE ?? 'full';
const NATAL_ONLY = FIXTURE === 'natal-only';
const OUT_FILE = resolve(OUT_DIR, NATAL_ONLY ? 'sample-report-natal-only.pdf' : 'sample-report.pdf');

/**
 * Re-register the report fonts from absolute LOCAL file paths. The document's
 * module-load registration used URL paths (/fonts/…) which Node cannot fetch;
 * re-registering the same families points them at on-disk .ttf for the Node render.
 */
function registerLocalFonts() {
  Font.registerHyphenationCallback((word) => [word]);
  Font.register({
    family: 'Fraunces Report',
    fonts: [
      { src: resolve(FONT_DIR, 'Fraunces-Regular.ttf'), fontWeight: 400 },
      { src: resolve(FONT_DIR, 'Fraunces-SemiBold.ttf'), fontWeight: 600 },
      { src: resolve(FONT_DIR, 'Fraunces-Italic.ttf'), fontWeight: 400, fontStyle: 'italic' },
    ],
  });
  Font.register({
    family: 'Hanken Grotesk Report',
    fonts: [
      { src: resolve(FONT_DIR, 'HankenGrotesk-Report-Regular.ttf'), fontWeight: 400 },
      { src: resolve(FONT_DIR, 'HankenGrotesk-Report-Medium.ttf'), fontWeight: 500 },
      { src: resolve(FONT_DIR, 'HankenGrotesk-Report-SemiBold.ttf'), fontWeight: 600 },
    ],
  });
  Font.register({
    family: 'Spline Sans Mono Report',
    fonts: [
      { src: resolve(FONT_DIR, 'SplineSansMono-Regular.ttf'), fontWeight: 400 },
      { src: resolve(FONT_DIR, 'SplineSansMono-SemiBold.ttf'), fontWeight: 600 },
    ],
  });
}

/**
 * An authored sample interpretation in the `VedicInterpretation` shape — the
 * narrative the optional LLM produces in the app. This is ILLUSTRATIVE sample
 * copy used only to exercise the report layout end-to-end; it does not describe
 * the reference native's actual placements (the real narrative comes from the
 * optional LLM against the engine-computed chart).
 */
const SAMPLE_INTERPRETATION = {
  summary:
    'An ascendant lit by an exalted Venus rising in the first house gives a life shaped ' +
    'by aesthetic sensitivity, devotion, and an unusual capacity to find meaning in the unseen. ' +
    'Jupiter, your chart lord, sits debilitated yet rescued (Neecha Bhanga) — a signature of ' +
    'hard-won wisdom: the very places you feel diminished become, with time, your deepest ' +
    'authority. With every graha caught between the lunar nodes (Kala Sarpa), life tends to move ' +
    'in concentrated chapters rather than scattered ease.',
  strengths: [
    {
      title: 'Exalted Venus in the First',
      layman:
        'Venus, the planet of beauty and relationship, is at its strongest in your rising sign. ' +
        'People feel an immediate warmth and grace in your presence, and you have a natural eye ' +
        'for harmony — in art, in spaces, and in how you treat others.',
    },
    {
      title: 'Mars Exalted in the Eleventh',
      layman:
        'Your drive is channelled into gains, networks, and long-term goals. Exalted Mars here ' +
        'makes you persistent about the things you want and generous with the community that ' +
        'forms around your ambitions.',
    },
  ],
  challenges: [
    {
      title: 'Venus Combust',
      layman:
        'Although Venus is exalted, it sits very close to the Sun and is "combust" — its light ' +
        'partly absorbed. Outwardly graceful, you may privately discount your own worth in love ' +
        'and creativity. Naming that pattern is most of the work of undoing it.',
    },
    {
      title: 'Kala Sarpa Pattern',
      layman:
        'With all planets held within the Rahu–Ketu axis, life can feel as if it runs in ' +
        'tunnels — intense focus on one arena while others wait. Deliberately widening your ' +
        'attention keeps the pattern an asset rather than a constraint.',
    },
  ],
  life_themes: [
    {
      title: 'Wisdom Through Reversal',
      layman:
        'The debilitated-but-rescued Jupiter is the spine of your story: early underestimation ' +
        'in learning, faith, or guidance matures into exactly the wisdom others later seek from you.',
    },
  ],
  career_guidance: {
    layman:
      'Rahu in the tenth house pulls your career toward the unconventional, the foreign, or the ' +
      'technological — fields without a worn path. You do your best work where you can invent the ' +
      'role rather than inherit it. The Saturn major period now running rewards patient, ' +
      'structural building over quick wins.',
  },
  relationship_guidance: {
    layman:
      'An exalted Venus rising makes partnership central to your sense of self. The combustion ' +
      'asks you to let yourself be truly seen rather than only admired — intimacy, not just ' +
      'attraction. Relationships that honour your inner life, not only your charm, are the ones ' +
      'that last.',
  },
  spiritual_guidance: {
    layman:
      'A water-sign ascendant with Jupiter and Ketu strong inclines you toward the contemplative. ' +
      'Devotion, water, music, and quiet practice restore you more than analysis does. Your ' +
      'twelfth-house Mercury makes the inner world unusually articulate when you give it space.',
  },
  // The LLM's woven yoga story — prose about the engine's OWN formed yogas,
  // printed above the yoga cards it describes (Section VI).
  integrated_yoga_narrative: {
    layman:
      'The yogas in this chart do not read as a list of separate blessings; they read as one ' +
      'argument made three times. An exalted Venus rising, a debilitated-but-rescued chart lord, ' +
      'and every graha held inside the nodal axis all say the same thing — that value here is ' +
      'discovered through reversal rather than handed over intact.',
    technical:
      'Malavya Yoga (exalted Venus in a kendra) supplies the outward signature, while Neecha ' +
      'Bhanga on the debilitated chart lord supplies the mechanism; Kala Sarpa constrains the ' +
      'whole to the Rahu–Ketu axis, concentrating rather than dispersing the result.',
  },
};

/** The localized chrome labels (authored here; the app passes i18n strings). */
const LABELS = {
  preparedFor: 'Prepared for',
  birthDetailsTitle: 'Birth Details',
  birthDetailsEyebrow: 'Section I',
  birthDetailsIntro:
    'The exact moment and place of birth from which every placement in this report is derived.',
  technicalNote:
    'Computed with the Lahiri ayanamsa and the whole-sign house system. All values are emitted ' +
    'by the AlmaMesh engine on your device.',
  footerNote: 'AlmaMesh · Vedic Birth-Chart Report',

  planetsEyebrow: 'Section II',
  planetsTitle: 'Planetary Positions',
  planetsIntro:
    'The sidereal longitude of each graha at the moment of birth — its sign, exact degree, ' +
    'nakshatra, house, and dignity. Combust planets are shown dimmed; (R) marks retrograde motion.',
  colPlanet: 'Graha',
  colSign: 'Sign',
  colDegree: 'Degree',
  colNakshatra: 'Nakshatra · Pada',
  colHouse: 'Hse',
  colDignity: 'Dignity',
  lagnaRowName: 'Ascendant',

  housesEyebrow: 'Section III',
  housesTitle: 'Houses (Bhāva)',
  housesIntro:
    "The twelve whole-sign houses counted from the Ascendant — each house's sign, its ruling " +
    'planet, and the grahas placed within it.',
  colHouseNumber: 'House',
  colHouseSign: 'Sign',
  colHouseLord: 'Sign Lord',
  colOccupants: 'Occupants',
  housesNote:
    'Whole-sign houses: each house spans one full sign, counted from the Ascendant. House 1 ' +
    'carries the Ascendant.',

  chartsEyebrow: 'Section IV',
  chartsTitle: 'The Kundli',
  chartsIntro:
    'The birth chart (D1 Rāśi) and the navamsa (D9), the divisional chart of marriage, dharma, ' +
    'and inner strength — both in the classical North-Indian diamond, houses fixed, signs rotating.',

  dashaEyebrow: 'Section V',
  dashaTitle: 'Vimshottari Daśā',
  dashaIntro:
    'The 120-year planetary period system keyed to the Moon’s nakshatra at birth. Each maha-daśā ' +
    'colours a long chapter of life; the current period is marked in brass.',
  dashaCurrentLabel: 'Currently Running — Maha · Antar · Pratyantar',
  dashaSequenceLabel: 'Maha-Daśā Sequence',

  yogasEyebrow: 'Section VI',
  yogasTitle: 'Yogas & Combinations',
  yogasIntro:
    'The named planetary combinations the engine identifies in this chart, with their classical ' +
    'grade. A yoga is a tendency, never a verdict.',

  narrativeEyebrow: 'Section VII',
  narrativeTitle: 'Interpretation',
  narrativeIntro:
    'A reading woven from the placements above — strengths, challenges, life themes, and ' +
    'guidance across the major life domains.',
  // Printed INSTEAD of the reading on the natal-only fixture: the section keeps
  // its place in the document and says plainly why it is empty.
  narrativeAbsentNote: enReport.pdf.narrative_absent_note,
};

/** Glyph-safe every string in a flat label/value record (mirrors the app). */
function safeRecord(record) {
  return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, glyphSafe(v)]));
}

/**
 * A bare i18next instance over the REAL en catalogs — the same `t` functions
 * the page injects into the comprehensive builders (no app side effects).
 */
async function buildTranslators() {
  const instance = i18next.createInstance();
  await instance.init({
    lng: 'en',
    ns: ['report', 'predictive', 'rectify'],
    defaultNS: 'report',
    resources: { en: { report: enReport, predictive: enPredictive, rectify: enRectify } },
    interpolation: { escapeValue: false },
  });
  return { tr: instance.getFixedT(null, 'report'), tp: instance.getFixedT(null, 'predictive') };
}

/** All sixteen varga charts (synthetic sign placements) for the plate grid. */
function fullSixteenVargaCtx() {
  const ids = [
    'D1', 'D2', 'D3', 'D4', 'D7', 'D9', 'D10', 'D12',
    'D16', 'D20', 'D24', 'D27', 'D30', 'D40', 'D45', 'D60',
  ];
  const charts = Object.fromEntries(
    ids.map((id, index) => [
      id,
      VARGA_CTX_FULL.charts[id] ?? {
        chart: id,
        lagna_sign: ['aries', 'taurus', 'gemini', 'cancer'][index % 4],
        lagna_sign_lord: 'mars',
        placements: {
          saturn: { graha: 'saturn', sign: 'capricorn', sign_lord: 'saturn', is_combust: false },
          jupiter: { graha: 'jupiter', sign: 'pisces', sign_lord: 'jupiter', is_combust: false },
        },
      },
    ]),
  );
  return { ...VARGA_CTX_FULL, charts };
}

/** A synthetic confirmed rectification for the Birth Time Authority section. */
const SAMPLE_RECTIFICATION_RECORD = {
  profileId: 'reference-native',
  confirmedAt: '2026-06-20T09:00:00.000Z',
  mode: 'cusp',
  band: 'leans',
  margin: 0.62,
  originalTime: '06:30',
  originalSign: 'cancer',
  rectifiedTime: '06:14',
  rectifiedSign: 'cancer',
  supportingEventIds: ['evt-1', 'evt-2'],
};

const SAMPLE_RECTIFICATION_EVENTS = [
  { date: '2012-11-19', category: 'marriage', summary: 'Married in Bengaluru' },
  { date: '2016-04-02', category: 'career_change', summary: 'Left engineering to teach' },
];

async function main() {
  registerLocalFonts();
  const chart = JSON.parse(await readFile(CHART_FILE, 'utf8'));
  const d1Geometry = buildD1Geometry(chart);
  const translators = await buildTranslators();

  // Birth-time stability, derived exactly as the app derives it: a lagna within
  // 3° of a sign boundary makes every house-based verdict birth-time SENSITIVE;
  // otherwise the ascendant is unambiguous and each verdict is stable. Never
  // asserted by hand — the reference chart's own lagna decides.
  const { lagna } = chart;
  const nearCusp = cuspInfo(lagna.sign, lagna.sign_degrees, 3, lagna) !== null;
  const stabilityMarkers = reportStabilityMarkers(
    [
      ...chart.yogas.map((yoga) => yogaClaimId(yoga.name)),
      ...Object.keys(DOMAINS_CTX.forecasts).map(domainClaimId),
    ],
    nearCusp,
  );
  const stabilityFlagFor = (claimId) => {
    const marker = stabilityMarkers.get(claimId);
    if (!marker) {
      return undefined;
    }
    return glyphSafe(
      translators.tr(marker.holdsUnderBoth ? 'stability.stable' : 'stability.sensitive'),
    );
  };

  const data = {
    personName: glyphSafe('Reference Native'),
    audienceLabel: glyphSafe('For You'),
    subtitle: glyphSafe('A sidereal birth-chart reading, computed on your device.'),
    kicker: glyphSafe('Vedic Astrology Report'),
    generatedOn: glyphSafe('Generated on June 20, 2026'),
    birthDetails: [
      { label: 'Date of Birth', value: glyphSafe('August 8, 1988') },
      { label: 'Time of Birth', value: glyphSafe('06:14 (Asia/Kolkata) — rectified'), mono: true },
      { label: 'Place of Birth', value: glyphSafe('Bengaluru, Karnataka, India') },
      { label: 'Ascendant (Lagna)', value: glyphSafe("Cancer 22°54'"), mono: true },
    ],
    ascendantNote: glyphSafe(
      "~22.9° into Cancer. The recorded birth time has been rectified to 06:14 IST; a few minutes' " +
        'difference would shift the rising sign and every house placement with it. House-based ' +
        'interpretation depends on an accurate birth time — refine it in AlmaMesh before relying on ' +
        'house placements.',
    ),
    technical: [
      { label: 'Ayanamsa', value: glyphSafe('23.48° (Lahiri)') },
      { label: 'House System', value: glyphSafe('Whole Sign') },
    ],
    planets: buildPlanetRows(d1Geometry),
    houses: buildHouses(chart),
    charts: buildCharts(chart, d1Geometry, { rasi: 'Rāśi · D1', navamsa: 'Navāṁśa · D9' }),
    dasha: buildDasha(chart, (lord) => `Antar-daśās of the ${lord} Mahā-daśā`),
    yogas: buildYogas(chart, stabilityFlagFor),
    // Natal-only fixture omits the narrative entirely (undefined) — the
    // Interpretation page still renders, carrying `narrativeAbsentNote` instead
    // of a reading; the full fixture builds the reading as usual. Section titles
    // come from the REAL en catalog, never hardcoded in the PDF layer.
    yogaNarrative: NATAL_ONLY ? undefined : buildYogaNarrative(SAMPLE_INTERPRETATION, 'you'),
    narrative: NATAL_ONLY
      ? undefined
      : buildNarrative(SAMPLE_INTERPRETATION, 'you', {
          currentSky: translators.tr('interpretation.current_sky'),
          strengths: translators.tr('interpretation.strengths'),
          challenges: translators.tr('interpretation.challenges'),
          lifeThemes: translators.tr('interpretation.life_themes'),
          roadAhead: translators.tr('interpretation.road_ahead'),
        }),
    // The comprehensive sections (transits · all 16 vargas · strength · domains ·
    // Birth Time Authority) render only on the full fixture — the natal-only
    // fixture proves they are cleanly omitted, exactly like the app.
    ...(NATAL_ONLY
      ? {}
      : {
          transits: buildTransitsSection(TRANSIT_CTX, translators),
          vargas: buildVargasSection(fullSixteenVargaCtx(), translators),
          strength: buildStrengthSection(STRENGTH_CTX, translators),
          domains: buildDomainsSection(DOMAINS_CTX, translators, undefined, stabilityFlagFor),
          rectification: buildRectificationPdf({
            record: SAMPLE_RECTIFICATION_RECORD,
            events: SAMPLE_RECTIFICATION_EVENTS,
            t: translators.tr,
          }),
        }),
    labels: safeRecord(LABELS),
  };

  await mkdir(OUT_DIR, { recursive: true });
  await renderToFile(createElement(ReportDocument, { data }), OUT_FILE);
  console.log(`✅ Wrote ${OUT_FILE} (fixture=${FIXTURE})`);
  console.log(
    `   planets=${data.planets.length} houses=${data.houses.length} yogas=${data.yogas.length} ` +
      `maha=${data.dasha.mahaSequence.length} antarTables=${data.dasha.antarTables.length} ` +
      `narrative=${data.narrative ? data.narrative.length : 'absent-note'} ` +
      `yogaNarrative=${data.yogaNarrative ? data.yogaNarrative.length : 'omitted'} ` +
      `stability=${nearCusp ? 'sensitive' : 'stable'} ` +
      `navamsa=${data.charts.navamsa ? 'yes' : 'no'} ` +
      `vargaPlates=${data.vargas ? data.vargas.plates.length : 'omitted'} ` +
      `rectification=${data.rectification ? 'yes' : 'omitted'}`,
  );
}

main().catch((error) => {
  console.error('❌ Failed to render sample report:', error);
  process.exit(1);
});
