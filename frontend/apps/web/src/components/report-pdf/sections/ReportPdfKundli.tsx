/**
 * ReportPdfKundli — the North-Indian (diamond) kundli rendered as a true VECTOR
 * inside the @react-pdf document, driven by the renderer-agnostic `ChartGeometry`
 * the on-screen SVGs already consume (so D1 and D9 share one renderer with the
 * app — calculation integrity: zero astrology recomputed here).
 *
 * The geometry is the canonical unit-square North-Indian layout ported from
 * `components/chart/NorthIndianChartSVG.tsx`: a square with both diagonals AND the
 * side-midpoint diamond, carving 12 FIXED house cells (H1 = top-center diamond,
 * counter-clockwise). House positions are fixed; the SIGN in each rotates with the
 * lagna — exactly what `ChartGeometry.houses` (ordered house 1..12) provides.
 *
 * Colours come from the shared `PAPER_THEME` (chartTheme.ts) so the plate matches
 * the app's printed report. Degree text is suppressed for sign-precision (varga)
 * charts — a fabricated "0°" reads as a calculation bug to a practitioner.
 */

import type { ReactElement } from 'react';
import { Svg, Polygon, Line, Rect, Text } from '@react-pdf/renderer';
import type { ChartGeometry, ChartHouse, ChartPlanet } from '@almamesh/store';
import { FONT_MONO, palette } from '../theme';

/** The paper kundli palette, mirrored from chartTheme.ts PAPER_THEME. */
const PAPER = {
  cellFill: '#FFFFFF',
  gridStroke: '#4B5563',
  lagnaFill: '#FEF3C7',
  accent: palette.brass,
  signNum: '#9A917D',
  ink: palette.ink,
} as const;

/** A point in unit-square space (0,0 top-left → 1,1 bottom-right). */
interface UnitPoint {
  readonly x: number;
  readonly y: number;
}

interface HouseCell {
  readonly polygon: readonly UnitPoint[];
  readonly centroid: UnitPoint;
}

// Canonical North-Indian cell geometry — IDENTICAL to NorthIndianChartSVG.tsx.
const TL: UnitPoint = { x: 0, y: 0 };
const TR: UnitPoint = { x: 1, y: 0 };
const BR: UnitPoint = { x: 1, y: 1 };
const BL: UnitPoint = { x: 0, y: 1 };
const T: UnitPoint = { x: 0.5, y: 0 };
const R: UnitPoint = { x: 1, y: 0.5 };
const B: UnitPoint = { x: 0.5, y: 1 };
const L: UnitPoint = { x: 0, y: 0.5 };
const C: UnitPoint = { x: 0.5, y: 0.5 };
const QTL: UnitPoint = { x: 0.25, y: 0.25 };
const QTR: UnitPoint = { x: 0.75, y: 0.25 };
const QBR: UnitPoint = { x: 0.75, y: 0.75 };
const QBL: UnitPoint = { x: 0.25, y: 0.75 };

function centroidOf(polygon: readonly UnitPoint[]): UnitPoint {
  const sum = polygon.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
  return { x: sum.x / polygon.length, y: sum.y / polygon.length };
}

function cell(polygon: readonly UnitPoint[]): HouseCell {
  return { polygon, centroid: centroidOf(polygon) };
}

/** Index 0..11 → the cell for house (index + 1), counter-clockwise from H1. */
const HOUSE_CELLS: readonly HouseCell[] = [
  cell([T, QTL, C, QTR]), // H1  top-center diamond
  cell([TL, T, QTL]), // H2  top-left triangle
  cell([TL, QTL, L]), // H3  left-top triangle
  cell([L, QTL, C, QBL]), // H4  left-center diamond
  cell([L, QBL, BL]), // H5  left-bottom triangle
  cell([BL, QBL, B]), // H6  bottom-left triangle
  cell([B, QBL, C, QBR]), // H7  bottom-center diamond
  cell([B, QBR, BR]), // H8  bottom-right triangle
  cell([BR, QBR, R]), // H9  right-bottom triangle
  cell([R, QBR, C, QTR]), // H10 right-center diamond
  cell([R, QTR, TR]), // H11 right-top triangle
  cell([TR, QTR, T]), // H12 top-right triangle
];

