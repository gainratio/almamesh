/**
 * Evidence & Confidence — acceptance against REAL PDF BYTES.
 *
 * Everything here is asserted on text extracted by `pdftotext` from a rendered
 * document, never on a React tree. That distinction is the whole point: a
 * section can be present in the component graph and still be invisible in the
 * artifact a reader actually keeps — clipped, overlapped, or dropped by a
 * layout rule. The durable artifact is the thing under test.
 *
 * Four properties, each one a claim the section makes to the reader:
 *
 *  1. THE METHOD IS PRINTED. The ceiling table with its reasons, and both
 *     deduction thresholds interpolated from `CUSP_THRESHOLD_DEG` /
 *     `BOUNDARY_MARGIN_DEG` — so a level can be re-derived, not just believed.
 *  2. THE SECOND CHART IS PRINTED IN FULL, every graha's move, plus the explicit
 *     admission that the equivalent in MINUTES of birth time was not computed.
 *  3. EVERY ROW CARRIES ALL FIVE CELLS. Drop one — say the Alternative — and
 *     this goes red by observation id.
 *  4. GENERAL GUIDANCE STAYS BARE. Statements the model declared ungrounded
 *     render with no Evidence, Confidence or Alternative beside them, because
 *     dressing them in the ledger's furniture is the laundering this section
 *     exists to prevent.
 */

import path from 'node:path';
import { renderToBuffer } from '@react-pdf/renderer';
import { act } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ReportDocument } from '../ReportDocument';
import { buildEvidenceSection } from '../buildEvidenceSection';
import { glyphSafe } from '../glyphSafe';
import { registerReportFonts } from '../theme';
import type { ReportPdfData, ReportPdfEvidence } from '../types';
import { buildEvidenceLedger } from '../../../lib/evidence';
import {
  buildMaximalReportPdfData,
  CHART,
  EVIDENCE_GUIDANCE_SENTINEL,
  maximalReportT,
} from './maximalReportFixture';
import { inspectPdfWithPoppler, normalizePdfText, type InspectedPdf } from './pdfPoppler';

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

/** Poppler folds all whitespace, so compare against the same folding. */
function folded(value: string): string {
  return normalizePdfText(value).toLocaleLowerCase('en');
}

