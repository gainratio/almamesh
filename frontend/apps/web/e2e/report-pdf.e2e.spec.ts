import { test, expect, type Page, type Download } from '@playwright/test';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SiderealChart } from '@almamesh/browser/types';
import type { DivisionalChartId, VargaCtxFull } from '@almamesh/shared-types';
import { FOUNDER_DASHAS } from '../src/test/dashaFixtures';
import {
  DOMAINS_CTX,
  STRENGTH_CTX,
  TRANSIT_CTX,
  VARGA_CTX_FULL,
} from '../src/test/predictiveFixtures';
import {
  a4ContentBoundViolations,
  footerGeometryViolations,
  horizontalWordOverlapViolations,
  inspectPdfWithPoppler,
  normalizePdfText,
} from '../src/components/report-pdf/__tests__/pdfPoppler';

const execFileAsync = promisify(execFile);

/**
 * Stage-5 REAL end-to-end gate for the beautiful @react-pdf report + the
 * rectified-time fix.
 *
 * Unlike every other e2e suite in this repo, this one drives the app WITHOUT the
 * VITE_EXIT_GATE_HOOKS observability/seed hooks. It exercises the ACTUAL
 * onboarding -> engine-bootstrap -> Generate -> dashboard journey a real visitor
 * walks (the project scar: the hooked gate bypasses real onboarding and once
 * shipped a permanently-stuck first run CI-green). It then:
 *
 *   1. rectifies the birth time on /settings/profile (06:44 -> 06:14) and saves,
 *   2. reloads and asserts the rectified time PERSISTS (entered 06:44, effective
 *      06:14, lagna flips Leo -> Cancer),
 *   3. hard-reloads the dashboard offline and proves the saved Cancer chart survives,
 *   4. computes fixed-date predictive transits and checks houses from Cancer,
 *   5. downloads the keyless report and verifies the same transit/lagna/date facts,
 *      including that section VII (Interpretation) is PRESENT with an honest
 *      "no reading yet" note rather than silently deleted, and that the document
 *      never shrinks below its measured 26-page baseline.
 *
 * A fourth test covers stable natal export: a complete natal-only reading beside
 * refreshed predictive facts must still print its narrative in the PDF.
 *
 * The proof case is the reference native: Bengaluru, India, 08 Aug 1988, 06:44 IST.
 * The lagna sits on the Cancer / Leo cusp:
 *   - 06:44 -> Leo ~0deg (original)
 *   - 06:14 -> Cancer (rectified, stepping the time earlier crosses into Cancer)
 *
 * Build NON-hooked + preview before running (see playwright.report-pdf.config.ts).
 * Run:  bun run test:e2e:report:pdf   (from apps/web)
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, '../.report-out');
const DOWNLOAD_PATH = resolve(OUT_DIR, 'e2e-download.pdf');
const SECOND_DOWNLOAD_PATH = resolve(OUT_DIR, 'e2e-download-second.pdf');
const DASHBOARD_SHOT = resolve(OUT_DIR, 'e2e-dashboard.png');
const REPORT_SHOT = resolve(OUT_DIR, 'e2e-report.png');
const MAXIMAL_DOWNLOAD_PATH = resolve(OUT_DIR, 'e2e-maximal-download.pdf');
const STALE_DOWNLOAD_PATH = resolve(OUT_DIR, 'e2e-stale-natal-download.pdf');
const EN_REPORT_CATALOG = resolve(HERE, '../src/locales/en/report.json');

const SYNTHETIC_PROFILE_ID = 'report-pdf-maximal-profile';
const SYNTHETIC_CHART_ID = 'report-pdf-maximal-chart';
const SYNTHETIC_EVENT_COUNT = 18;
const NATAL_REPORT_SENTINEL = 'Stable natal browser-download sentinel';
const CURRENT_SKY_SENTINEL = 'Current sky browser-download sentinel';
const TRANSIT_REFERENCE_TIME = '2026-07-11T12:00:00Z';

/**
 * The reported bug, in one sentence: a natal-only reading records
 * `inputProvenance.predictiveRequestKey: null`, and that provenance stops being
 * "input-current" the instant the predictive layer publishes raw contexts — so
 * an export gated on `status === 'complete'` silently dropped the entire
 * Interpretation section while the dashboard kept showing the same reading.
 * These sentinels are the narrative that MUST survive that downgrade.
 */
const NATAL_ONLY_SUMMARY_SENTINEL = 'Natal-only summary survives the stale-status downgrade';
const NATAL_ONLY_STRENGTH_SENTINEL = 'Natal-only strength survives the stale-status downgrade';

/**
 * Pages in the keyless report measured on `main` BEFORE the fix: sections I–VI
 * and VIII–XIII, with VII absent and the numbering visibly jumping VI → VIII.
 * The fixed document only ADDS the Interpretation page, so it can never be
 * shorter; a smaller count means a section was silently gutted again.
 */
const KEYLESS_PDF_BASELINE_PAGES = 26;

/**
 * The raw predictive calculation slices from `computePredictive` (the store
 * persists them at v3 under `rawContexts`, without per-boot proof). Their
 * PRESENCE is what makes the staleness path fire: `currentPredictiveFacts` counts predictive
 * facts as existing only when all four slices are readable, and a natal-only
 * reading is "current" only while they do NOT. Without `rawContexts` the bug
 * does not reproduce at all — the reading simply stays complete.
 */
const RAW_PREDICTIVE_CONTEXTS = {
  transit_context: { instant: TRANSIT_REFERENCE_TIME },
  varga_context_full: { charts: {} },
  strength_context: { ashtakavarga: { sarva: { total: 337 } } },
  domains_context: { forecasts: {} },
} as const;
const RECTIFIED_TRANSIT_ROWS = [
  { graha: 'Saturn', sign: 'Pisces', cancerHouse: 9, aquariusHouse: 2 },
  { graha: 'Sun', sign: 'Gemini', cancerHouse: 12, aquariusHouse: 5 },
  { graha: 'Rahu', sign: 'Aquarius', cancerHouse: 8, aquariusHouse: 1 },
] as const;
const ALL_VARGA_IDS = [
  'D1',
  'D2',
  'D3',
  'D4',
  'D7',
  'D9',
  'D10',
  'D12',
  'D16',
  'D20',
  'D24',
  'D27',
  'D30',
  'D40',
  'D45',
  'D60',
] as const satisfies readonly DivisionalChartId[];