const INTERNAL_LINES: readonly (readonly [UnitPoint, UnitPoint])[] = [
  [TL, BR],
  [TR, BL],
  [T, R],
  [R, B],
  [B, L],
  [L, T],
];

function scale(point: UnitPoint, size: number): UnitPoint {
  return { x: point.x * size, y: point.y * size };
}

function polygonPoints(polygon: readonly UnitPoint[], size: number): string {
  return polygon
    .map((p) => {
      const s = scale(p, size);
      return `${s.x},${s.y}`;
    })
    .join(' ');
}

/** A paper-legible planet ink (already resolved by the data builder). */
function planetLabel(planet: ChartPlanet, showDegrees: boolean): string {
  const retro = planet.isRetrograde ? ' (R)' : '';
  const degrees = showDegrees ? ` ${Math.floor(planet.signDegrees)}°` : '';
  return `${planet.label}${retro}${degrees}`;
}

/** Scaled bounding box of one North-Indian house polygon. */
interface CellBounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly width: number;
  readonly height: number;
}

/** Positioned planet row inside one house cell. */
export interface CellPlanetRow {
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly fontSize: number;
}

/** Computed geometry for every text element inside one house cell. */
export interface CellTextLayout {
  readonly signX: number;
  readonly signY: number;
  readonly signFont: number;
  readonly lagnaX: number;
  readonly lagnaY: number;
  readonly rows: readonly CellPlanetRow[];
}

const MONO_CHAR_WIDTH_RATIO = 0.62;
const MIN_FONT_PT = 4.5;
const GLYPH_ASCENT_RATIO = 0.85;
const GLYPH_DESCENT_RATIO = 0.15;

function boundsOf(polygon: readonly UnitPoint[], size: number): CellBounds {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const point of polygon) {
    const x = point.x * size;
    const y = point.y * size;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY };
}

/** Horizontal interior span `[loX, hiX]` of a convex polygon at vertical position `y`. */
function polygonChordAtY(
  polygon: readonly UnitPoint[],
  size: number,
  y: number,
): readonly [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  const n = polygon.length;
  for (let i = 0; i < n; i += 1) {
    const a = scale(polygon[i]!, size);
    const b = scale(polygon[(i + 1) % n]!, size);
    if ((a.y <= y && b.y >= y) || (b.y <= y && a.y >= y)) {
      if (Math.abs(b.y - a.y) < 1e-6) {
        lo = Math.min(lo, a.x, b.x);
        hi = Math.max(hi, a.x, b.x);
      } else {
        const x = a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x);
        lo = Math.min(lo, x);
        hi = Math.max(hi, x);
      }
    }
  }
  return lo <= hi ? [lo, hi] : null;
}

/**
 * Conservative horizontal span across a glyph's full vertical extent
 * `[baselineY - ascent, baselineY + descent]`, guaranteeing no glyph corner
 * crosses a 45° diagonal divider.
 */
function bandChordAtY(
  polygon: readonly UnitPoint[],
  size: number,
  baselineY: number,
  fontSize: number,
): readonly [number, number] | null {
  const top = polygonChordAtY(polygon, size, baselineY - fontSize * GLYPH_ASCENT_RATIO);
  const bot = polygonChordAtY(polygon, size, baselineY + fontSize * GLYPH_DESCENT_RATIO);
  if (!top || !bot) return null;
  const lo = Math.max(top[0], bot[0]);
  const hi = Math.min(top[1], bot[1]);
  return lo <= hi ? [lo, hi] : null;
}

/**
 * Exact vertical interval `[yLo, yHi]` where a convex polygon's horizontal
 * chord width is at least `minWidth`, keeping multi-planet stacks out of
 * zero-width triangle and diamond apexes.
 */