describe('Evidence & Confidence — the exported PDF', () => {
  let data: ReportPdfData;
  let evidence: ReportPdfEvidence;
  let pdf: InspectedPdf;
  let text: string;

  beforeAll(async () => {
    registerReportFonts(path.resolve('public/fonts'));
    data = buildMaximalReportPdfData();
    if (!data.evidence) throw new Error('The maximal fixture must carry Section VIII');
    evidence = data.evidence;
    let bytes: Uint8Array | undefined;
    await act(async () => {
      bytes = await renderToBuffer(<ReportDocument data={data} />);
    });
    if (!bytes) throw new Error('The maximal report did not render bytes');
    pdf = await inspectPdfWithPoppler(bytes);
    text = folded(pdf.text);
  }, 90_000);

  it('opens as a numbered section, after Interpretation', () => {
    expect(evidence.chrome.eyebrow).toBe('Section VIII');
    expect(text).toContain(folded(evidence.chrome.title));
    expect(text).toContain(folded(evidence.chrome.eyebrow));
  });

  it('prints the ceiling table — every class, its level, and its reason', () => {
    expect(evidence.ceilings).toHaveLength(3);
    expect(text).toContain(folded(evidence.ceilingHeading));
    for (const ceiling of evidence.ceilings) {
      expect(text, `missing ceiling label ${ceiling.label}`).toContain(folded(ceiling.label));
      expect(text, `missing ceiling reason for ${ceiling.label}`).toContain(folded(ceiling.value));
    }
    expect(text).toContain(folded(evidence.ceilingNote));
    expect(text).toContain(folded(evidence.formula));
  });

  it('prints every deduction rule with its real numeric threshold', () => {
    expect(text).toContain(folded(evidence.deductionHeading));
    for (const rule of evidence.deductionRules) {
      expect(text, `missing deduction rule ${rule}`).toContain(folded(rule));
    }
    // The thresholds themselves, interpolated from the exported constants —
    // never retyped into the copy, so they cannot drift from the code.
    expect(text).toContain('3.00°');
    expect(text).toContain('1.00°');
  });

  it('prints the whole second chart, and refuses to state it in minutes', () => {
    expect(evidence.alternateShifts?.length ?? 0).toBeGreaterThan(0);
    expect(text).toContain(folded(evidence.alternateHeading ?? ''));
    expect(text).toContain(folded(evidence.alternateLead ?? ''));
    for (const shift of evidence.alternateShifts ?? []) {
      expect(text, `missing alternate-chart shift ${shift}`).toContain(folded(shift));
    }
    expect(text).toContain(folded(evidence.alternateMinutesNote ?? ''));
  });

  it('prints all five cells of every observation row', () => {
    expect(evidence.rows.length).toBeGreaterThan(0);
    const labels = evidence.cellLabels;
    for (const label of Object.values(labels)) {
      expect(text, `missing cell label ${label}`).toContain(folded(label));
    }
    for (const row of evidence.rows) {
      const where = `row ${row.observationId}`;
      expect(text, `${where}: observation cell missing`).toContain(folded(row.observation));
      for (const factor of row.evidence) {
        expect(text, `${where}: evidence line missing — ${factor}`).toContain(folded(factor));
      }
      expect(text, `${where}: interpretation cell missing`).toContain(folded(row.interpretation));
      expect(text, `${where}: confidence cell missing`).toContain(folded(row.confidence));
      expect(text, `${where}: alternative cell missing`).toContain(folded(row.alternative));
    }
  });

  it('restates measured values in the Evidence cell, never the interpretation', () => {
    // The richest row in the fixture: a model-class ceiling, a lagna-fork
    // deduction, and a floored level — every input to that arithmetic printed.
    const row = evidence.rows.find((candidate) => candidate.evidence.length > 1);
    expect(row, 'the fixture must carry a multi-factor observation').toBeDefined();
    if (!row) return;
    for (const factor of row.evidence) {
      // `<id> · <measured values> · <class>` — the id makes it checkable.
      expect(factor).toMatch(/·/);
    }
    expect(row.confidence.toLowerCase()).toMatch(/ceiling/);
  });

  it('keeps General guidance bare — no Evidence, Confidence or Alternative', () => {
    const heading = evidence.guidanceHeading ?? '';
    expect(heading, 'the maximal fixture must exercise general guidance').not.toBe('');
    expect(evidence.guidance ?? []).toContain(EVIDENCE_GUIDANCE_SENTINEL);

    const page = pdf.pages.find((candidate) => folded(candidate.text).includes(folded(heading)));
    expect(page, 'the general-guidance block must reach a rendered page').toBeDefined();
    if (!page) return;

    const pageText = folded(page.text);
    for (const statement of evidence.guidance ?? []) {
      expect(pageText, `guidance statement missing: ${statement}`).toContain(folded(statement));
    }
    // The separation is the point: these statements rest on nothing computed,
    // so none of the ledger's cells may appear beside them.
    for (const label of [
      evidence.cellLabels.evidence,
      evidence.cellLabels.confidence,
      evidence.cellLabels.alternative,
      evidence.cellLabels.observation,
      evidence.cellLabels.interpretation,
    ]) {
      expect(pageText, `general guidance must not carry a ${label} cell`).not.toContain(
        folded(label),
      );
    }
  });

  it('counts the model statements it rejected, so a drop is never silent', () => {
    expect(data.evidence?.rejectedNote, 'the fixture must exercise a rejection').toBeTruthy();
    expect(text).toContain(folded(evidence.rejectedNote ?? ''));
  });

  it('keeps a legacy near-cusp chart consistent in the durable PDF bytes', async () => {
    const legacyChart = {
      ...CHART,
      lagna: {
        ...CHART.lagna,
        lagna_cusp_distance_deg: undefined,
        lagna_adjacent_sign: undefined,
        is_near_cusp: undefined,
      },
    };
    const legacyEvidence = buildEvidenceSection(
      buildEvidenceLedger(legacyChart),
      maximalReportT(),
      glyphSafe,
    );
    const rulership = legacyEvidence.rows.find(
      (row) => row.observationId === 'rulership:saturn',
    );
    expect(rulership, 'fixture must carry a house-dependent yogakaraka').toBeDefined();
    if (!rulership) return;

    let bytes: Uint8Array | undefined;
    await act(async () => {
      bytes = await renderToBuffer(
        <ReportDocument data={{ ...buildMaximalReportPdfData(), evidence: legacyEvidence }} />,
      );
    });
    if (!bytes) throw new Error('The legacy-cusp report did not render bytes');
    const legacyPdf = await inspectPdfWithPoppler(bytes);
    const legacyText = folded(legacyPdf.text);

    expect(legacyText).toContain(folded(legacyEvidence.alternateLead ?? ''));
    expect(legacyText).toContain(folded(rulership.confidence));
    expect(legacyText).toContain(folded(rulership.alternative));
    expect(rulership.confidence).toContain('Low');
    expect(rulership.confidence.toLowerCase()).toContain('lagna fork');
    expect(rulership.alternative).not.toContain('sign placement alone');
    expect(legacyText).not.toContain('the ascendant sits well inside its sign');
  }, 90_000);
});
