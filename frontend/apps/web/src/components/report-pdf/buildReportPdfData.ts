/**
 * buildReportPdfData — reshape engine + birth data into the PURE `ReportPdfData`
 * the @react-pdf document renders. Uses ONLY the existing `lib/reportData.ts`
 * formatters (timezone-safe, epoch-safe, locale-aware) — it recomputes NO
 * astrology. The caller supplies pre-localized labels (so i18n stays in React,
 * out of the PDF layer).
 */

import type { LagnaData, SiderealChart } from '@almamesh/browser/types';
import type {
  DomainsCtx,
  ProcessedBirthData,
  StrengthCtx,
  TransitCtx,
  VargaCtxFull,
  VedicInterpretation,
} from '@almamesh/shared-types';
import {
  buildPlaceString,
  formatBirthDateTime,
  formatDegree,
  formatReportDate,
  reportInstant,
  selectTechnicalFields,
  type ReportChartFields,
} from '../../lib/reportData';
import type { ReportAudience } from '../../lib/reportSelectors';
import { rectificationDelta, type RectificationDelta } from '../../lib/rectification';
import type { StabilityMarker } from '../../lib/stability';
import type { StrengthProvenance } from '../../lib/strengthProvenance';
import type {
  ReportPdfAssumptions,
  ReportPdfData,
  ReportPdfDetail,
  ReportPdfEvidence,
  ReportPdfLabels,
  ReportPdfNarrativeTitles,
  ReportPdfRectification,
  ReportPdfTechnical,
} from './types';
import { glyphSafe } from './glyphSafe';
import {
  buildCharts,
  buildD1Geometry,
  buildDasha,
  buildCombustionNotes,
  buildHouses,
  buildNarrative,
  buildPlanetRows,
  buildYogaNarrative,
  buildYogas,
  type CombustionCopy,
  type StabilityFlagFor,
} from './buildReportSections';
import {
  buildDomainsSection,
  buildStrengthSection,
  buildTransitsSection,
  buildVargasSection,
  type ReportPdfTranslators,
} from './buildComprehensiveSections';

/**
 * The `/CreationDate` stamped when a chart records no calculation instant. The
 * epoch is the conventional "unknown time" and, unlike `new Date()`, it keeps
 * the exported file reproducible.
 */
const UNKNOWN_INSTANT = new Date(0);

/** The per-field labels the birth-details list needs (already localized). */
export interface BirthDetailLabels {
  readonly dateOfBirth: string;
  readonly timeOfBirth: string;
  readonly placeOfBirth: string;
  readonly ascendant: string;
}