test('report-PDF acceptance permanently disables hooks and stale-server reuse', async () => {
  const config = await readFile(resolve(HERE, '../playwright.report-pdf.config.ts'), 'utf8');
  expect(config).toMatch(
    /command:\s*`VITE_API_URL=\s+VITE_EXIT_GATE_HOOKS=\s+bun run build/,
  );
  expect(config).toMatch(
    /&&\s+VITE_API_URL=\s+VITE_EXIT_GATE_HOOKS=\s+bun run preview/,
  );
  expect(config).toContain('reuseExistingServer: false');
});

const SYNTHETIC_BIRTH = {
  name: 'Maximal Browser Native',
  birth_datetime_utc: '1990-01-15T12:00:00Z',
  birth_datetime_local: '1990-01-15T17:30:00',
  birth_location_details: {
    city: 'Delhi',
    state: 'Delhi',
    country: 'India',
    latitude: 28.6139,
    longitude: 77.209,
    timezone: 'Asia/Kolkata',
    location_name: 'Delhi, India',
  },
} as const;

// The synthetic reports run on a pinned clock. 20:00 UTC is deliberately an
// instant where the chart's Asia/Kolkata calendar day (Sep 24) is already one
// day ahead of the UTC day (Sep 23): the app pins its predictive reference
// instant to the CHART's local day, so a seed keyed to the UTC day only
// matched between 00:00 and 18:30 UTC and silently dropped sections IX-XII
// for the rest of the day.
const SYNTHETIC_NOW = new Date('2026-09-23T20:00:00Z');

/**
 * The predictive reference instant the app expects for `now`: midnight of the
 * chart's LOCAL calendar day, written as `YYYY-MM-DDT00:00:00Z`. Mirrors
 * `predictiveReferenceInstant(now, timeZone)` in src/lib/predictive.ts (not
 * imported: that module pulls the persisted stores into the Node runner).
 */
function chartDayReferenceInstant(now: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(now)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T00:00:00Z`;
}

const BASE_SYNTHETIC_PLANET = {
  longitude: 75.1,
  latitude: 0,
  distance: 9.5,
  speed: 0.03,
  is_retrograde: false,
  sign: 'Gemini',
  sign_degrees: 15.1,
  sign_lord: 'mercury',
  nakshatra: 'Ardra',
  nakshatra_pada: 3,
  nakshatra_lord: 'rahu',
  house: 3,
  dignity: 'neutral',
  is_combust: false,
  combustion_separation_deg: null,
  houses_ruled: [10, 11],
  is_yogakaraka: false,
} as const;

function syntheticPlanet(name: string, index: number, nakshatra: string) {
  return {
    ...BASE_SYNTHETIC_PLANET,
    name,
    longitude: index * 30 + 29.99,
    sign_degrees: 29.99,
    nakshatra,
    house: index + 1,
  };
}

const SYNTHETIC_PLANETS: SiderealChart['planets'] = {
  sun: syntheticPlanet('sun', 0, 'Ashwini'),
  moon: syntheticPlanet('moon', 1, 'Bharani'),
  mars: syntheticPlanet('mars', 2, 'Krittika'),
  mercury: syntheticPlanet('mercury', 3, 'Rohini'),
  jupiter: syntheticPlanet('jupiter', 4, 'Mrigashira'),
  venus: syntheticPlanet('venus', 5, 'Ardra'),
  saturn: syntheticPlanet('saturn', 6, 'Punarvasu'),
  rahu: syntheticPlanet('rahu', 7, 'Uttara Bhadrapada'),
  ketu: syntheticPlanet('ketu', 8, 'Final Planet Sentinel'),
};

function syntheticYoga(index: number) {
  const final = index === 8;
  const name = final ? 'Final Yoga Sentinel' : `Synthetic Yoga ${index + 1}`;
  return {
    name,
    display_name: name,
    category: 'special',
    description: final
      ? 'The final yoga card survives browser PDF pagination.'
      : `Synthetic yoga card ${index + 1} exercises pagination.`,
    effects: 'Display-only synthetic evidence.',
    grade: index % 2 === 0 ? ('strong' as const) : ('moderate' as const),
    strength_factors: [
      {
        planet: 'saturn',
        factor: 'synthetic',
        value: 'present',
        basis: 'browser PDF acceptance fixture',
        mark: 1,
      },
    ],
    planets_involved: ['saturn'],
    houses_involved: [10],
    planetary_signature: 'Saturn',
    formation_rules: [
      {
        rule: 'synthetic_rule',
        description: 'Synthetic formation for artifact testing.',
        source: 'E2E fixture',
        planets: ['saturn'],
        houses: [10],
      },
    ],
  };
}

const SYNTHETIC_SIDEREAL: SiderealChart = {
  ayanamsa_value: 24.1,
  lagna: {
    longitude: 5.4,
    sign: 'Aries',
    sign_degrees: 5.4,
    sign_lord: 'mars',
    nakshatra: 'Ashwini',
    nakshatra_pada: 2,
    nakshatra_lord: 'ketu',
  },
  planets: SYNTHETIC_PLANETS,
  houses: Object.fromEntries(
    Array.from({ length: 12 }, (_, index) => [
      String(index + 1),
      { house: index + 1, longitude: index * 30, sign: 'Aries', sign_lord: 'mars' },
    ]),
  ) as SiderealChart['houses'],
  dashas: FOUNDER_DASHAS,
  yogas: Array.from({ length: 9 }, (_, index) => syntheticYoga(index)),
  navamsa: {
    name: 'D9',
    lagna_sign: 'Leo',
    lagna_sign_lord: 'sun',
    planets: { saturn: { name: 'saturn', sign: 'Aquarius', sign_lord: 'saturn' } },
  },
};

const SYNTHETIC_VARGA_CONTEXT: VargaCtxFull = {
  ...VARGA_CTX_FULL,
  charts: Object.fromEntries(
    ALL_VARGA_IDS.map((id) => [
      id,
      {
        ...VARGA_CTX_FULL.charts.D1,
        chart: id,
      },
    ]),
  ) as VargaCtxFull['charts'],
};

/**
 * The stored reading seeded beside the synthetic chart.
 *
 * `staleNatalOnly` reproduces the reported production case: the reading is
 * natal-only and remains stable when predictive facts change. The ordinary
 * maximal fixture also carries a separately dated current timeline, matching
 * the v6 production shape; report/PDF export must keep that timeline separate.
 */
function syntheticInterpretationEntry(requestKey: string, staleNatalOnly: boolean) {
  const base = {
    status: 'complete',
    profileId: SYNTHETIC_PROFILE_ID,
    updatedAt: '2026-07-11T12:00:00Z',
  } as const;
  if (staleNatalOnly) {
    return {
      ...base,
      sections: { summary: true, strengths: true },
      inputProvenance: { predictiveRequestKey: null },
      interpretation: {
        summary: {
          layman: `${NATAL_ONLY_SUMMARY_SENTINEL}.`,
          technical: `${NATAL_ONLY_SUMMARY_SENTINEL}.`,
        },
        strengths: [
          {
            title: 'Saturn in the tenth',
            layman: NATAL_ONLY_STRENGTH_SENTINEL,
            technical: NATAL_ONLY_STRENGTH_SENTINEL,
          },
        ],
        challenges: [],
        life_themes: [],
        // No `current_sky`: a natal-only reading never narrates timing.
      },
    };
  }
  return {
    ...base,
    sections: { summary: true },
    inputProvenance: { predictiveRequestKey: null },
    interpretation: {
      summary: {
        layman: NATAL_REPORT_SENTINEL,
        technical: NATAL_REPORT_SENTINEL,
      },
      strengths: [],
      challenges: [],
      life_themes: [],
    },
    timeline: {
      status: 'complete',
      updatedAt: '2026-07-11T12:00:00Z',
      inputProvenance: { predictiveRequestKey: requestKey },
      sections: { current_sky: true },
      content: {
        upcoming_periods: null,
        current_sky: [
          {
            title: 'Jupiter transit',
            layman: CURRENT_SKY_SENTINEL,
            technical: CURRENT_SKY_SENTINEL,
          },
        ],
      },
    },
  };
}

interface MaximalSeedOptions {
  /**
   * Seed a natal-only reading (`predictiveRequestKey: null`) beside a `ready`
   * predictive slice that carries refreshed `rawContexts`. See
   * `syntheticInterpretationEntry` and `RAW_PREDICTIVE_CONTEXTS`.
   */
  readonly staleNatalOnlyReading?: boolean;
}

/** Seed only local persisted inputs; the page still builds and downloads the real report. */
async function seedSyntheticMaximalReport(
  page: Page,
  options: MaximalSeedOptions = {},
): Promise<void> {
  const staleNatalOnly = options.staleNatalOnlyReading === true;
  // Establish the preview origin without booting the SPA. If the empty Zustand
  // stores hydrate before this write, they can race and overwrite the fixture.
  await page.clock.setFixedTime(SYNTHETIC_NOW);
  await page.goto('/robots.txt', { waitUntil: 'domcontentloaded' });
  // ONE analysis instant (PR #277): the predictive facts are keyed to the
  // chart's own calculation day, read in the viewer's zone (the zone the
  // footer, cover and PDF print it in). The browser runs in this process's zone.
  const referenceInstant = chartDayReferenceInstant(
    SYNTHETIC_NOW,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const requestKey = JSON.stringify([
    SYNTHETIC_PROFILE_ID,
    SYNTHETIC_BIRTH.birth_datetime_utc,
    SYNTHETIC_BIRTH.birth_location_details.latitude,
    SYNTHETIC_BIRTH.birth_location_details.longitude,
    referenceInstant,
    330, // Asia/Kolkata civil offset at the birth instant (predictiveRequestKey)
  ]);
  const storedChart = {
    chart_id: SYNTHETIC_CHART_ID,
    profile_id: SYNTHETIC_PROFILE_ID,
    person_name: SYNTHETIC_BIRTH.name,
    is_primary: true,
    birth_data: SYNTHETIC_BIRTH,
    astronomical_calculations: {
      sidereal_ctx: {
        ayanamsa_value: SYNTHETIC_SIDEREAL.ayanamsa_value,
        ayanamsa_type: 'lahiri',
        house_system: 'whole_sign',
        julian_day: 0,
        sidereal_time: 0,
        lagna: SYNTHETIC_SIDEREAL.lagna,
        planets: SYNTHETIC_SIDEREAL.planets,
      },
      // Computed as of SYNTHETIC_NOW: the instant its seeded predictive facts are for.
      calculation_timestamp: SYNTHETIC_NOW.toISOString(),
      software_version: 'report-pdf-e2e',
    },
    sidereal_chart: SYNTHETIC_SIDEREAL,
  };
  const events = Array.from({ length: SYNTHETIC_EVENT_COUNT }, (_, index) => {
    const final = index === SYNTHETIC_EVENT_COUNT - 1;
    return {
      id: `report-pdf-maximal-event-${index + 1}`,
      description: final ? 'family_rupture' : 'career_change',
      summary: final
        ? 'Final paginated event sentinel'
        : index === 0
          ? 'Accepted the maximal browser sentinel role'
          : `Synthetic supporting event ${index + 1}`,
      date: `${2000 + index}-07-01`,
      category: final ? 'family_rupture' : 'career_change',
      precision: 'exact',
      createdAt: `2026-01-${String(index + 1).padStart(2, '0')}T00:00:00Z`,
    };
  });
  const supportingEvents = events.map((event, index) => ({
    eventIndex: index,
    category: event.category,
    date: event.date,
    signals:
      index === events.length - 1
        ? ['pd_lord_rules_h7#dignified_fit']
        : ['md_lord_rules_h10'],
    contribution: 1,
  }));
  const record = {
    profileId: SYNTHETIC_PROFILE_ID,
    confirmedAt: '2026-01-01T00:00:00Z',
    mode: 'cusp',
    band: 'leans',
    margin: 0.72,
    originalTime: '17:15',
    originalSign: 'pisces',
    rectifiedTime: '17:30',
    rectifiedSign: 'aries',
    supportingEventIds: events.map((event) => event.id),
    resultSnapshot: {
      mode: 'cusp',
      margin: 0.72,
      band: 'leans',
      discriminatingEventCount: events.length,
      confidencePct: 72,
      recordedTimeSign: 'pisces',
      honestyNoteKey: 'rectify.honesty.leans',
      candidates: [
        {
          ascendantSign: 'aries',
          representativeTimeLocal: '17:30',
          lagnaLongitudeDeg: 5.4,
          lagnaCuspDistanceDeg: 5.4,
          isNearCusp: false,
          fitScore: 18.2,
          navamsaLagnaSign: 'leo',
          positiveTotal: 18,
          penaltyTotal: 0.15,
          priorBonus: 0.35,
          misses: ['miss_silent_family_rupture_h4'],
          supportingEvents,
        },
        {
          ascendantSign: 'pisces',
          representativeTimeLocal: '08:15',
          lagnaLongitudeDeg: 359.2,
          lagnaCuspDistanceDeg: 0.8,
          isNearCusp: true,
          fitScore: 7.4,
          navamsaLagnaSign: 'cancer',
          positiveTotal: 7.4,
          penaltyTotal: 0,
          priorBonus: 0,
          misses: [],
          supportingEvents: [],
        },
      ],
    },
  };
  const entries: ReadonlyArray<readonly [string, string]> = [
    [
      'almamesh-profiles',
      JSON.stringify({
        state: {
          profiles: {
            [SYNTHETIC_PROFILE_ID]: {
              id: SYNTHETIC_PROFILE_ID,
              name: SYNTHETIC_BIRTH.name,
              createdAt: '2026-01-01T00:00:00Z',
              avatarTint: '#C9A24B',
            },
          },
          activeProfileId: SYNTHETIC_PROFILE_ID,
        },
        version: 1,
      }),
    ],
    [
      'almamesh-chart-library',
      JSON.stringify({ state: { charts: { [SYNTHETIC_CHART_ID]: storedChart } }, version: 1 }),
    ],
    [
      'almamesh-predictive',
      JSON.stringify({
        state: {
          status: 'ready',
          transitCtx: TRANSIT_CTX,
          vargaCtxFull: SYNTHETIC_VARGA_CONTEXT,
          strengthCtx: STRENGTH_CTX,
          domainsCtx: DOMAINS_CTX,
          // Only the stale case publishes raw engine facts — that is the
          // trigger that turns a natal-only reading's provenance stale.
          ...(staleNatalOnly ? { rawContexts: RAW_PREDICTIVE_CONTEXTS } : {}),
          profileKey: SYNTHETIC_PROFILE_ID,
          requestKey,
        },
        // The current predictive persist version: an older one is a cache miss.
        version: 4,
      }),
    ],
    [
      'almamesh-life-events',
      JSON.stringify({
        state: { eventsByProfile: { [SYNTHETIC_PROFILE_ID]: events } },
        version: 4,
      }),
    ],
    [
      'almamesh-interpretations',
      JSON.stringify({
        state: {
          byChart: {
            [SYNTHETIC_CHART_ID]: syntheticInterpretationEntry(requestKey, staleNatalOnly),
          },
        },
        version: 6,
      }),
    ],
    [
      'almamesh-rectification-records',
      JSON.stringify({
        state: { recordsByProfile: { [SYNTHETIC_PROFILE_ID]: record } },
        version: 2,
      }),
    ],
  ];

  await page.evaluate(async (persistedEntries) => {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const open = indexedDB.open('keyval-store');
      open.onupgradeneeded = () => open.result.createObjectStore('keyval');
      open.onerror = () => rejectPromise(open.error);
      open.onsuccess = () => {
        const transaction = open.result.transaction('keyval', 'readwrite');
        for (const [key, value] of persistedEntries) {
          transaction.objectStore('keyval').put(value, key);
        }
        transaction.oncomplete = () => resolvePromise();
        transaction.onerror = () => rejectPromise(transaction.error);
      };
    });
    localStorage.setItem('almamesh-chart', '1');
  }, entries);
}

// ---------------------------------------------------------------------------
// Console hygiene: collect page errors + console.error for the clean-console
// assertion. We tolerate known-benign noise (favicon, third-party LLM probes
// the user never opted into here, ResizeObserver loop warnings).
// ---------------------------------------------------------------------------
const BENIGN = [
  /favicon/i,
  /ResizeObserver loop/i,
  /Download the React DevTools/i,
  // The optional LLM endpoint is never configured in this keyless gate; any
  // interpretation probe failing is expected and NOT a report/onboarding bug.
  /openrouter|interpretation|llm/i,
];

function collectConsole(page: Page): { errors: string[] } {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (BENIGN.some((re) => re.test(text))) return;
    errors.push(`[console.error] ${text}`);
  });
  page.on('pageerror', (err) => {
    const text = String(err);
    if (BENIGN.some((re) => re.test(text))) return;
    errors.push(`[pageerror] ${text}`);
  });
  return { errors };
}

