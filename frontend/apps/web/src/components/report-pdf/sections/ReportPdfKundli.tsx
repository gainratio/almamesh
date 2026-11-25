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

/** Computed geometry for every text element inside one house cell. */
export interface CellTextLayout {
  readonly signX: number;
  readonly signY: number;
  readonly signFont: number;
  readonly lagnaY: number;
  readonly planetX: number;
  readonly firstPlanetY: number;
  readonly lineH: number;
  readonly planetFont: number;
  readonly labels: readonly string[];
}

const MONO_CHAR_WIDTH_RATIO = 0.62;
const MIN_FONT_PT = 4.5;

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

function clamp(value: number, lo: number, hi: number): number {
  return hi < lo ? (lo + hi) / 2 : Math.min(Math.max(value, lo), hi);
}

/**
 * Derive font sizes and clamped text anchors purely from each house polygon's
 * bounds so outer triangles (H2/H12 vertically, H3/H5/H9/H11 horizontally) and
 * dense varga stacks never clip outside the SVG viewport `[0, size]`.
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

  const availW = Math.max(10, bounds.width - pad * 2);
  const availH = Math.max(10, bounds.height - pad * 2);
  const planetFontH =
    maxChars > 0
      ? Math.max(MIN_FONT_PT, Math.min(basePlanetFont, availW / (maxChars * MONO_CHAR_WIDTH_RATIO)))
      : basePlanetFont;

  const baseHeaderH = isLagna ? baseSignFont * 1.2 : 0;
  const baseStackBelow = count > 0 ? baseLineH * 1.05 + (count - 1) * baseLineH : 0;
  const reqH = baseSignFont + baseHeaderH + baseStackBelow;
  const vScale = reqH > availH ? availH / reqH : 1;

  const planetFont = Math.max(MIN_FONT_PT, Math.min(planetFontH, basePlanetFont * vScale));
  const signFont = Math.max(MIN_FONT_PT, baseSignFont * vScale);
  const lineH = Math.max(planetFont * 1.12, baseLineH * vScale);

  const headerH = isLagna ? signFont * 1.2 : 0;
  const stackBelow = count > 0 ? lineH * 1.05 + (count - 1) * lineH : 0;
  const idealSignY = center.y - (count > 0 ? (stackBelow - signFont) / 2 : -signFont * 0.35);
  const minSignY = bounds.minY + pad + signFont + headerH;
  const maxSignY = bounds.maxY - pad - stackBelow;
  const signY = clamp(idealSignY, minSignY, Math.max(minSignY, maxSignY));

  const halfPlanetW = (maxChars * MONO_CHAR_WIDTH_RATIO * planetFont) / 2;
  const planetX = clamp(center.x, bounds.minX + pad + halfPlanetW, bounds.maxX - pad - halfPlanetW);
  const signDigits = String(house.signIndex + 1).length;
  const halfSignW = (signDigits * MONO_CHAR_WIDTH_RATIO * signFont) / 2;
  const signX = clamp(center.x, bounds.minX + pad + halfSignW, bounds.maxX - pad - halfSignW);

  return {
    signX,
    signY,
    signFont,
    lagnaY: signY - signFont * 1.2,
    planetX,
    firstPlanetY: signY + lineH * 1.05,
    lineH,
    planetFont,
    labels,
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
          x={layout.signX}
          y={layout.lagnaY}
          style={{ fontFamily: FONT_MONO, fontSize: layout.signFont, fill: PAPER.accent }}
          textAnchor="middle"
        >
          La
        </Text>
      ) : null}
      {house.planets.map((planet, index) => (
        <Text
          key={planet.name}
          x={layout.planetX}
          y={layout.firstPlanetY + index * layout.lineH}
          style={{ fontFamily: FONT_MONO, fontSize: layout.planetFont, fill: planet.color }}
          textAnchor="middle"
        >
          {layout.labels[index]}
        </Text>
      ))}
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
