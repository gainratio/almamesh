/**
 * downloadReportPdf — generate the @react-pdf birth-chart report as a Blob in the
 * browser and trigger a download. Keeps the heavy `@react-pdf/renderer` import OUT
 * of `ReportView`'s static graph (dynamic `import()`), registers the self-hosted
 * report fonts, reshapes engine output via the pure `buildReportPdfData`, and
 * saves `AlmaMesh — <Name> (<date>).pdf`. No astrology is computed here.
 */

import type { DomainStrengthReceipt, LagnaData, SiderealChart } from '@almamesh/browser/types';
import type {
  DomainsCtx,
  ProcessedBirthData,
  StrengthCtx,
  TransitCtx,
  VargaCtxFull,
  VedicInterpretation,
} from '@almamesh/shared-types';
import type {
  BirthDetailLabels,
  CombustionCopy,
  ReportPdfAssumptions,
  ReportPdfEvidence,
  ReportPdfLabels,
  ReportPdfNarrativeTitles,
  ReportPdfRectification,
  ReportPdfTranslators,
} from '../components/report-pdf';
import type { StabilityMarker } from './stability';
import type { ReportAudience } from './reportSelectors';
import type { ReportChartFields } from './reportData';
import type { RectificationDelta } from './rectification';
import { verifyStrengthProvenance, type StrengthProvenance } from './strengthProvenance';
import { canonicalizeFontSubsetTags } from './reportPdfDeterminism';
import { containsDevanagari } from '../components/report-pdf/glyphSafe';

/** All localized chrome strings the document needs (passed from React/i18n). */
export interface ReportPdfChrome {
  readonly personName: string;
  readonly audienceLabel: string;
  readonly subtitle: string;
  readonly kicker: string;
  readonly ascendantNote?: string;
  /**
   * Binds the localized `report:cover.rectified_note` template to a derived
   * rectification delta. The builder calls it only when a rectification is in
   * effect, so i18n stays in React while the cover stays honest.
   */
  readonly formatRectifiedNote?: (delta: RectificationDelta) => string;
  /** Binds `report:dasha.antar_heading` for the all-mahā antar tables. */
  readonly formatAntarHeading?: (lord: string) => string;
  /** Binds `report:dasha.pratyantar_heading` for the running antar's table. */
  readonly formatPratyantarHeading?: (lord: string) => string;
  /**
   * Binds `report:pdf.planet_state_combust` + `report:pdf.combustion_note` — the
   * words that STATE combustion in the planetary table. Omitting it falls back
   * to English rather than to silence: a dimmed row is what this replaced.
   */
  readonly formatCombustion?: CombustionCopy;
  /** Localized kundli plate captions ("Rāśi · D1" / "Navāṁśa · D9"). */
  readonly chartCaptions: { readonly rasi: string; readonly navamsa: string };
  readonly detailLabels: BirthDetailLabels;
  readonly chromeLabels: ReportPdfLabels;
}

export interface DownloadReportPdfInput {
  /**
   * The chart's own calculation instant — the date printed on the cover and
   * stamped into `/CreationDate`. Required and nullable so no caller can quietly
   * fall back to the clock; see `BuildReportPdfDataInput.generatedAt`.
   */
  readonly generatedAt: Date | string | number | null;
  readonly birth: ProcessedBirthData;
  readonly lagna: LagnaData;
  readonly chart: ReportChartFields;
  /** The full engine chart — drives the planet table, kundli, dasha, and yogas. */
  readonly sidereal: SiderealChart;
  /**
   * The structured LLM interpretation (narrative section). OPTIONAL: when absent
   * the PDF degrades to its deterministic natal halves and omits the narrative.
   */
  readonly interpretation?: VedicInterpretation;
  /** Resolved audience voice (layman / technical) for the narrative. */
  readonly audience: ReportAudience;
  /**
   * Localized headings for the narrative blocks (Strengths, Challenges, …).
   * i18n stays in React; the PDF layer only typesets what it is handed.
   */
  readonly narrativeTitles?: ReportPdfNarrativeTitles;
  /**
   * The SAME birth-time stability markers the on-screen report renders as
   * `StabilityChip`s. Carried into the PDF so the durable artifact keeps the
   * honesty furniture the screen shows — a near-cusp ascendant makes every
   * house-based verdict birth-time-sensitive, and a reader of the PDF alone
   * deserves to know which verdicts those are.
   */
  readonly stability?: ReadonlyMap<string, StabilityMarker>;
  /** Localizes a marker into the chip's own wording. */
  readonly formatStability?: (marker: StabilityMarker) => string;
  readonly chrome: ReportPdfChrome;
  /**
   * The computed predictive contexts + the i18next translators that localize
   * them. OPTIONAL: when absent (or a context is missing) the matching PDF
   * sections are omitted — the PDF mirrors exactly what the web report shows.
   */
  readonly comprehensive?: {
    readonly translators: ReportPdfTranslators;
    readonly transitCtx?: TransitCtx;
    readonly vargaCtxFull?: VargaCtxFull;
    readonly strengthCtx?: StrengthCtx;
    readonly domainsCtx?: DomainsCtx;
    /**
     * Every domain's sealed strength receipt + the signer that sealed them
     * (see `pyodide/strengthReceipt.ts`). OPTIONAL: an older persisted
     * payload, or predictive not yet computed, legitimately lacks these —
     * `downloadReportPdf` then verifies nothing and the export behaves
     * exactly as before this check existed. The signing key is generated
     * fresh per Worker boot and never leaves the device, so a receipt is
     * TAMPER-EVIDENCE for the stored figure, never an attestation of who
     * computed it.
     */
    readonly domainStrengthReceipts?: Readonly<Record<string, DomainStrengthReceipt>>;
    readonly strengthSignerPublicKey?: string;
  };
  /** Pre-localized Birth Time Authority slice (when a rectification exists). */
  readonly rectification?: ReportPdfRectification;
  /** Pre-localized assumptions & provenance section (Section XIV). */
  readonly assumptions?: ReportPdfAssumptions;
  /** Pre-localized Evidence & Confidence section (Section VIII). */
  readonly evidence?: ReportPdfEvidence;
  /** The download file name (without extension). */
  readonly fileBaseName: string;
  /** Optional UI locale (e.g. 'hi'); enables self-hosted Devanagari PDF typography. */
  readonly locale?: string;
}