/**
 * Type a value into ONE segment of a MUI X "section list" picker (DatePicker /
 * TimePicker). These fields are NOT a plain <input>: the visible field is a
 * contenteditable container with per-segment spinbuttons (Month/Day/Year, or
 * Hours/Minutes/Meridiem) and the real <input> is aria-hidden + pointer-events-
 * intercepted, so click the addressed spinbutton segment and type into it.
 */
async function typeSection(
  page: Page,
  testId: string,
  ariaLabel: string,
  keys: string,
): Promise<void> {
  const seg = page.getByTestId(testId).locator(`[role="spinbutton"][aria-label="${ariaLabel}"]`).first();
  await seg.click();
  await page.keyboard.type(keys, { delay: 40 });
}

/**
 * Fill the MUI DatePicker as 08/08/1988. CRITICAL ORDER: Year, then Month, then
 * Day. Typing the year LAST re-clamps the day (MUI re-validates the day segment
 * when a later segment changes), so the day must be the final segment entered.
 * Verified live against the production build.
 */
async function fillDatePicker(page: Page, testId: string): Promise<void> {
  const container = page.getByTestId(testId).locator('.MuiPickersSectionList-root').first();
  await container.waitFor({ state: 'visible', timeout: 15_000 });
  await typeSection(page, testId, 'Year', '1988');
  await typeSection(page, testId, 'Month', '08');
  await typeSection(page, testId, 'Day', '08');
  await page.keyboard.press('Escape'); // close any popper so the next click hits Next
}

/** Fill the MUI TimePicker as 06:44 AM. */
async function fillTimePicker(page: Page, testId: string): Promise<void> {
  const container = page.getByTestId(testId).locator('.MuiPickersSectionList-root').first();
  await container.waitFor({ state: 'visible', timeout: 15_000 });
  await typeSection(page, testId, 'Hours', '06');
  await typeSection(page, testId, 'Minutes', '44');
  // The meridiem segment has no stable aria-label; it is the last spinbutton.
  await page.getByTestId(testId).locator('[role="spinbutton"]').last().click();
  await page.keyboard.press('a'); // AM
  await page.keyboard.press('Escape'); // close the popper
}

const NEXT = '[data-testid="next-button"]';

/**
 * Click "Continue" and wait for the step to actually advance (the expected next
 * locator to appear). After a MUI picker edit the FIRST Next click can be
 * consumed closing the picker popper / committing a blur, so retry up to a few
 * times until the next step is visibly mounted. This mirrors what a real user
 * does (clicks again when nothing happened) and keeps the gate honest.
 */
async function advanceStep(page: Page, nextStepLocator: () => ReturnType<Page['locator']>): Promise<void> {
  await expect(page.locator(NEXT)).toBeEnabled({ timeout: 15_000 });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await page.locator(NEXT).click();
    try {
      await nextStepLocator().waitFor({ state: 'visible', timeout: 6_000 });
      return;
    } catch {
      // Step didn't advance (popper consumed the click) — try again.
    }
  }
  // Final attempt surfaces the real error if it still hasn't advanced.
  await nextStepLocator().waitFor({ state: 'visible', timeout: 6_000 });
}

/**
 * Drive REAL onboarding from a clean state through to /dashboard, returning when
 * a chart has rendered. NO seed hooks — this is the genuine first-run journey.
 */
