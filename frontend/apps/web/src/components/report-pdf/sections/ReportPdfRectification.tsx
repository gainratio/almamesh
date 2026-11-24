/**
 * ReportPdfRectification — Section XII: Birth Time Authority. Entered vs
 * working time + rising sign, the fit mode, the qualitative confidence band,
 * the aggregate calibrated confidence percentage when its evidence gate passes,
 * and the confirm date, supporting life events, and honest caveat
 * ("resolves the sign, not the minute"). Phase 2 (Spec 062): when the slice
 * carries the optional snapshot tables (v2 records), the candidate
 * comparison, per-event evidence, quiet-period misses and prior note print
 * too — v1 slices render the classic section unchanged. All values arrive
 * pre-localized on `ReportPdfRectification`. The percentage describes event-fit
 * separation and is not a probability that the time is correct; raw margins,
 * fit scores, and per-signal numeric contributions stay out. Pure presentation.
 */

import type { ReactElement } from 'react';
import { StyleSheet, Text, View } from '@react-pdf/renderer';
import {
  createDevanagariStyles,
  FONT_MONO,
  palette,
  type as typeScale,
  useFontSheet,
  useReportStyles,
} from '../theme';
import type { ReportPdfData } from '../types';
import { ReportPdfHeading } from './ReportPdfHeading';
import { ReportPdfTable } from './ReportPdfTable';

const local = StyleSheet.create({
  factLabel: {
    width: 168,
    fontFamily: FONT_MONO,
    fontSize: typeScale.caption,
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: palette.muted,
  },
  factValue: {
    flex: 1,
    fontSize: typeScale.small,
    color: palette.ink,
  },
});

const localDevanagari = createDevanagariStyles(local);

interface ReportPdfRectificationProps {
  readonly data: ReportPdfData;
}

interface RectificationSubsectionHeadingProps {
  readonly breakBefore?: boolean;
  readonly heading?: string;
}

/** Keep a subsection label with enough following content for its table's first row. */
function RectificationSubsectionHeading({
  breakBefore = false,
  heading,
}: RectificationSubsectionHeadingProps): ReactElement {
  const s = useReportStyles();
  return (
    <View wrap={false} break={breakBefore}>
      <Text style={s.subLabel} minPresenceAhead={180}>
        {heading}
      </Text>
    </View>
  );
}

export function ReportPdfRectification({ data }: ReportPdfRectificationProps): ReactElement | null {
  const s = useReportStyles();
  const loc = useFontSheet(local, localDevanagari);
  const rectification = data.rectification;
  if (!rectification) {
    return null;
  }
  return (
    <View>
      <ReportPdfHeading
        eyebrow={rectification.chrome.eyebrow}
        title={rectification.chrome.title}
        intro={rectification.chrome.intro}
      />

      <View style={s.detailPanel} wrap={false}>
        {rectification.facts.map((fact, index) => (
          <View
            key={fact.label}
            style={index === rectification.facts.length - 1 ? s.detailRowLast : s.detailRow}
          >
            <Text style={loc.factLabel}>{fact.label}</Text>
            <Text style={loc.factValue}>{fact.value}</Text>
          </View>
        ))}
      </View>

      <RectificationSubsectionHeading heading={rectification.eventsHeading} />
      {rectification.events.rows.length === 0 ? (
        <Text style={s.detailNote}>{rectification.eventsEmpty}</Text>
      ) : (
        <ReportPdfTable table={rectification.events} />
      )}

      {/* Phase 2 (Spec 062): the full evidence story from a v2 snapshot. */}
      {rectification.candidates !== undefined && (
        <>
          <RectificationSubsectionHeading heading={rectification.candidatesHeading} />
          <ReportPdfTable table={rectification.candidates} />
        </>
      )}
      {rectification.evidence !== undefined && (
        <>
          <RectificationSubsectionHeading
            heading={rectification.evidenceHeading}
            breakBefore
          />
          <ReportPdfTable table={rectification.evidence} />
        </>
      )}
      {rectification.missNotes !== undefined && rectification.missNotes.length > 0 && (
        <>
          <RectificationSubsectionHeading heading={rectification.missesHeading} />
          {rectification.missNotes.map((note) => (
            <Text key={note} style={s.detailNote}>
              {note}
            </Text>
          ))}
        </>
      )}
      {rectification.priorNote !== undefined && (
        <Text style={s.detailNote}>{rectification.priorNote}</Text>
      )}

      <Text style={s.detailNote}>{rectification.caveat}</Text>
    </View>
  );
}
