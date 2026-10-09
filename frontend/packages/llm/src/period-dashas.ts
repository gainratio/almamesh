// Dashas by date (spec 2026-10-08, "Dashas by date"). The engine already dates
// every maha and antar; this picks the rows that overlap a period. It is a
// date-overlap filter over engine-stated dates, not astrology.
import type { DashaPeriod, VimshottariDasha } from "@almamesh/browser/types";

import { yearDay } from "./period";
import { dashaBoundaryMonth, type PeriodRange } from "./sanitize";

export const PRATYANTAR_NOTE = "Pratyantar dashas are only available for the current antar.";
export const BIRTH_YEAR_ROWS_NOTE =
  "The first period row begins during the year of birth; months before birth don't apply.";
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
 * Where the birth instant sits, at year precision only. A row that starts at birth
 * is treated as starting on 1 January of the LOCAL birth year (the same year the
 * refusal uses). Otherwise whether it appears for a period inside the birth year
 * would bisect the birth day; the year is all the dasha boundaries already reveal.
 */
interface BirthAnchor {
  readonly start: string | undefined;
  readonly yearFirst: string;
  readonly yearLast: string;
}

function birthAnchor(dashas: VimshottariDasha, birthYear: number | undefined): BirthAnchor {
  const start = dashas.maha_dasha_sequence[0]?.start_date;
  // Without a local year (incomplete birth data), fall back to the instant's UTC year.
  const year = birthYear ?? Number((start ?? "0000").slice(0, 4));
  return { start, yearFirst: yearDay(year, "01-01"), yearLast: yearDay(year, "12-31") };
}

function overlaps(row: DashaPeriod, period: PeriodRange, birth: BirthAnchor): boolean {
  const start = row.start_date === birth.start ? birth.yearFirst : day(row.start_date);
  return start <= period.end && day(row.end_date) >= period.start;
}

function overlapsBirthYear(period: PeriodRange, birth: BirthAnchor): boolean {
  return birth.start !== undefined && period.start <= birth.yearLast && period.end >= birth.yearFirst;
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
  birth: BirthAnchor,
): { readonly rows?: readonly PeriodDashaRow[]; readonly note?: string } {
  const antar = dashas.current_antar;
  const sequence = dashas.pratyantar_sequence;
  if (!antar || !sequence) return { note: PRATYANTAR_NOTE };
  const inside = day(antar.start_date) <= period.start && period.end <= day(antar.end_date);
  if (!inside) return { note: PRATYANTAR_NOTE };
  return { rows: sequence.filter((row) => overlaps(row, period, birth)).map((row) => toRow(row, birth.start)) };
}

export function selectDashasForPeriod(
  dashas: VimshottariDasha,
  period: PeriodRange,
  birthYear?: number,
): PeriodDashas {
  const birth = birthAnchor(dashas, birthYear);
  const mahas = dashas.maha_dasha_sequence.filter((maha) => overlaps(maha, period, birth));
  const antar = mahas.flatMap((maha) =>
    (maha.antar_sequence ?? [])
      .filter((row) => overlaps(row, period, birth))
      .map((row) => ({ maha_lord: maha.lord, ...toRow(row, birth.start) })),
  );
  const notes: string[] = [];
  if (overlapsBirthYear(period, birth)) notes.push(BIRTH_YEAR_ROWS_NOTE);
  if (mahas.some((maha) => maha.antar_sequence === undefined)) notes.push(NO_TREE_NOTE);
  const pratyantar = pratyantarRows(dashas, period, birth);
  if (pratyantar.note) notes.push(pratyantar.note);
  return {
    maha: mahas.map((maha) => toRow(maha, birth.start)),
    antar,
    ...(pratyantar.rows ? { pratyantar: pratyantar.rows } : {}),
    notes,
  };
}
