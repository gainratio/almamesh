/**
 * ReportPdfNarrative — the structured interpretation rendered as elegant editorial
 * prose. The first block (an empty title) is the summary, set as a brass-ruled
 * italic pull-quote; every subsequent block is a Fraunces sub-heading over its
 * ordered paragraphs. Paragraphs arrive as plain text on `ReportPdfNarrativeSection`
 * (markdown already stripped) — the PDF layer only typesets.
 *
 * When no reading exists the section STILL prints: heading + one honest
 * paragraph saying the written interpretation appears once an AI reading is
 * generated. Silently deleting the section left a reader wondering what they
 * had missed; a fabricated narrative would be worse. This is the third option.
 */

import type { ReactElement } from 'react';
import { Text, View } from '@react-pdf/renderer';
import { useReportStyles } from '../theme';
import type { ReportPdfData, ReportPdfNarrativeSection } from '../types';
import { ReportPdfHeading } from './ReportPdfHeading';

interface ReportPdfNarrativeProps {
  readonly data: ReportPdfData;
}

function SummaryBlock({ section }: { section: ReportPdfNarrativeSection }): ReactElement {
  const s = useReportStyles();
  return (
    <View style={s.narrativeSummary}>
      {section.paragraphs.map((para, index) => (
        <Text key={index} style={s.narrativeSummaryText}>
          {para}
        </Text>
      ))}
    </View>
  );
}

function NarrativeBlock({ section }: { section: ReportPdfNarrativeSection }): ReactElement {
  const s = useReportStyles();
  const [firstPara, ...restParas] = section.paragraphs;
  return (
    <View style={s.narrativeBlock} wrap>
      {/* Widow control: glue the sub-heading to its FIRST paragraph in a
          non-wrapping group so a sub-heading never strands alone at the foot of
          a page. Remaining paragraphs flow (and may break) normally. */}
      <View wrap={false}>
        {section.title ? <Text style={s.narrativeHeading}>{section.title}</Text> : null}
        {firstPara !== undefined ? (
          <Text style={s.narrativePara}>{firstPara}</Text>
        ) : null}
      </View>
      {restParas.map((para, index) => (
        <Text key={index} style={s.narrativePara}>
          {para}
        </Text>
      ))}
    </View>
  );
}

/**
 * The English fallback for callers that have not wired `narrativeAbsentNote`
 * yet. Shipping locales override it; it exists so the section can never go
 * blank, not as the contract (i18n stays in React).
 */
const ABSENT_NOTE_FALLBACK =
  'No AI reading has been generated for this chart yet, so the written interpretation ' +
  'is not printed here. Generating one is optional and uses your own API key — ' +
  'everything else in this report is complete and unaffected.';

export function ReportPdfNarrative({ data }: ReportPdfNarrativeProps): ReactElement {
  const s = useReportStyles();
  const { narrative, labels } = data;
  const sections = narrative ?? [];
  return (
    <View>
      <ReportPdfHeading
        eyebrow={labels.narrativeEyebrow}
        title={labels.narrativeTitle}
        intro={labels.narrativeIntro}
      />
      {sections.length === 0 ? (
        <Text style={s.narrativePara}>
          {labels.narrativeAbsentNote || ABSENT_NOTE_FALLBACK}
        </Text>
      ) : null}
      {sections.map((section, index) =>
        section.title === '' ? (
          <SummaryBlock key={`summary-${index}`} section={section} />
        ) : (
          <NarrativeBlock key={`${section.title}-${index}`} section={section} />
        ),
      )}
    </View>
  );
}
