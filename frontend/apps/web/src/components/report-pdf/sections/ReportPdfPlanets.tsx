/**
 * ReportPdfPlanets — the planetary-positions table (all 9 grahas + the Lagna).
 *
 * An immaculate engraved table: a brass-chip planet glyph, the sign, a mono
 * tabular-figure degree readout (with an ASCII "(R)" retrograde mark), the
 * nakshatra + pada, the whole-sign house, the dignity, and the STATE (retro /
 * combust, with the measured separation). All values arrive pre-formatted on
 * `ReportPdfPlanetRow` — no recomputation.
 *
 * The State column is load-bearing. Combustion used to be encoded here as
 * `opacity: 0.55` and nothing else, so a combust Venus printed "EXALTED" and the
 * exported table said nothing about the engine's own `is_combust` — a fact
 * carried only by opacity survives neither text extraction, nor a screen reader,
 * nor greyscale printing. The dimming stays as a REDUNDANT cue.
 */

import type { ReactElement } from 'react';
import { StyleSheet, Text, View } from '@react-pdf/renderer';
import { useReportStyles } from '../theme';
import type { ReportPdfData, ReportPdfPlanetRow } from '../types';
import { ReportPdfHeading } from './ReportPdfHeading';

// Small local style atoms (typed Style) so style arrays never carry `null` —
// react-pdf's style typing rejects `null` in a composed array position.
const local = StyleSheet.create({
  empty: {},
  degreeCellLayout: { flexDirection: 'row', alignItems: 'baseline' },
});
const empty = local.empty;
const degreeCellLayout = local.degreeCellLayout;

interface ReportPdfPlanetsProps {
  readonly data: ReportPdfData;
}

function HeaderRow({ data }: { data: ReportPdfData }): ReactElement {
  const s = useReportStyles();
  const { labels } = data;
  return (
    <View style={s.tableHead}>
      <Text style={[s.tableHeadCell, s.colPlanet]}>{labels.colPlanet}</Text>
      <Text style={[s.tableHeadCell, s.colSign]}>{labels.colSign}</Text>
      <Text style={[s.tableHeadCell, s.colDegree]}>{labels.colDegree}</Text>
      <Text style={[s.tableHeadCell, s.colNakshatra]}>{labels.colNakshatra}</Text>
      <Text style={[s.tableHeadCell, s.colHouse]}>{labels.colHouse}</Text>
      <Text style={[s.tableHeadCell, s.colDignity]}>{labels.colDignity}</Text>
      <Text style={[s.tableHeadCell, s.colState]}>{labels.colState}</Text>
    </View>
  );
}

/**
 * The State cell: combustion first, so the row's OWN baseline carries it (a
 * wrapped second line extracts as a separate line with no planet name on it),
 * then the retrograde word. Empty for a calm graha.
 */
function StateCell({
  row,
  labels,
}: {
  row: ReportPdfPlanetRow;
  labels: ReportPdfData['labels'];
}): ReactElement {
  const s = useReportStyles();
  return (
    <View style={[s.colState, row.isCombust ? s.rowDim : empty]}>
      {row.combustion ? <Text style={s.cellState}>{row.combustion}</Text> : null}
      {row.isRetrograde ? <Text style={s.cellState}>{labels.stateRetrograde}</Text> : null}
    </View>
  );
}

function PlanetRow({
  row,
  labels,
  alt,
  last,
}: {
  row: ReportPdfPlanetRow;
  labels: ReportPdfData['labels'];
  alt: boolean;
  last: boolean;
}): ReactElement {
  const s = useReportStyles();
  const isLagna = row.glyph === '';
  const base = last ? s.tableRowLast : s.tableRow;
  const rowStyle = [
    base,
    ...(alt && !isLagna ? [s.tableRowAlt] : []),
    ...(isLagna ? [s.tableRowLagna] : []),
  ];
  const dim = row.isCombust ? s.rowDim : empty;

  return (
    <View style={rowStyle} wrap={false}>
      <View style={[s.colPlanet, dim]}>
        {row.glyph ? (
          <View style={[s.glyphChip, { backgroundColor: row.color }]}>
            <Text style={s.glyphChipText}>{row.glyph}</Text>
          </View>
        ) : null}
        <Text style={s.cellName}>{row.name}</Text>
      </View>
      <Text style={[s.cellSign, s.colSign, dim]}>{row.sign}</Text>
      <View style={[s.colDegree, degreeCellLayout, dim]}>
        <Text style={s.cellMono}>{row.degree}</Text>
        {row.isRetrograde ? <Text style={s.cellRetro}> (R)</Text> : null}
      </View>
      <Text style={[s.cellNak, s.colNakshatra, dim]}>{row.nakshatra}</Text>
      <Text style={[s.cellMonoCenter, s.colHouse, dim]}>{row.house}</Text>
      <Text style={[s.cellDignity, s.colDignity, dim]}>{row.dignity}</Text>
      <StateCell row={row} labels={labels} />
    </View>
  );
}

export function ReportPdfPlanets({ data }: ReportPdfPlanetsProps): ReactElement {
  const s = useReportStyles();
  const { planets, labels, combustionNotes } = data;
  return (
    <View>
      <ReportPdfHeading
        eyebrow={labels.planetsEyebrow}
        title={labels.planetsTitle}
        intro={labels.planetsIntro}
      />
      <View style={s.table}>
        <HeaderRow data={data} />
        {planets.map((row, index) => (
          <PlanetRow
            key={row.name}
            row={row}
            labels={labels}
            alt={index % 2 === 1}
            last={index === planets.length - 1}
          />
        ))}
      </View>
      {/* The checkable arithmetic behind each "Combust": the measured separation
          from the Sun AND the classical orb it was tested against. One line per
          graha, full width, so a figure never wraps away from its planet. */}
      {(combustionNotes ?? []).map((note) => (
        <Text key={note} style={s.combustionNote}>
          {note}
        </Text>
      ))}
    </View>
  );
}
