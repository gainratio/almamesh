/**
 * ReportPdfTransits — Section VIII: Transits & Timing. The gochara table, the
 * Sade Sati panel, the slow-graha hits, the daśā × transit fusion read, and
 * the twelve-month timeline — all pre-formatted on `ReportPdfTransits`
 * (engine TransitCtx verbatim; localized by the builder). Pure presentation.
 */

import type { ReactElement } from 'react';
import { StyleSheet, Text, View } from '@react-pdf/renderer';
import { palette, type as typeScale, useReportStyles } from '../theme';
import type { ReportPdfData, ReportPdfLabeledValue } from '../types';
import { ReportPdfHeading } from './ReportPdfHeading';
import { ReportPdfTable } from './ReportPdfTable';

const local = StyleSheet.create({
  asOf: {
    fontSize: typeScale.caption,
    color: palette.muted,
    marginBottom: 2,
  },
  panelLabel: {
    width: 210,
    fontSize: typeScale.caption,
    color: palette.muted,
    paddingRight: 8,
  },
  panelValue: {
    flex: 1,
    fontSize: typeScale.caption,
    color: palette.ink,
  },
});

/** A label → value panel (Sade Sati / fusion readouts), detail-row styled. */
function LabeledPanel({ rows }: { rows: ReadonlyArray<ReportPdfLabeledValue> }): ReactElement {
  const s = useReportStyles();
  return (
    <View style={s.detailPanel}>
      {rows.map((row, index) => (
        <View
          key={`${row.label}-${index}`}
          wrap={false}
          style={index === rows.length - 1 ? s.detailRowLast : s.detailRow}
        >
          <Text style={local.panelLabel}>{row.label}</Text>
          <Text style={local.panelValue}>{row.value}</Text>
        </View>
      ))}
    </View>
  );
}

interface ReportPdfTransitsProps {
  readonly data: ReportPdfData;
}

export function ReportPdfTransits({ data }: ReportPdfTransitsProps): ReactElement | null {
  const s = useReportStyles();
  const transits = data.transits;
  if (!transits) {
    return null;
  }
  return (
    <View>
      <ReportPdfHeading
        eyebrow={transits.chrome.eyebrow}
        title={transits.chrome.title}
        intro={transits.chrome.intro}
      />
      <Text style={local.asOf}>{transits.asOf}</Text>
      <ReportPdfTable table={transits.gochara} />

      <Text style={s.subLabel}>{transits.sadeSatiHeading}</Text>
      <LabeledPanel rows={transits.sadeSati} />

      <Text style={s.subLabel}>{transits.slowHitsHeading}</Text>
      {transits.slowHits.rows.length === 0 ? (
        <Text style={s.detailNote}>{transits.slowHitsEmpty}</Text>
      ) : (
        <ReportPdfTable table={transits.slowHits} />
      )}

      <Text style={s.subLabel}>{transits.fusionHeading}</Text>
      <LabeledPanel rows={transits.fusion} />

      <Text style={s.subLabel}>{transits.timelineHeading}</Text>
      {transits.timeline.rows.length === 0 ? (
        <Text style={s.detailNote}>{transits.timelineEmpty}</Text>
      ) : (
        <ReportPdfTable table={transits.timeline} />
      )}
    </View>
  );
}
