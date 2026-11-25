/**
 * ReportEvidence — the on-screen "Evidence & Confidence" section.
 *
 * This is the audit of every section above it. For each thing the engine
 * computed it prints five cells — Observation, Evidence, Interpretation,
 * Confidence, Alternative — and it opens with the METHOD, so a reader can
 * re-derive any confidence level from the numbers printed beside it instead of
 * trusting a label.
 *
 * NO ASTROLOGY AND NO COPY LIVE HERE. The rows come from `buildEvidenceLedger`
 * (pure, engine-only) and the sentences from `buildEvidenceSection` — the SAME
 * builder the exported PDF uses, called with the same `t`. That is what keeps
 * the screen and the durable artifact from drifting: there is no second place
 * for a sentence to be phrased differently or a cell to go missing.
 *
 * The general-guidance block at the end is deliberately set apart, and carries
 * NO evidence, confidence or alternative — those are statements the model
 * declared ungrounded, and dressing them in the ledger's furniture is precisely
 * the laundering this section exists to prevent.
 */

import { useMemo, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { SiderealChart } from '@almamesh/browser/types';
import { buildEvidenceLedger, type RawAnnotationPayload } from '../../../lib/evidence';
import { buildEvidenceSection } from '../../report-pdf/buildEvidenceSection';
import type { ReportPdfEvidence, ReportPdfEvidenceRow } from '../../report-pdf/types';
import { ReportSectionHeading } from './ReportSectionHeading';
import { sectionNumeral } from '../../../lib/reportSections';

interface ReportEvidenceProps {
  readonly chart: SiderealChart;
  /**
   * The model's RAW, UNVALIDATED annotations, straight from the store.
   * Passed on deliberately unchecked: `buildEvidenceLedger` is the single place
   * a citation is ever tested against the computed chart, and routing the screen
   * through it means the screen cannot end up more permissive than the export.
   */
  readonly annotations?: RawAnnotationPayload;
  /** True when a structured reading exists for this chart. */
  readonly hasReading?: boolean;
  /** Canonical error code when the optional evidence-annotation request failed. */
  readonly annotationError?: string | null;
  /** Optional on-screen action to re-run only evidence annotations without touching Sections VI & VII. */
  readonly onRefreshAnnotations?: () => void;
  readonly isRefreshingAnnotations?: boolean;
}

/** One five-cell row of the ledger, keyed by the observation's factor id. */
function EvidenceRow({
  row,
  labels,
}: {
  readonly row: ReportPdfEvidenceRow;
  readonly labels: ReportPdfEvidence['cellLabels'];
}): ReactElement {
  return (
    <div className="report-evidence-row" data-testid={`report-evidence-row-${row.observationId}`}>
      <div className="report-evidence-cell">
        <span className="report-evidence-cell-label">{labels.observation}</span>
        <p className="report-evidence-cell-value">{row.observation}</p>
      </div>
      <div className="report-evidence-cell">
        <span className="report-evidence-cell-label">{labels.evidence}</span>
        <ul className="report-evidence-factors">
          {row.evidence.map((factor) => (
            <li key={factor}>{factor}</li>
          ))}
        </ul>
      </div>
      <div className="report-evidence-cell">
        <span className="report-evidence-cell-label">{labels.interpretation}</span>
        <p className="report-evidence-cell-value">{row.interpretation}</p>
      </div>
      <div className="report-evidence-cell">
        <span className="report-evidence-cell-label">{labels.confidence}</span>
        <p className="report-evidence-cell-value">{row.confidence}</p>
      </div>
      <div className="report-evidence-cell">
        <span className="report-evidence-cell-label">{labels.alternative}</span>
        <p className="report-evidence-cell-value">{row.alternative}</p>
      </div>
    </div>
  );
}

/** The reproducible method: the ceiling table, the deductions, the formula. */
function EvidenceMethod({ section }: { readonly section: ReportPdfEvidence }): ReactElement {
  return (
    <div className="report-evidence-method" data-testid="report-evidence-method">
      <h3 className="report-evidence-subheading">{section.methodHeading}</h3>
      <p className="report-evidence-step">{section.ceilingHeading}</p>
      <dl className="report-evidence-ceilings">
        {section.ceilings.map((ceiling) => (
          <div className="report-evidence-ceiling" key={ceiling.label}>
            <dt>{ceiling.label}</dt>
            <dd>{ceiling.value}</dd>
          </div>
        ))}
      </dl>
      <p className="report-evidence-note">{section.ceilingNote}</p>
      <p className="report-evidence-step">{section.deductionHeading}</p>
      <ul className="report-evidence-rules">
        {section.deductionRules.map((rule) => (
          <li key={rule}>{rule}</li>
        ))}
      </ul>
      <p className="report-evidence-formula">{section.formula}</p>
    </div>
  );
}

/** The second chart a near-cusp birth time could have, projected in full. */
function EvidenceAlternate({ section }: { readonly section: ReportPdfEvidence }): ReactElement | null {
  if (!section.alternateHeading || !section.alternateShifts) {
    return null;
  }
  return (
    <div className="report-evidence-alternate" data-testid="report-evidence-alternate">
      <h3 className="report-evidence-subheading">{section.alternateHeading}</h3>
      <p className="report-evidence-cell-value">{section.alternateLead}</p>
      <ul className="report-evidence-shifts">
        {section.alternateShifts.map((shift) => (
          <li key={shift}>{shift}</li>
        ))}
      </ul>
      <p className="report-evidence-note">{section.alternateMinutesNote}</p>
    </div>
  );
}

/**
 * Statements the model declared ungrounded. Visually separate, and structurally
 * incapable of carrying an evidence, confidence or alternative cell — they are
 * plain strings, not ledger rows.
 */
function EvidenceGuidance({ section }: { readonly section: ReportPdfEvidence }): ReactElement | null {
  if (!section.guidance || section.guidance.length === 0) {
    return null;
  }
  return (
    <aside className="report-evidence-guidance" data-testid="report-evidence-guidance">
      <h3 className="report-evidence-subheading">{section.guidanceHeading}</h3>
      <p className="report-evidence-note">{section.guidanceNote}</p>
      {section.guidance.map((statement) => (
        <p className="report-evidence-cell-value" key={statement}>
          {statement}
        </p>
      ))}
    </aside>
  );
}

/** The evidence ledger, rendered for the screen. */
export function ReportEvidence({
  chart,
  annotations,
  hasReading,
  annotationError,
  onRefreshAnnotations,
  isRefreshingAnnotations,
}: ReportEvidenceProps): ReactElement {
  const { t } = useTranslation('report');
  // Pure and input-shaped; rebuild only when the chart or the stored reading moves.
  const section = useMemo(
    () =>
      buildEvidenceSection(buildEvidenceLedger(chart, annotations), t, undefined, {
        hasReading,
        annotationError,
      }),
    [chart, annotations, hasReading, annotationError, t],
  );

  return (
    <section className="report-section report-evidence" data-testid="report-evidence">
      <ReportSectionHeading index={sectionNumeral('evidence')} title={section.chrome.title} />
      <p className="report-evidence-intro">{section.chrome.intro}</p>
      <EvidenceMethod section={section} />
      <EvidenceAlternate section={section} />
      <div className="report-evidence-rows">
        {section.rows.map((row) => (
          <EvidenceRow key={row.observationId} row={row} labels={section.cellLabels} />
        ))}
      </div>
      <EvidenceGuidance section={section} />
      {section.rejectedNote ? (
        <div className="space-y-2">
          <p
            className="report-evidence-rejected whitespace-pre-line"
            data-testid="report-evidence-rejected"
          >
            {section.rejectedNote}
          </p>
          {onRefreshAnnotations ? (
            <button
              type="button"
              className="report-toolbar-button no-print"
              onClick={onRefreshAnnotations}
              disabled={isRefreshingAnnotations}
              data-testid="report-refresh-annotations"
            >
              {isRefreshingAnnotations
                ? t('evidence.refreshing_annotations')
                : t('evidence.refresh_annotations')}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
