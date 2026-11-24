/**
 * report-pdf/theme — the design system for the @react-pdf/renderer Vedic report.
 *
 * AESTHETIC DIRECTION: "Letterpress observatory" — an editorial, archival
 * star-chart monograph. Warm cream paper, deep ink, a single restrained brass
 * accent, and a deliberate three-voice type system:
 *   - DISPLAY  Fraunces (high-optical-size serif) — the elegant, characterful
 *              voice for the cover and section titles.
 *   - BODY     Hanken Grotesk — a clean, contemporary humanist sans for reading.
 *   - MONO     Spline Sans Mono — tabular figures for degrees / coordinates,
 *              so technical readouts align in monospace columns.
 *
 * Every font is registered from a SELF-HOSTED .ttf under `public/fonts/`
 * (derived at build-prep time from the project's own woff2 — ZERO network
 * egress). Colours reuse the proven print palette from the kundli SVGs
 * (`chartTheme.ts` PAPER_THEME) plus the canonical brass accent.
 */

import { createContext, useContext } from 'react';
import { Font, StyleSheet } from '@react-pdf/renderer';

/* ── Font families ─────────────────────────────────────────────────────────
 * Registered by absolute URL path so they resolve identically in the browser
 * (served from /fonts/*) and in the Node render harness (which maps the same
 * URL onto the on-disk public/fonts file). Names are unique-per-report
 * ("… Report") so they never collide with the app's DOM @font-face families.
 */

export const FONT_DISPLAY = 'Fraunces Report';
export const FONT_BODY = 'Hanken Grotesk Report';
export const FONT_MONO = 'Spline Sans Mono Report';
export const FONT_DEVANAGARI = 'Noto Sans Devanagari Report';

/** Absolute, same-origin font URLs (served from `public/fonts/`). */
const FONT_BASE = '/fonts';

/**
 * Register all report faces ONCE with immutable family names (Latin + Devanagari).
 * Distinct families prevent @react-pdf/font's global singleton from leaking font
 * bindings across sequential or concurrent English/Hindi PDF exports.
 * `fontBase` lets the Node harness rewrite the same URLs onto local files.
 */
export function registerReportFonts(fontBase: string = FONT_BASE): void {
  const devanagariRegular = `${fontBase}/NotoSansDevanagari-Regular.ttf`;
  const devanagariSemiBold = `${fontBase}/NotoSansDevanagari-SemiBold.ttf`;

  Font.register({
    family: FONT_DISPLAY,
    fonts: [
      { src: `${fontBase}/Fraunces-Regular.ttf`, fontWeight: 400 },
      { src: `${fontBase}/Fraunces-SemiBold.ttf`, fontWeight: 600 },
      { src: `${fontBase}/Fraunces-Italic.ttf`, fontWeight: 400, fontStyle: 'italic' },
    ],
  });
  Font.register({
    family: FONT_BODY,
    fonts: [
      { src: `${fontBase}/HankenGrotesk-Report-Regular.ttf`, fontWeight: 400 },
      { src: `${fontBase}/HankenGrotesk-Report-Medium.ttf`, fontWeight: 500 },
      { src: `${fontBase}/HankenGrotesk-Report-SemiBold.ttf`, fontWeight: 600 },
    ],
  });
  Font.register({
    family: FONT_MONO,
    fonts: [
      { src: `${fontBase}/SplineSansMono-Regular.ttf`, fontWeight: 400 },
      { src: `${fontBase}/SplineSansMono-SemiBold.ttf`, fontWeight: 600 },
    ],
  });
  Font.register({
    family: FONT_DEVANAGARI,
    fonts: [
      { src: devanagariRegular, fontWeight: 400 },
      { src: devanagariRegular, fontWeight: 400, fontStyle: 'italic' },
      { src: devanagariSemiBold, fontWeight: 500 },
      { src: devanagariSemiBold, fontWeight: 600 },
    ],
  });

  // Never hyphenate — Sanskrit/Devanagari words and proper nouns must stay whole.
  Font.registerHyphenationCallback((word) => [word]);
}

