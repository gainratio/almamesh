/**
 * buildReportSections — pure reshapers from the engine's `SiderealChart` (+ the
 * LLM `VedicInterpretation`) into the presentation-ready section slices of
 * `ReportPdfData`. Like `buildReportPdfData`, this RESHAPES and formats ONLY; it
 * recomputes no astrology (the engine is the single source of truth). The kundli
 * geometry rides along via the shared `buildChartGeometry` / `buildVargaGeometry`
 * adapters — the same geometry the on-screen SVGs consume.
 */

import type { SiderealChart, YogaData } from '@almamesh/browser/types';
import type { VedicInterpretation } from '@almamesh/shared-types';
import {
  buildChartGeometry,
  buildVargaGeometry,
  type ChartGeometry,
  type ChartPlanet,
} from '@almamesh/store';
import { planetInk } from '../chart/chartTheme';
import { combustionOrbDeg } from '../../lib/evidence/combustionOrbs';
import { formatDegree } from '../../lib/reportData';
import { buildGuidanceSections, personaText, type ReportAudience } from '../../lib/reportSelectors';
import { hasStrength, yogaStrength } from '../../lib/yogaStrength';
import { glyphSafe } from './glyphSafe';
import { yogaClaimId } from '../../lib/stability';
import type {
  ReportPdfAntarTable,
  ReportPdfCharts,
  ReportPdfDasha,
  ReportPdfDashaPeriod,
  ReportPdfHouseRow,
  ReportPdfNarrativeSection,
  ReportPdfNarrativeTitles,
  ReportPdfPlanetRow,
  ReportPdfYoga,
} from './types';

/**
 * Resolve one claim's pre-localized stability flag ("birth-time sensitive"),
 * or `undefined` when no marker exists for it. Built by `buildReportPdfData`
 * from the caller's marker map + its localized formatter, so i18n stays in
 * React exactly like every other string the PDF layer renders.
 */
export type StabilityFlagFor = (claimId: string) => string | undefined;

/** Display order for the planetary table (luminaries, then taras, then nodes). */
const PLANET_ORDER: readonly string[] = [
  'sun',
  'moon',
  'mars',
  'mercury',
  'jupiter',
  'venus',
  'saturn',
  'rahu',
  'ketu',
];

const PLANET_NAMES: Readonly<Record<string, string>> = {
  sun: 'Sun',
  moon: 'Moon',
  mars: 'Mars',
  mercury: 'Mercury',
  jupiter: 'Jupiter',
  venus: 'Venus',
  saturn: 'Saturn',
  rahu: 'Rahu',
  ketu: 'Ketu',
};

function titleCase(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : '';
}

/** Show a dignity only when it is meaningful (exalted / debilitated / own etc.). */
function dignityLabel(dignity: string): string {
  const normalized = dignity.trim().toLowerCase();
  if (!normalized || normalized === 'neutral') {
    return '';
  }
  return titleCase(normalized);
}

/** A graha's nakshatra + pada, e.g. "Uttara Bhadrapada · 4". */
function nakshatraLabel(nakshatra: string, pada: number): string {
  if (!nakshatra) {
    return '';
  }
  return pada > 0 ? `${nakshatra} · ${pada}` : nakshatra;
}

/**
 * The two localized combustion strings, bound in React by the caller (i18n never
 * enters this layer) — the same pattern as `formatAntarHeading`.
 *
 * Unlike the chrome labels, these default to ENGLISH rather than to absence. A
 * fact-carrying string that silently disappears when a caller forgets to wire it
 * is the very failure this whole change exists to end: combustion used to be
 * encoded as `opacity: 0.55` and nothing else, so the exported table said nothing
 * at all about a combust graha.
 */
export interface CombustionCopy {
  /** The planet row's State cell, e.g. "Combust 2.76°". */
  readonly state: (separation: string) => string;
  /** The under-table statement, e.g. "Venus — combust 2.76° from the Sun (orb 10°)". */
  readonly note: (parts: {
    readonly planet: string;
    readonly separation: string;
    readonly orb: string;
  }) => string;
}

const DEFAULT_COMBUSTION_COPY: CombustionCopy = {
  state: (separation) => `Combust ${separation}°`,
  note: ({ planet, separation, orb }) =>
    `${planet} — combust ${separation}° from the Sun (orb ${orb}°)`,
};

/** Degrees print to 2 dp throughout the report. */
function degrees2dp(value: number): string {
  return value.toFixed(2);
}

