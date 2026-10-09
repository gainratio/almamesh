// Dashas by date (spec 2026-10-08, "Dashas by date"). The engine already dates
// every maha and antar; this picks the rows that overlap a period. It is a
// date-overlap filter over engine-stated dates, not astrology.
import type { DashaPeriod, VimshottariDasha } from "@almamesh/browser/types";

import { dashaBoundaryMonth, type PeriodRange } from "./sanitize";

export const PRATYANTAR_NOTE = "Pratyantar dashas are only available for the current antar.";
export const NO_TREE_NOTE =
  "This chart was computed before dated antar periods existed. Recompute it to read antars by date.";

export interface PeriodDashaRow {
  readonly lord: string;
  /** "YYYY-MM", or "birth" for the row that starts at the birth instant. */
  readonly start_month: string;
  readonly end_month: string;
}

export interface PeriodAntarRow extends PeriodDashaRow {
  readonly maha_lord: string;
}

export interface PeriodDashas {
  readonly maha: readonly PeriodDashaRow[];
  readonly antar: readonly PeriodAntarRow[];
  readonly pratyantar?: readonly PeriodDashaRow[];
  readonly notes: readonly string[];
}

function day(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * A row that starts at the birth instant is treated as starting on 1 January of
 * the birth year. Otherwise whether it appears for a period inside the birth year
 * would bisect the birth day; the year is all the dasha boundaries already reveal.
 */
function rowStartDay(row: DashaPeriod, birthStart: string | undefined): string {
  return row.start_date === birthStart ? `${row.start_date.slice(0, 4)}-01-01` : day(row.start_date);
}

function overlaps(row: DashaPeriod, period: PeriodRange, birthStart: string | undefined): boolean {
  return rowStartDay(row, birthStart) <= period.end && day(row.end_date) >= period.start;
}

function toRow(row: DashaPeriod, birthStart: string | undefined): PeriodDashaRow {
  return {
    lord: row.lord,
    start_month: dashaBoundaryMonth(row.start_date, birthStart),
    end_month: dashaBoundaryMonth(row.end_date, birthStart),
  };
}

/** Pratyantars exist only for the chart's current antar; outside it, say so. */
function pratyantarRows(
  dashas: VimshottariDasha,
  period: PeriodRange,
  birthStart: string | undefined,
): { readonly rows?: readonly PeriodDashaRow[]; readonly note?: string } {
  const antar = dashas.current_antar;
  const sequence = dashas.pratyantar_sequence;
  if (!antar || !sequence) return { note: PRATYANTAR_NOTE };
  const inside = day(antar.start_date) <= period.start && period.end <= day(antar.end_date);
  if (!inside) return { note: PRATYANTAR_NOTE };
  return { rows: sequence.filter((row) => overlaps(row, period, birthStart)).map((row) => toRow(row, birthStart)) };
}

export function selectDashasForPeriod(dashas: VimshottariDasha, period: PeriodRange): PeriodDashas {
  const birthStart = dashas.maha_dasha_sequence[0]?.start_date;
  const mahas = dashas.maha_dasha_sequence.filter((maha) => overlaps(maha, period, birthStart));
  const antar = mahas.flatMap((maha) =>
    (maha.antar_sequence ?? [])
      .filter((row) => overlaps(row, period, birthStart))
      .map((row) => ({ maha_lord: maha.lord, ...toRow(row, birthStart) })),
  );
  const notes: string[] = [];
  if (mahas.some((maha) => maha.antar_sequence === undefined)) notes.push(NO_TREE_NOTE);
  const pratyantar = pratyantarRows(dashas, period, birthStart);
  if (pratyantar.note) notes.push(pratyantar.note);
  return {
    maha: mahas.map((maha) => toRow(maha, birthStart)),
    antar,
    ...(pratyantar.rows ? { pratyantar: pratyantar.rows } : {}),
    notes,
  };
}
