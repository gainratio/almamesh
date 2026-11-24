/**
 * ReportPdfDasha — the Vimshottari daśā timeline: a "current period" card
 * (Maha · Antar · Pratyantar), the nine maha-daśā rows with dated spans, and the
 * antar-daśā drill-down of EVERY mahā (the definitive reference tables; the
 * running antar is marked inside its mahā too). All dates/spans arrive
 * pre-formatted (epoch-safe) on `ReportPdfData` — no recomputation here.
 *
 * The running period is named IN WORDS on its own row. It used to be a brass dot
 * plus a slightly heavier lord — and a `<View>` dot contributes no characters, so
 * all nine mahā rows extracted as identical text. The brass stays as a redundant
 * cue; `labels.dashaCurrentMarker` is what actually says which row is running.
 */

import type { ReactElement } from 'react';
import { Text, View } from '@react-pdf/renderer';
import { useReportStyles } from '../theme';
import type {
  ReportPdfAntarTable,
  ReportPdfData,
  ReportPdfDashaPeriod,
} from '../types';
import { ReportPdfHeading } from './ReportPdfHeading';

interface ReportPdfDashaProps {
  readonly data: ReportPdfData;
}

interface ReportPdfDashaTablesProps {
  readonly tables: readonly ReportPdfAntarTable[];
  /** `labels.dashaCurrentMarker` — the word printed on the running period's row. */
  readonly currentMarker: string;
}

const TABLE_UNITS_PER_PAGE = 2;

function tableUnits(table: ReportPdfAntarTable): number {
  return table.pratyantarTable ? 2 : 1;
}

export function planDashaTablePages(
  tables: readonly ReportPdfAntarTable[],
): readonly (readonly ReportPdfAntarTable[])[] {
  const pages: ReportPdfAntarTable[][] = [];
  let page: ReportPdfAntarTable[] = [];
  let units = 0;

  for (const table of tables) {
    const nextUnits = tableUnits(table);
    if (page.length > 0 && units + nextUnits > TABLE_UNITS_PER_PAGE) {
      pages.push(page);
      page = [];
      units = 0;
    }
    page.push(table);
    units += nextUnits;
  }
  if (page.length > 0) pages.push(page);
  return pages;
}

function PeriodRow({
  period,
  currentMarker,
}: {
  period: ReportPdfDashaPeriod;
  currentMarker: string;
}): ReactElement {
  const s = useReportStyles();
  return (
    <View style={s.dashaRow} wrap={false}>
      <View style={period.isCurrent ? s.dashaTickCurrent : s.dashaTick} />
      <Text style={period.isCurrent ? s.dashaLordCurrent : s.dashaLord}>
        {period.lord}
      </Text>
      <Text style={s.dashaSpan}>
        {period.start} — {period.end}
      </Text>
      <Text style={s.dashaYears}>{period.span}</Text>
      {/* Always rendered so the column keeps its width; empty rows print nothing. */}
      <Text style={s.dashaCurrentMark}>{period.isCurrent ? currentMarker : ''}</Text>
    </View>
  );
}

function PeriodTable({
  heading,
  periods,
  currentMarker,
}: {
  heading: string;
  periods: readonly ReportPdfDashaPeriod[];
  currentMarker: string;
}): ReactElement {
  const s = useReportStyles();
  const [first, ...remaining] = periods;
  return (
    <View>
      <View wrap={false}>
        <Text style={s.subLabel}>{heading}</Text>
        {first ? <PeriodRow period={first} currentMarker={currentMarker} /> : null}
      </View>
      {remaining.map((period) => (
        <PeriodRow
          key={`${heading}-${period.lord}-${period.start}`}
          period={period}
          currentMarker={currentMarker}
        />
      ))}
    </View>
  );
}

export function ReportPdfDashaOverview({ data }: ReportPdfDashaProps): ReactElement {
  const s = useReportStyles();
  const { dasha, labels } = data;
  return (
    <View>
      <ReportPdfHeading
        eyebrow={labels.dashaEyebrow}
        title={labels.dashaTitle}
        intro={labels.dashaIntro}
      />

      {dasha.currentFocus ? (
        <View style={s.dashaCurrent} wrap={false}>
          <Text style={s.dashaCurrentLabel}>{labels.dashaCurrentLabel}</Text>
          <Text style={s.dashaCurrentValue}>{dasha.currentFocus}</Text>
        </View>
      ) : null}

      <Text style={s.subLabel}>{labels.dashaSequenceLabel}</Text>
      <View>
        {dasha.mahaSequence.map((period) => (
          <PeriodRow
            key={`${period.lord}-${period.start}`}
            period={period}
            currentMarker={labels.dashaCurrentMarker}
          />
        ))}
      </View>
    </View>
  );
}

export function ReportPdfDashaTables({
  tables,
  currentMarker,
}: ReportPdfDashaTablesProps): ReactElement {
  return (
    <View wrap={false}>
      {tables.map((table) => (
        <View key={table.heading} wrap={false}>
          <PeriodTable
            heading={table.heading}
            periods={table.periods}
            currentMarker={currentMarker}
          />
          {table.pratyantarTable ? (
            <PeriodTable
              heading={table.pratyantarTable.heading}
              periods={table.pratyantarTable.periods}
              currentMarker={currentMarker}
            />
          ) : null}
        </View>
      ))}
    </View>
  );
}
