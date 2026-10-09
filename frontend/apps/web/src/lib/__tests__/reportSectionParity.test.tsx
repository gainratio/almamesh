/**
 * reportSectionParity — the guard that makes an export/screen gap DETECTABLE.
 *
 * The defect this exists to prevent: the dashboard and the report screen keep
 * growing, the PDF quietly does not, and nothing fails. Two assertions close
 * that loop, and both name the offending section in their failure message:
 *
 *  1. SCREEN → REGISTRY. Every section the on-screen report renders must be
 *     declared in `lib/reportSections.ts`. Add a section to `ReportView` and
 *     forget the registry → red, naming the unregistered `data-testid`. That is
 *     the forcing function: you cannot add a section without deciding whether it
 *     is exported.
 *  2. REGISTRY → PDF. Every section declared `included` must actually appear in
 *     a rendered PDF. Declare it included and forget the document → red, naming
 *     the section key.
 *
 * LIMIT, stated plainly: this proves a section is PRESENT, not that it carries
 * the same detail as the screen. A section that renders its heading and drops
 * half its numbers still passes here. See the header of `lib/reportSections.ts`
 * for why that bar is the right one now, and where depth is covered instead.
 */

import path from 'node:path';
import { renderToBuffer } from '@react-pdf/renderer';
import { act } from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  useChartLibraryStore,
  useInterpretationStore,
  usePredictiveStore,
  useProfilesStore,
  useRectificationRecordsStore,
  predictiveRequestKey,
} from '@almamesh/store';
import '../../i18n/config';
import { ReportDocument } from '../../components/report-pdf/ReportDocument';
import { registerReportFonts } from '../../components/report-pdf/theme';
import type { ReportPdfData } from '../../components/report-pdf/types';
import { buildMaximalReportPdfData } from '../../components/report-pdf/__tests__/maximalReportFixture';
import {
  inspectPdfWithPoppler,
  normalizePdfText,
  type InspectedPdf,
} from '../../components/report-pdf/__tests__/pdfPoppler';
import {
  includedSections,
  numberedSections,
  REPORT_SECTIONS,
  REPORT_SECTION_SCREEN_TEST_IDS,
} from '../reportSections';
import { FULL_INTERPRETATION, storedChart } from '../../test/reportFixtures';
import {
  DOMAINS_CTX,
  STRENGTH_CTX,
  TRANSIT_CTX,
  VARGA_CTX_FULL,
} from '../../test/predictiveFixtures';

/** A confirmed rectification so Section XII (Birth Time Authority) renders. */
const RECTIFICATION_RECORD = {
  profileId: 'chart-1',
  confirmedAt: '2026-06-20T09:00:00.000Z',
  mode: 'cusp',
  band: 'leans',
  margin: 0.62,
  originalTime: '06:30',
  originalSign: 'aries',
  rectifiedTime: '06:14',
  rectifiedSign: 'aries',
  supportingEventIds: [],
} as never;

vi.mock('../../lib/downloadReportPdf', () => ({
  downloadReportPdf: vi.fn(async () => undefined),
}));

import ReportView from '../../pages/ReportView';
import { predictiveReferenceInstant } from '../predictive';
import { storedChartReferenceDay, viewerTimeZone } from '../analysisInstant';

