// The year ahead is four quarters counted from the reading's as-of month. The
// app computes them (pure calendar arithmetic, no astrology) and sends the
// keys in the prompt; the parser rejects any key it did not send.

import type { PromptLanguage } from "./language";

export type QuarterKey = "Q1" | "Q2" | "Q3" | "Q4";

export interface Quarter {
  readonly key: QuarterKey;
  /** The quarter's three months, `YYYY-MM`. */
  readonly months: readonly [string, string, string];
}

const QUARTER_KEYS: readonly QuarterKey[] = ["Q1", "Q2", "Q3", "Q4"];
const YEAR_MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

function monthAt(year: number, monthIndex: number, offset: number): string {
  const total = year * 12 + monthIndex + offset;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}`;
}

export function computeQuarters(asOfMonth: string): readonly Quarter[] {
  const match = YEAR_MONTH.exec(asOfMonth);
  if (!match) {
    throw new Error(`computeQuarters: expected YYYY-MM, got ${JSON.stringify(asOfMonth)}`);
  }
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  return QUARTER_KEYS.map((key, q) => ({
    key,
    months: [
      monthAt(year, monthIndex, q * 3),
      monthAt(year, monthIndex, q * 3 + 1),
      monthAt(year, monthIndex, q * 3 + 2),
    ] as const,
  }));
}

const LOCALES: Readonly<Record<PromptLanguage, string>> = { en: "en-US", es: "es-ES", pt: "pt-BR" };

function monthParts(yearMonth: string, language: PromptLanguage): { month: string; year: string } {
  const [year, month] = yearMonth.split("-").map(Number);
  const label = new Intl.DateTimeFormat(LOCALES[language], { month: "short", timeZone: "UTC" }).format(
    new Date(Date.UTC(year, month - 1, 1)),
  );
  return { month: label, year: String(year) };
}

/** "Oct-Dec 2026", or "Nov 2026-Jan 2027" when the quarter crosses a year. */
export function quarterTitle(quarter: Quarter, language: PromptLanguage = "en"): string {
  const first = monthParts(quarter.months[0], language);
  const last = monthParts(quarter.months[2], language);
  return first.year === last.year
    ? `${first.month}-${last.month} ${last.year}`
    : `${first.month} ${first.year}-${last.month} ${last.year}`;
}
