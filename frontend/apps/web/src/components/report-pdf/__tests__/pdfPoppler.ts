export interface PdfWordBox {
  readonly text: string;
  readonly xMin: number;
  readonly yMin: number;
  readonly xMax: number;
  readonly yMax: number;
  readonly lineText: string;
}

export interface PdfPageBox {
  readonly number: number;
  readonly width: number;
  readonly height: number;
  readonly text: string;
  readonly words: readonly PdfWordBox[];
}

export interface InspectedPdf {
  readonly text: string;
  readonly pages: readonly PdfPageBox[];
}

export interface PdfBoundsOptions {
  readonly footerNote: string;
}

function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

export function normalizePdfText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function attribute(tag: string, name: string): number {
  const value = new RegExp(`${name}="([^"]+)"`).exec(tag)?.[1];
  if (value === undefined) {
    throw new Error(`Poppler bbox output omitted ${name}`);
  }
  return Number(value);
}

function wordsFromLine(lineTag: string, body: string): readonly PdfWordBox[] {
  const rawWords = [...body.matchAll(/<word\b([^>]*)>([\s\S]*?)<\/word>/g)];
  const lineText = normalizePdfText(rawWords.map((match) => decodeXml(match[2] ?? '')).join(' '));
  return rawWords.map((match) => {
    const tag = match[1] ?? lineTag;
    return {
      text: normalizePdfText(decodeXml(match[2] ?? '')),
      xMin: attribute(tag, 'xMin'),
      yMin: attribute(tag, 'yMin'),
      xMax: attribute(tag, 'xMax'),
      yMax: attribute(tag, 'yMax'),
      lineText,
    };
  });
}

function parseBbox(xml: string): readonly PdfPageBox[] {
  return [...xml.matchAll(/<page\b([^>]*)>([\s\S]*?)<\/page>/g)].map((pageMatch, index) => {
    const tag = pageMatch[1] ?? '';
    const body = pageMatch[2] ?? '';
    const lineMatches = [...body.matchAll(/<line\b([^>]*)>([\s\S]*?)<\/line>/g)];
    const lineWords = lineMatches.map((lineMatch) =>
      wordsFromLine(lineMatch[1] ?? '', lineMatch[2] ?? ''),
    );
    const words = lineWords.flat();
    const lines = lineWords.map((line) => line[0]?.lineText ?? '').filter(Boolean);
    return {
      number: index + 1,
      width: attribute(tag, 'width'),
      height: attribute(tag, 'height'),
      text: normalizePdfText(lines.join('\n')),
      words,
    };
  });
}

async function poppler(path: string, args: readonly string[]): Promise<string> {
  try {
    const result = await execFileAsync('pdftotext', [...args, path, '-'], {
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER,
      env: { ...process.env, LC_ALL: 'C.UTF-8', TZ: 'UTC' },
    });
    return String(result.stdout);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`pdftotext is required for maximal PDF acceptance: ${detail}`, { cause: error });
  }
}