function usableVerticalInterval(
  polygon: readonly UnitPoint[],
  size: number,
  minWidth: number,
  bounds: CellBounds,
): readonly [number, number] {
  const ys = [...new Set(polygon.map((p) => p.y * size))].sort((a, b) => a - b);
  let yLo = Infinity;
  let yHi = -Infinity;
  for (let i = 0; i < ys.length - 1; i += 1) {
    const y0 = ys[i]!;
    const y1 = ys[i + 1]!;
    const c0 = polygonChordAtY(polygon, size, y0);
    const c1 = polygonChordAtY(polygon, size, y1);
    const w0 = c0 ? c0[1] - c0[0] : 0;
    const w1 = c1 ? c1[1] - c1[0] : 0;
    if (w0 < minWidth && w1 < minWidth) continue;
    let segLo = y0;
    let segHi = y1;
    if (w0 < minWidth && w1 >= minWidth) {
      segLo = y0 + ((minWidth - w0) / (w1 - w0)) * (y1 - y0);
    } else if (w0 >= minWidth && w1 < minWidth) {
      segHi = y0 + ((w0 - minWidth) / (w0 - w1)) * (y1 - y0);
    }
    if (segLo < yLo) yLo = segLo;
    if (segHi > yHi) yHi = segHi;
  }
  return yLo <= yHi ? [yLo, yHi] : [bounds.minY, bounds.maxY];
}

function clamp(value: number, lo: number, hi: number): number {
  return hi < lo ? (lo + hi) / 2 : Math.min(Math.max(value, lo), hi);
}

/**
 * Derive font sizes and clamped text anchors from each house polygon's exact
 * glyph-band scanline chords and usable vertical interval so outer triangles
 * (H2/H12, H3/H5/H9/H11), diamond apexes, and dense varga stacks stay strictly
 * inside both `[0, size]` and their diagonal house borders.
 */