export interface BuildReportPdfDataInput {
  readonly personName: string;
  readonly audienceLabel: string;
  readonly subtitle: string;
  readonly kicker: string;
  /**
   * WHEN this report was generated, as a value carried by the chart itself
   * (`astronomical_calculations.calculation_timestamp`) — never `new Date()`.
   *
   * It is REQUIRED and nullable on purpose: reading the clock here is what made
   * "same input, same file every time" false, so every caller has to say which
   * instant it means, and `null` is the honest way to say "this chart records
   * none". A null instant prints no date and stamps the epoch into
   * `/CreationDate`; it never reaches for the clock.
   */
  readonly generatedAt: Date | string | number | null;
  readonly birth: ProcessedBirthData;
  readonly lagna: LagnaData;
  readonly chart: ReportChartFields;
  /** The full engine chart — drives the planet table, kundli, dasha, and yogas. */
  readonly sidereal: SiderealChart;
  /**
   * The structured LLM interpretation (narrative section). OPTIONAL: when it has
   * not been generated yet, the report degrades to its deterministic natal halves
   * and the Interpretation section is omitted entirely.
   */
  readonly interpretation?: VedicInterpretation;
  /** Resolved audience voice (layman / technical) for the narrative. */
  readonly audience: ReportAudience;
  /**
   * The five narrative section titles, ALREADY LOCALIZED (the same
   * `report:interpretation.*` strings the on-screen report uses). OPTIONAL:
   * omit it and the builder falls back to its English defaults, so an
   * unwired caller keeps producing exactly what it produced before.
   */
  readonly narrativeTitles?: ReportPdfNarrativeTitles;
  /**
   * The per-claim birth-time stability markers keyed by `yoga:<name>` /
   * `domain:<domain>` — the SAME map the on-screen report feeds its
   * `StabilityChip`s (`reportStabilityMarkers`). OPTIONAL; without it (or
   * without `formatStability`) no stability flag is printed and every yoga /
   * domain renders exactly as it did before.
   */
  readonly stability?: ReadonlyMap<string, StabilityMarker>;
  /**
   * Binds `report:stability.stable` / `report:stability.sensitive` to a marker
   * — the same i18n keys `StabilityChip` reads, so PDF and screen say the same
   * words. Same "i18n stays in React" pattern as `formatRectifiedNote`.
   */
  readonly formatStability?: (marker: StabilityMarker) => string;
  /** Localized kundli plate captions ("Rāśi · D1" / "Navāṁśa · D9"). */
  readonly chartCaptions: { readonly rasi: string; readonly navamsa: string };
  /** Optional, already-localized near-cusp caveat. */
  readonly ascendantNote?: string;
  /**
   * Binds the localized `report:cover.rectified_note` template to a derived
   * rectification delta. The builder calls `rectificationDelta(birth)` and, when
   * a rectification is in effect, invokes this to produce the finished string —
   * so the "only when in effect" logic lives here while i18n stays in React.
   * Omit it (or return no delta) to render no rectification note.
   */
  readonly formatRectifiedNote?: (delta: RectificationDelta) => string;
  /**
   * Binds the localized `report:dasha.antar_heading` template ("Antar-daśās of
   * the {{lord}} Mahā-daśā") for the all-mahā antar drill-down tables. Same
   * i18n-stays-in-React pattern as `formatRectifiedNote`; without it each
   * antar table is headed by the title-cased lord alone.
   */
  readonly formatAntarHeading?: (lord: string) => string;
  /** Binds `report:dasha.pratyantar_heading` for the running antar's table. */
  readonly formatPratyantarHeading?: (lord: string) => string;
  /**
   * Binds the localized combustion copy (`report:pdf.planet_state_combust` and
   * `report:pdf.combustion_note`). Same i18n-stays-in-React pattern as above,
   * with one deliberate difference: omitting it falls back to ENGLISH text, not
   * to silence. Combustion is a FACT the engine computed — a caller that forgets
   * to wire the words must still see them, because "no words" is precisely the
   * defect (a dimmed row) this replaced.
   */
  readonly formatCombustion?: CombustionCopy;
  readonly detailLabels: BirthDetailLabels;
  readonly chromeLabels: ReportPdfLabels;
  /**
   * The on-device PREDICTIVE contexts + the i18next translators that localize
   * them (the same `t` functions the on-screen report uses). OPTIONAL: when
   * absent — or when an individual context was not computed — the matching
   * PDF sections are omitted entirely, exactly like the web report.
   */
  readonly comprehensive?: {
    readonly translators: ReportPdfTranslators;
    readonly transitCtx?: TransitCtx;
    readonly vargaCtxFull?: VargaCtxFull;
    readonly strengthCtx?: StrengthCtx;
    readonly domainsCtx?: DomainsCtx;
    /**
     * The ALREADY-VERIFIED split of the domain-strength receipts (see
     * `verifyStrengthProvenance`), or absent when no receipts/signer were
     * supplied. `buildDomainsSection` withholds a domain's numeric percentages
     * only for the domains named in `provenance.failed` — every other domain,
     * and every domain when `provenance` itself is absent, renders exactly as
     * it does today.
     */
    readonly provenance?: StrengthProvenance;
  };
  /**
   * The pre-localized Birth Time Authority slice (see `buildRectificationPdf`).
   * OPTIONAL: present only when a confirmed rectification record exists.
   */
  readonly rectification?: ReportPdfRectification;
  /**
   * The assumptions & provenance section (Section XIV), pre-localized in React.
   * OPTIONAL — omitted entirely when not supplied, exactly like the other slices.
   */
  readonly assumptions?: ReportPdfAssumptions;
  /**
   * Section VIII — Evidence & Confidence, pre-localized by
   * `buildEvidenceSection` (the same builder the on-screen report calls).
   * OPTIONAL — omitted entirely when not supplied, like the other slices.
   */
  readonly evidence?: ReportPdfEvidence;
}

/**
 * The cover's rectification note, or undefined when no rectification is in
 * effect (or no formatter supplied). Pure: it reads the two clocks the engine
 * path already produced via `rectificationDelta` — it recomputes no astrology.
 */
function buildRectifiedNote(input: BuildReportPdfDataInput): string | undefined {
  if (!input.formatRectifiedNote) {
    return undefined;
  }
  const delta = rectificationDelta(input.birth);
  if (!delta) {
    return undefined;
  }
  return glyphSafe(input.formatRectifiedNote(delta));
}

function titleCase(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : '';
}

/**
 * The claim-id → localized stability flag resolver, or `undefined` when the
 * caller supplied no markers (or no formatter) — in which case nothing about
 * the yoga cards or domain blocks changes. Pure lookup + formatting; it never
 * decides stability itself (that is `lib/stability`'s deterministic diff).
 */
function stabilityFlagResolver(input: BuildReportPdfDataInput): StabilityFlagFor | undefined {
  const { stability, formatStability } = input;
  if (!stability || !formatStability) {
    return undefined;
  }
  return (claimId: string): string | undefined => {
    const marker = stability.get(claimId);
    return marker ? glyphSafe(formatStability(marker)) : undefined;
  };
}

