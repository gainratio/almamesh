/**
 * ReportPdfAssumptions — Section XIII, the PDF mirror of the web report's
 * assumptions & provenance panel. A bordered label→value list of the four
 * load-bearing choices behind every verdict (ayanāṁśa, house system, birth
 * time, ascendant cusp proximity). Pre-formatted strings only — no astrology,
 * no engine, no store. Renders nothing when the section was not supplied.
 */

import type { ReactElement } from 'react';
import { Text, View } from '@react-pdf/renderer';
import { useReportStyles } from '../theme';
import type { ReportPdfData } from '../types';
import { ReportPdfHeading } from './ReportPdfHeading';

export function ReportPdfAssumptions({
  data,
}: {
  readonly data: ReportPdfData;
}): ReactElement | null {
  const s = useReportStyles();
  const { assumptions } = data;
  if (!assumptions) {
    return null;
  }
  const lastIndex = assumptions.rows.length - 1;
  return (
    <View>
      <ReportPdfHeading
        eyebrow={assumptions.chrome.eyebrow}
        title={assumptions.chrome.title}
        intro={assumptions.chrome.intro}
      />
      <View style={s.detailPanel}>
        {assumptions.rows.map((row, index) => (
          <View key={row.label} style={index === lastIndex ? s.detailRowLast : s.detailRow}>
            <Text style={s.detailLabel}>{row.label}</Text>
            <Text style={s.detailValue}>{row.value}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}
