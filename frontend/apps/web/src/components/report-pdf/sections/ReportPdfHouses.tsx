/**
 * ReportPdfHouses — Section III: the twelve whole-sign houses (bhāva) table.
 *
 * House number, sign, sign lord, and occupying grahas — all pre-formatted on
 * `ReportPdfHouseRow` (occupants grouped from the engine's own per-planet
 * `house` field; no recomputation). Deliberately NO cusp-degree column:
 * whole-sign house longitudes are sign-starts, and a column of "0°00′" reads
 * as a calculation bug. The honest whole-sign note closes the section.
 */

import type { ReactElement } from 'react';
import { Text, View } from '@react-pdf/renderer';
import { useReportStyles } from '../theme';
import type { ReportPdfData } from '../types';
import { ReportPdfHeading } from './ReportPdfHeading';
import { ReportPdfTable } from './ReportPdfTable';

interface ReportPdfHousesProps {
  readonly data: ReportPdfData;
}

export function ReportPdfHouses({ data }: ReportPdfHousesProps): ReactElement {
  const s = useReportStyles();
  const { houses, labels } = data;
  return (
    <View>
      <ReportPdfHeading
        eyebrow={labels.housesEyebrow}
        title={labels.housesTitle}
        intro={labels.housesIntro}
      />
      <ReportPdfTable
        table={{
          headers: [
            labels.colHouseNumber,
            labels.colHouseSign,
            labels.colHouseLord,
            labels.colOccupants,
          ],
          rows: houses.map((row) => ({
            cells: [row.house, row.sign, row.signLord, row.occupants],
          })),
          widths: [0.7, 1.2, 1.2, 2.4],
        }}
      />
      <Text style={s.detailNote}>{labels.housesNote}</Text>
    </View>
  );
}