/* ── Palette ───────────────────────────────────────────────────────────────
 * The cream/ink print palette, kept in sync with chartTheme.ts PAPER_THEME so
 * the report and the kundli SVGs share one visual language.
 */
export const palette = {
  paper: '#FBF7EE', // warm cream page
  paperDeep: '#F3ECDC', // recessed panels / birth box
  card: '#FFFFFF', // crisp white inset
  ink: '#111827', // near-black body ink
  inkSoft: '#1F2937', // headings
  muted: '#4B5563', // captions / labels
  faint: '#8A8576', // hairline meta
  brass: '#B8860B', // the single accent (dark goldenrod)
  brassDeep: '#8A6508', // pressed/edge brass
  rule: '#D9CFB8', // warm hairline rules on cream
  ruleStrong: '#C2B492', // stronger divider
} as const;

/* ── Spacing scale (points) ──────────────────────────────────────────────── */
export const space = {
  xs: 4,
  sm: 8,
  md: 14,
  lg: 22,
  xl: 34,
  xxl: 52,
} as const;

/* ── Type scale (points) ─────────────────────────────────────────────────── */
export const type = {
  micro: 7.5,
  caption: 9,
  small: 10,
  body: 11,
  lead: 13,
  h3: 15,
  h2: 20,
  h1: 30,
  display: 46,
} as const;

/**
 * The shared StyleSheet. A4 page, generous margins, the three-voice type system,
 * and the reusable primitives (kicker, rule, eyebrow, panel) the sections compose.
 */
