/**
 * ReportPdfTable — the shared engraved-table primitive for the comprehensive
 * sections: a repeated header row (react-pdf `fixed`, so the header re-renders
 * at the top of every page a long table breaks across), zebra rows that never
 * split mid-row (`wrap={false}`), optional per-column flex weights, and an
 * `emphasis` row treatment (brass ink) for totals / running rows.
 *
 * Pure presentation over a pre-formatted `ReportPdfTable` — no data logic.
 */

import { useContext, type ReactElement } from 'react';
import { StyleSheet, Text, View } from '@react-pdf/renderer';
import {
  DevanagariContext,
  FONT_BODY,
  FONT_DEVANAGARI,
  palette,
  type as typeScale,
  useReportStyles,
} from '../theme';
import type { ReportPdfTable as ReportPdfTableData } from '../types';

const local = StyleSheet.create({
  cell: {
    fontSize: typeScale.caption,
    color: palette.ink,
    paddingRight: 6,
  },
  cellEmphasis: {
    fontSize: typeScale.caption,
    fontFamily: FONT_BODY,
    fontWeight: 600,
    color: palette.brassDeep,
    paddingRight: 6,
  },
  headCell: {
    paddingRight: 6,
  },
  denseHeadCell: {
    fontSize: 6.5,
    letterSpacing: 0.15,
    paddingRight: 2,
  },
  denseCell: {
    fontSize: 8,
    paddingRight: 3,
  },
  // Mirrors the theme's emphasized-row treatment (`tableRowLagna`): the
  // recessed paperDeep tint + a strong top rule — no hardcoded hex.
  rowEmphasis: {
    backgroundColor: palette.paperDeep,
    borderTopWidth: 1,
    borderTopColor: palette.ruleStrong,
  },
});

interface ReportPdfTableProps {
  readonly table: ReportPdfTableData;
  /** Repeat the header when the table breaks across pages (default true). */
  readonly repeatHeader?: boolean;
  /** Tight but legible typography for high-column-count reference tables. */
  readonly dense?: boolean;
  /** Use Noto Sans Devanagari family on headers & emphasized cells for Hindi exports. */
  readonly devanagari?: boolean;
}

/** Flex weight for column `index` (equal columns unless widths are given). */
function flexOf(table: ReportPdfTableData, index: number): number {
  return table.widths?.[index] ?? 1;
}

/** A pre-formatted table in the report's engraved style. */
export function ReportPdfTable({
  table,
  repeatHeader = true,
  dense = false,
  devanagari,
}: ReportPdfTableProps): ReactElement {
  const fromContext = useContext(DevanagariContext);
  const isDevanagari = devanagari ?? fromContext;
  const s = useReportStyles(isDevanagari);
  const lastIndex = table.rows.length - 1;
  const fontOverride = isDevanagari ? [{ fontFamily: FONT_DEVANAGARI }] : [];
  return (
    <View style={s.table}>
      <View style={s.tableHead} fixed={repeatHeader}>
        {table.headers.map((header, index) => (
          <Text
            key={`${header}-${index}`}
            style={[
              s.tableHeadCell,
              dense ? local.denseHeadCell : local.headCell,
              { flex: flexOf(table, index) },
            ]}
          >
            {header}
          </Text>
        ))}
      </View>
      {table.rows.map((row, rowIndex) => (
        <View
          key={rowIndex}
          wrap={false}
          style={[
            rowIndex === lastIndex ? s.tableRowLast : s.tableRow,
            ...(rowIndex % 2 === 1 && !row.emphasis ? [s.tableRowAlt] : []),
            ...(row.emphasis ? [local.rowEmphasis] : []),
          ]}
        >
          {row.cells.map((cell, cellIndex) => (
            <Text
              key={cellIndex}
              style={[
                row.emphasis ? local.cellEmphasis : local.cell,
                ...(dense ? [local.denseCell] : []),
                ...fontOverride,
                { flex: flexOf(table, cellIndex) },
              ]}
            >
              {cell}
            </Text>
          ))}
        </View>
      ))}
    </View>
  );
}