export function computeCellTextLayout(
  house: ChartHouse,
  houseCell: HouseCell,
  size: number,
  isLagna: boolean,
  showDegrees: boolean,
): CellTextLayout {
  const center = scale(houseCell.centroid, size);
  const bounds = boundsOf(houseCell.polygon, size);
  const pad = Math.max(2.5, size * 0.018);
  const labels = house.planets.map((planet) => planetLabel(planet, showDegrees));
  const count = labels.length;
  const maxChars = labels.reduce((longest, label) => Math.max(longest, label.length), 0);

  const basePlanetFont = Math.max(6.5, size * 0.042);
  const baseSignFont = Math.max(5.5, size * 0.034);
  const baseLineH = Math.max(8.5, size * 0.05);

  const minLabelW = Math.max(2, maxChars) * MONO_CHAR_WIDTH_RATIO * MIN_FONT_PT;
  const minChordW = Math.min(bounds.width * 0.72, Math.max(14, minLabelW + pad * 2));
  const [usableMinY, usableMaxY] = usableVerticalInterval(
    houseCell.polygon,
    size,
    minChordW,
    bounds,
  );
  const usableH = Math.max(10, usableMaxY - usableMinY - pad * 2);

  const availW = Math.max(10, bounds.width - pad * 2);
  const planetFontH =
    maxChars > 0
      ? Math.max(MIN_FONT_PT, Math.min(basePlanetFont, availW / (maxChars * MONO_CHAR_WIDTH_RATIO)))
      : basePlanetFont;

  const baseHeaderH = isLagna ? baseSignFont * 1.2 : 0;
  const baseStackBelow = count > 0 ? baseLineH * 1.05 + (count - 1) * baseLineH : 0;
  const reqH = baseSignFont * GLYPH_ASCENT_RATIO + baseHeaderH + baseStackBelow + basePlanetFont * GLYPH_DESCENT_RATIO;
  const vScale = reqH > usableH ? usableH / reqH : 1;

  const baseFittedPlanetFont = Math.max(MIN_FONT_PT, Math.min(planetFontH, basePlanetFont * vScale));
  const signFont = Math.max(MIN_FONT_PT, baseSignFont * vScale);
  const rawLineH = Math.max(baseFittedPlanetFont * 1.12, baseLineH * vScale);

  const headerH = isLagna ? signFont * 1.2 : 0;
  const maxBottomY = Math.min(usableMaxY, size) - pad - baseFittedPlanetFont * GLYPH_DESCENT_RATIO;
  const minSignY = Math.max(
    usableMinY + pad + signFont * GLYPH_ASCENT_RATIO + headerH,
    pad + signFont * GLYPH_ASCENT_RATIO + headerH,
  );
  // Compress inter-row spacing cleanly when an extreme stellium (7–9 grahas in
  // a shallow 0.25*size varga triangle) exceeds `usableH` even at `MIN_FONT_PT`.
  const maxStackBelow = Math.max(0, maxBottomY - minSignY);
  const lineH =
    count > 0 && rawLineH * (count + 0.05) > maxStackBelow && maxStackBelow > 0
      ? Math.max(2.6, maxStackBelow / (count + 0.05))
      : rawLineH;
  const rowFontCap = Math.min(baseFittedPlanetFont, Math.max(2.4, lineH * 0.92));

  const stackBelow = count > 0 ? lineH * 1.05 + (count - 1) * lineH : 0;
  const usableMidY = (usableMinY + usableMaxY) / 2;
  const targetMidY = (center.y + usableMidY) / 2;
  const idealSignY = targetMidY - (count > 0 ? (stackBelow - signFont) / 2 : -signFont * 0.35);
  const maxSignY = maxBottomY - stackBelow;
  const signY = clamp(idealSignY, minSignY, Math.max(minSignY, maxSignY));

  const signChord = bandChordAtY(houseCell.polygon, size, signY, signFont);
  const signLo = signChord ? Math.max(bounds.minX, signChord[0]) : bounds.minX;
  const signHi = signChord ? Math.min(bounds.maxX, signChord[1]) : bounds.maxX;
  const signDigits = String(house.signIndex + 1).length;
  const halfSignW = (signDigits * MONO_CHAR_WIDTH_RATIO * signFont) / 2;
  const signInteriorX = clamp((signLo + signHi) / 2, signLo + pad + halfSignW, signHi - pad - halfSignW);
  const signX = clamp(signInteriorX, pad + halfSignW, size - pad - halfSignW);

  const lagnaY = clamp(
    signY - signFont * 1.2,
    pad + signFont * GLYPH_ASCENT_RATIO,
    size - pad - signFont * GLYPH_DESCENT_RATIO,
  );
  const lagnaChord = bandChordAtY(houseCell.polygon, size, lagnaY, signFont);
  const lagnaLo = lagnaChord ? Math.max(bounds.minX, lagnaChord[0]) : signLo;
  const lagnaHi = lagnaChord ? Math.min(bounds.maxX, lagnaChord[1]) : signHi;
  const halfLagnaW = (2 * MONO_CHAR_WIDTH_RATIO * signFont) / 2;
  const lagnaInteriorX = clamp(
    (lagnaLo + lagnaHi) / 2,
    lagnaLo + pad + halfLagnaW,
    lagnaHi - pad - halfLagnaW,
  );
  const lagnaX = clamp(lagnaInteriorX, pad + halfLagnaW, size - pad - halfLagnaW);

  const firstPlanetY = signY + lineH * 1.05;
  const rows: CellPlanetRow[] = labels.map((label, index) => {
    const rawY = firstPlanetY + index * lineH;
    const y = clamp(
      rawY,
      pad + rowFontCap * GLYPH_ASCENT_RATIO,
      size - pad - rowFontCap * GLYPH_DESCENT_RATIO,
    );
    const initialChord = bandChordAtY(houseCell.polygon, size, y, rowFontCap);
    const initLo = initialChord ? Math.max(bounds.minX, initialChord[0]) : bounds.minX;
    const initHi = initialChord ? Math.min(bounds.maxX, initialChord[1]) : bounds.maxX;
    const rowAvailW = Math.max(8, initHi - initLo - pad * 2);
    const fontSize = Math.max(
      Math.min(MIN_FONT_PT, rowFontCap),
      Math.min(
        rowFontCap,
        rowAvailW / (Math.max(1, label.length) * MONO_CHAR_WIDTH_RATIO),
      ),
    );
    const chord =
      fontSize < rowFontCap
        ? (bandChordAtY(houseCell.polygon, size, y, fontSize) ?? initialChord)
        : initialChord;
    const loX = chord ? Math.max(bounds.minX, chord[0]) : bounds.minX;
    const hiX = chord ? Math.min(bounds.maxX, chord[1]) : bounds.maxX;
    const halfW = (label.length * MONO_CHAR_WIDTH_RATIO * fontSize) / 2;
    const preferredX = (loX + hiX) / 2;
    const interiorX = clamp(preferredX, loX + pad + halfW, hiX - pad - halfW);
    const x = clamp(interiorX, pad + halfW, size - pad - halfW);
    return { label, x, y, fontSize };
  });

  return {
    signX,
    signY,
    signFont,
    lagnaX,
    lagnaY,
    rows,
  };
}

