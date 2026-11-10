/**
 * reportSectionNumerals — the two surfaces must agree on what Section VIII is.
 *
 * The report is rendered twice: on screen by `components/features/report/*` and
 * on paper by `components/report-pdf/*`. Each used to hardcode its own roman
 * numerals, in its own file, with nothing comparing them. Inserting "Evidence &
 * Confidence" renumbered the PDF and left the screen untouched, so the same
 * section printed as VIII in the export and XII on screen — and five sections
 * after it disagreed too.
 *
 * `lib/reportSections.ts` now declares each numeral ONCE. This test holds both
 * surfaces to it: the screen reads its numerals from the registry (so it cannot
 * drift by construction), and every locale's PDF eyebrow string is checked to
 * carry the SAME numeral, in all three languages. Renumber one surface alone and
 * this fails by section name.
 */
import { describe, expect, it } from 'vitest';
import enReport from '../../locales/en/report.json';
import esReport from '../../locales/es/report.json';
import ptReport from '../../locales/pt/report.json';
import hiReport from '../../locales/hi/report.json';
import { REPORT_SECTIONS, numberedSections, sectionNumeral } from '../reportSections';

const LOCALES: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ['en', enReport as unknown as Record<string, unknown>],
  ['es', esReport as unknown as Record<string, unknown>],
  ['pt', ptReport as unknown as Record<string, unknown>],
  ['hi', hiReport as unknown as Record<string, unknown>],
];

/** The roman numeral inside an eyebrow, whatever wording surrounds it. */
function romanIn(eyebrow: string): string | null {
  const match = /\b([IVXL]+)\b/.exec(eyebrow);
  return match ? match[1] : null;
}

const ROMAN_SEQUENCE = [
  'I',
  'II',
  'III',
  'IV',
  'V',
  'VI',
  'VII',
  'VIII',
  'IX',
  'X',
  'XI',
  'XII',
  'XIII',
  'XIV',
  'XV',
] as const;

describe('report section numerals — one declaration, both surfaces', () => {
  it('numbers the sections consecutively from I, in document order', () => {
    const numerals = numberedSections().map((section) => section.numeral);
    expect(numerals).toEqual(ROMAN_SEQUENCE.slice(0, numerals.length));
  });

  it('gives every numbered section a distinct numeral', () => {
    const numerals = numberedSections().map((section) => section.numeral);
    expect(new Set(numerals).size).toBe(numerals.length);
  });

  it.each(LOCALES)('agrees with the %s PDF eyebrow for every section', (locale, bundle) => {
    const pdf = bundle.pdf as Record<string, string>;
    for (const section of numberedSections()) {
      if (!section.pdfEyebrowKey) continue;
      const eyebrow = pdf[section.pdfEyebrowKey];
      expect(
        eyebrow,
        `The ${locale} bundle has no report:pdf.${section.pdfEyebrowKey}, but ` +
          `lib/reportSections.ts says the "${section.key}" section is numbered ` +
          `${section.numeral}.`,
      ).toBeTruthy();
      expect(
        romanIn(String(eyebrow)),
        `Section "${section.key}" is declared ${section.numeral} in ` +
          `lib/reportSections.ts, but the ${locale} PDF eyebrow reads ` +
          `${JSON.stringify(eyebrow)}. The screen and the export are numbering the ` +
          `same section differently — renumber both, in the registry.`,
      ).toBe(section.numeral);
    }
  });

  it('refuses to invent a numeral for an unknown section', () => {
    expect(() => sectionNumeral('not-a-section')).toThrow(/not-a-section/);
  });

  it('declares a numeral for every exported section except the cover chrome', () => {
    const unnumbered = REPORT_SECTIONS.filter((section) => !section.numeral).map((s) => s.key);
    // The cover page and the running footer are chrome, not numbered chapters.
    expect(unnumbered).toEqual(['cover', 'footer']);
  });
});
