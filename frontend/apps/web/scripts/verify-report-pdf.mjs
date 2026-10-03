#!/usr/bin/env node
/**
 * verify-report-pdf.mjs — regenerate the print-first Vedic report PDF to PROVE
 * the three visual fixes (dark interpretation prose + full pages, formatted
 * dasha duration, spaced kundli labels).
 *
 * It reuses the same harness shape as scripts/verify-exit-gate.mjs +
 * e2e/interpretation.helpers.ts: a REAL production build with the exit-gate
 * hooks (VITE_EXIT_GATE_HOOKS=1) served by `vite preview`, driven by the
 * project Playwright Chromium. It boots the in-browser Pyodide engine, generates
 * the real Delhi chart (so the dasha sequence — incl. the Venus balance float —
 * is the engine's own), then seeds a COMPLETE interpretation with LONG
 * multi-paragraph strengths / challenges / guidance, then restores the fixture
 * through Settings' shipped backup boundary into canonical SQLite. It opens
 * /report, emulates print media, and writes an A4 PDF + per-page PNGs.
 *
 * Requires: `pdftoppm` from poppler-utils, on PATH. The per-page PNGs ARE the
 * verification — a run that cannot rasterize has verified nothing — so a missing
 * binary fails the run rather than skipping the step.
 *   macOS:         brew install poppler
 *   Debian/Ubuntu: sudo apt-get install -y poppler-utils
 *
 * Usage (the caller builds + previews first, then passes the base URL):
 *   node scripts/verify-report-pdf.mjs http://localhost:4317
 *
 * Output:
 *   /tmp/almamesh-verify/report2/report-astrologer.pdf
 *   /tmp/almamesh-verify/report2/astro2-page-*.png
 */

import { chromium } from '@playwright/test';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { confirmLegacyBackupImport } from './confirmLegacyBackupImport.mjs';

const BASE_URL = process.argv[2] ?? 'http://localhost:4317';
// Output dir + per-page PNG prefix are overridable so the same harness can
// regenerate successive verification runs (report2, report3, …) side by side.
const OUT_DIR = process.env.REPORT_PDF_OUT_DIR ?? '/tmp/almamesh-verify/report2';
const PAGE_PREFIX = process.env.REPORT_PDF_PAGE_PREFIX ?? 'astro2-page';
const CHART_ID = 'interp-delhi-1990';

const DELHI_BIRTH = {
  datetimeUtc: '1990-01-15T12:00:00.000Z',
  latitude: 28.6139,
  longitude: 77.209,
  referenceDate: '2025-01-01T00:00:00+00:00',
  name: 'Delhi Report Test',
};

// LONG multi-paragraph copy so the interpretation pages are genuinely full and
// the page-break + dark-prose fixes are exercised under real content.
const P1 =
  'The lagna lord sits in a kendra in close aspect to a benefic, lending a steady, ' +
  'self-possessed core that others read as quiet authority. Across the formative ' +
  'years this expresses as a capacity to absorb pressure without visibly fraying, ' +
  'and to return to a task long after the initial enthusiasm of others has burned ' +
  'off. The chart rewards patience over flourish.';
const P2 =
  'A second strand runs through the same configuration: a pull toward synthesis. ' +
  'Where many charts scatter their significations, here the planetary dispositions ' +
  'fold back toward a single axis, so the native tends to braid disparate skills ' +
  'into one coherent vocation rather than holding several apart. This is the ' +
  'engine of slow, compounding competence.';
const P3 =
  'Materially, the dhana indications are neither sudden nor fragile. Wealth, when ' +
  'it arrives, tracks demonstrated reliability and accrues across decades; the ' +
  'remedial emphasis is therefore on consistency and on resisting the temptation ' +
  'to trade a durable position for a faster one. Guard the routine and the routine ' +
  'guards you.';
const LONG = (lead) => `${lead}\n\n${P1}\n\n${P2}\n\n${P3}`;

function persona(lead) {
  return { layman: LONG(lead), technical: LONG(`${lead} (technical voice)`) };
}
function titled(title, lead) {
  return { title, ...persona(lead) };
}

