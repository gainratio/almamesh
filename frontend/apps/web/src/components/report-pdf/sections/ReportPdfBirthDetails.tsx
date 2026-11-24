/**
 * ReportPdfBirthDetails — the birth-details page of the @react-pdf Vedic report.
 *
 * A section heading (mono eyebrow + Fraunces title + brass rule), a short intro,
 * a bordered data-list panel (date / time / place / ascendant, each value
 * pre-formatted in the birth timezone), an optional near-cusp honesty note, and a
 * two-up technical readout (ayanamsa, house system). Degree/coordinate values are
 * set in mono so they align in tabular columns.
 */

import type { ReactElement } from 'react';
import { Text, View } from '@react-pdf/renderer';
import { useReportStyles } from '../theme';
import type { ReportPdfData, ReportPdfDetail, ReportPdfTechnical } from '../types';

interface ReportPdfBirthDetailsProps {
  readonly data: ReportPdfData;
}

/** One row of the birth data list; mono value for technical readouts. */
function DetailRow({ detail, last }: { detail: ReportPdfDetail; last: boolean }): ReactElement {
  const s = useReportStyles();
  return (
    <View style={last ? s.detailRowLast : s.detailRow}>
      <Text style={s.detailLabel}>{detail.label}</Text>
      <Text style={detail.mono ? s.detailValueMono : s.detailValue}>{detail.value}</Text>
    </View>
  );
}

/** One technical readout cell (engine-emitted value). */
function TechCell({ field }: { field: ReportPdfTechnical }): ReactElement {
  const s = useReportStyles();
  return (
    <View style={s.techCell}>
      <Text style={s.techLabel}>{field.label}</Text>
      <Text style={s.techValue}>{field.value}</Text>
    </View>
  );
}

export function ReportPdfBirthDetails({ data }: ReportPdfBirthDetailsProps): ReactElement {
  const s = useReportStyles();
  const { birthDetails, technical, labels } = data;

  return (
    <View>
      <View style={s.sectionHead}>
        <Text style={s.sectionEyebrow}>{labels.birthDetailsEyebrow}</Text>
        <Text style={s.sectionTitle}>{labels.birthDetailsTitle}</Text>
        <View style={s.sectionRule} />
        <Text style={s.sectionIntro}>{labels.birthDetailsIntro}</Text>
      </View>

      <View style={s.detailPanel}>
        {birthDetails.map((detail, index) => (
          <DetailRow
            key={detail.label}
            detail={detail}
            last={index === birthDetails.length - 1 && !data.ascendantNote}
          />
        ))}
        {data.ascendantNote ? <Text style={s.detailNote}>{data.ascendantNote}</Text> : null}
      </View>

      {technical.length > 0 ? (
        <>
          <View style={s.techRow}>
            {technical.map((field) => (
              <TechCell key={field.label} field={field} />
            ))}
          </View>
          <Text style={[s.detailNote, { marginTop: 18 }]}>{labels.technicalNote}</Text>
        </>
      ) : null}
    </View>
  );
}
