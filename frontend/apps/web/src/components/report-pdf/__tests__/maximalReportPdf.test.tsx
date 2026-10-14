import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { renderToBuffer } from '@react-pdf/renderer';
import { act } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ReportDocument } from '../ReportDocument';
import { planDashaTablePages } from '../sections/ReportPdfDasha';
import { registerReportFonts } from '../theme';
import type { ReportPdfAntarTable, ReportPdfData } from '../types';
import {
  ALL_VARGA_IDS,
  buildMaximalReportPdfData,
  CURRENT_SKY_SENTINEL,
  FINAL_MAHA_SENTINELS,
  FINAL_PLANET_SENTINEL,
  FINAL_PRATYANTAR_SENTINELS,
  FINAL_YOGA_SENTINEL,
  LEGACY_LIFE_EVENT_BLOB,
} from './maximalReportFixture';
import {
  a4ContentBoundViolations,
  footerGeometryViolations,
  horizontalWordOverlapViolations,
  inspectPdfWithPoppler,
  linesContainingAll,
  normalizePdfText,
  pagesContaining,
  type InspectedPdf,
} from './pdfPoppler';

vi.hoisted(() => {
  const entries = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      get length() {
        return entries.size;
      },
      clear: () => entries.clear(),
      getItem: (key: string) => entries.get(key) ?? null,
      key: (index: number) => [...entries.keys()][index] ?? null,
      removeItem: (key: string) => entries.delete(key),
      setItem: (key: string, value: string) => entries.set(key, value),
    },
  });
});

function expectSamePage(pdf: Awaited<ReturnType<typeof inspectPdfWithPoppler>>, ...needles: string[]) {
  const pageSets = needles.map((needle) => pagesContaining(pdf, needle));
  const shared = pageSets[0]?.filter((page) => pageSets.every((pages) => pages.includes(page))) ?? [];
  expect(
    shared,
    `Expected ${needles.map((needle) => JSON.stringify(needle)).join(' and ')} on one page; found ${JSON.stringify(pageSets)}`,
  ).not.toHaveLength(0);
}