/**
 * Verify every domain-strength receipt BEFORE the PDF data is built, so a
 * tampered or cross-signer figure never reaches the render. Runs ONLY when
 * BOTH the receipts and the signer key are present; an older payload (either
 * missing) is left untouched — no verification, no withheld figures, no
 * layout change, exactly as before this check existed.
 */
async function resolveStrengthProvenance(
  comprehensive: DownloadReportPdfInput['comprehensive'],
): Promise<StrengthProvenance | undefined> {
  const receipts = comprehensive?.domainStrengthReceipts;
  const signerPublicKey = comprehensive?.strengthSignerPublicKey;
  if (!receipts || !signerPublicKey) {
    return undefined;
  }
  const summaries = comprehensive.domainsCtx
    ? Object.fromEntries(
        Object.entries(comprehensive.domainsCtx.forecasts).map(([domain, forecast]) => [
          domain,
          forecast.strength_summary,
        ]),
      )
    : undefined;
  const assays = comprehensive.domainsCtx
    ? Object.fromEntries(
        Object.entries(comprehensive.domainsCtx.forecasts).map(([domain, forecast]) => [
          domain,
          forecast.strength_assay,
        ]),
      )
    : undefined;
  return verifyStrengthProvenance(receipts, signerPublicKey, summaries, assays);
}

/** Build the document, render to a Blob, and click a temporary download link. */
export async function downloadReportPdf(input: DownloadReportPdfInput): Promise<void> {
  const { pdf } = await import('@react-pdf/renderer');
  const { ReportDocument, buildReportPdfData, registerReportFonts } = await import(
    '../components/report-pdf'
  );

  registerReportFonts();

  const provenance = await resolveStrengthProvenance(input.comprehensive);

  const data = buildReportPdfData({
    personName: input.chrome.personName,
    audienceLabel: input.chrome.audienceLabel,
    subtitle: input.chrome.subtitle,
    kicker: input.chrome.kicker,
    generatedAt: input.generatedAt,
    birth: input.birth,
    lagna: input.lagna,
    chart: input.chart,
    sidereal: input.sidereal,
    interpretation: input.interpretation,
    audience: input.audience,
    narrativeTitles: input.narrativeTitles,
    stability: input.stability,
    formatStability: input.formatStability,
    chartCaptions: input.chrome.chartCaptions,
    ascendantNote: input.chrome.ascendantNote,
    formatRectifiedNote: input.chrome.formatRectifiedNote,
    formatAntarHeading: input.chrome.formatAntarHeading,
    formatPratyantarHeading: input.chrome.formatPratyantarHeading,
    formatCombustion: input.chrome.formatCombustion,
    detailLabels: input.chrome.detailLabels,
    chromeLabels: input.chrome.chromeLabels,
    comprehensive: input.comprehensive
      ? {
          translators: input.comprehensive.translators,
          transitCtx: input.comprehensive.transitCtx,
          vargaCtxFull: input.comprehensive.vargaCtxFull,
          strengthCtx: input.comprehensive.strengthCtx,
          domainsCtx: input.comprehensive.domainsCtx,
          provenance,
        }
      : undefined,
    rectification: input.rectification,
    assumptions: input.assumptions,
    evidence: input.evidence,
  });

  const devanagari =
    Boolean(input.locale?.toLowerCase().startsWith('hi')) ||
    containsDevanagari(JSON.stringify(data));
  const rendered = await pdf(<ReportDocument data={data} devanagari={devanagari} />).toBlob();
  // The last step before the file leaves: pin the font subset tags @react-pdf
  // draws from Math.random, so the same chart downloads as the same bytes.
  const bytes = canonicalizeFontSubsetTags(new Uint8Array(await rendered.arrayBuffer()));
  triggerDownload(new Blob([bytes], { type: 'application/pdf' }), `${input.fileBaseName}.pdf`);
}

/** Save a Blob to disk via a transient object-URL anchor. */
function triggerDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoke on the next tick so the click's navigation has consumed the URL.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
