/**
 * reportSections — the ONE declared list of report sections.
 *
 * WHY THIS EXISTS. The exported PDF was built once, early, when the report was
 * small, and then treated as a serialization detail rather than a product
 * surface. The screen kept growing; nobody re-opened the PDF; the gap widened
 * silently — because nothing anywhere asserted that the export had kept pace.
 * Filling in the missing sections fixes today and guarantees a repeat.
 *
 * So: every section of the report is declared HERE, once, and
 * `__tests__/reportSectionParity.test.tsx` holds both renderers to this list.
 * Adding a section to the on-screen report without deciding about the export
 * fails that test BY NAME. The only way to opt out is to say so out loud, in
 * this file, with a reason (`excluded`).
 *
 * WHAT THIS GUARD DOES AND DOES NOT PROVE. It proves a section is PRESENT in
 * the exported document. It does NOT prove it is present at the same fidelity —
 * a section that renders its heading but silently drops half its rows still
 * passes. That weaker bar is deliberate and sufficient here, because the export
 * and the screen now read the SAME stored, pre-formatted values (see
 * `hooks/useReportPdfExport.ts`); there is no second computation left for them
 * to disagree about. Per-section content depth is covered separately by the
 * acceptance suite in `components/report-pdf/__tests__/maximalReportPdf.test.tsx`.
 */

import type { ReportPdfData } from '../components/report-pdf/types';

/** How a declared section reaches the exported PDF. */
export type ReportSectionExport =
  | {
      readonly kind: 'included';
      /**
       * The text the PDF is expected to carry for this section, read off the
       * SAME data object the document renders (a label or a section chrome
       * title). Returning undefined means "this slice was absent from the data"
       * — the parity test reports that as a failure for an `included` section.
       */
      readonly pdfText: (data: ReportPdfData) => string | undefined;
    }
  | {
      readonly kind: 'excluded';
      /** Why this on-screen section deliberately does not reach the PDF. */
      readonly reason: string;
    };

export interface ReportSectionSpec {
  /** Stable identifier used in failure messages. */
  readonly key: string;
  /**
   * The `data-testid` the on-screen report (`/report`) renders for this
   * section, as a direct child of `[data-testid="report-document"]`.
   */
  readonly screenTestId: string;
  /**
   * The section's roman numeral — declared ONCE, for BOTH renderers.
   *
   * Screen and paper each used to hardcode their own numerals in their own
   * files, with nothing comparing them; inserting a section renumbered one
   * surface and silently left the other stale (Evidence printed VIII in the
   * export and XII on screen). The on-screen components now read this via
   * `sectionNumeral`, and `__tests__/reportSectionNumerals.test.ts` checks the
   * PDF's localized eyebrow strings carry the same numeral in every language.
   *
   * Absent for chrome that is not a numbered chapter (the cover, the footer).
   */
  readonly numeral?: string;
  /**
   * The `report:pdf.*` key whose eyebrow string states this numeral on paper —
   * the thing the drift guard reads. Absent when the PDF builds the eyebrow from
   * `report:section_eyebrow` + this numeral directly (nothing to drift from).
   */
  readonly pdfEyebrowKey?: string;
  readonly export: ReportSectionExport;
}

/**
 * Every section of the report, in the order the document presents them.
 *
 * Note the cover↔birth-details asymmetry: on screen one `ReportCover` carries
 * both the identity block and the birth-details list; the PDF splits them into
 * the cover page plus Section I. Both PDF halves are asserted below, mapped to
 * the single screen section that produces them.
 */