describe('maximal report PDF acceptance', () => {
  let data: ReportPdfData;
  let pdf: InspectedPdf;

  beforeAll(async () => {
    registerReportFonts(path.resolve('public/fonts'));
    data = buildMaximalReportPdfData();
    let bytes: Uint8Array | undefined;
    await act(async () => {
      bytes = await renderToBuffer(<ReportDocument data={data} />);
    });
    if (!bytes) throw new Error('The maximal report did not render bytes');
    const output = process.env.ALMAMESH_MAXIMAL_PDF_OUTPUT;
    if (output) {
      await writeFile(output, bytes);
    }
    pdf = await inspectPdfWithPoppler(bytes);
  }, 60_000);

  it('builds every maximal chart, period, table, and rectification slice', () => {
    expect(data.planets).toHaveLength(10);
    expect(data.planets.at(-1)?.name).toBe(FINAL_PLANET_SENTINEL);
    expect(data.yogas).toHaveLength(3);
    expect(data.yogas.at(-1)?.name).toBe(FINAL_YOGA_SENTINEL);
    expect(data.dasha.mahaSequence).toHaveLength(9);
    expect(data.dasha.mahaSequence.at(-1)).toMatchObject({
      lord: FINAL_MAHA_SENTINELS[0],
      end: FINAL_MAHA_SENTINELS[1],
    });
    expect(data.dasha.antarTables).toHaveLength(9);
    expect(data.dasha.antarTables.every((table) => table.periods.length === 9)).toBe(true);
    expect(data.vargas?.plates.map((plate) => plate.id)).toEqual(ALL_VARGA_IDS);
    const pratyantar = data.dasha.antarTables[0]?.pratyantarTable;
    expect(pratyantar?.periods).toHaveLength(9);
    expect(pratyantar?.periods.at(-1)).toMatchObject({
      lord: FINAL_PRATYANTAR_SENTINELS[0],
      end: FINAL_PRATYANTAR_SENTINELS[1],
    });
    expect(data.transits?.gochara.rows.length).toBeGreaterThan(0);
    expect(data.transits?.slowHits.rows.length).toBeGreaterThan(0);
    expect(data.transits?.timeline.rows.length).toBeGreaterThan(0);
    expect(data.vargas?.vimshopaka.rows.length).toBeGreaterThan(0);
    expect(data.strength?.savCells).toHaveLength(12);
    expect(data.strength?.bav.rows.length).toBeGreaterThan(0);
    expect(data.strength?.shadbala.rows.length).toBeGreaterThan(0);
    expect(data.domains?.blocks).toHaveLength(8);
    expect(data.domains?.blocks.every((block) => block.windows.length > 0)).toBe(true);
    expect(data.domains?.blocks.every((block) => block.assay.components.length === 3)).toBe(true);
    expect(data.domains?.blocks.every((block) => block.avow.status === 'Unavailable')).toBe(true);
    expect(data.rectification?.events.rows).toHaveLength(11);
    expect(data.rectification?.events.headers).toHaveLength(2);
    expect(data.rectification?.events.rows.every((row) => row.cells.length === 2)).toBe(true);
    expect(JSON.stringify(data.rectification?.events)).not.toContain(
      'Life events used for rectification',
    );
    expect(data.rectification?.candidates?.rows.length).toBeGreaterThan(0);
    expect(data.rectification?.evidence?.rows.length).toBeGreaterThan(0);
    expect(data.rectification?.missNotes?.length).toBeGreaterThan(0);
  });

  it('plans bounded dasha continuation pages instead of trusting renderer auto-wrap', () => {
    const pratyantar = data.dasha.antarTables.find((table) => table.pratyantarTable)
      ?.pratyantarTable;
    expect(pratyantar).toBeDefined();
    if (!pratyantar) throw new Error('The maximal fixture must include a pratyantar table');

    const plainTables = data.dasha.antarTables.map(({ pratyantarTable: _, ...table }) => table);
    expect(planDashaTablePages([])).toEqual([]);
    expect(planDashaTablePages(plainTables.slice(0, 1))).toEqual([plainTables.slice(0, 1)]);

    plainTables.forEach((_, pratyantarIndex) => {
      const positioned: readonly ReportPdfAntarTable[] = plainTables.map((table, index) =>
        index === pratyantarIndex ? { ...table, pratyantarTable: pratyantar } : table,
      );
      const pages = planDashaTablePages(positioned);
      const units = pages.map((page) =>
        page.reduce((total, table) => total + (table.pratyantarTable ? 2 : 1), 0),
      );

      expect([5, 6]).toContain(pages.length);
      expect(units.every((pageUnits) => pageUnits <= 2)).toBe(true);
      expect(pages.flat()).toEqual(positioned);
      expect(
        pages.some(
          (page) =>
            page.includes(positioned[pratyantarIndex]!) &&
            positioned[pratyantarIndex]?.pratyantarTable === pratyantar,
        ),
      ).toBe(true);
    });
  });

  it('preserves every chart/table sentinel and removes the repeated legacy narrative', () => {
    const foldedText = pdf.text.toLocaleUpperCase('en');
    const pratyantar = data.dasha.antarTables[0]?.pratyantarTable;

    expect(foldedText).toContain('MAXIMAL REFERENCE NATIVE');
    expect(foldedText).toContain('RASI D1 MAIN SENTINEL');
    expect(foldedText).toContain('NAVAMSA D9 MAIN SENTINEL');
    expect(foldedText).toContain(data.labels.colPlanet.toLocaleUpperCase('en'));
    expect(
      linesContainingAll(pdf, [FINAL_PLANET_SENTINEL, data.planets.at(-1)?.sign ?? '']),
    ).not.toHaveLength(0);
    expect(linesContainingAll(pdf, FINAL_MAHA_SENTINELS)).not.toHaveLength(0);
    expect(foldedText).toContain(FINAL_YOGA_SENTINEL.toLocaleUpperCase('en'));
    expect(foldedText).toContain(CURRENT_SKY_SENTINEL.toLocaleUpperCase('en'));
    for (const table of data.dasha.antarTables) {
      const finalPeriod = table.periods.at(-1);
      expect(foldedText, `missing antar table heading ${table.heading}`).toContain(
        table.heading.toLocaleUpperCase('en'),
      );
      expect(
        linesContainingAll(pdf, [finalPeriod?.lord ?? '', finalPeriod?.end ?? '']),
        `missing final row for ${table.heading}`,
      ).not.toHaveLength(0);
    }
    for (const plate of data.vargas?.plates ?? []) {
      expect(foldedText, `missing varga caption ${plate.caption}`).toContain(
        normalizePdfText(plate.caption).toLocaleUpperCase('en'),
      );
    }
    expect(foldedText).toContain('D60');
    expect(foldedText).toContain(pratyantar?.heading.toLocaleUpperCase('en'));
    expect(
      linesContainingAll(pdf, FINAL_PRATYANTAR_SENTINELS),
      'the final pratyantar lord and end date must survive on one rendered row',
    ).not.toHaveLength(0);
    expect(pdf.text).toContain('165.00');
    expect(pdf.text).toContain('6.13');
    expect(foldedText).toContain('HOW CALCULATED — ASSAY');
    expect(foldedText).toContain('WHAT VERIFIED — AVOW');
    expect(pdf.text).toContain('82.50%');
    expect(pdf.text).toContain('53.57%');
    expect(foldedText).not.toContain(
      normalizePdfText(LEGACY_LIFE_EVENT_BLOB).toLocaleUpperCase('en'),
    );
    expect(foldedText).not.toContain('LIFE EVENTS USED FOR RECTIFICATION');
  });

  /**
   * Section XIII is the honesty furniture the product's credibility rests on:
   * which ayanamsa, which house system, whether the birth time was rectified,
   * and how near the ascendant sits to a cusp. Nothing asserted it in a REAL
   * rendered PDF, so it was one refactor away from silently vanishing from the
   * durable artifact while every other test stayed green.
   */
  it('prints Assumptions & Provenance with all four load-bearing rows', () => {
    const assumptions = data.assumptions;
    expect(assumptions, 'the maximal fixture must carry Section XIII').toBeDefined();
    if (!assumptions) return;

    const [pageNumber] = pagesContaining(pdf, assumptions.chrome.title);
    expect(pageNumber, 'Section XIII must reach a rendered page').toBeDefined();
    const page = pdf.pages.find((candidate) => candidate.number === pageNumber);
    const pageText = normalizePdfText(page?.text ?? '').toLocaleLowerCase('en');

    expect(assumptions.rows).toHaveLength(4);
    for (const row of assumptions.rows) {
      // Labels are small-caps and wrap around the value column, so poppler
      // reads their words out of order — assert every word landed, not a
      // contiguous run.
      for (const word of normalizePdfText(row.label).toLocaleLowerCase('en').split(' ')) {
        expect(pageText, `missing word ${word} of assumptions label ${row.label}`).toContain(word);
      }
      // A label with no value beside it would state an assumption without
      // disclosing it — the exact failure this section exists to prevent.
      expect(pageText, `missing assumptions value for ${row.label}`).toContain(
        normalizePdfText(row.value).toLocaleLowerCase('en'),
      );
    }
  });

  it('keeps content and footer text inside their A4 layout regions', () => {
    expect(a4ContentBoundViolations(pdf, { footerNote: data.labels.footerNote })).toEqual([]);
  });

  it('keeps dense Shadbala headers geometrically separate and extractable', () => {
    expect(horizontalWordOverlapViolations(pdf, 'SADBALA')).toEqual([]);
    const foldedText = pdf.text.toLocaleUpperCase('en');
    for (const index of [5, 6, 8, 9]) {
      const header = data.strength?.shadbala.headers[index];
      expect(header).toBeDefined();
      expect(foldedText).toContain(header?.toLocaleUpperCase('en'));
    }
  });

  it('keeps each rectification heading with its first body row', () => {
    const rectification = data.rectification;
    expect(rectification).toBeDefined();
    if (!rectification) return;
    expectSamePage(pdf, rectification.eventsHeading, rectification.events.rows[0]?.cells[1] ?? '');
    expectSamePage(
      pdf,
      rectification.candidatesHeading ?? '',
      rectification.candidates?.rows[0]?.cells.at(-1) ?? '',
    );
    expectSamePage(
      pdf,
      rectification.evidenceHeading?.split(',')[0] ?? '',
      rectification.evidence?.rows[0]?.cells.at(-1) ?? '',
    );
  });

  it('keeps the pratyantar table heading with its first period row', () => {
    const pratyantar = data.dasha.antarTables[0]?.pratyantarTable;
    expect(pratyantar).toBeDefined();
    if (pratyantar) {
      expectSamePage(pdf, 'PRATYANTAR-DASAS', pratyantar.periods[0]?.end ?? '');
    }
  });

  it('renders the footer note and page counter on every content page', () => {
    const contentPages = pdf.pages.slice(1);
    expect(contentPages.length).toBeGreaterThan(0);
    const footer = normalizePdfText(data.labels.footerNote).toLocaleUpperCase('en');
    for (const page of contentPages) {
      const pageText = normalizePdfText(page.text).toLocaleUpperCase('en');
      expect(pageText, `page ${page.number} footer note`).toContain(footer);
      expect(pageText, `page ${page.number} page counter`).toContain(
        `${page.number} / ${pdf.pages.length}`,
      );
    }
    expect(footerGeometryViolations(pdf, { footerNote: data.labels.footerNote })).toEqual([]);
  });
});