/** Exported for geometric viewport-bounds unit tests. */
export const NORTH_INDIAN_HOUSE_CELLS: readonly HouseCell[] = HOUSE_CELLS;

interface HouseCellViewProps {
  readonly house: ChartHouse;
  readonly cell: HouseCell;
  readonly size: number;
  readonly isLagna: boolean;
  readonly showDegrees: boolean;
}

/** One house cell: filled polygon, faint sign number, lagna mark, planet rows. */
function HouseCellView({
  house,
  cell: houseCell,
  size,
  isLagna,
  showDegrees,
}: HouseCellViewProps): ReactElement {
  const layout = computeCellTextLayout(house, houseCell, size, isLagna, showDegrees);

  return (
    <>
      <Polygon
        points={polygonPoints(houseCell.polygon, size)}
        fill={isLagna ? PAPER.lagnaFill : PAPER.cellFill}
        stroke={isLagna ? PAPER.accent : PAPER.gridStroke}
        strokeWidth={isLagna ? 1.2 : 0.8}
      />
      <Text
        x={layout.signX}
        y={layout.signY}
        style={{ fontFamily: FONT_MONO, fontSize: layout.signFont, fill: PAPER.signNum }}
        textAnchor="middle"
      >
        {String(house.signIndex + 1)}
      </Text>
      {isLagna ? (
        <Text
          x={layout.lagnaX}
          y={layout.lagnaY}
          style={{ fontFamily: FONT_MONO, fontSize: layout.signFont, fill: PAPER.accent }}
          textAnchor="middle"
        >
          La
        </Text>
      ) : null}
      {house.planets.map((planet, index) => {
        const row = layout.rows[index]!;
        return (
          <Text
            key={planet.name}
            x={row.x}
            y={row.y}
            style={{ fontFamily: FONT_MONO, fontSize: row.fontSize, fill: planet.color }}
            textAnchor="middle"
          >
            {row.label}
          </Text>
        );
      })}
    </>
  );
}

interface ReportPdfKundliProps {
  readonly geometry: ChartGeometry;
  /** Side length in points. */
  readonly size: number;
}

/** A North-Indian kundli drawn as a self-contained @react-pdf vector. */
export function ReportPdfKundli({ geometry, size }: ReportPdfKundliProps): ReactElement {
  // The lagna lives in house 1 by whole-sign definition; match defensively.
  const lagnaHouse =
    geometry.houses.find((h) => h.signIndex === geometry.lagna.signIndex)?.house ?? 1;
  const showDegrees = geometry.precision === 'degree';

  return (
    <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <Rect
        x={0}
        y={0}
        width={size}
        height={size}
        fill={PAPER.cellFill}
        stroke={PAPER.gridStroke}
        strokeWidth={1.4}
      />
      {geometry.houses.map((house, index) => (
        <HouseCellView
          key={house.house}
          house={house}
          cell={HOUSE_CELLS[index]}
          size={size}
          isLagna={house.house === lagnaHouse}
          showDegrees={showDegrees}
        />
      ))}
      {INTERNAL_LINES.map(([from, to], index) => {
        const a = scale(from, size);
        const b = scale(to, size);
        return (
          <Line
            key={index}
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            stroke={PAPER.gridStroke}
            strokeWidth={0.8}
          />
        );
      })}
    </Svg>
  );
}