export const REPORT_SECTIONS: readonly ReportSectionSpec[] = [
  {
    key: 'cover',
    screenTestId: 'report-cover',
    // The cover's identity block: the name the report is prepared for. Asserted
    // on the value rather than the "Prepared for" label because the cover sets
    // that label in wide letter-spacing, which poppler reads back with the
    // tracking baked in as spaces.
    export: { kind: 'included', pdfText: (d) => d.personName },
  },
  {
    key: 'birth-details',
    screenTestId: 'report-cover',
    numeral: 'I',
    pdfEyebrowKey: 'birth_details_eyebrow',
    export: { kind: 'included', pdfText: (d) => d.labels.birthDetailsTitle },
  },
  {
    key: 'planets',
    screenTestId: 'report-planet-table',
    numeral: 'II',
    pdfEyebrowKey: 'planets_eyebrow',
    export: { kind: 'included', pdfText: (d) => d.labels.planetsTitle },
  },
  {
    key: 'houses',
    screenTestId: 'report-houses',
    numeral: 'III',
    pdfEyebrowKey: 'houses_eyebrow',
    export: { kind: 'included', pdfText: (d) => d.labels.housesTitle },
  },
  {
    key: 'charts',
    screenTestId: 'report-charts',
    numeral: 'IV',
    pdfEyebrowKey: 'charts_eyebrow',
    export: { kind: 'included', pdfText: (d) => d.labels.chartsTitle },
  },
  {
    key: 'dasha',
    screenTestId: 'report-dasha',
    numeral: 'V',
    pdfEyebrowKey: 'dasha_eyebrow',
    export: { kind: 'included', pdfText: (d) => d.labels.dashaTitle },
  },
  {
    key: 'yogas',
    screenTestId: 'report-yogas',
    numeral: 'VI',
    pdfEyebrowKey: 'yogas_eyebrow',
    export: { kind: 'included', pdfText: (d) => d.labels.yogasTitle },
  },
  {
    key: 'interpretation',
    screenTestId: 'report-interpretation',
    numeral: 'VII',
    pdfEyebrowKey: 'narrative_eyebrow',
    export: { kind: 'included', pdfText: (d) => d.labels.narrativeTitle },
  },
  {
    key: 'evidence',
    screenTestId: 'report-evidence',
    numeral: 'VIII',
    pdfEyebrowKey: 'evidence_eyebrow',
    export: { kind: 'included', pdfText: (d) => d.evidence?.chrome.title },
  },
  {
    key: 'transits',
    screenTestId: 'report-transits',
    numeral: 'IX',
    pdfEyebrowKey: 'transits_eyebrow',
    export: { kind: 'included', pdfText: (d) => d.transits?.chrome.title },
  },
  {
    key: 'vargas',
    screenTestId: 'report-vargas',
    numeral: 'X',
    pdfEyebrowKey: 'vargas_eyebrow',
    export: { kind: 'included', pdfText: (d) => d.vargas?.chrome.title },
  },
  {
    key: 'strength',
    screenTestId: 'report-strength',
    numeral: 'XI',
    pdfEyebrowKey: 'strength_eyebrow',
    export: { kind: 'included', pdfText: (d) => d.strength?.chrome.title },
  },
  {
    key: 'domains',
    screenTestId: 'report-domains',
    numeral: 'XII',
    pdfEyebrowKey: 'domains_eyebrow',
    export: { kind: 'included', pdfText: (d) => d.domains?.chrome.title },
  },
  {
    key: 'rectification',
    screenTestId: 'report-rectification',
    numeral: 'XIII',
    pdfEyebrowKey: 'rectification_eyebrow',
    export: { kind: 'included', pdfText: (d) => d.rectification?.chrome.title },
  },
  {
    // No `pdfEyebrowKey`: the export builds this eyebrow from
    // `report:section_eyebrow` + `sectionNumeral('assumptions')`, so there is no
    // second copy of the numeral to drift from.
    key: 'assumptions',
    screenTestId: 'report-assumptions',
    numeral: 'XIV',
    export: { kind: 'included', pdfText: (d) => d.assumptions?.chrome.title },
  },
  {
    key: 'footer',
    screenTestId: 'report-footer',
    export: {
      kind: 'excluded',
      reason:
        'The on-screen provenance footer is chrome, not content: the PDF prints ' +
        'its own fixed page footer (note + "n / total") on every page instead.',
    },
  },
];

/** The screen `data-testid`s the report document is expected to render. */
export const REPORT_SECTION_SCREEN_TEST_IDS: readonly string[] = [
  ...new Set(REPORT_SECTIONS.map((section) => section.screenTestId)),
];

/** Sections that must be findable in the exported PDF. */
export function includedSections(): readonly ReportSectionSpec[] {
  return REPORT_SECTIONS.filter((section) => section.export.kind === 'included');
}

/** The numbered chapters, in document order (cover + footer chrome excluded). */
export function numberedSections(): readonly ReportSectionSpec[] {
  return REPORT_SECTIONS.filter((section) => section.numeral !== undefined);
}

/**
 * The declared roman numeral for a section. Both renderers call this instead of
 * writing a literal, so there is exactly one place a numeral can be wrong.
 *
 * Throws on an unknown key rather than returning "" — a section heading with a
 * silently blank numeral is precisely the kind of quiet wrongness this replaced.
 */
export function sectionNumeral(key: string): string {
  const spec = REPORT_SECTIONS.find((section) => section.key === key);
  if (!spec?.numeral) {
    throw new Error(
      `No numeral is declared for report section "${key}" in lib/reportSections.ts. ` +
        `Add the section (with its numeral) to REPORT_SECTIONS, or fix the key.`,
    );
  }
  return spec.numeral;
}

export interface ReportSectionPresence {
  /** Whether Sections IX–XII (transits, vargas, strength, domains) are included. */
  readonly hasPredictive: boolean;
  /** Whether Section XIII (Birth Time Authority) is included. */
  readonly hasRectification: boolean;
}

export interface OmittedSectionsLabels {
  readonly predictive: string;
  readonly rectification: string;
}

/**
 * Build the explicit omitted-sections manifest value for Section XIV
 * (`Assumptions & Provenance`), or `null` when every chapter I–XIV is present.
 *
 * Keeping an explicit manifest prevents silent numeral jumps (`VIII → XIV` or
 * `XII → XIV`) whenever optional chapters are legitimately absent.
 */
export function buildOmittedSectionsValue(
  presence: ReportSectionPresence,
  labels: OmittedSectionsLabels,
): string | null {
  const items: string[] = [];
  if (!presence.hasPredictive) {
    items.push(labels.predictive);
  }
  if (!presence.hasRectification) {
    items.push(labels.rectification);
  }
  return items.length > 0 ? items.join('; ') : null;
}