const INTERPRETATION = {
  summary: LONG('In summary, this is a chart built for endurance rather than spectacle.'),
  strengths: [
    titled('Resilience under load', 'The first strength is sheer staying power.'),
    titled('Synthetic intelligence', 'The second strength is the habit of synthesis.'),
    titled('Quiet authority', 'The third strength is unforced credibility.'),
  ],
  challenges: [
    titled('Over-deliberation', 'The first challenge is the cost of caution.'),
    titled('Difficulty delegating', 'The second challenge is holding too much alone.'),
    titled('Slow to celebrate', 'The third challenge is deferring satisfaction.'),
  ],
  life_themes: [
    titled('The long apprenticeship', 'A recurring theme is the long apprenticeship.'),
    titled('Stewardship', 'A second theme is stewardship over ownership.'),
  ],
  health_guidance: persona('On health, the chart asks for rhythm over intensity.'),
  relationship_guidance: persona('In relationships, depth is favoured over breadth.'),
  career_guidance: persona('In career, the arc rewards a single deepening track.'),
  education_guidance: persona('In learning, structured study beats improvisation.'),
  finances_guidance: persona('On finances, durable beats fast at every horizon.'),
  spiritual_guidance: persona('Spiritually, a steady practice anchors the rest.'),
  life_evolution_guidance: persona('Over time, the native grows into stewardship.'),
  remedial_measures: persona('The remedial measures are simple and repeatable.'),
};

async function boot(page) {
  await page.goto(BASE_URL + '/onboarding', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => {
      const w = window;
      if (w.__ALMAMESH_ERROR__) throw new Error('engine boot error: ' + w.__ALMAMESH_ERROR__);
      return w.__ALMAMESH_STAGE__ === 'ready' && typeof w.__almameshGenerate === 'function';
    },
    undefined,
    { timeout: 180_000, polling: 500 },
  );
}

async function seed(page) {
  return page.evaluate(
    async ({ birth, chartId, interpretation }) => {
      const w = window;
      const chart = await w.__almameshGenerate(birth);
      const profileId = `${chartId}-profile`;

      const stored = {
        chart_id: chartId,
        profile_id: profileId,
        person_name: birth.name,
        is_primary: true,
        birth_data: {
          name: birth.name,
          birth_datetime_utc: birth.datetimeUtc,
          birth_datetime_local: '1990-01-15T17:30:00',
          birth_location_details: {
            city: 'Delhi',
            state: 'Delhi',
            country: 'India',
            latitude: birth.latitude,
            longitude: birth.longitude,
            timezone: 'Asia/Kolkata',
            location_name: 'Delhi, India',
          },
        },
        astronomical_calculations: {
          sidereal_ctx: {
            ayanamsa_value: chart.ayanamsa_value ?? 0,
            ayanamsa_type: 'lahiri',
            house_system: 'whole_sign',
            julian_day: 0,
            sidereal_time: 0,
            lagna: chart.lagna,
            planets: chart.planets,
          },
          varga_ctx: undefined,
          dasha_ctx: undefined,
          yoga_ctx: chart.yogas ?? [],
          calculation_timestamp: '2025-01-01T00:00:00+00:00',
          software_version: 'almamesh-browser-engine',
        },
        interpretation: undefined,
        sidereal_chart: chart,
      };

      const backup = JSON.stringify({
        format: 'almamesh-backup',
        formatVersion: 1,
        app: { version: 'verify-report-pdf' },
        exportedAt: '2025-01-01T00:00:00.000Z',
        encryption: 'none',
        stores: {
          'almamesh-profiles': {
            version: 1,
            state: {
              profiles: {
                [profileId]: {
                  id: profileId,
                  name: birth.name,
                  createdAt: '2025-01-01T00:00:00.000Z',
                  avatarTint: '#3A4FB0',
                  relationship: 'self',
                },
              },
              activeProfileId: profileId,
            },
          },
          'almamesh-chart-library': {
            version: 1,
            state: { charts: { [chartId]: stored } },
          },
          'almamesh-interpretations': {
            version: 6,
            state: {
              byChart: {
                [chartId]: {
                  profileId,
                  status: 'complete',
                  interpretation,
                  sections: {
                    core: true,
                    yoga: true,
                    guidance1: true,
                    guidance2: true,
                    remedial: true,
                  },
                  updatedAt: Date.now(),
                },
              },
            },
          },
        },
      });

      // Report the raw Venus balance duration so the harness can assert the fix.
      const seq = chart?.dashas?.maha_dasha_sequence ?? [];
      return {
        backup,
        lagna: chart?.lagna?.sign ?? null,
        firstDuration: seq.length ? seq[0].duration_years : null,
        firstLord: seq.length ? seq[0].lord : null,
        seqLen: seq.length,
      };
    },
    { birth: DELHI_BIRTH, chartId: CHART_ID, interpretation: INTERPRETATION },
  );
}

