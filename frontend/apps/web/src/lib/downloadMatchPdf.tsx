/**
 * downloadMatchPdf — generate the @react-pdf Kundli Matching / Relationship
 * report as a Blob entirely on-device and trigger a browser download.
 * Keeps `@react-pdf/renderer` out of `MeshEdge`'s static import graph.
 */

import type { BuildMatchPdfInput } from '../components/report-pdf/buildMatchPdfData';
import { canonicalizeFontSubsetTags } from './reportPdfDeterminism';

export interface DownloadMatchPdfInput extends BuildMatchPdfInput {
  readonly fileBaseName: string;
}

export async function downloadMatchPdf(input: DownloadMatchPdfInput): Promise<void> {
  const { pdf } = await import('@react-pdf/renderer');
  const { MatchReportDocument, buildMatchPdfData, registerReportFonts } = await import(
    '../components/report-pdf'
  );

  registerReportFonts();

  const data = buildMatchPdfData(input);
  const rawBlob = await pdf(<MatchReportDocument data={data} />).toBlob();
  const rawBytes = new Uint8Array(await rawBlob.arrayBuffer());
  const canonical = canonicalizeFontSubsetTags(rawBytes);
  const blob = new Blob([canonical as Uint8Array<ArrayBuffer>], { type: 'application/pdf' });

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${input.fileBaseName}.pdf`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