/** Classical orbs are whole degrees; print them bare, and only decimalize if not. */
function orbFigure(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/** The graha's display name — the same string the table row prints. */
function planetName(name: string): string {
  return PLANET_NAMES[name] ?? titleCase(name);
}

/**
 * The combustion STATE in words, or "" when the graha is not combust. When the
 * payload carries no measured separation (older bundles), the state degrades to
 * the bare verdict rather than inventing a number.
 */
function combustionState(planet: ChartPlanet, copy: CombustionCopy): string {
  if (!planet.isCombust) {
    return '';
  }
  const separation = planet.combustionSeparationDeg;
  if (separation === null) {
    return glyphSafe(copy.state('').trim());
  }
  return glyphSafe(copy.state(degrees2dp(separation)));
}

/** One planet → one table row (paper-legible ink, glyph-safe degree). */
function toPlanetRow(planet: ChartPlanet, copy: CombustionCopy): ReportPdfPlanetRow {
  return {
    name: planetName(planet.name),
    glyph: planet.label,
    sign: planet.sign,
    degree: glyphSafe(formatDegree(planet.signDegrees)),
    nakshatra: glyphSafe(nakshatraLabel(planet.nakshatra, planet.pada)),
    house: String(planet.house),
    dignity: dignityLabel(planet.dignity),
    isRetrograde: planet.isRetrograde,
    isCombust: planet.isCombust,
    combustion: combustionState(planet, copy),
    color: planetInk(planet.color, 'paper'),
  };
}

/** The 9 grahas (engine order) + a leading Lagna row. */
export function buildPlanetRows(
  geometry: ChartGeometry,
  copy: CombustionCopy = DEFAULT_COMBUSTION_COPY,
): ReadonlyArray<ReportPdfPlanetRow> {
  const byName = new Map(geometry.planets.map((p) => [p.name, p]));
  const rows = PLANET_ORDER.filter((name) => byName.has(name)).map((name) =>
    toPlanetRow(byName.get(name) as ChartPlanet, copy),
  );
  const lagnaRow: ReportPdfPlanetRow = {
    name: 'Ascendant',
    glyph: '',
    sign: geometry.lagna.sign,
    degree: glyphSafe(formatDegree(geometry.lagna.signDegrees)),
    nakshatra: '',
    house: '—',
    dignity: '',
    isRetrograde: false,
    isCombust: false,
    combustion: '',
    color: '#B8860B',
  };
  return [lagnaRow, ...rows];
}

/**
 * One finished sentence per combust graha, for the line under the planetary
 * table: the measured separation AND the classical orb it was tested against.
 *
 * The engine emits `is_combust` and `combustion_separation_deg` but NOT the orb,
 * so the orb comes from `lib/evidence/combustionOrbs.ts` — a mirror of the Python
 * constants whose own test parses the Python source, so the two cannot drift.
 * A graha with no orb (the Sun itself, the shadow nodes) states nothing here.
 */
export function buildCombustionNotes(
  geometry: ChartGeometry,
  copy: CombustionCopy = DEFAULT_COMBUSTION_COPY,
): ReadonlyArray<string> {
  const byName = new Map(geometry.planets.map((p) => [p.name, p]));
  return PLANET_ORDER.filter((name) => byName.has(name))
    .map((name) => byName.get(name) as ChartPlanet)
    .filter((planet) => planet.isCombust && planet.combustionSeparationDeg !== null)
    .flatMap((planet) => {
      const orb = combustionOrbDeg(planet.name, planet.isRetrograde);
      if (orb === null) {
        return [];
      }
      return [
        glyphSafe(
          copy.note({
            planet: planetName(planet.name),
            separation: degrees2dp(planet.combustionSeparationDeg as number),
            orb: orbFigure(orb),
          }),
        ),
      ];
    });
}

/**
 * The 12 whole-sign house rows: sign + lord from the engine's `houses` map,
 * occupants grouped purely from each planet's emitted `house` field. NO cusp
 * degree: whole-sign house `longitude` is a sign-start (a 30° multiple), so a
 * degree column would print a fabricated-looking "0°00′" on every row.
 */
export function buildHouses(chart: SiderealChart): ReadonlyArray<ReportPdfHouseRow> {
  const planets = [...Object.values(chart.planets)].sort(
    (a, b) => PLANET_ORDER.indexOf(a.name) - PLANET_ORDER.indexOf(b.name),
  );
  return Object.values(chart.houses)
    .slice()
    .sort((a, b) => a.house - b.house)
    .map((cusp) => {
      const occupants = planets
        .filter((planet) => planet.house === cusp.house)
        .map((planet) => PLANET_NAMES[planet.name] ?? titleCase(planet.name))
        .join(', ');
      return {
        house: String(cusp.house),
        sign: glyphSafe(titleCase(cusp.sign)),
        signLord: glyphSafe(titleCase(cusp.sign_lord)),
        occupants: glyphSafe(occupants || '—'),
      };
    });
}

/** Re-tint each geometry planet to its paper-legible ink (for the kundli cells). */
export function paperTint(geometry: ChartGeometry): ChartGeometry {
  const tint = (p: ChartPlanet): ChartPlanet => ({ ...p, color: planetInk(p.color, 'paper') });
  return {
    ...geometry,
    planets: geometry.planets.map(tint),
    houses: geometry.houses.map((h) => ({ ...h, planets: h.planets.map(tint) })),
    signs: geometry.signs.map((s) => ({ ...s, planets: s.planets.map(tint) })),
  };
}

/** Build the D1 + D9 kundli geometry, paper-tinted, with localized captions. */
export function buildCharts(
  chart: SiderealChart,
  d1Geometry: ChartGeometry,
  captions: { readonly rasi: string; readonly navamsa: string },
): ReportPdfCharts {
  const nav = chart.navamsa;
  const navamsa = nav
    ? paperTint(
        buildVargaGeometry({
          name: nav.name,
          lagna_sign: nav.lagna_sign,
          lagna_sign_lord: nav.lagna_sign_lord,
          planets: nav.planets,
        }),
      )
    : null;
  return {
    rasi: paperTint(d1Geometry),
    rasiCaption: glyphSafe(captions.rasi),
    navamsa,
    navamsaCaption: glyphSafe(captions.navamsa),
  };
}

/**
 * A short "Mon YYYY" label from an ISO date string (epoch-safe), by the
 * Periods panel's rule. A date-only string is its WRITTEN Y/M/D, formatted at
 * local noon — `new Date(iso)` would reparse it as UTC midnight and roll the
 * label back a month west of GMT (the life-event date bug class, Spec 062).
 * A full instant is read in the viewer's zone, as the screen shows it.
 */
function shortMonthYear(iso: string): string {
  const datePart = iso.split('T')[0] ?? '';
  const [year, month, day] = datePart.split('-').map(Number);
  if (!year || !month || !day || Date.UTC(year, month - 1, day) === 0) {
    return '';
  }
  const instant = iso.includes('T') ? new Date(iso) : null;
  const when =
    instant !== null && !Number.isNaN(instant.getTime())
      ? instant
      : new Date(year, month - 1, day, 12, 0, 0);
  return new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric' }).format(when);
}

function spanLabel(years: number): string {
  if (!Number.isFinite(years) || years <= 0) {
    return '';
  }
  const rounded = years >= 1 ? Math.round(years) : Number(years.toFixed(1));
  return `${rounded} yr`;
}

/**
 * Build the dasha timeline: the maha sequence, the current focus line, and the
 * antar drill-down of EVERY mahā (in mahā order — the definitive reference
 * tables; empty on older payloads without period depth). `formatAntarHeading`
 * binds the localized "Antar-daśās of the {lord} Mahā-daśā" template from the
 * React layer; without it the title-cased lord alone heads each table.
 */
export function buildDasha(
  chart: SiderealChart,
  formatAntarHeading?: (lord: string) => string,
  formatPratyantarHeading?: (lord: string) => string,
): ReportPdfDasha {
  const { dashas } = chart;
  const currentLord = dashas.current_maha?.lord ?? null;
  const currentStart = dashas.current_maha?.start_date ?? null;

  const mahaSequence: ReadonlyArray<ReportPdfDashaPeriod> = dashas.maha_dasha_sequence.map(
    (period) => ({
      lord: titleCase(period.lord),
      start: shortMonthYear(period.start_date),
      end: shortMonthYear(period.end_date),
      span: spanLabel(period.duration_years),
      isCurrent: period.lord === currentLord && period.start_date === currentStart,
    }),
  );

  const focusParts = [dashas.current_maha, dashas.current_antar, dashas.current_pratyantar]
    .filter((p): p is NonNullable<typeof p> => Boolean(p))
    .map((p) => titleCase(p.lord));
  const currentFocus = glyphSafe(focusParts.join(' · '));

  const currentAntar = dashas.current_antar ?? null;
  const currentPratyantar = dashas.current_pratyantar ?? null;
  const antarTables: ReadonlyArray<ReportPdfAntarTable> = dashas.maha_dasha_sequence.flatMap(
    (maha) => {
      const antars = maha.antar_sequence ?? [];
      if (antars.length === 0) {
        return [];
      }
      // A running antar can only live inside the running mahā.
      const isRunningMaha = maha.lord === currentLord && maha.start_date === currentStart;
      const lord = titleCase(maha.lord);
      const pratyantars = isRunningMaha ? (dashas.pratyantar_sequence ?? []) : [];
      return [
        {
          heading: glyphSafe(formatAntarHeading ? formatAntarHeading(lord) : lord),
          periods: antars.map((period) => ({
            lord: titleCase(period.lord),
            start: shortMonthYear(period.start_date),
            end: shortMonthYear(period.end_date),
            span: spanLabel(period.duration_years),
            isCurrent:
              isRunningMaha &&
              currentAntar !== null &&
              period.lord === currentAntar.lord &&
              period.start_date === currentAntar.start_date,
          })),
          ...(currentAntar !== null && pratyantars.length > 0
            ? {
                pratyantarTable: {
                  heading: glyphSafe(
                    formatPratyantarHeading
                      ? formatPratyantarHeading(titleCase(currentAntar.lord))
                      : titleCase(currentAntar.lord),
                  ),
                  periods: pratyantars.map((period) => ({
                    lord: titleCase(period.lord),
                    start: shortMonthYear(period.start_date),
                    end: shortMonthYear(period.end_date),
                    span: spanLabel(period.duration_years),
                    isCurrent:
                      currentPratyantar !== null &&
                      period.lord === currentPratyantar.lord &&
                      period.start_date === currentPratyantar.start_date,
                  })),
                },
              }
            : {}),
        },
      ];
    },
  );

  return { mahaSequence, currentFocus, antarTables };
}

const GRADE_TITLE: Readonly<Record<string, string>> = {
  strong: 'Strong',
  moderate: 'Moderate',
  weak: 'Weak',
};

/** ASCII-safe signed integer for the PDF font (no Unicode minus glyph needed). */
const pdfSign = (n: number): string => (n >= 0 ? `+${n}` : `-${Math.abs(n)}`);

/**
 * The calibrated STRUCTURAL strength headline + signed ledger for the PDF card.
 * Empty strings for bundles stored before the calibrated-strength upgrade, so
 * the card silently omits the line (mirrors the web's presence guard).
 *
 * The ledger always names the FULL achievable scale — the engine's percentage
 * divides by max_favorable + max_unfavorable, so printing a single bound left
 * the arithmetic unreproducible on paper too.
 */
function buildYogaStrength(yoga: YogaData): { strength: string; strengthLedger: string } {
  if (!hasStrength(yoga)) {
    return { strength: '', strengthLedger: '' };
  }
  const view = yogaStrength(yoga);
  const band = GRADE_TITLE[view.band] ?? titleCase(view.band);
  const strength = glyphSafe(`${view.pct}% · ${band} · structural estimate`);
  const scale = `net ${pdfSign(view.net)} on the ${pdfSign(view.min)}...${pdfSign(view.max)} scale`;
  const marks = view.entries
    .map((entry) => `${titleCase(entry.planet)} ${entry.value} ${pdfSign(entry.mark)}`)
    .join(' · ');
  return { strength, strengthLedger: glyphSafe(marks ? `${marks} · ${scale}` : scale) };
}

/**
 * Build the yoga cards (engine yogas → name + category·grade + strength + desc).
 *
 * `stabilityFlagFor` optionally supplies each yoga's pre-localized birth-time
 * stability mark — the same honesty furniture the screen's `StabilityChip`
 * shows. Omit it and every card is byte-identical to before.
 */
export function buildYogas(
  chart: SiderealChart,
  stabilityFlagFor?: StabilityFlagFor,
): ReadonlyArray<ReportPdfYoga> {
  return chart.yogas.map((yoga) => {
    const category = titleCase(yoga.category.replace(/_/g, ' '));
    const grade = GRADE_TITLE[yoga.grade] ?? titleCase(yoga.grade);
    const planets = yoga.planets_involved.map(titleCase).join(' · ');
    // The clean `name` is the card title; `display_name` appends a parenthetical
    // formation that duplicates the description, so we drop it. The 4 distinct
    // "Dhana Yoga" rows stay distinguishable via their description line.
    const stability = stabilityFlagFor?.(yogaClaimId(yoga.name));
    return {
      name: glyphSafe(yoga.name),
      classification: glyphSafe(category ? `${category} · ${grade}` : grade),
      description: glyphSafe(yoga.description || yoga.effects),
      signature: glyphSafe(planets),
      grade: yoga.grade,
      ...buildYogaStrength(yoga),
      ...(stability ? { stability } : {}),
    };
  });
}

/** Split a prose blob into clean paragraphs (markdown bullets/emphasis stripped). */
function toParagraphs(text: string): ReadonlyArray<string> {
  return text
    .split(/\n{2,}|\r\n\r\n/)
    .map((para) =>
      glyphSafe(
        para
          .replace(/\r?\n/g, ' ')
          .replace(/^#+\s*/gm, '')
          .replace(/\*\*(.+?)\*\*/g, '$1')
          .replace(/\*(.+?)\*/g, '$1')
          .replace(/^[-*]\s+/gm, '')
          .trim(),
      ),
    )
    .filter((para) => para.length > 0);
}

/** A titled-persona list → one narrative section (its items joined as paragraphs). */
function titledSection(
  title: string,
  items: ReadonlyArray<{ readonly title?: string; readonly layman?: string; readonly technical?: string }>,
  audience: ReportAudience,
): ReportPdfNarrativeSection | null {
  const paragraphs = items
    .map((item) => {
      const text = personaText(item, audience);
      if (!text) {
        return '';
      }
      return item.title ? `${item.title}. ${text}` : text;
    })
    .filter((text) => text.length > 0)
    .flatMap((text) => toParagraphs(text));
  return paragraphs.length > 0 ? { title, paragraphs } : null;
}

/**
 * The English titles used when a caller has not injected localized ones. They
 * are a FALLBACK, not the contract: the app passes `report:interpretation.*`
 * so the PDF matches the reader's language (i18n stays in React).
 */
const DEFAULT_NARRATIVE_TITLES: ReportPdfNarrativeTitles = {
  currentSky: "What's Active Now & Next",
  strengths: 'Strengths',
  challenges: 'Challenges',
  lifeThemes: 'Life Themes',
  roadAhead: 'The Road Ahead',
};

/**
 * Build the structured interpretation as ordered narrative blocks.
 *
 * `titles` carries the five section headings ALREADY LOCALIZED (the same
 * `report:interpretation.*` strings the on-screen report renders). Guidance
 * headings already arrive localized via `buildGuidanceSections`.
 */
export function buildNarrative(
  interpretation: VedicInterpretation,
  audience: ReportAudience,
  titles: ReportPdfNarrativeTitles = DEFAULT_NARRATIVE_TITLES,
): ReadonlyArray<ReportPdfNarrativeSection> {
  const sections: ReportPdfNarrativeSection[] = [];

  const summary = personaText(interpretation.summary, audience);
  if (summary) {
    sections.push({ title: '', paragraphs: toParagraphs(summary) });
  }

  // "What's Active Now & Next" (current_sky, Spec 065) — the predictive
  // differentiator leads the reading, right after the summary. Degrades
  // gracefully: absent/empty on a natal-only reading (honesty fence: never
  // invent timing) simply drops the section, same as every titledSection below.
  const currentSky = titledSection(titles.currentSky, interpretation.current_sky ?? [], audience);
  if (currentSky) sections.push(currentSky);

  const strengths = titledSection(titles.strengths, interpretation.strengths ?? [], audience);
  if (strengths) sections.push(strengths);
  const challenges = titledSection(titles.challenges, interpretation.challenges ?? [], audience);
  if (challenges) sections.push(challenges);
  const themes = titledSection(titles.lifeThemes, interpretation.life_themes ?? [], audience);
  if (themes) sections.push(themes);

  for (const guidance of buildGuidanceSections(interpretation, audience)) {
    sections.push({ title: guidance.title, paragraphs: toParagraphs(guidance.text) });
  }

  const road = titledSection(titles.roadAhead, interpretation.upcoming_periods ?? [], audience);
  if (road) sections.push(road);

  return sections;
}

/**
 * The LLM's woven yoga story (`integrated_yoga_narrative`) as ordered
 * paragraphs in the reader's voice, or `undefined` when the reading carries
 * none (older stored readings, or a natal-only report). It is prose the model
 * wrote about the engine's OWN formed yogas — the PDF only typesets it.
 */
export function buildYogaNarrative(
  interpretation: VedicInterpretation,
  audience: ReportAudience,
): ReadonlyArray<string> | undefined {
  const text = personaText(interpretation.integrated_yoga_narrative, audience);
  if (!text) {
    return undefined;
  }
  const paragraphs = toParagraphs(text);
  return paragraphs.length > 0 ? paragraphs : undefined;
}

/** Build the D1 geometry once (shared by the planet table + the kundli plate). */
export function buildD1Geometry(chart: SiderealChart): ChartGeometry {
  return buildChartGeometry(chart);
}