async function driveRealOnboarding(page: Page, consoleErrors: readonly string[]): Promise<void> {
  await page.goto('/onboarding', { waitUntil: 'domcontentloaded' });

  const hookGlobals = await page.evaluate(() => {
    const gateWindow = window as typeof window & {
      readonly __almameshGenerate?: unknown;
      readonly __ALMAMESH_STAGE__?: unknown;
    };
    return {
      generate: typeof gateWindow.__almameshGenerate,
      stage: typeof gateWindow.__ALMAMESH_STAGE__,
    };
  });
  expect(hookGlobals, 'the real-visitor acceptance build must not expose exit-gate hooks').toEqual({
    generate: 'undefined',
    stage: 'undefined',
  });

  // Step 1 — name.
  await page.getByTestId('name-input').waitFor({ state: 'visible', timeout: 30_000 });
  await page.getByTestId('name-input').fill('Reference Native');
  await advanceStep(page, () => page.getByTestId('birth-date-input'));

  // Step 2 — birth date (MUI DatePicker -> 08/08/1988).
  await fillDatePicker(page, 'birth-date-input');
  await advanceStep(page, () => page.getByTestId('location-search-input'));

  // Step 3 — birth location (offline city DB). Type "Bengaluru", select India.
  const locInput = page.getByTestId('location-search-input');
  await locInput.fill('Bengaluru');
  const cityResult = page.locator('button:has-text("India")').first();
  await expect(cityResult).toBeVisible({ timeout: 10_000 });
  await cityResult.click();
  await advanceStep(page, () => page.getByTestId('birth-time-input'));

  // Step 4 — birth time (MUI TimePicker -> 06:44 AM).
  await fillTimePicker(page, 'birth-time-input');
  await advanceStep(page, () => page.getByTestId('life-events-input'));

  // Step 5 — turn a real free-form narrative into two typed rows with the
  // deterministic, zero-egress fallback. This is the exact first-run path used
  // when no AI provider has been configured.
  await page
    .getByTestId('life-events-input')
    .fill('I got married in 2015. I changed careers in 2020.');
  await page.getByTestId('extract-events-button').click();
  const capturedEvents = page.getByTestId('captured-life-events');
  await expect(capturedEvents.getByText(/got married in 2015/i)).toBeVisible({ timeout: 10_000 });
  await expect(capturedEvents.getByText(/changed careers in 2020/i)).toBeVisible();

  // The generating screen now WAITS for the ~38MB engine bootstrap, then
  // navigates to /dashboard. Be patient (cold Pyodide boot + OPFS bundle sync).
  await page.waitForFunction(
    () =>
      window.location.pathname === '/dashboard' ||
      document.body.innerText.includes('CHART_GEN_001'),
    { timeout: 180_000 },
  );
  if (new URL(page.url()).pathname !== '/dashboard') {
    throw new Error(
      [
        'Real onboarding stopped on CHART_GEN_001 before reaching /dashboard.',
        ...consoleErrors,
      ].join('\n'),
    );
  }
}

/** Poll the dashboard until the real chart has rendered (no seed hook). */
async function waitForDashboardChart(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const text = document.body.innerText || '';
      if (/chart data not available/i.test(text)) return false;
      // Real chart evidence: the dashboard shows the person + dasha/identity
      // strip once a chart is loaded. Use a robust signal: SVG kundli or the
      // ascendant/lagna readout present.
      const svgCount = document.querySelectorAll('svg').length;
      const hasLagna = /ascendant|lagna|leo|cancer/i.test(text);
      return svgCount >= 2 && hasLagna && text.length > 200;
    },
    { timeout: 60_000, polling: 1000 },
  );
}

