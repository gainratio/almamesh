/**
 * report-pdf — the @react-pdf/renderer birth-chart report document.
 *
 * Public surface: the `ReportDocument` component, the pure `buildReportPdfData`
 * reshaper, and the data contract types. Everything here is presentation over
 * pre-formatted engine output — no astrology is computed.
 */

export { ReportDocument } from './ReportDocument';
export { MatchReportDocument } from './MatchReportDocument';
export { buildReportPdfData } from './buildReportPdfData';
export { buildMatchPdfData } from './buildMatchPdfData';
export type { BuildMatchPdfInput, MatchPdfData, MatchPdfLabels } from './buildMatchPdfData';
export type { BirthDetailLabels, BuildReportPdfDataInput } from './buildReportPdfData';
export { buildEvidenceSection } from './buildEvidenceSection';
export type { EvidenceText } from './buildEvidenceSection';
export { buildRectificationPdf } from './buildRectificationPdf';
export type { BuildRectificationPdfInput, RectificationPdfEvent } from './buildRectificationPdf';
export type { ReportPdfTranslators } from './buildComprehensiveSections';
export type { CombustionCopy } from './buildReportSections';
export type {
  ReportPdfAssumptions,
  ReportPdfData,
  ReportPdfDetail,
  ReportPdfEvidence,
  ReportPdfEvidenceRow,
  ReportPdfLabels,
  ReportPdfNarrativeTitles,
  ReportPdfRectification,
  ReportPdfTechnical,
} from './types';
export { registerReportFonts } from './theme';