export const styles = StyleSheet.create({
  page: {
    backgroundColor: palette.paper,
    color: palette.ink,
    fontFamily: FONT_BODY,
    fontSize: type.body,
    lineHeight: 1.55,
    paddingTop: 54,
    paddingBottom: 56,
    paddingHorizontal: 56,
  },

  /* Running footer pinned to the bottom of every page. */
  pageFooterNote: {
    position: 'absolute',
    bottom: 28,
    left: 56,
    fontFamily: FONT_MONO,
    fontSize: type.micro,
    letterSpacing: 0.6,
    color: palette.faint,
    textTransform: 'uppercase',
  },
  pageFooterCounter: {
    position: 'absolute',
    bottom: 28,
    right: 56,
    width: 80,
    height: 12,
    fontFamily: FONT_MONO,
    fontSize: type.micro,
    lineHeight: 0,
    letterSpacing: 0.6,
    color: palette.faint,
    textAlign: 'right',
  },
  pageFooterRule: {
    position: 'absolute',
    bottom: 44,
    left: 56,
    right: 56,
    borderTopWidth: 0.5,
    borderTopColor: palette.rule,
  },

  /* ── Cover ───────────────────────────────────────────────── */
  cover: {
    flex: 1,
    justifyContent: 'space-between',
  },
  coverTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  wordmark: {
    fontFamily: FONT_DISPLAY,
    fontWeight: 600,
    fontSize: type.h3,
    letterSpacing: 1.5,
    color: palette.inkSoft,
  },
  coverKicker: {
    fontFamily: FONT_MONO,
    fontSize: type.micro,
    letterSpacing: 2,
    textTransform: 'uppercase',
    color: palette.brassDeep,
    textAlign: 'right',
  },
  coverCenter: {
    marginTop: space.xxl,
  },
  coverEyebrow: {
    fontFamily: FONT_MONO,
    fontSize: type.caption,
    letterSpacing: 3,
    textTransform: 'uppercase',
    color: palette.brass,
    marginBottom: space.md,
  },
  coverName: {
    fontFamily: FONT_DISPLAY,
    fontWeight: 400,
    fontSize: type.display,
    lineHeight: 1.04,
    color: palette.inkSoft,
    marginBottom: space.lg,
  },
  coverSubtitle: {
    fontFamily: FONT_DISPLAY,
    fontStyle: 'italic',
    fontSize: type.lead,
    color: palette.muted,
    maxWidth: 360,
  },

  /* A quiet honesty caption under the title: this chart used a rectified time. */
  coverRectifiedNote: {
    marginTop: space.md,
    fontFamily: FONT_DISPLAY,
    fontStyle: 'italic',
    fontSize: type.small,
    color: palette.muted,
    lineHeight: 1.5,
    maxWidth: 360,
    textAlign: 'center',
  },

  /* The decorative star ornament rule under the title. */
  ornamentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: space.lg,
    marginBottom: space.lg,
  },
  ornamentLine: {
    height: 0.75,
    backgroundColor: palette.ruleStrong,
    flexGrow: 1,
  },
  // A rotated-square diamond (vector, font-independent) — the brass node motif.
  ornamentDiamondOuter: {
    width: 9,
    height: 9,
    marginHorizontal: space.md,
    transform: 'rotate(45deg)',
    backgroundColor: palette.brass,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ornamentDiamondInner: {
    width: 3,
    height: 3,
    backgroundColor: palette.paper,
  },

  badge: {
    alignSelf: 'flex-start',
    fontFamily: FONT_MONO,
    fontSize: type.micro,
    letterSpacing: 1.6,
    textTransform: 'uppercase',
    color: palette.paper,
    backgroundColor: palette.brassDeep,
    paddingVertical: 3,
    paddingHorizontal: 9,
    borderRadius: 2,
  },

  coverFooter: {
    marginTop: space.xl,
  },
  coverGenerated: {
    fontFamily: FONT_MONO,
    fontSize: type.caption,
    letterSpacing: 0.4,
    color: palette.muted,
  },

  /* ── Section heading (shared) ────────────────────────────── */
  sectionHead: {
    marginBottom: space.lg,
  },
  sectionEyebrow: {
    fontFamily: FONT_MONO,
    fontSize: type.micro,
    letterSpacing: 2.5,
    textTransform: 'uppercase',
    color: palette.brass,
    marginBottom: space.xs,
  },
  sectionTitle: {
    fontFamily: FONT_DISPLAY,
    fontWeight: 600,
    fontSize: type.h2,
    color: palette.inkSoft,
  },
  sectionRule: {
    marginTop: space.sm,
    borderTopWidth: 1.25,
    borderTopColor: palette.brass,
    width: 44,
  },
  sectionIntro: {
    marginTop: space.md,
    fontSize: type.body,
    color: palette.muted,
    maxWidth: 420,
    lineHeight: 1.6,
  },

  /* ── Birth-detail data list ──────────────────────────────── */
  detailPanel: {
    marginTop: space.lg,
    backgroundColor: palette.card,
    borderWidth: 0.5,
    borderColor: palette.rule,
    borderRadius: 4,
    paddingVertical: space.lg,
    paddingHorizontal: space.lg,
  },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    paddingVertical: space.sm,
    borderBottomWidth: 0.5,
    borderBottomColor: palette.rule,
  },
  detailRowLast: {
    flexDirection: 'row',
    alignItems: 'baseline',
    paddingVertical: space.sm,
  },
  detailLabel: {
    width: 132,
    fontFamily: FONT_MONO,
    fontSize: type.caption,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    color: palette.muted,
  },
  detailValue: {
    flex: 1,
    fontSize: type.lead,
    color: palette.ink,
  },
  detailValueMono: {
    flex: 1,
    fontFamily: FONT_MONO,
    fontSize: type.body,
    color: palette.ink,
  },
  detailNote: {
    marginTop: space.xs,
    fontFamily: FONT_DISPLAY,
    fontStyle: 'italic',
    fontSize: type.small,
    color: palette.muted,
    lineHeight: 1.5,
  },

  /* Two-up technical readout row beneath the birth panel. */
  techRow: {
    flexDirection: 'row',
    marginTop: space.lg,
  },
  techCell: {
    flex: 1,
    paddingRight: space.lg,
  },
  techLabel: {
    fontFamily: FONT_MONO,
    fontSize: type.micro,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    color: palette.faint,
    marginBottom: 2,
  },
  techValue: {
    fontFamily: FONT_MONO,
    fontSize: type.body,
    color: palette.inkSoft,
  },

  /* Long-form prose blocks. */
  prose: {
    fontSize: type.body,
    color: palette.ink,
    lineHeight: 1.7,
    marginBottom: space.md,
  },

  /* ── Cover refinements (vertical balance) ─────────────────── */
  // A faint observatory motif that fills the cover's upper void without noise.
  coverMotifWrap: {
    marginTop: space.xxl,
    marginBottom: space.lg,
    alignItems: 'center',
  },
  coverMeta: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    borderTopWidth: 0.5,
    borderTopColor: palette.rule,
    paddingTop: space.md,
  },
  coverMetaCell: {
    flexDirection: 'column',
  },
  coverMetaLabel: {
    fontFamily: FONT_MONO,
    fontSize: type.micro,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    color: palette.faint,
    marginBottom: 2,
  },
  coverMetaValue: {
    fontFamily: FONT_MONO,
    fontSize: type.caption,
    color: palette.inkSoft,
  },

  /* ── Planetary-positions table ────────────────────────────── */
  table: {
    marginTop: space.md,
    borderWidth: 0.5,
    borderColor: palette.rule,
    borderRadius: 4,
    overflow: 'hidden',
  },
  tableHead: {
    flexDirection: 'row',
    backgroundColor: palette.paperDeep,
    borderBottomWidth: 1,
    borderBottomColor: palette.ruleStrong,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
  },
  tableHeadCell: {
    fontFamily: FONT_MONO,
    fontSize: type.micro,
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: palette.muted,
  },
  tableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 7,
    paddingHorizontal: space.md,
    borderBottomWidth: 0.5,
    borderBottomColor: palette.rule,
  },
  tableRowAlt: {
    backgroundColor: '#FDFBF5',
  },
  tableRowLast: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 7,
    paddingHorizontal: space.md,
  },
  tableRowLagna: {
    backgroundColor: palette.paperDeep,
    borderTopWidth: 1,
    borderTopColor: palette.ruleStrong,
  },
  // Column widths (sum reflects the inner measure). Glyph chip + name share col 1.
  // The seventh column, State, is what makes combustion a WORD rather than an
  // opacity; the other six were trimmed to make room for it without letting any
  // cell overflow into its neighbour (see `__tests__/pdfPoppler.ts`'s
  // `horizontalWordOverlapViolations`, which fails on exactly that).
  colPlanet: { width: 84, flexDirection: 'row', alignItems: 'center' },
  colSign: { width: 60 },
  colDegree: { width: 56 },
  colNakshatra: { flex: 1 },
  colHouse: { width: 26, textAlign: 'center' },
  colDignity: { width: 60 },
  colState: { width: 74 },
  // Planet glyph chip.
  glyphChip: {
    width: 19,
    height: 15,
    borderRadius: 2,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: space.sm,
  },
  glyphChipText: {
    fontFamily: FONT_MONO,
    fontSize: type.micro,
    fontWeight: 600,
    color: palette.paper,
  },
  cellName: {
    fontSize: type.small,
    color: palette.ink,
  },
  cellSign: {
    fontSize: type.small,
    color: palette.inkSoft,
  },
  cellMono: {
    fontFamily: FONT_MONO,
    fontSize: type.caption,
    color: palette.ink,
  },
  cellMonoCenter: {
    fontFamily: FONT_MONO,
    fontSize: type.caption,
    color: palette.ink,
    textAlign: 'center',
  },
  cellNak: {
    fontSize: type.caption,
    color: palette.muted,
  },
  cellDignity: {
    fontFamily: FONT_MONO,
    fontSize: type.micro,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    color: palette.brassDeep,
  },
  cellRetro: {
    fontFamily: FONT_MONO,
    fontSize: type.micro,
    color: palette.brass,
  },
  /** The State cell — retro / combust, in words, one per line. */
  cellState: {
    fontSize: type.caption,
    color: palette.inkSoft,
  },
  /**
   * The combustion statements under the table: the measured separation AND the
   * classical orb, full width so the arithmetic never wraps mid-figure.
   */
  combustionNote: {
    marginTop: space.sm,
    fontFamily: FONT_MONO,
    fontSize: type.micro,
    color: palette.muted,
    lineHeight: 1.5,
  },
  /**
   * Combust rows dim. This is a REDUNDANT cue on top of the State column — never
   * the carrier. Opacity does not survive text extraction, a screen reader,
   * greyscale printing, or a photocopy.
   */
  rowDim: { opacity: 0.55 },

  /* ── Kundli plates ────────────────────────────────────────── */
  chartsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: space.md,
  },
  chartPlate: {
    width: 232,
  },
  chartCaption: {
    fontFamily: FONT_MONO,
    fontSize: type.micro,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    color: palette.muted,
    marginBottom: space.sm,
    textAlign: 'center',
  },
  chartFrame: {
    borderWidth: 0.5,
    borderColor: palette.ruleStrong,
    borderRadius: 4,
    padding: space.md,
    backgroundColor: palette.card,
    alignItems: 'center',
  },
  chartLegend: {
    marginTop: space.lg,
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: space.lg,
    marginBottom: space.xs,
  },
  legendSwatchText: {
    fontFamily: FONT_MONO,
    fontSize: type.micro,
    fontWeight: 600,
    marginRight: 4,
  },
  legendName: {
    fontSize: type.caption,
    color: palette.muted,
  },

  /* ── Dasha timeline ───────────────────────────────────────── */
  dashaCurrent: {
    marginTop: space.md,
    backgroundColor: palette.paperDeep,
    borderLeftWidth: 2.5,
    borderLeftColor: palette.brass,
    borderRadius: 3,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
  },
  dashaCurrentLabel: {
    fontFamily: FONT_MONO,
    fontSize: type.micro,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    color: palette.brassDeep,
    marginBottom: 3,
  },
  dashaCurrentValue: {
    fontFamily: FONT_DISPLAY,
    fontWeight: 600,
    fontSize: type.h3,
    color: palette.inkSoft,
  },
  subLabel: {
    fontFamily: FONT_MONO,
    fontSize: type.micro,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    color: palette.faint,
    marginTop: space.md,
    marginBottom: space.xs,
  },
  dashaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 3.5,
    borderBottomWidth: 0.5,
    borderBottomColor: palette.rule,
  },
  dashaTick: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    marginRight: space.md,
    borderWidth: 1,
    borderColor: palette.ruleStrong,
    backgroundColor: palette.card,
  },
  dashaTickCurrent: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    marginRight: space.md,
    backgroundColor: palette.brass,
  },
  dashaLord: {
    width: 92,
    fontSize: type.small,
    color: palette.ink,
  },
  dashaLordCurrent: {
    width: 92,
    fontSize: type.small,
    fontFamily: FONT_BODY,
    fontWeight: 600,
    color: palette.brassDeep,
  },
  dashaSpan: {
    flex: 1,
    fontFamily: FONT_MONO,
    fontSize: type.caption,
    color: palette.muted,
  },
  dashaYears: {
    width: 56,
    fontFamily: FONT_MONO,
    fontSize: type.caption,
    color: palette.faint,
    textAlign: 'right',
  },
  /**
   * The running period's marker, IN WORDS. The brass tick and the heavier lord
   * beside it are redundant cues: a `<View>` dot contributes zero characters, so
   * without this the nine mahā rows extract as nine identical lines. The cell is
   * always present (empty when not running) so the columns stay aligned.
   */
  dashaCurrentMark: {
    width: 64,
    fontFamily: FONT_MONO,
    // Deliberately the same size as the span / years cells beside it: a smaller
    // face sits on its own baseline band, and text extraction then reads the
    // marker as a separate line from the row it belongs to.
    fontSize: type.caption,
    textTransform: 'uppercase',
    color: palette.brassDeep,
    textAlign: 'right',
  },

  /* ── Yogas ────────────────────────────────────────────────── */
  yogaCard: {
    marginBottom: space.sm,
    borderWidth: 0.5,
    borderColor: palette.rule,
    borderRadius: 4,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    backgroundColor: palette.card,
  },
  yogaHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginBottom: 3,
  },
  yogaName: {
    fontFamily: FONT_DISPLAY,
    fontWeight: 600,
    fontSize: type.lead,
    color: palette.inkSoft,
  },
  yogaChip: {
    fontFamily: FONT_MONO,
    fontSize: type.micro,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    color: palette.brassDeep,
  },
  /* Calibrated structural strength headline (NN% · band · structural estimate). */
  yogaPct: {
    marginBottom: 3,
    fontFamily: FONT_MONO,
    fontSize: type.micro,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: palette.brassDeep,
  },
  /* The signed factor ledger, auditable to the %. */
  yogaLedger: {
    marginBottom: 3,
    fontFamily: FONT_MONO,
    fontSize: type.micro,
    letterSpacing: 0.4,
    color: palette.faint,
  },
  /* Birth-time stability flag — the paper twin of the screen's StabilityChip. */
  yogaStability: {
    marginBottom: 3,
    fontFamily: FONT_MONO,
    fontSize: type.micro,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: palette.faint,
  },
  yogaDesc: {
    fontSize: type.small,
    color: palette.ink,
    lineHeight: 1.55,
  },
  yogaSignature: {
    marginTop: space.xs,
    fontFamily: FONT_MONO,
    fontSize: type.micro,
    letterSpacing: 0.6,
    color: palette.faint,
    textTransform: 'uppercase',
  },

  /* ── Interpretation narrative ─────────────────────────────── */
  narrativeSummary: {
    marginTop: space.md,
    marginBottom: space.lg,
    paddingLeft: space.lg,
    borderLeftWidth: 2,
    borderLeftColor: palette.brass,
  },
  narrativeSummaryText: {
    fontFamily: FONT_DISPLAY,
    fontStyle: 'italic',
    fontSize: type.lead,
    lineHeight: 1.6,
    color: palette.inkSoft,
  },
  narrativeBlock: {
    marginBottom: space.lg,
  },
  narrativeHeading: {
    fontFamily: FONT_DISPLAY,
    fontWeight: 600,
    fontSize: type.h3,
    color: palette.inkSoft,
    marginBottom: space.sm,
  },
  narrativePara: {
    fontSize: type.body,
    color: palette.ink,
    lineHeight: 1.7,
    marginBottom: space.sm,
  },

  /* ── Evidence & Confidence ────────────────────────────────────
   * Cells are STACKED (label above value, full measure) rather than columnar:
   * a side-by-side label/value pair reads back out of pdftotext interleaved
   * once the value wraps, which would make the printed section unverifiable.
   */
  evidenceMethod: {
    marginTop: space.sm,
    marginBottom: space.lg,
    paddingLeft: space.md,
    borderLeftWidth: 2,
    borderLeftColor: palette.brass,
  },
  evidenceSubheading: {
    fontFamily: FONT_DISPLAY,
    fontWeight: 600,
    fontSize: type.h3,
    color: palette.inkSoft,
    marginBottom: space.sm,
  },
  evidenceStep: {
    fontFamily: FONT_MONO,
    fontSize: type.micro,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    color: palette.brassDeep,
    marginTop: space.md,
    marginBottom: space.xs,
  },
  evidenceCeiling: {
    marginBottom: space.xs,
  },
  evidenceCeilingLabel: {
    fontFamily: FONT_MONO,
    fontSize: type.caption,
    color: palette.inkSoft,
  },
  evidenceNote: {
    marginTop: space.xs,
    fontFamily: FONT_DISPLAY,
    fontStyle: 'italic',
    fontSize: type.small,
    color: palette.muted,
    lineHeight: 1.5,
  },
  evidenceFormula: {
    marginTop: space.sm,
    fontFamily: FONT_MONO,
    fontSize: type.caption,
    color: palette.brassDeep,
  },
  evidenceAlternate: {
    marginBottom: space.lg,
    backgroundColor: palette.paperDeep,
    borderRadius: 4,
    paddingVertical: space.md,
    paddingHorizontal: space.md,
  },
  evidenceRow: {
    marginBottom: space.sm,
    borderWidth: 0.5,
    borderColor: palette.rule,
    borderRadius: 4,
    backgroundColor: palette.card,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
  },
  evidenceCell: {
    marginBottom: space.xs,
  },
  evidenceCellLabel: {
    fontFamily: FONT_MONO,
    fontSize: type.micro,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    color: palette.faint,
  },
  evidenceCellValue: {
    fontSize: type.small,
    color: palette.ink,
    lineHeight: 1.55,
  },
  evidenceFactor: {
    fontFamily: FONT_MONO,
    fontSize: type.micro,
    color: palette.inkSoft,
    lineHeight: 1.55,
  },
  /* Deliberately unlike a ledger row: no white card, a brass-tinted frame. */
  evidenceGuidance: {
    marginBottom: space.md,
    backgroundColor: palette.paperDeep,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: palette.brass,
    borderRadius: 4,
    paddingVertical: space.md,
    paddingHorizontal: space.md,
  },
  evidenceGuidanceHeading: {
    fontFamily: FONT_DISPLAY,
    fontWeight: 600,
    fontSize: type.h3,
    color: palette.brassDeep,
    marginBottom: space.xs,
  },
  evidenceGuidanceText: {
    marginTop: space.sm,
    fontSize: type.small,
    color: palette.ink,
    lineHeight: 1.6,
  },
  evidenceRejected: {
    marginTop: space.md,
    fontFamily: FONT_MONO,
    fontSize: type.micro,
    color: palette.muted,
    lineHeight: 1.55,
  },
});