/** SPA-navigate without a hard reload so the booted engine singleton survives. */
async function spaNavigate(page: Page, path: string): Promise<void> {
  await page.evaluate((to) => {
    window.history.pushState({}, '', to);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}

/**
 * Read the LAGNA (ascendant) sign from the dashboard IdentityStrip — SCOPED, not
 * a whole-body text scan. Whole-body text can contain BOTH "Leo" and "Cancer"
 * because planets occupy many signs regardless of the rising sign, so a body-wide
 * `toContain('leo')` is meaningless. The IdentityStrip's "Lagna · Ascendant" fact
 * is the rising sign.
 */
async function readDashboardLagna(page: Page): Promise<string> {
  const lagnaFact = page
    .getByTestId('identity-strip')
    .locator('div', { has: page.locator('dt', { hasText: 'Lagna · Ascendant' }) })
    .first()
    .locator('dd')
    .first();
  await lagnaFact.waitFor({ state: 'visible', timeout: 30_000 });
  return (await lagnaFact.innerText()).trim().toLowerCase();
}

async function expectReportTransitRow(
  page: Page,
  expected: (typeof RECTIFIED_TRANSIT_ROWS)[number],
): Promise<void> {
  const table = page.getByTestId('report-gochara-table');
  const row = table.getByRole('row').filter({
    has: page.getByRole('cell', { name: expected.graha, exact: true }),
  });
  await expect(row).toHaveCount(1);
  const cells = row.getByRole('cell');
  await expect(cells.nth(1)).toHaveText(expected.sign);
  await expect(cells.nth(4)).toHaveText(String(expected.cancerHouse));
  await expect(cells.nth(4)).not.toHaveText(String(expected.aquariusHouse));
}

/**
 * The shipping ENGLISH copy for one dotted key of the `report` namespace.
 *
 * Read from the catalog rather than retyped: an assertion that hardcodes prose
 * passes while the app says something completely different, and it goes red on
 * a harmless copy edit. The catalog is what the PDF actually renders.
 */
async function englishReportString(dottedKey: string): Promise<string> {
  const catalog: unknown = JSON.parse(await readFile(EN_REPORT_CATALOG, 'utf8'));
  let node: unknown = catalog;
  for (const segment of dottedKey.split('.')) {
    node = node === null || typeof node !== 'object'
      ? undefined
      : (node as Record<string, unknown>)[segment];
  }
  expect(typeof node, `en/report.json must define "${dottedKey}"`).toBe('string');
  return String(node);
}

/** Whitespace-flattened, case-folded PDF text — headings letter-space and body copy wraps. */
function flattenPdfText(pdfText: string): string {
  return normalizePdfText(pdfText).toLocaleLowerCase('en');
}

/**
 * The flattened "<eyebrow> <title>" needle for the Interpretation section — the
 * two parts ADJACENT, which is how `ReportPdfHeading` renders them.
 *
 * Checking the eyebrow alone would be VACUOUS: "section vii" is a substring of
 * the "SECTION VIII" eyebrow that follows it, so a bare eyebrow check passes on
 * the pre-fix 26-page document that deleted section VII outright (verified
 * against the saved pre-fix artifact). The pair is present only when the
 * section itself is.
 */
async function interpretationHeadingNeedle(): Promise<string> {
  const eyebrow = await englishReportString('pdf.narrative_eyebrow');
  const title = await englishReportString('interpretation.heading');
  return flattenPdfText(`${eyebrow} ${title}`);
}

/** Extract the text of the downloaded PDF via the system `pdftotext`. */
async function pdfToText(pdfPath: string): Promise<string> {
  const txtPath = pdfPath.replace(/\.pdf$/, '.txt');
  await execFileAsync('pdftotext', ['-layout', pdfPath, txtPath]);
  return readFile(txtPath, 'utf8');
}

/** The single "ASCENDANT (LAGNA)" birth-detail line from the PDF text. */
function pdfAscendantLine(pdfText: string): string {
  return (pdfText.split('\n').find((l) => /ascendant\s*\(lagna\)/i.test(l)) ?? '').trim();
}

function pdfTransitColumns(pdfText: string, graha: string): readonly string[] {
  const normalized = pdfText.toLocaleLowerCase('en');
  const start = normalized.indexOf('transits & timing');
  expect(start).toBeGreaterThanOrEqual(0);

  const line = pdfText
    .slice(start)
    .split('\n')
    .find((candidate) => new RegExp(`^\\s*${graha}\\s+`, 'i').test(candidate));
  expect(line, `${graha} must appear in the PDF gochara table`).toBeDefined();
  const columns = line?.trim().split(/\s{2,}/) ?? [];
  expect(columns).toHaveLength(6);
  return columns;
}

// The running maha/antar/pratyantar row carries an extra trailing word — the
// `labels.dashaCurrentMarker` text (ReportPdfDasha.tsx) — in the SAME y-band as
// the rest of the row, so it lands in the same extracted line. The marker is
// OPTIONAL in the pattern (most rows don't have it) and its exact text is
// threaded in from the shipping catalog rather than hardcoded, so a copy edit
// to "Current" can't silently desync this from what the PDF actually prints.
function dashaRowPattern(currentMarker: string): RegExp {
  const escapedMarker = currentMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `^(Sun|Moon|Mars|Rahu|Jupiter|Saturn|Mercury|Ketu|Venus)\\s+([A-Z][a-z]{2} \\d{4})\\s+—\\s+([A-Z][a-z]{2} \\d{4})\\s+\\d+(?:\\.\\d+)? yr(?:\\s+${escapedMarker})?$`,
  );
}

function titleCaseDashaLord(lord: string): string {
  return `${lord.charAt(0).toUpperCase()}${lord.slice(1)}`;
}

function dashaMonthYear(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${iso}T00:00:00Z`));
}

function dashaRowTuple(period: {
  readonly lord: string;
  readonly start_date: string;
  readonly end_date: string;
}): string {
  return [
    titleCaseDashaLord(period.lord),
    dashaMonthYear(period.start_date),
    dashaMonthYear(period.end_date),
  ].join('|');
}

function downloadedDashaRowTuples(
  pdf: Awaited<ReturnType<typeof inspectPdfWithPoppler>>,
  currentMarker: string,
): readonly string[] {
  const pattern = dashaRowPattern(currentMarker);
  return pdf.pages
    .filter(
      (pdfPage) =>
        pdfPage.text.includes('MAHA-DASA SEQUENCE') || /\bANTAR-DASAS\b/i.test(pdfPage.text),
    )
    .flatMap((pdfPage) => {
      const bands: Array<{
        center: number;
        words: Array<(typeof pdfPage.words)[number]>;
      }> = [];
      for (const word of [...pdfPage.words].sort((left, right) => left.yMin - right.yMin)) {
        const center = (word.yMin + word.yMax) / 2;
        const band = bands.find((candidate) => Math.abs(candidate.center - center) <= 1.5);
        if (band) band.words.push(word);
        else bands.push({ center, words: [word] });
      }
      return bands.map((band) =>
        band.words
          .sort((left, right) => left.xMin - right.xMin)
          .map((word) => word.text)
          .join(' '),
      );
    })
    .flatMap((line) => {
      const match = pattern.exec(line);
      return match ? [`${match[1]}|${match[2]}|${match[3]}`] : [];
    });
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * The offset of the first byte two exports disagree on, or `null` when they are
 * byte-identical. A shorter file that is a strict prefix of the longer one
 * "differs" at its own length — the offset where it stopped.
 */
function firstDifferingByteOffset(first: Uint8Array, second: Uint8Array): number | null {
  const shared = Math.min(first.length, second.length);
  for (let offset = 0; offset < shared; offset += 1) {
    if (first[offset] !== second[offset]) return offset;
  }
  return first.length === second.length ? null : shared;
}

/**
 * The failure message for the determinism gate. "The hashes differ" names no
 * culprit, so carry both digests, both byte lengths, and the offset of the
 * first differing byte — enough to point at the actual non-determinism (a live
 * `/CreationDate`, a cover date read off the wall clock, a random font subset
 * tag) without re-running the 8-minute journey to find it.
 */
function pdfDeterminismReport(first: Uint8Array, second: Uint8Array): string {
  const offset = firstDifferingByteOffset(first, second);
  return [
    `first  export: sha256=${sha256Hex(first)} bytes=${first.length}`,
    `second export: sha256=${sha256Hex(second)} bytes=${second.length}`,
    offset === null
      ? 'the two exports are byte-identical'
      : `first differing byte at offset ${offset}`,
  ].join('\n');
}

test('REAL onboarding -> rectify -> offline reload -> predictive PDF is correct', async ({ page }) => {
  test.setTimeout(480_000);
  const { errors } = collectConsole(page);
  await mkdir(OUT_DIR, { recursive: true });

  // The PDF layout engine (yoga, inside @react-pdf) must load its wasm from an
  // own-origin hashed asset (yogaWasmAssetPlugin) — never by fetch()ing a
  // data: URI, which production CSP blocks. Collect the evidence here; the
  // assertion runs after the PDF download below.
  const wasmAssetUrls: string[] = [];
  page.on('response', (response) => {
    if (/\/assets\/[^/]+\.wasm(\?|$)/.test(response.url()) && response.ok()) {
      wasmAssetUrls.push(response.url());
    }
  });

  // ---- 0. Production-fidelity guard: the preview server must serve the REAL
  // Cloudflare browser headers (previewProdBrowserHeadersPlugin in vite.config.ts).
  // Without the CSP this
  // suite cannot catch CSP-blocked fetches — the yoga-layout data:-URI wasm
  // fetch shipped console errors to production exactly that way while the
  // clean-console gate below stayed vacuously green.
  const bootResponse = await page.goto('/onboarding', { waitUntil: 'domcontentloaded' });
  expect(
    bootResponse?.headers()['content-security-policy'] ?? '',
    'vite preview must serve the production Content-Security-Policy',
  ).toContain("connect-src 'self'");
  expect(bootResponse?.headers()['cross-origin-opener-policy']).toBe('same-origin');
  expect(bootResponse?.headers()['cross-origin-embedder-policy']).toBe('require-corp');
  expect(
    await page.evaluate(() => ({
      isolated: globalThis.crossOriginIsolated,
      sharedArrayBuffer: typeof globalThis.SharedArrayBuffer === 'function',
      waitAsync: typeof Atomics.waitAsync === 'function',
    })),
  ).toEqual({ isolated: true, sharedArrayBuffer: true, waitAsync: true });

  // Bracket the real on-device chart work with wall-clock dates. The exported
  // cover is user-visible proof of the persisted calculation instant; reaching
  // into a retired persistence implementation would test storage internals, not
  // the product contract. Keep both bounds because CI can cross midnight while
  // onboarding and rectification run.
  //
  // CHANGED with PR #277 (one analysis instant): the PDF's transits now follow
  // the chart's own instant, not the export clock. So the chart is computed as
  // of TRANSIT_REFERENCE_TIME (the page clock runs from there), which is the
  // day RECTIFIED_TRANSIT_ROWS pin, and the cover must print that same day.
  await page.clock.setSystemTime(new Date(TRANSIT_REFERENCE_TIME));

  // ---- 1. REAL onboarding through the live engine bootstrap to /dashboard ----
  await driveRealOnboarding(page, errors);
  await waitForDashboardChart(page);
  await page.screenshot({ path: DASHBOARD_SHOT, fullPage: true });

  // Clean-console gate for the onboarding -> dashboard journey.
  expect(errors, `console errors during onboarding/dashboard:\n${errors.join('\n')}`).toEqual([]);

  // Sanity: at the entered 06:44 the engine yields the Leo cusp case. Read
  // the SCOPED IdentityStrip lagna, not whole-body text (planets sit in many signs).
  const lagna0644 = await readDashboardLagna(page);
  console.log('[report-pdf] dashboard lagna @06:44 =', JSON.stringify(lagna0644));
  expect(lagna0644, 'at 06:44 the dashboard lagna should be Leo (pre-rectification)').toContain('leo');

  // Deliberately let the Dashboard's heavy predictive computation start on the
  // same serial Pyodide worker. This reproduces the slow-run scheduling case
  // that previously let Save race ahead of the queued lagna previews.
  await expect(page.getByTestId('life-atlas-gate')).toContainText('Computing on this device', {
    timeout: 15_000,
  });

  // ---- 2. Rectify 06:44 -> 06:14 on /settings/profile, save, regenerate ----
  await spaNavigate(page, '/settings/profile');
  const rectifyInput = page
    .locator('div', { has: page.getByRole('heading', { name: 'Birth time rectification' }) })
    .last()
    .locator('input[type="time"]')
    .first();
  await expect(rectifyInput).toBeVisible({ timeout: 30_000 });
  await rectifyInput.fill('06:14');
  await rectifyInput.blur();

  // The product deliberately keeps Save disabled until BOTH engine previews
  // resolve, so the sign-flip acknowledgement can never be bypassed by a slow
  // worker. Prove the user-visible comparison before opening the modal.
  const comparison = page.getByTestId('birth-time-comparison');
  await expect(comparison).toContainText('06:14', { timeout: 180_000 });
  await expect(comparison).toContainText('06:44');
  await expect(comparison).toContainText('As recorded');
  await expect(comparison).toContainText('Rectified');
  await expect(comparison).toContainText('Leo');
  await expect(comparison).toContainText('Cancer');

  // Save Changes -> the regeneration modal. Because 06:44 -> 06:14 crosses the
  // Leo/Cancer sign boundary, the modal raises its MANDATORY rising-sign-flip
  // acknowledgement: "Confirm & Regenerate" stays DISABLED until the user ticks
  // the "regen-flip-ack" checkbox. This is the real-visitor gate — a sign flip is
  // a different chart, not a tweak — so the gate must drive it exactly as a person
  // must. The checkbox is engine-gated (it appears only once BOTH lagna previews
  // resolve on the shared Pyodide thread and disagree), so wait for it before
  // ticking; that same wait removes the pre-fix race where the click could land
  // on the button in its brief still-enabled window before the flip was detected.
  const saveChanges = page.getByRole('button', { name: 'Save Changes' });
  await expect(saveChanges).toBeEnabled({ timeout: 180_000 });
  await saveChanges.click();
  const flipAck = page.getByTestId('regen-flip-ack').locator('input[type="checkbox"]');
  await flipAck.waitFor({ state: 'visible', timeout: 60_000 });
  await flipAck.check();
  const confirmRegenerate = page.getByRole('button', { name: 'Confirm & Regenerate' });
  await expect(confirmRegenerate, 'the sign-flip ack must enable Confirm & Regenerate').toBeEnabled({
    timeout: 15_000,
  });
  await confirmRegenerate.click();
  // The on-device regenerate then shows a success card with a "View New Chart" CTA.
  const viewNewChart = page.getByRole('button', { name: /View New Chart/i });
  await expect(viewNewChart, 'rectification must regenerate the chart on-device').toBeVisible({
    timeout: 90_000,
  });
  await viewNewChart.click();

  // Back on the dashboard, wait for the regenerated Cancer chart to be COMMITTED
  // and live before asserting the lagna. "Confirm & Regenerate" is fire-and-forget:
  // it shows the success card (and thus "View New Chart") the instant the
  // birth-info-changed event is emitted, NOT when the recompute finishes. The
  // real on-device regenerate then has to run engine.generateChart on the SINGLE
  // serial Pyodide worker, saveChart the new chart id, invalidate the
  // ['primary-chart'] query, refetch, and re-render — and that recompute can be
  // queued behind the dashboard's ~30s predictive auto-compute on the same worker.
  // Polling the lagna text alone races that commit: the stale Leo snapshot reads
  // for the whole window, which is the CI flake ("Received: leo0°02′ …"). Gate on
  // the commit-tied `identity-rectification` note instead — it is ABSENT on the
  // entered-time Leo chart and renders ONLY once the new rectified (06:14) chart
  // is the live primary chart, and the SAME render flips the lagna to Cancer. So
  // it is the deterministic "the new chart is on screen" signal. Allow
  // serial-worker headroom (mirrors the 180s Save-gate waits above); the lagna
  // poll then resolves immediately once the note is present.
  await waitForDashboardChart(page);
  await expect(
    page.getByTestId('identity-rectification'),
    'the regenerated rectified (06:14) chart must become the live dashboard chart',
  ).toContainText('6:14 AM', { timeout: 180_000 });
  await expect
    .poll(() => readDashboardLagna(page), {
      timeout: 30_000,
      message: 'after rectifying to 06:14 the dashboard lagna must flip to Cancer',
    })
    .toContain('cancer');
  const lagnaAfterRectify = await readDashboardLagna(page);
  console.log('[report-pdf] dashboard lagna @06:14 =', JSON.stringify(lagnaAfterRectify));
  expect(lagnaAfterRectify, 'after rectifying the lagna must no longer be Leo').not.toContain('leo');

  // ---- 3. RELOAD and prove the rectified time PERSISTED ----
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  await waitForDashboardChart(page);
  await expect
    .poll(() => readDashboardLagna(page), {
      timeout: 30_000,
      message: 'after reload the rectified lagna (Cancer) must persist',
    })
    .toContain('cancer');
  const lagnaAfterReload = await readDashboardLagna(page);
  console.log('[report-pdf] dashboard lagna after reload =', JSON.stringify(lagnaAfterReload));
  expect(lagnaAfterReload, 'after reload the lagna must NOT revert to Leo').not.toContain('leo');

  // ---- 4. HARD-OFFLINE RELOAD: SW shell + saved rectified chart ----
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const registration = await navigator.serviceWorker.getRegistration();
          return (
            registration?.active?.state === 'activated' &&
            navigator.serviceWorker.controller !== null
          );
        }),
      {
        timeout: 30_000,
        message: 'the dashboard must be controlled by an activated service worker',
      },
    )
    .toBe(true);

  const offlineConsoleStart = errors.length;
  try {
    await page.context().setOffline(true);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });

    expect(new URL(page.url()).pathname).toBe('/dashboard');
    expect(
      await page.evaluate(() => navigator.serviceWorker.controller !== null),
      'the offline document must be served under service-worker control',
    ).toBe(true);
    await expect(page.locator('#root')).toBeAttached();
    await waitForDashboardChart(page);

    const offlineLagna = await readDashboardLagna(page);
    expect(offlineLagna, 'the saved rectified chart must survive a hard-offline reload').toContain(
      'cancer',
    );
    expect(offlineLagna, 'offline reload must not revert to the entered-time Leo chart').not.toContain(
      'leo',
    );
    const rectificationNote = page.getByTestId('identity-rectification');
    await expect(rectificationNote).toContainText('6:44 AM');
    await expect(rectificationNote).toContainText('6:14 AM');
  } finally {
    await page.context().setOffline(false);
  }

  // Chromium's offline->online transition is not instantaneous: CI evidence
  // (main run 36732631421, rerun identical) showed a request issued ~40ms
  // AFTER this setOffline(false) already resolved still failing with
  // net::ERR_FAILED, and its console.error can be delivered to this process
  // later still. Prove the network is GENUINELY back before computing the
  // splice boundary below, so every offline-triggered console event,
  // however late Chromium delivers it, lands inside the window this test
  // already filters.
  //
  // The probe must bypass the service worker's CACHE, not just the HTTP
  // cache -- `fetch(location.href)` would NOT prove this: `/dashboard` (or
  // whatever the current route is) could be answered by the SW's
  // `navigateFallback: '/'` shell fallback, and known signal routes like
  // `/version.json` are NetworkFirst (see `runtimeCaching` in
  // vite.config.ts) which falls back to its `almamesh-signals` cache on
  // ANY fetch error -- exactly the still-offline case this probe needs to
  // detect, not mask. Instead hit a path that matches NONE of the SW's
  // routes at all, so its fetch handler never calls `respondWith()` and the
  // request goes straight to the real network (vite.config.ts
  // `runtimeCaching`: only `/bundle/(chunk|chunks|manifest|manifests)/`,
  // `/pyodide/`, `/models/`, `/public.key`, `/bundle/latest`, and
  // `/version.json` are routed; `navigateFallbackAllowlist` only covers the
  // app's real client routes, none of which match this path; the precache
  // manifest only contains real built files, which this path is not).
  // A RESOLVED fetch (any HTTP status, even a 404) proves a real network
  // round-trip completed; a REJECTED fetch (net::ERR_FAILED /
  // net::ERR_INTERNET_DISCONNECTED) proves it didn't -- `toPass` retries
  // until one genuinely succeeds.
  await expect(async () => {
    const reachedRealNetwork = await page.evaluate(() =>
      fetch(`${location.origin}/__offline-recovery-probe__?t=${Date.now()}`, {
        cache: 'no-store',
      })
        .then(() => true)
        .catch(() => false),
    );
    expect(reachedRealNetwork).toBe(true);
  }).toPass({ timeout: 10_000 });

  const offlineErrors = errors.splice(offlineConsoleStart);
  // Chromium reports the same intentional context-offline abort as either
  // ERR_INTERNET_DISCONNECTED or ERR_FAILED across Playwright browser builds.
  const unexpectedOfflineErrors = offlineErrors.filter(
    (message) =>
      !/^\[console\.error\] Failed to load resource: net::ERR_(?:INTERNET_DISCONNECTED|FAILED)$/.test(
        message,
      ),
  );
  expect(
    unexpectedOfflineErrors,
    `unexpected console errors during hard-offline reload:\n${unexpectedOfflineErrors.join('\n')}`,
  ).toEqual([]);

  // ---- 5. Fixed-date predictive computation from the persisted Cancer lagna ----
  const realNow = new Date();
  const generatedOn = new Date(TRANSIT_REFERENCE_TIME);
  await page.clock.setFixedTime(generatedOn);
  await spaNavigate(page, '/report');
  // The chart is computed as of this day (PR #277), so the dashboard's Life
  // Atlas may already have computed its facts; compute only if they are absent.
  const computePredictive = page.getByTestId('report-predictive-compute');
  const gocharaTable = page.getByTestId('report-gochara-table');
  await expect(computePredictive.or(gocharaTable)).toBeVisible({ timeout: 150_000 });
  if (await computePredictive.isVisible()) {
    await computePredictive.click();
  }
  await expect(gocharaTable).toBeVisible({ timeout: 150_000 });
  await expect(gocharaTable.getByRole('columnheader').nth(4)).toHaveText('From Lagna');
  for (const expected of RECTIFIED_TRANSIT_ROWS) {
    await expectReportTransitRow(page, expected);
  }

  // ---- 6. /report -> Download PDF (deterministic, no LLM key) ----
  const downloadBtn = page.getByTestId('report-download-pdf');
  await expect(downloadBtn).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('report-document')).toBeVisible({ timeout: 30_000 });

  // Stage-4 stable-vs-lagna: the assumptions & provenance panel ALWAYS renders
  // (ayanāṁśa, whole-sign, entered-vs-rectified, cusp proximity), and every yoga
  // carries an honest birth-time stability chip (a word, never a number).
  await expect(page.getByTestId('report-assumptions')).toBeVisible({ timeout: 30_000 });
  expect(
    (await page.getByTestId('report-assumptions-house-system').textContent())?.toLowerCase(),
    'the assumptions panel must name the whole-sign house system',
  ).toContain('whole-sign');
  await expect(
    page.getByTestId('report-stability-chip').first(),
    'each yoga must carry a birth-time stability chip',
  ).toBeVisible({ timeout: 30_000 });

  await page.screenshot({ path: REPORT_SHOT, fullPage: true });

  const [download]: [Download, void] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    downloadBtn.click(),
  ]);
  await download.saveAs(DOWNLOAD_PATH);

  // ---- 6a. DETERMINISM: the same input must produce the same FILE ----
  // The claim under test is README.md's promise that the PDF export is
  // "deterministic (same input, same file every time)". Export the SAME chart a
  // second time in the SAME page session and compare the whole files byte for
  // byte.
  //
  // The page clock is MOVED ON by one second first. Step 5 froze it at
  // TRANSIT_REFERENCE_TIME, and leaving it frozen would let a clock-reading
  // export sail through — the defect being fixed here is exactly that
  // `/CreationDate`, and the trailer `/ID` pdfkit hashes out of it, came from
  // `new Date()`. A second is enough to change both and far too little to move
  // anything this report renders, all of which is day-granular. Restored right
  // after, so step 7's fixed-date assertions are untouched.
  //
  // This is also the check the Node unit test CANNOT make: Node's
  // @react-pdf/pdfkit build deflates through async `zlib.createDeflate()`, whose
  // completion order varies between runs, while the shipped browser build is
  // single-threaded pako. The browser is the only place "same file every time"
  // is testable end to end; the unit test guards the pieces.
  await page.clock.setFixedTime(new Date(generatedOn.getTime() + 1_000));
  const [secondDownload]: [Download, void] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    downloadBtn.click(),
  ]);
  await secondDownload.saveAs(SECOND_DOWNLOAD_PATH);
  await page.clock.setFixedTime(generatedOn);

  const firstExportBytes = new Uint8Array(await readFile(DOWNLOAD_PATH));
  const secondExportBytes = new Uint8Array(await readFile(SECOND_DOWNLOAD_PATH));
  const firstExportDigest = sha256Hex(firstExportBytes);
  const secondExportDigest = sha256Hex(secondExportBytes);
  expect(
    secondExportDigest,
    `two exports of the same chart must be byte-identical:\n${pdfDeterminismReport(
      firstExportBytes,
      secondExportBytes,
    )}`,
  ).toBe(firstExportDigest);
  console.log('[report-pdf] export sha256     :', firstExportDigest);

  // ---- 7. Parse the PDF text and ASSERT correctness ----
  const pdfText = await pdfToText(DOWNLOAD_PATH);
  await writeFile(resolve(OUT_DIR, 'e2e-download.assertions.txt'), pdfText, 'utf8');

  for (const expected of RECTIFIED_TRANSIT_ROWS) {
    const columns = pdfTransitColumns(pdfText, expected.graha);
    expect(columns[1]).toBe(expected.sign);
    expect(columns[4]).toBe(String(expected.cancerHouse));
    expect(columns[4]).not.toBe(String(expected.aquariusHouse));
  }
  await page.clock.setFixedTime(realNow);

  // 7a. INVERTED on 2026-08-03 — a stated contract is being reversed, on purpose.
  //
  // This block used to assert the cover carried the EXPORT-TIME clock: the page
  // clock was frozen at TRANSIT_REFERENCE_TIME and the cover was expected to read
  // "July 11, 2026". That assertion encoded the defect. Reading the clock at
  // export time is exactly what made two downloads of one chart different files,
  // contradicting README.md's "same input, same file every time".
  //
  // The cover date is now the chart's OWN `calculation_timestamp` — a value
  // stored once, with the chart — so the assertion flips: the printed date must
  // be the real day this chart was COMPUTED, and must NOT follow the clock at
  // export. Validate that contract through the exported PDF itself, allowing
  // either wall-clock day only when the end-to-end journey crossed midnight.
  // The epoch guard below is unchanged and still load-bearing: a chart with no
  // usable instant now prints no date at all, and must never print 1969/1970.
  //
  // INVERTED AGAIN with PR #277: the chart is computed as of the transit day,
  // so cover, transits and footer name ONE day. The export clock is still not
  // read: step 6a moved it and the two exports are byte-identical.
  const computedAtLong = new Date(TRANSIT_REFERENCE_TIME).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  expect(
    pdfText,
    `the PDF cover must carry the chart's own analysis day (${computedAtLong}), the transits' day`,
  ).toContain(computedAtLong);
  const dateLine = (pdfText.split('\n').find((line) => line.includes(computedAtLong)) ?? '').trim();
  expect(pdfText, 'the PDF must NOT show the Unix-epoch year 1969').not.toMatch(/\b1969\b/);
  expect(pdfText, 'the PDF must NOT show the Unix-epoch year 1970').not.toMatch(/\b1970\b/);

  // 7b. Birth time shows the rectified 6:14 AM (not the original 6:44 AM). The
  // cover renders a 12-hour clock ("6:14 AM (Asia/Kolkata)").
  const timeOfBirthLine = (pdfText.split('\n').find((l) => /time of birth/i.test(l)) ?? '').trim();
  expect(timeOfBirthLine, 'the PDF must carry a "Time of Birth" line').toMatch(/time of birth/i);
  expect(timeOfBirthLine, 'the PDF birth-time must be the rectified 6:14 AM').toContain('6:14 AM');
  expect(timeOfBirthLine, 'the PDF birth-time must NOT be the original 6:44 AM').not.toContain('6:44');

  // 7c. Lagna / ascendant is Cancer (the rectified result), not Leo. SCOPE
  // to the "ASCENDANT (LAGNA)" birth-detail line — the PDF body may legitimately
  // name Leo elsewhere (planets occupy many signs regardless of the rising sign).
  const ascLine = pdfAscendantLine(pdfText).toLowerCase();
  expect(ascLine, 'the PDF must carry an "Ascendant (Lagna)" line').toMatch(/ascendant\s*\(lagna\)/i);
  expect(ascLine, 'the PDF ascendant must be Cancer (the rectified result)').toContain('cancer');
  expect(ascLine, 'the PDF ascendant must NOT be the original Leo').not.toContain('leo');

  // 7d. The natal sections are present (multi-page deterministic report).
  expect(pdfText, 'PDF must include the person name').toContain('Reference Native');
  expect(pdfText.toLowerCase(), 'PDF must include the birth place').toContain('bengaluru');
  // Multi-page: the report carries the deterministic natal sections. Assert a
  // few section headers are present (cover + planets + dasha + yogas).
  expect(pdfText.toLowerCase(), 'PDF must include the planetary-positions section').toContain('nakshatra');
  // The dasha section header renders as "Vimshottari Dasa" (engine spelling).
  expect(pdfText.toLowerCase(), 'PDF must include the Vimshottari dasa section').toMatch(/vimshottari|dasa/);
  expect(pdfText.toLowerCase(), 'PDF must include the yogas section').toContain('yoga');
  // 7e. The PDF mirrors the Stage-4 assumptions & provenance section.
  expect(pdfText.toLowerCase(), 'PDF must mirror the assumptions & provenance section').toContain(
    'provenance',
  );
  expect(pdfText.toLowerCase(), 'the PDF assumptions must name the whole-sign house system').toContain(
    'whole-sign',
  );

  // 7f. KEYLESS HONESTY. This lane never configures an LLM, so no reading
  // exists — and the pre-fix document simply DELETED section VII, leaving the
  // numbering to jump VI → VIII with nothing to explain it. The section must
  // now print its heading and say plainly that the written interpretation
  // appears once a reading is generated. Assert against the shipping catalog
  // copy, never hand-typed prose (see `englishReportString`). Headings
  // letter-space and the note wraps mid-sentence in the PDF, so compare on
  // whitespace-flattened, case-folded text.
  const flatPdfText = flattenPdfText(pdfText);
  expect(flatPdfText, 'the PDF must explain the unchanged headline through Assay').toContain(
    'how calculated — assay',
  );
  expect(flatPdfText, 'the PDF must show Avow as the separate integrity check').toContain(
    'what verified — avow',
  );
  const avowStatuses = pdfText
    .split('\n')
    .flatMap((line) => {
      const match = line.match(/\s{2,}(verified|failed|unavailable)\s*$/i);
      return match?.[1] ? [match[1].toLocaleLowerCase('en')] : [];
    });
  expect(
    avowStatuses.filter((status) => status === 'verified'),
    'all seven fresh-boot domain receipts must verify before export',
  ).toHaveLength(7);
  expect(
    avowStatuses.filter((status) => status === 'failed'),
    'a fresh-boot report must contain no failed domain proof',
  ).toHaveLength(0);
  expect(
    avowStatuses.filter((status) => status === 'unavailable'),
    'a fresh-boot report must contain no unavailable domain proof',
  ).toHaveLength(0);
  expect(
    avowStatuses,
    'the report must contain exactly one proof outcome for each of seven life domains',
  ).toHaveLength(7);
  expect(flatPdfText, 'the Avow claim must explicitly exclude correctness and identity').toContain(
    'not correctness or identity',
  );
  const headingNeedle = await interpretationHeadingNeedle();
  const narrativeAbsentNote = await englishReportString('pdf.narrative_absent_note');
  expect(
    flatPdfText,
    `a keyless report must still carry the Interpretation section ("${headingNeedle}")`,
  ).toContain(headingNeedle);
  expect(
    flatPdfText,
    'a keyless report must SAY the interpretation is absent, never silently skip section VII',
  ).toContain(flattenPdfText(narrativeAbsentNote));

  // 7g. The document may only GROW. 26 pages is the measured pre-fix baseline
  // (sections I–VI, VIII–XIII); a shorter report means a section was gutted.
  const downloadedPages = (
    await inspectPdfWithPoppler(new Uint8Array(await readFile(DOWNLOAD_PATH)))
  ).pages.length;
  console.log('[report-pdf] keyless page count :', downloadedPages);
  expect(
    downloadedPages,
    `the keyless report must not shrink below its ${KEYLESS_PDF_BASELINE_PAGES}-page baseline`,
  ).toBeGreaterThanOrEqual(KEYLESS_PDF_BASELINE_PAGES);

  // Surface the load-bearing lines in the test log as evidence.
  console.log('[report-pdf] generated-on date :', JSON.stringify(dateLine || computedAtLong));
  console.log('[report-pdf] time-of-birth line:', JSON.stringify(timeOfBirthLine));
  console.log('[report-pdf] ascendant line    :', JSON.stringify(pdfAscendantLine(pdfText)));

  // The PDF just generated, so yoga's wasm must have been served as an
  // own-origin hashed asset (see the response collector at the top): the
  // CSP-clean loading path actually executed, not a silent fallback.
  expect(
    wasmAssetUrls.length,
    'the PDF layout wasm must load from an own-origin /assets/*.wasm asset',
  ).toBeGreaterThan(0);
  console.log('[report-pdf] yoga wasm asset   :', wasmAssetUrls[0]);

  // Final clean-console gate across the whole journey.
  expect(errors, `console errors during the full journey:\n${errors.join('\n')}`).toEqual([]);
});

test('synthetic maximal state -> real browser download preserves report families without the separate timeline', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await mkdir(OUT_DIR, { recursive: true });
  await seedSyntheticMaximalReport(page);
  await page.goto('/report?mode=astrologer', { waitUntil: 'domcontentloaded' });

  const downloadBtn = page.getByTestId('report-download-pdf');
  await expect(downloadBtn).toBeVisible({ timeout: 30_000 });

  const [download]: [Download, void] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    downloadBtn.click(),
  ]);
  await download.saveAs(MAXIMAL_DOWNLOAD_PATH);

  const maximalBytes = new Uint8Array(await readFile(MAXIMAL_DOWNLOAD_PATH));
  const inspectedPdf = await inspectPdfWithPoppler(maximalBytes);
  const footerNote = 'AlmaMesh · Vedic Birth-Chart Report';
  expect(a4ContentBoundViolations(inspectedPdf, { footerNote })).toEqual([]);
  expect(footerGeometryViolations(inspectedPdf, { footerNote })).toEqual([]);
  expect(horizontalWordOverlapViolations(inspectedPdf, 'SADBALA')).toEqual([]);
  expect(horizontalWordOverlapViolations(inspectedPdf, 'ANTAR-DASAS')).toEqual([]);

  const expectedMahaRows = FOUNDER_DASHAS.maha_dasha_sequence.map(dashaRowTuple);
  const expectedAntarRows = FOUNDER_DASHAS.maha_dasha_sequence.flatMap((maha) =>
    (maha.antar_sequence ?? []).map(dashaRowTuple),
  );
  const expectedPratyantarRows = (FOUNDER_DASHAS.pratyantar_sequence ?? []).map(dashaRowTuple);
  const expectedDashaRows = [
    ...expectedMahaRows,
    ...expectedAntarRows,
    ...expectedPratyantarRows,
  ];
  // `styles.dashaCurrentMark` (theme.ts) sets `textTransform: 'uppercase'`, so
  // the glyphs pdftotext actually extracts are "CURRENT", not the catalog's
  // title-case "Current" — mirror that transform rather than hardcoding the
  // upper-cased word, so a font/style change can't silently desync this again.
  const dashaCurrentMarker = (
    await englishReportString('pdf.dasha_current_marker')
  ).toLocaleUpperCase('en');
  const downloadedDashaRows = downloadedDashaRowTuples(inspectedPdf, dashaCurrentMarker);
  expect(expectedMahaRows).toHaveLength(9);
  expect(expectedAntarRows).toHaveLength(81);
  expect(expectedPratyantarRows).toHaveLength(9);
  expect(new Set(expectedDashaRows).size, 'every expected dasha tuple must be unique').toBe(99);
  expect(downloadedDashaRows, 'the browser PDF must contain exactly 99 dasha rows').toHaveLength(99);
  expect(
    new Set(downloadedDashaRows).size,
    'the browser PDF must not duplicate any dasha row',
  ).toBe(99);
  expect([...downloadedDashaRows].sort()).toEqual([...expectedDashaRows].sort());

  const pdfText = (await pdfToText(MAXIMAL_DOWNLOAD_PATH)).toLowerCase();
  const pdfLines = pdfText.split('\n');
  const finalPratyantarRow = pdfLines
    .find((line) => line.includes('ketu') && line.includes('nov 2026') && line.includes('jan 2027'));
  expect(finalPratyantarRow, 'the final pratyantar row must survive the real download').toBeTruthy();
  const finalPlanetIndex = pdfLines.findIndex((line) => line.includes('final planet sentinel'));
  const finalPlanetRow = pdfLines.slice(finalPlanetIndex, finalPlanetIndex + 2).join(' ');
  expect(finalPlanetIndex, 'the final planet sentinel must survive the real download').toBeGreaterThanOrEqual(0);
  expect(finalPlanetRow, 'the final planet sentinel must remain attached to Ketu').toContain('ketu');
  const missLine = pdfLines.find(
    (line) =>
      line.includes('predicted a strong family rupture') &&
      line.includes('window with nothing reported'),
  );
  expect(missLine, 'the final quiet-period miss must survive the real download').toBeTruthy();
  for (const sentinel of [
    'pratyantar',
    'transits & timing',
    'd10',
    'd60',
    '165.00',
    '6.13',
    'life domains',
    'career',
    'how calculated — assay',
    'what verified — avow',
    '82.50%',
    '53.57%',
    'not correctness or identity',
    'birth time authority',
    'accepted the maximal browser sentinel role',
    'final yoga sentinel',
    'final paginated event sentinel',
    NATAL_REPORT_SENTINEL.toLowerCase(),
    '08:15',
    'timed to the sub-sub-period',
  ]) {
    expect(pdfText, `downloaded maximal PDF is missing ${sentinel}`).toContain(sentinel);
  }
  expect(
    pdfText,
    'the independently dated current timeline must remain dashboard-only',
  ).not.toContain(CURRENT_SKY_SENTINEL.toLowerCase());
});

test('a natal-only reading still prints after predictive facts refresh', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await mkdir(OUT_DIR, { recursive: true });

  // Seed a stored chart plus a complete natal-only reading beside a refreshed
  // predictive slice carrying raw contexts. The stable reading must remain in
  // the report; changing current timing facts no longer invalidates natal prose.
  await seedSyntheticMaximalReport(page, { staleNatalOnlyReading: true });
  await page.goto('/report?mode=astrologer', { waitUntil: 'domcontentloaded' });

  const downloadBtn = page.getByTestId('report-download-pdf');
  await expect(
    downloadBtn,
    'a stale reading must not disable export — a stored chart is the only precondition',
  ).toBeVisible({ timeout: 30_000 });

  const [download]: [Download, void] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    downloadBtn.click(),
  ]);
  await download.saveAs(STALE_DOWNLOAD_PATH);

  const pdfText = await pdfToText(STALE_DOWNLOAD_PATH);
  const flatPdfText = flattenPdfText(pdfText);

  // The section header is present...
  const headingNeedle = await interpretationHeadingNeedle();
  expect(
    flatPdfText,
    `the stale-status PDF must carry the Interpretation section ("${headingNeedle}")`,
  ).toContain(headingNeedle);

  // ...AND the seeded prose itself. Before the fix the PDF omitted the narrative
  // entirely — this pair of sentinels is the property under test.
  expect(
    flatPdfText,
    'the stale natal-only SUMMARY must survive into the downloaded PDF',
  ).toContain(flattenPdfText(NATAL_ONLY_SUMMARY_SENTINEL));
  expect(
    flatPdfText,
    'the stale natal-only STRENGTHS block must survive into the downloaded PDF',
  ).toContain(flattenPdfText(NATAL_ONLY_STRENGTH_SENTINEL));

  // And the "no reading" note must NOT appear — there IS a reading here, and
  // printing the honest-absence note beside real prose would be a new lie.
  const narrativeAbsentNote = await englishReportString('pdf.narrative_absent_note');
  expect(
    flatPdfText,
    'a report that HAS a reading must not also claim no reading was generated',
  ).not.toContain(flattenPdfText(narrativeAbsentNote));
});
