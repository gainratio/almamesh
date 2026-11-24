/**
 * ReportDocument — the @react-pdf/renderer `<Document>` skeleton for the
 * AlmaMesh Vedic birth-chart report.
 *
 * THE COMPREHENSIVE ARTIFACT: cover · birth details · planets · houses ·
 * kundli · daśā (with every mahā's antars) · yogas · narrative, then the
 * comprehensive sections mirrored from the web report — transits, all sixteen
 * varga plates (four per page), strength (SAV/BAV/Ṣaḍbala), the life-domain
 * forecasts, and Birth Time Authority. Optional sections are OMITTED entirely
 * when their data is absent (never a blank page). The document is PURE
 * presentation over a pre-reshaped `ReportPdfData` — no engine, no store, no
 * astrology (calculation integrity).
 *
 * Fonts are registered by the CALLER before rendering (the browser via
 * `registerReportFonts()`; the Node harness via local .ttf paths).
 */

import type { ReactElement } from 'react';
import { Document, Page, Text, View } from '@react-pdf/renderer';
import { DevanagariContext, useReportStyles } from './theme';
import type { ReportPdfData } from './types';
import { ReportPdfCover } from './sections/ReportPdfCover';
import { ReportPdfBirthDetails } from './sections/ReportPdfBirthDetails';
import { ReportPdfPlanets } from './sections/ReportPdfPlanets';
import { ReportPdfHouses } from './sections/ReportPdfHouses';
import { ReportPdfCharts } from './sections/ReportPdfCharts';
import {
  planDashaTablePages,
  ReportPdfDashaOverview,
  ReportPdfDashaTables,
} from './sections/ReportPdfDasha';
import { ReportPdfYogas } from './sections/ReportPdfYogas';
import { ReportPdfNarrative } from './sections/ReportPdfNarrative';
import {
  hasEvidenceEpilogue,
  ReportPdfEvidence,
  ReportPdfEvidenceGuidance,
} from './sections/ReportPdfEvidence';
import { ReportPdfTransits } from './sections/ReportPdfTransits';
import {
  chunkVargaPlates,
  ReportPdfVargaPlates,
  ReportPdfVargaTallies,
} from './sections/ReportPdfVargas';
import { ReportPdfStrength } from './sections/ReportPdfStrength';
import { ReportPdfDomains } from './sections/ReportPdfDomains';
import { ReportPdfRectification } from './sections/ReportPdfRectification';
import { ReportPdfAssumptions } from './sections/ReportPdfAssumptions';

interface ReportDocumentProps {
  readonly data: ReportPdfData;
  /** Select Noto Sans Devanagari on page root when rendering Hindi/Devanagari copy. */
  readonly devanagari?: boolean;
}