/**
 * Per-document Devanagari typography context so English and Hindi PDFs can
 * render sequentially or concurrently without mutating global font bindings.
 */
export const DevanagariContext = createContext(false);

/** Derive a StyleSheet mirror whose explicit `fontFamily` rules use Noto Sans Devanagari. */
export function createDevanagariStyles<T extends Parameters<typeof StyleSheet.create>[0]>(
  sheet: T,
): T {
  const mapped = Object.fromEntries(
    Object.entries(sheet).map(([key, rule]) => [
      key,
      'fontFamily' in rule ? { ...rule, fontFamily: FONT_DEVANAGARI } : rule,
    ]),
  ) as T;
  return StyleSheet.create(mapped) as T;
}

const devanagariStyles = createDevanagariStyles(styles);

/** Read DevanagariContext safely (falls back to false in non-reconciler test walkers). */
export function useDevanagari(): boolean {
  try {
    return useContext(DevanagariContext);
  } catch {
    return false;
  }
}

/** Select between a Latin StyleSheet and its pre-derived Devanagari mirror. */
export function useFontSheet<T>(latin: T, devanagariSheet: T, devanagari?: boolean): T {
  const fromContext = useDevanagari();
  return (devanagari ?? fromContext) ? devanagariSheet : latin;
}

/** Return the standard Latin styles or the Noto Sans Devanagari style variant. */
export function useReportStyles(devanagari?: boolean): typeof styles {
  return useFontSheet(styles, devanagariStyles, devanagari);
}