/** Build the cream-paper data list from the birth + lagna data. */
function buildBirthDetails(input: BuildReportPdfDataInput): ReadonlyArray<ReportPdfDetail> {
  const when = formatBirthDateTime(input.birth);
  const place = buildPlaceString(input.birth);
  const time = when.tzLabel ? `${when.time} (${when.tzLabel})` : when.time;
  const ascendant = glyphSafe(
    `${titleCase(input.lagna.sign)} ${formatDegree(input.lagna.sign_degrees)}`,
  );
  const { detailLabels } = input;

  return [
    { label: detailLabels.dateOfBirth, value: glyphSafe(when.date || '—') },
    { label: detailLabels.timeOfBirth, value: glyphSafe(time || '—'), mono: true },
    { label: detailLabels.placeOfBirth, value: glyphSafe(place || '—') },
    { label: detailLabels.ascendant, value: ascendant, mono: true },
  ];
}

/** Glyph-safe the assumptions section (chrome + rows), or drop it when absent. */
function buildAssumptions(input: BuildReportPdfDataInput): ReportPdfAssumptions | undefined {
  const source = input.assumptions;
  if (!source) {
    return undefined;
  }
  return {
    chrome: {
      eyebrow: glyphSafe(source.chrome.eyebrow),
      title: glyphSafe(source.chrome.title),
      intro: source.chrome.intro ? glyphSafe(source.chrome.intro) : undefined,
    },
    rows: source.rows.map((row) => ({
      label: glyphSafe(row.label),
      value: glyphSafe(row.value),
    })),
  };
}

/**
 * Glyph-safe every chrome label so the PDF layer renders verbatim strings.
 * Optional labels a caller has not wired are left absent rather than coerced
 * to `""` — the renderer's own fallback then applies.
 */
function safeLabels(labels: ReportPdfLabels): ReportPdfLabels {
  const safe = {} as Record<keyof ReportPdfLabels, string>;
  for (const key of Object.keys(labels) as (keyof ReportPdfLabels)[]) {
    const value = labels[key];
    if (value !== undefined) {
      safe[key] = glyphSafe(value);
    }
  }
  return safe as ReportPdfLabels;
}

export function buildReportPdfData(input: BuildReportPdfDataInput): ReportPdfData {
  const technical: ReadonlyArray<ReportPdfTechnical> = selectTechnicalFields(input.chart).map(
    (field) => ({ label: field.label, value: glyphSafe(field.value) }),
  );
  const d1Geometry = buildD1Geometry(input.sidereal);
  const { comprehensive } = input;
  const stabilityFlagFor = stabilityFlagResolver(input);
  const generatedAt = reportInstant(input.generatedAt);

  return {
    personName: glyphSafe(input.personName),
    audienceLabel: glyphSafe(input.audienceLabel),
    subtitle: glyphSafe(input.subtitle),
    kicker: glyphSafe(input.kicker),
    generatedOn: generatedAt ? glyphSafe(formatReportDate(generatedAt)) : undefined,
    creationDate: generatedAt ?? UNKNOWN_INSTANT,
    birthDetails: buildBirthDetails(input),
    ascendantNote: input.ascendantNote ? glyphSafe(input.ascendantNote) : undefined,
    rectifiedNote: buildRectifiedNote(input),
    technical,
    planets: buildPlanetRows(d1Geometry, input.formatCombustion),
    combustionNotes: buildCombustionNotes(d1Geometry, input.formatCombustion),
    houses: buildHouses(input.sidereal),
    charts: buildCharts(input.sidereal, d1Geometry, input.chartCaptions),
    dasha: buildDasha(
      input.sidereal,
      input.formatAntarHeading,
      input.formatPratyantarHeading,
    ),
    yogas: buildYogas(input.sidereal, stabilityFlagFor),
    yogaNarrative: input.interpretation
      ? buildYogaNarrative(input.interpretation, input.audience)
      : undefined,
    narrative: input.interpretation
      ? buildNarrative(input.interpretation, input.audience, input.narrativeTitles)
      : undefined,
    // Comprehensive sections mirror the web report: each renders only when its
    // on-device context was computed (and the translators were supplied).
    transits:
      comprehensive?.transitCtx !== undefined
        ? buildTransitsSection(comprehensive.transitCtx, comprehensive.translators)
        : undefined,
    vargas:
      comprehensive?.vargaCtxFull !== undefined
        ? buildVargasSection(comprehensive.vargaCtxFull, comprehensive.translators)
        : undefined,
    strength:
      comprehensive?.strengthCtx !== undefined
        ? buildStrengthSection(
            comprehensive.strengthCtx,
            comprehensive.translators,
            input.birth.birth_location_details?.timezone,
          )
        : undefined,
    domains:
      comprehensive?.domainsCtx !== undefined
        ? buildDomainsSection(
            comprehensive.domainsCtx,
            comprehensive.translators,
            comprehensive.provenance,
            stabilityFlagFor,
          )
        : undefined,
    evidence: input.evidence,
    rectification: input.rectification,
    assumptions: buildAssumptions(input),
    labels: safeLabels(input.chromeLabels),
  };
}