export async function inspectPdfWithPoppler(bytes: Uint8Array): Promise<InspectedPdf> {
  const directory = await mkdtemp(join(tmpdir(), 'almamesh-maximal-pdf-'));
  const path = join(directory, 'maximal-report.pdf');
  try {
    await writeFile(path, bytes);
    const [text, bbox] = await Promise.all([
      poppler(path, ['-enc', 'UTF-8', '-layout']),
      poppler(path, ['-enc', 'UTF-8', '-bbox-layout']),
    ]);
    const pages = parseBbox(bbox);
    if (pages.length === 0) {
      throw new Error('Poppler returned no PDF pages');
    }
    return { text: normalizePdfText(text), pages };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function isFooterLine(lineText: string, footerNote: string): boolean {
  const normalized = normalizePdfText(lineText).toLocaleLowerCase('en');
  const note = normalizePdfText(footerNote).toLocaleLowerCase('en');
  return normalized.includes(note) || /^\d+\s*\/\s*\d+$/.test(normalized);
}

function isRunningFooterWord(
  page: PdfPageBox,
  word: PdfWordBox,
  options: PdfBoundsOptions,
): boolean {
  return page.number > 1 && isFooterLine(word.lineText, options.footerNote);
}

function outside(value: number, expected: number, tolerance: number): boolean {
  return Math.abs(value - expected) > tolerance;
}

export function a4ContentBoundViolations(
  pdf: InspectedPdf,
  options: PdfBoundsOptions,
): readonly string[] {
  const violations: string[] = [];
  for (const page of pdf.pages) {
    if (outside(page.width, A4_WIDTH, PAGE_TOLERANCE)) {
      violations.push(`page ${page.number}: width ${page.width} is not A4`);
    }
    if (outside(page.height, A4_HEIGHT, PAGE_TOLERANCE)) {
      violations.push(`page ${page.number}: height ${page.height} is not A4`);
    }
    for (const word of page.words) {
      if (word.xMin < CONTENT_LEFT - CONTENT_TOLERANCE) {
        violations.push(`page ${page.number}: ${JSON.stringify(word.text)} xMin=${word.xMin}`);
      }
      if (word.xMax > CONTENT_RIGHT + CONTENT_TOLERANCE) {
        violations.push(`page ${page.number}: ${JSON.stringify(word.text)} xMax=${word.xMax}`);
      }
      const footer = isRunningFooterWord(page, word, options);
      const expectedTop = footer ? FOOTER_TOP : CONTENT_TOP;
      const expectedBottom = footer ? FOOTER_BOTTOM : CONTENT_BOTTOM;
      if (word.yMin < expectedTop - CONTENT_TOLERANCE) {
        violations.push(`page ${page.number}: ${JSON.stringify(word.text)} yMin=${word.yMin}`);
      }
      if (word.yMax > expectedBottom + CONTENT_TOLERANCE) {
        violations.push(`page ${page.number}: ${JSON.stringify(word.text)} yMax=${word.yMax}`);
      }
    }
  }
  return violations;
}

function footerWords(
  page: PdfPageBox,
  options: PdfBoundsOptions,
): { readonly note: readonly PdfWordBox[]; readonly counter: readonly PdfWordBox[] } {
  const normalizedNote = normalizePdfText(options.footerNote).toLocaleLowerCase('en');
  return {
    note: page.words.filter((word) =>
      normalizePdfText(word.lineText).toLocaleLowerCase('en').includes(normalizedNote),
    ),
    counter: page.words.filter((word) => /^\d+\s*\/\s*\d+$/.test(normalizePdfText(word.lineText))),
  };
}

function footerContentOverlap(
  page: PdfPageBox,
  footer: readonly PdfWordBox[],
  options: PdfBoundsOptions,
): boolean {
  const content = page.words.filter((word) => !isRunningFooterWord(page, word, options));
  const contentBottom = Math.max(...content.map((word) => word.yMax));
  const footerTop = Math.min(...footer.map((word) => word.yMin));
  return contentBottom >= footerTop;
}

export function footerGeometryViolations(
  pdf: InspectedPdf,
  options: PdfBoundsOptions,
): readonly string[] {
  const violations: string[] = [];
  for (const page of pdf.pages.slice(1)) {
    const { note, counter } = footerWords(page, options);
    if (note.length === 0) violations.push(`page ${page.number}: footer note missing`);
    if (counter.length === 0) violations.push(`page ${page.number}: footer counter missing`);
    if (note.length === 0 || counter.length === 0) continue;

    const noteRight = Math.max(...note.map((word) => word.xMax));
    const counterLeft = Math.min(...counter.map((word) => word.xMin));
    if (noteRight + FOOTER_COLUMN_GAP > counterLeft) {
      violations.push(`page ${page.number}: footer note and counter overlap`);
    }
    if (footerContentOverlap(page, [...note, ...counter], options)) {
      violations.push(`page ${page.number}: content overlaps footer text`);
    }
  }
  return violations;
}

export function pagesContaining(pdf: InspectedPdf, needle: string): readonly number[] {
  const normalized = normalizePdfText(needle).toLocaleLowerCase('en');
  if (!normalized) return [];
  return pdf.pages
    .filter((page) => normalizePdfText(page.text).toLocaleLowerCase('en').includes(normalized))
    .map((page) => page.number);
}

function compactPdfText(value: string): string {
  return normalizePdfText(value).replace(/\s+/g, '').toLocaleLowerCase('en');
}

export function horizontalWordOverlapViolations(
  pdf: InspectedPdf,
  pageNeedle: string,
): readonly string[] {
  const needle = compactPdfText(pageNeedle);
  const pages = pdf.pages.filter((page) => compactPdfText(page.text).includes(needle));
  const violations: string[] = [];
  for (const page of pages) {
    const bands: Array<{ center: number; words: PdfWordBox[] }> = [];
    for (const word of page.words) {
      const center = (word.yMin + word.yMax) / 2;
      const band = bands.find((candidate) => Math.abs(candidate.center - center) <= 0.5);
      if (band) band.words.push(word);
      else bands.push({ center, words: [word] });
    }
    for (const band of bands) {
      const words = band.words.sort((left, right) => left.xMin - right.xMin);
      for (let index = 1; index < words.length; index += 1) {
        const left = words[index - 1];
        const right = words[index];
        if (left && right && left.xMax > right.xMin + WORD_OVERLAP_TOLERANCE) {
          violations.push(
            `page ${page.number}: ${JSON.stringify(left.text)} overlaps ${JSON.stringify(right.text)}`,
          );
        }
      }
    }
  }
  return violations;
}

export function linesContainingAll(pdf: InspectedPdf, needles: readonly string[]): readonly string[] {
  const normalized = needles.map((needle) => normalizePdfText(needle).toLocaleLowerCase('en'));
  const rows = pdf.pages.flatMap((page) => {
    const bands: Array<{ center: number; words: PdfWordBox[] }> = [];
    for (const word of [...page.words].sort((left, right) => left.yMin - right.yMin)) {
      const center = (word.yMin + word.yMax) / 2;
      const band = bands.find((candidate) => Math.abs(candidate.center - center) <= 1.5);
      if (band) {
        band.words.push(word);
      } else {
        bands.push({ center, words: [word] });
      }
    }
    return bands.map((band) =>
      normalizePdfText(
        band.words
          .sort((left, right) => left.xMin - right.xMin)
          .map((word) => word.text)
          .join(' '),
      ),
    );
  });
  return rows.filter((line) => {
    const candidate = normalizePdfText(line).toLocaleLowerCase('en');
    return normalized.every((needle) => candidate.includes(needle));
  });
}
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;
const CONTENT_LEFT = 56;
const CONTENT_RIGHT = A4_WIDTH - 56;
const CONTENT_TOP = 54;
const CONTENT_BOTTOM = A4_HEIGHT - 56;
const FOOTER_TOP = 790;
const FOOTER_BOTTOM = 814;
const FOOTER_COLUMN_GAP = 12;
const PAGE_TOLERANCE = 0.25;
const CONTENT_TOLERANCE = 0.75;
const WORD_OVERLAP_TOLERANCE = 0.5;
const MAX_BUFFER = 32 * 1024 * 1024;