/** The running footer pinned to the bottom of every content page. */
function PageFooter({ note }: { note: string }): ReactElement {
  const s = useReportStyles();
  return (
    <>
      <View fixed style={s.pageFooterRule} />
      <Text fixed style={s.pageFooterNote}>
        {note}
      </Text>
      <Text
        fixed
        style={s.pageFooterCounter}
        render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`}
      />
    </>
  );
}

/** The full report document. */
export function ReportDocument({ data, devanagari = false }: ReportDocumentProps): ReactElement {
  const s = useReportStyles(devanagari);
  const pageStyle = s.page;
  const footer = (): ReactElement => <PageFooter note={data.labels.footerNote} />;
  const vargas = data.vargas;
  const dashaTablePages = planDashaTablePages(data.dasha.antarTables);
  const pages = [
    <Page key="cover" size="A4" style={pageStyle}>
      <ReportPdfCover data={data} />
    </Page>,

    <Page key="birth" size="A4" style={pageStyle}>
      <ReportPdfBirthDetails data={data} />
      {footer()}
    </Page>,

    <Page key="planets" size="A4" style={pageStyle}>
      <ReportPdfPlanets data={data} />
      {footer()}
    </Page>,

    <Page key="houses" size="A4" style={pageStyle}>
      <ReportPdfHouses data={data} />
      {footer()}
    </Page>,

    <Page key="charts" size="A4" style={pageStyle}>
      <ReportPdfCharts data={data} />
      {footer()}
    </Page>,

    <Page key="dasha-overview" size="A4" style={pageStyle}>
      <ReportPdfDashaOverview data={data} />
      {footer()}
    </Page>,

    ...dashaTablePages.map((tables, pageIndex) => (
      <Page key={`dasha-${pageIndex}`} size="A4" style={pageStyle}>
        <ReportPdfDashaTables
          tables={tables}
          currentMarker={data.labels.dashaCurrentMarker}
        />
        {footer()}
      </Page>
    )),

    <Page key="yogas" size="A4" style={pageStyle}>
      <ReportPdfYogas data={data} />
      {footer()}
    </Page>,

    /* The Interpretation page ALWAYS renders. With a narrative it carries the
       reading; without one it carries a short, honest note saying the written
       interpretation appears once an AI reading is generated. */
    <Page key="narrative" size="A4" style={pageStyle}>
      <ReportPdfNarrative data={data} />
      {footer()}
    </Page>,

    /* Section VIII — Evidence & Confidence: the audit of everything above. */
    data.evidence ? (
      <Page key="evidence" size="A4" style={pageStyle}>
        <ReportPdfEvidence data={data} />
        {footer()}
      </Page>
    ) : null,
    hasEvidenceEpilogue(data.evidence) ? (
      <Page key="evidence-guidance" size="A4" style={pageStyle}>
        <ReportPdfEvidenceGuidance data={data} />
        {footer()}
      </Page>
    ) : null,

    /* Comprehensive sections — mirrors of web report IX–XII. */
    data.transits ? (
      <Page key="transits" size="A4" style={pageStyle}>
        <ReportPdfTransits data={data} />
        {footer()}
      </Page>
    ) : null,

    ...(vargas
      ? chunkVargaPlates(vargas.plates).map((plates, pageIndex) => (
          <Page key={`vargas-${pageIndex}`} size="A4" style={pageStyle}>
            <ReportPdfVargaPlates vargas={vargas} plates={plates} first={pageIndex === 0} />
            {footer()}
          </Page>
        ))
      : []),
    vargas ? (
      <Page key="varga-tallies" size="A4" style={pageStyle}>
        <ReportPdfVargaTallies vargas={vargas} />
        {footer()}
      </Page>
    ) : null,

    data.strength ? (
      <Page key="strength" size="A4" style={pageStyle}>
        <ReportPdfStrength data={data} />
        {footer()}
      </Page>
    ) : null,

    data.domains ? (
      <Page key="domains" size="A4" style={pageStyle}>
        <ReportPdfDomains data={data} />
        {footer()}
      </Page>
    ) : null,

    data.rectification ? (
      <Page key="rectification" size="A4" style={pageStyle}>
        <ReportPdfRectification data={data} />
        {footer()}
      </Page>
    ) : null,

    data.assumptions ? (
      <Page key="assumptions" size="A4" style={pageStyle}>
        <ReportPdfAssumptions data={data} />
        {footer()}
      </Page>
    ) : null,
  ];
  return (
    <Document
      title={`AlmaMesh — ${data.personName}`}
      author="AlmaMesh"
      subject="Vedic birth-chart report"
      creator="AlmaMesh"
      producer="AlmaMesh"
      // Without this @react-pdf defaults to `new Date()`, which lands in
      // `/CreationDate` AND in the trailer `/ID` (pdfkit hashes the info
      // dictionary to build it) — two exports of one chart then differ.
      creationDate={data.creationDate}
    >
      {devanagari ? (
        <DevanagariContext.Provider value>{pages}</DevanagariContext.Provider>
      ) : (
        pages
      )}
    </Document>
  );
}
