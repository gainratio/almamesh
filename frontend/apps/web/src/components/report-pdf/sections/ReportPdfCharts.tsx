/**
 * ReportPdfCharts — the kundli page: the D1 Rāśi and (when present) the D9
 * Navāṁśa, each in a framed paper plate, drawn as true vectors by
 * `ReportPdfKundli`. A planet legend (glyph → name, in engine accent ink) keys
 * the two-letter abbreviations used inside the cells.
 */

import type { ReactElement } from 'react';
import { Text, View } from '@react-pdf/renderer';
import { useReportStyles } from '../theme';
import type { ReportPdfData } from '../types';
import { ReportPdfHeading } from './ReportPdfHeading';
import { ReportPdfKundli } from './ReportPdfKundli';

interface ReportPdfChartsProps {
  readonly data: ReportPdfData;
}

const PLATE_SIZE = 200;

/** The legend keys the in-cell two-letter abbreviations to planet names. */
function PlanetLegend({ data }: { data: ReportPdfData }): ReactElement {
  const s = useReportStyles();
  return (
    <View style={s.chartLegend}>
      {data.planets
        .filter((row) => row.glyph !== '')
        .map((row) => (
          <View key={row.name} style={s.legendItem}>
            <Text style={[s.legendSwatchText, { color: row.color }]}>{row.glyph}</Text>
            <Text style={s.legendName}>{row.name}</Text>
          </View>
        ))}
    </View>
  );
}

export function ReportPdfCharts({ data }: ReportPdfChartsProps): ReactElement {
  const s = useReportStyles();
  const { charts, labels } = data;
  return (
    <View>
      <ReportPdfHeading
        eyebrow={labels.chartsEyebrow}
        title={labels.chartsTitle}
        intro={labels.chartsIntro}
      />
      <View style={s.chartsRow}>
        <View style={s.chartPlate}>
          <Text style={s.chartCaption}>{charts.rasiCaption}</Text>
          <View style={s.chartFrame}>
            <ReportPdfKundli geometry={charts.rasi} size={PLATE_SIZE} />
          </View>
        </View>
        {charts.navamsa ? (
          <View style={s.chartPlate}>
            <Text style={s.chartCaption}>{charts.navamsaCaption}</Text>
            <View style={s.chartFrame}>
              <ReportPdfKundli geometry={charts.navamsa} size={PLATE_SIZE} />
            </View>
          </View>
        ) : null}
      </View>
      <PlanetLegend data={data} />
    </View>
  );
}
