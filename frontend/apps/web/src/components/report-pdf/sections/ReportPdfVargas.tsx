/**
 * ReportPdfVargas — Section IX: all sixteen divisional charts + tallies.
 *
 * The sixteen Shodaśavarga plates are laid out DELIBERATELY at four per A4
 * page (a 2×2 grid of framed, captioned kundli plates — the same North-Indian
 * vector `ReportPdfKundli` the natal pages use; sign-precision geometry, so no
 * degree text can appear). `ReportDocument` chunks the plates and emits one
 * `ReportPdfVargaPlates` per page, then closes the section with the
 * vargottama flags and the Viṁśopaka Bala table (`ReportPdfVargaTallies`).
 */

import type { ReactElement } from 'react';
import { StyleSheet, Text, View } from '@react-pdf/renderer';
import { palette, type as typeScale, useReportStyles } from '../theme';
import type { ReportPdfVargaPlate, ReportPdfVargas } from '../types';
import { ReportPdfHeading } from './ReportPdfHeading';
import { ReportPdfKundli } from './ReportPdfKundli';
import { ReportPdfTable } from './ReportPdfTable';

/** Plates per PDF page — a 2×2 grid fills an A4 content box handsomely. */
export const VARGA_PLATES_PER_PAGE = 4;

const PLATE_SIZE = 190;

const local = StyleSheet.create({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    marginTop: typeScale.caption,
  },
  plate: {
    width: 232,
    marginBottom: 18,
  },
  note: {
    fontSize: typeScale.caption,
    color: palette.muted,
    marginBottom: 4,
  },
  vargottamaLine: {
    fontSize: typeScale.small,
    color: palette.ink,
    lineHeight: 1.6,
  },
});

/** Split the plate list into page-sized chunks (pure; used by ReportDocument). */
export function chunkVargaPlates(
  plates: ReadonlyArray<ReportPdfVargaPlate>,
): ReadonlyArray<ReadonlyArray<ReportPdfVargaPlate>> {
  const pages: Array<ReadonlyArray<ReportPdfVargaPlate>> = [];
  for (let start = 0; start < plates.length; start += VARGA_PLATES_PER_PAGE) {
    pages.push(plates.slice(start, start + VARGA_PLATES_PER_PAGE));
  }
  return pages;
}

interface ReportPdfVargaPlatesProps {
  readonly vargas: ReportPdfVargas;
  /** The plates on THIS page (a `chunkVargaPlates` chunk). */
  readonly plates: ReadonlyArray<ReportPdfVargaPlate>;
  /** True on the first plate page only — it opens the section chrome. */
  readonly first: boolean;
}

/** One page of up to four framed varga plates (2×2). */
export function ReportPdfVargaPlates({
  vargas,
  plates,
  first,
}: ReportPdfVargaPlatesProps): ReactElement {
  const s = useReportStyles();
  return (
    <View>
      {first ? (
        <>
          <ReportPdfHeading
            eyebrow={vargas.chrome.eyebrow}
            title={vargas.chrome.title}
            intro={vargas.chrome.intro}
          />
          <Text style={local.note}>{vargas.note}</Text>
        </>
      ) : null}
      <View style={local.grid}>
        {plates.map((plate) => (
          <View key={plate.id} style={local.plate} wrap={false}>
            <Text style={s.chartCaption}>{plate.caption}</Text>
            <View style={s.chartFrame}>
              <ReportPdfKundli geometry={plate.geometry} size={PLATE_SIZE} />
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

interface ReportPdfVargaTalliesProps {
  readonly vargas: ReportPdfVargas;
}

/** The closing tallies page: vargottama flags + the Viṁśopaka Bala table. */
export function ReportPdfVargaTallies({ vargas }: ReportPdfVargaTalliesProps): ReactElement {
  const s = useReportStyles();
  return (
    <View>
      <Text style={s.subLabel}>{vargas.vargottamaHeading}</Text>
      <Text style={local.vargottamaLine}>{vargas.vargottamaLine}</Text>

      <Text style={s.subLabel}>{vargas.vimshopakaHeading}</Text>
      <ReportPdfTable table={vargas.vimshopaka} />
      {vargas.approxNote ? <Text style={s.detailNote}>{vargas.approxNote}</Text> : null}
    </View>
  );
}