async function restoreBackup(page, backup) {
  await page.addInitScript(() => {
    Reflect.deleteProperty(window, 'showOpenFilePicker');
    Reflect.deleteProperty(window, 'showSaveFilePicker');
  });
  await page.goto(BASE_URL + '/settings/data', { waitUntil: 'domcontentloaded' });
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByTestId('backup-import-button').click(),
  ]);
  await chooser.setFiles({
    name: 'verify-report-pdf.json',
    mimeType: 'application/json',
    buffer: Buffer.from(backup, 'utf8'),
  });
  await confirmLegacyBackupImport(page);
}

/**
 * Fail closed BEFORE the expensive work (a Chromium launch + a ~3 minute Pyodide
 * boot): without pdftoppm this harness cannot produce the page images it exists
 * to produce, so it must refuse to start rather than report success at the end.
 */
function requirePdftoppm() {
  try {
    execFileSync('pdftoppm', ['-v'], { stdio: 'ignore' });
  } catch (err) {
    console.error('Missing dependency: pdftoppm (poppler-utils) is not on PATH.');
    console.error('  ' + err.message);
    console.error('This script verifies the report by rasterizing every PDF page to a PNG,');
    console.error('so it cannot run without it. Install poppler and re-run:');
    console.error('  macOS:         brew install poppler');
    console.error('  Debian/Ubuntu: sudo apt-get install -y poppler-utils');
    process.exit(1);
  }
}

/** The page PNGs this run's prefix owns. */
function pagePngs() {
  return readdirSync(OUT_DIR).filter((f) => f.startsWith(PAGE_PREFIX + '-') && f.endsWith('.png'));
}

/**
 * Rasterize each PDF page to a PNG. Throws — and so exits non-zero — if pdftoppm
 * fails OR if it exits 0 having written nothing. Stale PNGs from an earlier run
 * are deleted first, so the count below is evidence about THIS invocation.
 */
function rasterize(pdfPath) {
  pagePngs().forEach((f) => unlinkSync(OUT_DIR + '/' + f));
  execFileSync('pdftoppm', ['-r', '120', '-png', pdfPath, OUT_DIR + '/' + PAGE_PREFIX], {
    stdio: 'inherit',
  });
  const produced = pagePngs();
  if (produced.length === 0) {
    throw new Error('pdftoppm exited 0 but wrote no ' + PAGE_PREFIX + '-*.png in ' + OUT_DIR);
  }
  console.log(
    'Rasterized ' + produced.length + ' page(s) to ' + OUT_DIR + '/' + PAGE_PREFIX + '-*.png',
  );
}

async function main() {
  requirePdftoppm();
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

  console.log('Booting engine at ' + BASE_URL + ' ...');
  await boot(page);
  console.log('Engine ready. Generating chart + interpretation fixture ...');
  const seeded = await seed(page);
  await restoreBackup(page, seeded.backup);
  console.log(
    'Restored to canonical SQLite:',
    JSON.stringify({
      lagna: seeded.lagna,
      firstDuration: seeded.firstDuration,
      firstLord: seeded.firstLord,
      seqLen: seeded.seqLen,
    }),
  );

  // Open the astrologer report; wait for the rendered document (not the empty state).
  await page.goto(BASE_URL + '/report?mode=astrologer', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="report-document"]', { timeout: 30_000 });
  await page.waitForSelector('[data-testid="report-interpretation"]', { timeout: 30_000 });
  await page.waitForSelector('[data-testid="report-dasha"]', { timeout: 30_000 });

  // Screen screenshot (full page) for reference.
  await page.screenshot({ path: OUT_DIR + '/report-astrologer-screen.png', fullPage: true });

  // Print PDF.
  await page.emulateMedia({ media: 'print' });
  const pdfPath = OUT_DIR + '/report-astrologer.pdf';
  await page.pdf({ path: pdfPath, format: 'A4', printBackground: true });
  console.log('Wrote ' + pdfPath);

  await browser.close();

  rasterize(pdfPath);

  // Same rule as the missing binary above: a run that saw the page throw has not
  // verified the page. Printing the errors and exiting 0 is how a harness reports
  // success it did not earn.
  if (consoleErrors.length) {
    console.error('CONSOLE ERRORS during flow:');
    consoleErrors.forEach((e) => console.error('  - ' + e));
    throw new Error(consoleErrors.length + ' console/page error(s) during the report flow');
  }
  console.log('No console errors during the flow.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