describe('report section parity — screen → registry', () => {
  beforeAll(() => {
    useProfilesStore.setState({ activeProfileId: 'chart-1' });
    useChartLibraryStore.setState({
      charts: { 'chart-1': storedChart() },
      hydrated: true,
    });
    useInterpretationStore.setState({ byChart: {} });
    useInterpretationStore
      .getState()
      .setInterpretation('chart-1', FULL_INTERPRETATION, '2026-06-05T00:00:00Z', undefined, {
        predictiveRequestKey: null,
      });
    useRectificationRecordsStore.setState({
      recordsByProfile: { 'chart-1': RECTIFICATION_RECORD },
    });
    usePredictiveStore.setState({
      status: 'ready',
      transitCtx: TRANSIT_CTX,
      vargaCtxFull: VARGA_CTX_FULL,
      strengthCtx: STRENGTH_CTX,
      domainsCtx: DOMAINS_CTX,
      profileKey: 'chart-1',
      requestKey: predictiveRequestKey({
        profileKey: 'chart-1',
        datetimeUtc: '1990-03-30T06:30:00Z',
        latitude: 12.97,
        longitude: 77.59,
        referenceInstant: storedChartReferenceDay(
          storedChart(),
          predictiveReferenceInstant(new Date(), viewerTimeZone()),
        ),
        utcOffsetMinutes: 330,
      }),
    });
  });

  it('declares every section the on-screen report renders', () => {
    render(
      <MemoryRouter initialEntries={['/report?mode=astrologer']}>
        <ReportView />
      </MemoryRouter>,
    );

    const document_ = screen.getByTestId('report-document');
    const rendered = [...document_.children]
      .map((child) => child.getAttribute('data-testid'))
      .filter((id): id is string => Boolean(id));

    const undeclared = rendered.filter((id) => !REPORT_SECTION_SCREEN_TEST_IDS.includes(id));
    expect(
      undeclared,
      `The report screen renders section(s) that lib/reportSections.ts does not declare: ` +
        `${undeclared.join(', ')}. Add each one to REPORT_SECTIONS and decide whether it is ` +
        `exported to the PDF ({ kind: 'included' }) or deliberately not ({ kind: 'excluded', reason }).`,
    ).toEqual([]);

    // ...and the registry must not claim sections the screen never renders.
    const missing = REPORT_SECTION_SCREEN_TEST_IDS.filter((id) => !rendered.includes(id));
    expect(
      missing,
      `lib/reportSections.ts declares section(s) the maximal report screen did not render: ` +
        `${missing.join(', ')}. Either the section was removed (drop it from REPORT_SECTIONS) ` +
        `or this test's fixture no longer produces it.`,
    ).toEqual([]);
  });

  /**
   * The numerals a READER actually sees, in the order they see them. The registry
   * test proves screen and PDF declare the same numeral per section; this proves
   * the screen presents them in that order, so the numbers ascend I…XIV instead
   * of jumping (Evidence used to print XII between VII and IX).
   */
  it('renders its section numerals in the declared order', () => {
    render(
      <MemoryRouter initialEntries={['/report?mode=astrologer']}>
        <ReportView />
      </MemoryRouter>,
    );

    const document_ = screen.getByTestId('report-document');
    const onScreen = [...document_.querySelectorAll('.report-section-eyebrow')]
      .map((node) => /\b([IVXL]+)\b/.exec(node.textContent ?? '')?.[1])
      .filter((numeral): numeral is string => Boolean(numeral));

    // The cover carries Section I's content (birth details) without an opener,
    // so the numbered headings on screen start at II.
    const declared = numberedSections()
      .filter((section) => section.screenTestId !== 'report-cover')
      .map((section) => section.numeral);

    expect(
      onScreen,
      `The on-screen report's section numerals read ${JSON.stringify(onScreen)}, but ` +
        `lib/reportSections.ts declares ${JSON.stringify(declared)}. The screen and the ` +
        `export are presenting the same sections in a different order or under different ` +
        `numbers — fix the order in ReportView, or the numerals in the registry.`,
    ).toEqual(declared);
  });
});

describe('report section parity — registry → PDF', () => {
  let data: ReportPdfData;
  let pdf: InspectedPdf;
  let text: string;

  beforeAll(async () => {
    registerReportFonts(path.resolve('public/fonts'));
    data = buildMaximalReportPdfData();
    let bytes: Uint8Array | undefined;
    await act(async () => {
      bytes = await renderToBuffer(<ReportDocument data={data} />);
    });
    if (!bytes) throw new Error('The maximal report did not render bytes');
    pdf = await inspectPdfWithPoppler(bytes);
    text = normalizePdfText(pdf.pages.map((page) => page.text).join('\n'));
  });

  it.each(includedSections().map((section) => [section.key, section] as const))(
    'exports the %s section',
    (key, section) => {
      if (section.export.kind !== 'included') return;
      const expected = section.export.pdfText(data);
      expect(
        expected,
        `Section "${key}" is declared exported, but the maximal PDF data carries no text for ` +
          `it — its slice is missing from ReportPdfData. Either wire the section into ` +
          `buildReportPdfData/ReportDocument, or mark it { kind: 'excluded', reason } in ` +
          `lib/reportSections.ts.`,
      ).toBeTruthy();

      expect(
        text.includes(normalizePdfText(expected as string)),
        `Section "${key}" is declared exported but its heading ` +
          `${JSON.stringify(expected)} does not appear anywhere in the rendered PDF. ` +
          `The screen shows this section and the export drops it.`,
      ).toBe(true);
    },
  );

  it('every declared section is either exported or has a written reason', () => {
    const unreasoned = REPORT_SECTIONS.filter(
      (section) => section.export.kind === 'excluded' && !section.export.reason.trim(),
    ).map((section) => section.key);
    expect(
      unreasoned,
      `Section(s) excluded from the export with no reason given: ${unreasoned.join(', ')}.`,
    ).toEqual([]);
  });
});
