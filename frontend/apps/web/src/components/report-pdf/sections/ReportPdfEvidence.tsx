/**
 * ReportPdfEvidence — Section VIII, the printed evidence ledger.
 *
 * The paper twin of the on-screen `ReportEvidence`, rendering the SAME
 * pre-formatted `ReportPdfEvidence` slice (built once by
 * `buildEvidenceSection`), so there is no second place a sentence could be
 * phrased differently or a cell could go missing.
 *
 * LAYOUT NOTE, and it is load-bearing: every cell is STACKED — its label on its
 * own line, its value full-measure below. A label/value pair set side by side
 * reads back out of `pdftotext` interleaved once the value wraps, which makes
 * the printed artifact unverifiable by the acceptance suite. Stacking keeps
 * every sentence contiguous in the extracted text, so the PDF can be checked
 * rather than merely admired.
 *
 * The general-guidance block is a SEPARATE component on a separate page, and it
 * takes `guidance: readonly string[]` — plain statements, not ledger rows. It is
 * therefore structurally incapable of printing an Evidence, Confidence or
 * Alternative cell, which is a stronger guarantee than remembering not to.
 */

import type { ReactElement } from 'react';
import { Text, View } from '@react-pdf/renderer';
import { useReportStyles } from '../theme';
import type { ReportPdfData, ReportPdfEvidenceRow, ReportPdfEvidence as EvidenceSlice } from '../types';
import { ReportPdfHeading } from './ReportPdfHeading';

/** One stacked cell: a small-caps label, then its value at full measure. */
function Cell({ label, value }: { readonly label: string; readonly value: string }): ReactElement {
  const s = useReportStyles();
  return (
    <View style={s.evidenceCell} wrap={false}>
      <Text style={s.evidenceCellLabel}>{label}</Text>
      <Text style={s.evidenceCellValue}>{value}</Text>
    </View>
  );
}

/** The Evidence cell: one line per cited factor, each with its id and class. */
function EvidenceCell({
  label,
  factors,
}: {
  readonly label: string;
  readonly factors: ReadonlyArray<string>;
}): ReactElement {
  const s = useReportStyles();
  return (
    <View style={s.evidenceCell} wrap={false}>
      <Text style={s.evidenceCellLabel}>{label}</Text>
      {factors.map((factor) => (
        <Text key={factor} style={s.evidenceFactor}>
          {factor}
        </Text>
      ))}
    </View>
  );
}

function Row({
  row,
  labels,
}: {
  readonly row: ReportPdfEvidenceRow;
  readonly labels: EvidenceSlice['cellLabels'];
}): ReactElement {
  const s = useReportStyles();
  return (
    <View style={s.evidenceRow} minPresenceAhead={60}>
      <Cell label={labels.observation} value={row.observation} />
      <EvidenceCell label={labels.evidence} factors={row.evidence} />
      <Cell label={labels.interpretation} value={row.interpretation} />
      <Cell label={labels.confidence} value={row.confidence} />
      <Cell label={labels.alternative} value={row.alternative} />
    </View>
  );
}

/** The reproducible method: ceiling table, deduction rules, the formula. */
function Method({ evidence }: { readonly evidence: EvidenceSlice }): ReactElement {
  const s = useReportStyles();
  return (
    <View style={s.evidenceMethod}>
      <Text style={s.evidenceSubheading}>{evidence.methodHeading}</Text>
      <Text style={s.evidenceStep}>{evidence.ceilingHeading}</Text>
      {evidence.ceilings.map((ceiling) => (
        <View key={ceiling.label} style={s.evidenceCeiling} wrap={false}>
          <Text style={s.evidenceCeilingLabel}>{ceiling.label}</Text>
          <Text style={s.evidenceCellValue}>{ceiling.value}</Text>
        </View>
      ))}
      <Text style={s.evidenceNote}>{evidence.ceilingNote}</Text>
      <Text style={s.evidenceStep}>{evidence.deductionHeading}</Text>
      {evidence.deductionRules.map((rule) => (
        <Text key={rule} style={s.evidenceCellValue}>
          {rule}
        </Text>
      ))}
      <Text style={s.evidenceFormula}>{evidence.formula}</Text>
    </View>
  );
}

/** The second chart a near-cusp birth time could have, projected in full. */
function Alternate({ evidence }: { readonly evidence: EvidenceSlice }): ReactElement | null {
  const s = useReportStyles();
  if (!evidence.alternateHeading || !evidence.alternateShifts) {
    return null;
  }
  return (
    <View style={s.evidenceAlternate}>
      <Text style={s.evidenceSubheading}>{evidence.alternateHeading}</Text>
      <Text style={s.evidenceCellValue}>{evidence.alternateLead}</Text>
      {evidence.alternateShifts.map((shift) => (
        <Text key={shift} style={s.evidenceFactor}>
          {shift}
        </Text>
      ))}
      <Text style={s.evidenceNote}>{evidence.alternateMinutesNote}</Text>
    </View>
  );
}

/** Section VIII: the method, the second chart, then one block per observation. */
export function ReportPdfEvidence({ data }: { readonly data: ReportPdfData }): ReactElement | null {
  const { evidence } = data;
  if (!evidence) {
    return null;
  }
  return (
    <View>
      <ReportPdfHeading
        eyebrow={evidence.chrome.eyebrow}
        title={evidence.chrome.title}
        intro={evidence.chrome.intro}
      />
      <Method evidence={evidence} />
      <Alternate evidence={evidence} />
      {evidence.rows.map((row) => (
        <Row key={row.observationId} row={row} labels={evidence.cellLabels} />
      ))}
    </View>
  );
}

/** True when there is a guidance / provenance page to print at all. */
export function hasEvidenceEpilogue(evidence: EvidenceSlice | undefined): boolean {
  return Boolean(evidence && ((evidence.guidance?.length ?? 0) > 0 || evidence.rejectedNote));
}

/**
 * The epilogue: statements the model declared ungrounded, plus the count of the
 * ones that were rejected outright. Kept on its own page and in its own frame so
 * the visual separation matches the epistemic one.
 */
export function ReportPdfEvidenceGuidance({
  data,
}: {
  readonly data: ReportPdfData;
}): ReactElement | null {
  const s = useReportStyles();
  const { evidence } = data;
  if (!evidence || !hasEvidenceEpilogue(evidence)) {
    return null;
  }
  return (
    <View>
      {evidence.guidance && evidence.guidance.length > 0 ? (
        <View style={s.evidenceGuidance}>
          <Text style={s.evidenceGuidanceHeading}>{evidence.guidanceHeading}</Text>
          <Text style={s.evidenceNote}>{evidence.guidanceNote}</Text>
          {evidence.guidance.map((statement) => (
            <Text key={statement} style={s.evidenceGuidanceText}>
              {statement}
            </Text>
          ))}
        </View>
      ) : null}
      {evidence.rejectedNote ? (
        <Text style={s.evidenceRejected}>{evidence.rejectedNote}</Text>
      ) : null}
    </View>
  );
}
