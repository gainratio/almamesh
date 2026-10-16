/**
 * report-pdf/types — the PURE, pre-reshaped data contract for the PDF document.
 *
 * The @react-pdf document NEVER touches the engine, the store, or astrology. It
 * renders an already-formatted, presentation-ready object. `ReportView` builds
 * this object from the engine output via the existing `lib/reportData.ts`
 * formatters; the Node render harness supplies literal fixture strings. Same
 * contract, two producers — calculation integrity preserved (the engine is the
 * single source of truth; this layer only renders).
 *
 * Every field is a finished display string (already in the BIRTH timezone, already
 * locale-formatted) — the document does no recomputation. The kundli charts ride
 * along as the renderer-agnostic `ChartGeometry` the on-screen SVGs already use
 * (house/sign placement, planet glyphs) — pure geometry, never recomputed here.
 */

import type { ChartGeometry } from '@almamesh/store';

/** The pair of kundli charts (D1 Rāśi + optional D9 Navāṁśa), as geometry. */
export interface ReportPdfCharts {
  /** The natal D1 chart geometry (degree-precision). */
  readonly rasi: ChartGeometry;
  /** Caption for the D1 plate, e.g. "Rāśi · D1". */
  readonly rasiCaption: string;
  /** The D9 navamsa geometry (sign-precision); null when the engine omits it. */
  readonly navamsa: ChartGeometry | null;
  /** Caption for the D9 plate, e.g. "Navāṁśa · D9". */
  readonly navamsaCaption: string;
}

/** A single label/value readout in the birth-details data list. */
export interface ReportPdfDetail {
  readonly label: string;
  /** Pre-formatted value. Mono-styled when `mono` is true (degrees / coords). */
  readonly value: string;
  readonly mono?: boolean;
}

/** A technical engine readout (ayanamsa, house system, …). */
export interface ReportPdfTechnical {
  readonly label: string;
  readonly value: string;
}

/** One row of the planetary-positions table — all values pre-formatted. */
export interface ReportPdfPlanetRow {
  /** Display name, e.g. "Sun", "Ascendant". */
  readonly name: string;
  /** Two-letter abbreviation glyph, e.g. "Su" (empty for the Lagna row). */
  readonly glyph: string;
  /** Sign name, e.g. "Pisces". */
  readonly sign: string;
  /** Within-sign degree readout, e.g. "15°41′" (already glyph-safe). */
  readonly degree: string;
  /** Nakshatra + pada, e.g. "Uttara Bhadrapada · 4". */
  readonly nakshatra: string;
  /** Whole-sign house number as a string, e.g. "1" ("—" for the Lagna row). */
  readonly house: string;
  /** Dignity label, title-cased ("Exalted" / "Debilitated" / "" when neutral). */
  readonly dignity: string;
  /** True → an ASCII "(R)" retrograde mark is shown next to the degree. */
  readonly isRetrograde: boolean;
  /** True → the row is dimmed (combust planet) — a REDUNDANT cue, never the carrier. */
  readonly isCombust: boolean;
  /**
   * The combustion STATE, stated in words — e.g. "Combust 2.76°" — or "" when the
   * graha is not combust. This exists because opacity is not a fact: a dimmed row
   * survives neither text extraction, nor a screen reader, nor a photocopy, and
   * for a long while it was the only thing the exported table said about a
   * combust planet. The measured separation rides along because "combust" alone
   * is a verdict, while "combust at 2.76°" is arithmetic a reader can check.
   */
  readonly combustion: string;
  /** Hex accent for the glyph chip (paper-legible planet ink). */
  readonly color: string;
}

/** One Vimshottari dasha period — pre-formatted dates + duration. */
export interface ReportPdfDashaPeriod {
  /** Title-cased ruling graha, e.g. "Saturn". */
  readonly lord: string;
  /** Pre-formatted start date, e.g. "Jan 2017" (epoch-safe). */
  readonly start: string;
  /** Pre-formatted end date, e.g. "Jan 2036" (epoch-safe). */
  readonly end: string;
  /** Span label, e.g. "19 yrs". */
  readonly span: string;
  /**
   * True → this period is the one currently running. The brass tick and the
   * heavier lord are REDUNDANT cues; the row also prints
   * `ReportPdfLabels.dashaCurrentMarker` in words, because a `<View>` dot
   * contributes zero characters and nine rows then extract identically.
   */
  readonly isCurrent: boolean;
}

/** One dasha drill-down table: a (localized) heading + its periods. */
export interface ReportPdfPeriodTable {
  readonly heading: string;
  readonly periods: ReadonlyArray<ReportPdfDashaPeriod>;
}

/** One antar-daśā table, optionally carrying the running antar's deeper table. */
export interface ReportPdfAntarTable extends ReportPdfPeriodTable {
  readonly pratyantarTable?: ReportPdfPeriodTable;
}

/** The dasha timeline slice: the maha sequence + the current focus line. */
export interface ReportPdfDasha {
  /** The nine maha-dasha periods, in order. */
  readonly mahaSequence: ReadonlyArray<ReportPdfDashaPeriod>;
  /** The current Maha · Antar · Pratyantar focus, pre-formatted (may be empty). */
  readonly currentFocus: string;
  /**
   * The antar-daśā drill-down of EVERY mahā (in mahā order) — the definitive
   * reference tables. Empty on older payloads without period depth.
   */
  readonly antarTables: ReadonlyArray<ReportPdfAntarTable>;
}

/** One whole-sign house row — all values pre-formatted. */
export interface ReportPdfHouseRow {
  /** House number as a string, "1"–"12". */
  readonly house: string;
  /** Sign name, e.g. "Aries". */
  readonly sign: string;
  /** Title-cased sign lord, e.g. "Mars". */
  readonly signLord: string;
  /** Occupying grahas, comma-joined ("Sun, Ketu"), or "—" when empty. */
  readonly occupants: string;
}

/** One yoga — name, classification, and description, all pre-formatted. */
export interface ReportPdfYoga {
  /** Display name, e.g. "Malavya Yoga". */
  readonly name: string;
  /** Category + grade chip text, e.g. "Mahapurusha · Strong". */
  readonly classification: string;
  /** The descriptive sentence(s) for this yoga. */
  readonly description: string;
  /** Planets involved, pre-formatted, e.g. "Venus". */
  readonly signature: string;
  /** Grade, used to tint the chip ("strong" | "moderate" | "weak"). */
  readonly grade: string;
  /**
   * Calibrated structural-strength headline, e.g. "91% · Strong · structural
   * estimate". Empty string for bundles stored before the calibrated-strength
   * upgrade (renderer omits the line).
   */
  readonly strength: string;
  /**
   * Signed factor ledger, e.g. "Jupiter exalted +1 · Moon kendra +1 · net +3 of
   * max +5". Empty when strength is absent or the yoga has no non-neutral marks.
   */
  readonly strengthLedger: string;
  /**
   * The birth-time stability flag for THIS yoga, pre-localized — the same words
   * the on-screen `StabilityChip` prints ("birth-time stable" / "birth-time
   * sensitive"). OPTIONAL: absent when no stability markers were supplied
   * (older payloads), and the card then renders exactly as it did before.
   */
  readonly stability?: string;
}

/**
 * The five LLM-narrative section titles, ALREADY LOCALIZED by the caller (they
 * are the same `report:interpretation.*` strings the on-screen report uses).
 * The PDF layer holds no i18n — inject these or accept the English defaults.
 */
export interface ReportPdfNarrativeTitles {
  /** `report:interpretation.current_sky` — "What's Active Now & Next". */
  readonly currentSky: string;
  /** `report:interpretation.strengths`. */
  readonly strengths: string;
  /** `report:interpretation.challenges`. */
  readonly challenges: string;
  /** `report:interpretation.life_themes`. */
  readonly lifeThemes: string;
  /** `report:interpretation.road_ahead`. */
  readonly roadAhead: string;
}

/** One interpretation block — an optional heading + ordered prose paragraphs. */
export interface ReportPdfNarrativeSection {
  /** Section heading, e.g. "Strengths" (empty → no heading, e.g. the summary). */
  readonly title: string;
  /** Ordered paragraphs of prose (already plain text, markdown stripped). */
  readonly paragraphs: ReadonlyArray<string>;
}

/* ── Comprehensive (predictive + rectification) section slices ─────────────
 * Every field below is a FINISHED display string, pre-localized by the
 * builders (which reuse the exact same i18n helpers as the on-screen report,
 * so PDF and web copy never drift). The PDF components render them verbatim.
 */

/** The eyebrow / title / intro chrome every comprehensive section opens with. */
export interface ReportPdfSectionChrome {
  readonly eyebrow: string;
  readonly title: string;
  readonly intro?: string;
}

/** A short label → value readout line (panel row). */
export interface ReportPdfLabeledValue {
  readonly label: string;
  readonly value: string;
}

/** One generic table row; `emphasis` brass-tints it (totals / running rows). */
export interface ReportPdfTableRow {
  readonly cells: ReadonlyArray<string>;
  readonly emphasis?: boolean;
}

/** A generic pre-formatted table (headers repeat when it breaks across pages). */
export interface ReportPdfTable {
  readonly headers: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<ReportPdfTableRow>;
  /** Optional per-column flex weights (defaults to equal columns). */
  readonly widths?: ReadonlyArray<number>;
}

/** Section VIII — Transits & Timing (engine TransitCtx, pre-formatted). */
export interface ReportPdfTransits {
  readonly chrome: ReportPdfSectionChrome;
  /** "Sidereal sky positions for …" line. */
  readonly asOf: string;
  readonly gochara: ReportPdfTable;
  readonly sadeSatiHeading: string;
  readonly sadeSati: ReadonlyArray<ReportPdfLabeledValue>;
  readonly slowHitsHeading: string;
  readonly slowHits: ReportPdfTable;
  /** Shown instead of the table when the engine emitted no slow hits. */
  readonly slowHitsEmpty: string;
  readonly fusionHeading: string;
  readonly fusion: ReadonlyArray<ReportPdfLabeledValue>;
  readonly timelineHeading: string;
  readonly timeline: ReportPdfTable;
  readonly timelineEmpty: string;
}

/** One framed divisional-chart plate (sign-precision geometry, no degrees). */
export interface ReportPdfVargaPlate {
  readonly id: string;
  /** Localized caption, e.g. "D9 · Navāṁśa". */
  readonly caption: string;
  readonly geometry: ChartGeometry;
}

/** Section IX — all sixteen divisional charts + the classical tallies. */
export interface ReportPdfVargas {
  readonly chrome: ReportPdfSectionChrome;
  readonly note: string;
  /** Up to 16 plates, canonical D1→D60 order (only emitted charts). */
  readonly plates: ReadonlyArray<ReportPdfVargaPlate>;
  readonly vargottamaHeading: string;
  /** Pre-joined vargottama line, or the localized empty-state text. */
  readonly vargottamaLine: string;
  readonly vimshopakaHeading: string;
  readonly vimshopaka: ReportPdfTable;
  /** The ≈-approximation footnote, present only when any score carries it. */
  readonly approxNote?: string;
}

/** Section X — Ashtakavarga (SAV + BAV) and six-component Shadbala. */
export interface ReportPdfStrength {
  readonly chrome: ReportPdfSectionChrome;
  /** SAV heading including the canonical total, pre-formatted. */
  readonly savHeading: string;
  /** The 12 per-sign SAV bindu cells, in zodiac order. */
  readonly savCells: ReadonlyArray<ReportPdfLabeledValue>;
  readonly bavHeading: string;
  /** Sign × graha bindu matrix, closed by an emphasised totals row. */
  readonly bav: ReportPdfTable;
  readonly shadbalaHeading: string;
  /** Graha · six components (virūpas) · rūpa totals · verdict. */
  readonly shadbala: ReportPdfTable;
  readonly componentsNote: string;
  readonly approxNote?: string;
  readonly sunriseNote: string;
}

/** One life-domain forecast block, fully pre-formatted. */
export interface ReportPdfAssayPanel {
  readonly heading: string;
  readonly method: string;
  readonly components: ReadonlyArray<ReportPdfLabeledValue>;
}

export interface ReportPdfAvowPanel {
  readonly heading: string;
  readonly status: string;
  readonly scope: string;
}

export interface ReportPdfDomainBlock {
  readonly name: string;
  readonly band: string; // calibrated headline "{pct} · {band word}" (rigor spec §A.1)
  readonly strengthAxes: string; // two-axis ledger "Śaḍbala {pct} · Aṣṭakavarga {pct} — model estimate"
  readonly strengthLine: string;
  readonly assay: ReportPdfAssayPanel;
  readonly avow: ReportPdfAvowPanel;
  readonly emphasisLine: string;
  readonly windowsLabel: string;
  readonly windows: ReadonlyArray<string>;
  readonly windowsEmpty: string;
  /**
   * The birth-time stability flag for THIS domain, pre-localized — identical
   * wording to the on-screen `StabilityChip`. OPTIONAL: absent when no markers
   * were supplied, and the block then renders exactly as it did before.
   */
  readonly stability?: string;
}

/** Section XI — the eight deterministic life-domain forecasts. */
export interface ReportPdfDomains {
  readonly chrome: ReportPdfSectionChrome;
  readonly blocks: ReadonlyArray<ReportPdfDomainBlock>;
}

/**
 * Section XII — Birth Time Authority. The facts carry the entered/working
 * clocks + signs, mode, band, confirm date, and (when the evidence gate is met)
 * the aggregate calibrated event-fit confidence percentage. Raw margins, fit
 * scores, and per-event numeric contributions remain intentionally hidden.
 */
export interface ReportPdfRectification {
  readonly chrome: ReportPdfSectionChrome;
  readonly facts: ReadonlyArray<ReportPdfLabeledValue>;
  readonly eventsHeading: string;
  readonly events: ReportPdfTable;
  /** Shown instead of the table when no supporting events resolved. */
  readonly eventsEmpty: string;
  readonly caveat: string;
  /**
   * Phase 2 (Spec 062, v2 records with a resultSnapshot): the full evidence
   * story — candidate comparison, per-event evidence with depth/polarity
   * labels, quiet-period misses, and the prior note. All optional so v1
   * records keep rendering the classic section unchanged. Per-event evidence
   * remains qualitative/polarity-only; only the aggregate gated confidence is
   * formatted as a percentage in the facts above.
   */
  readonly candidatesHeading?: string;
  readonly candidates?: ReportPdfTable;
  readonly evidenceHeading?: string;
  readonly evidence?: ReportPdfTable;
  readonly missesHeading?: string;
  readonly missNotes?: ReadonlyArray<string>;
  readonly priorNote?: string;
}

/**
 * One row of the evidence ledger — the five cells, all pre-formatted.
 *
 * `evidence` is a LIST because each cited factor prints on its own line as
 * `<id> · <measured values> · <how it was computed>`; collapsing them into one
 * sentence is exactly how a citation stops being checkable.
 */
export interface ReportPdfEvidenceRow {
  /** The primary factor's stable id — the row's identity in both renderers. */
  readonly observationId: string;
  /** What was computed, stated as a sentence. Never a judgement about it. */
  readonly observation: string;
  /** Every cited factor, with its measured values and its class. */
  readonly evidence: ReadonlyArray<string>;
  /** The model's prose, or the localized "no written interpretation" line. */
  readonly interpretation: string;
  /** The level AND its derivation (ceiling, the factor that set it, deductions). */
  readonly confidence: string;
  /** A real counterfactual, a robustness measurement, or an honest "none". */
  readonly alternative: string;
}

/** The five cell labels, in render order. */
export interface ReportPdfEvidenceCellLabels {
  readonly observation: string;
  readonly evidence: string;
  readonly interpretation: string;
  readonly confidence: string;
  readonly alternative: string;
}

/**
 * Section VIII — Evidence & Confidence: the audit of every section above it.
 *
 * The preamble states the METHOD (ceiling table, deduction rules with their real
 * numeric thresholds, the formula) so a reader can re-derive every level in the
 * rows rather than take it on authority — see `lib/evidence/confidence.ts`.
 *
 * `guidance` is a list of PLAIN STRINGS, never rows, and that is load-bearing:
 * statements the model itself declared ungrounded must render with no evidence,
 * no confidence and no alternative beside them. Making them structurally
 * incapable of carrying those cells is stronger than remembering not to.
 */
export interface ReportPdfEvidence {
  readonly chrome: ReportPdfSectionChrome;
  readonly methodHeading: string;
  readonly ceilingHeading: string;
  /** arithmetic → High, rule → Moderate, model → Low, each with its reason. */
  readonly ceilings: ReadonlyArray<ReportPdfLabeledValue>;
  readonly ceilingNote: string;
  readonly deductionHeading: string;
  /** Each deduction rule with its threshold interpolated from the constants. */
  readonly deductionRules: ReadonlyArray<string>;
  readonly formula: string;
  /* The second chart — present ONLY when this ascendant sits near a cusp. */
  readonly alternateHeading?: string;
  readonly alternateLead?: string;
  readonly alternateShifts?: ReadonlyArray<string>;
  /** States plainly that the equivalent in MINUTES of birth time is not computed. */
  readonly alternateMinutesNote?: string;
  readonly cellLabels: ReportPdfEvidenceCellLabels;
  readonly rows: ReadonlyArray<ReportPdfEvidenceRow>;
  /* General guidance — present only when the model declared some. */
  readonly guidanceHeading?: string;
  readonly guidanceNote?: string;
  readonly guidance?: ReadonlyArray<string>;
  /** Provenance: how many model statements were dropped, and what they cited. */
  readonly rejectedNote?: string;
}

/**
 * Section XIV — Assumptions & Provenance. The four load-bearing choices every
 * verdict rests on (ayanāṁśa, house system, birth time, ascendant cusp), each a
 * finished label→value string. Assembled from existing provenance; invents nothing.
 */
export interface ReportPdfAssumptions {
  readonly chrome: ReportPdfSectionChrome;
  readonly rows: ReadonlyArray<ReportPdfLabeledValue>;
}

/** The cover + birth-details slice (the foundation; more sections follow). */
export interface ReportPdfData {
  /** Document title / person name. */
  readonly personName: string;
  /** Audience voice label, already localized ("For You" / "For the Astrologer"). */
  readonly audienceLabel: string;
  /** A short, elegant subtitle line under the name (already localized). */
  readonly subtitle: string;
  /** Brand kicker on the cover (already localized). */
  readonly kicker: string;
  /**
   * The cover's generation date, locale-formatted. Derived from the chart's own
   * calculation instant — NEVER the wall clock, or the same chart would export
   * to different bytes on every download. Omitted when the chart carries no
   * usable instant: an absent date is honest, an invented one is not.
   */
  readonly generatedOn?: string;
  /**
   * The instant stamped into the PDF's `/CreationDate`. pdfkit derives the
   * trailer `/ID` from the info dictionary (an MD5 over it), so pinning this
   * pins both. Same source as `generatedOn`; the epoch stands for "unknown".
   */
  readonly creationDate: Date;

  /** The birth-details list (date, time, place, ascendant — all pre-formatted). */
  readonly birthDetails: ReadonlyArray<ReportPdfDetail>;
  /**
   * An optional honesty note rendered under the ascendant (e.g. the near-cusp
   * caveat). Already localized; omitted when not applicable.
   */
  readonly ascendantNote?: string;
  /**
   * An optional note on the cover stating that this chart was computed from a
   * *rectified* birth time — names the entered → rectified clocks + signed
   * minutes. Already localized; omitted when no rectification is in effect.
   */
  readonly rectifiedNote?: string;
  /** Technical engine readouts (ayanamsa, house system). */
  readonly technical: ReadonlyArray<ReportPdfTechnical>;

  /** The planetary-positions table (9 grahas + the Lagna row). */
  readonly planets: ReadonlyArray<ReportPdfPlanetRow>;
  /**
   * One finished sentence per combust graha, printed under the planetary table —
   * e.g. "Venus — combust 2.76° from the Sun (orb 10°)". The table cell states
   * the fact; this states the whole arithmetic, including the classical orb the
   * engine tested against (which the engine does not itself emit — see
   * `lib/evidence/combustionOrbs.ts`, a mirror guarded against drift). Empty
   * when no graha is combust.
   */
  readonly combustionNotes: ReadonlyArray<string>;
  /** The 12 whole-sign house rows (sign, lord, occupants). */
  readonly houses: ReadonlyArray<ReportPdfHouseRow>;
  /** The two kundli charts (D1 + optional D9), as geometry. */
  readonly charts: ReportPdfCharts;
  /** The Vimshottari dasha timeline. */
  readonly dasha: ReportPdfDasha;
  /** The engine's yogas. */
  readonly yogas: ReadonlyArray<ReportPdfYoga>;
  /**
   * The LLM's woven yoga story (`integrated_yoga_narrative`), resolved to the
   * reader's voice and split into paragraphs. OPTIONAL — absent on a natal-only
   * report, and the yoga section then prints the engine's cards alone.
   */
  readonly yogaNarrative?: ReadonlyArray<string>;
  /**
   * The structured interpretation, as ordered narrative blocks. OPTIONAL: when
   * the LLM interpretation has not been generated yet, the report degrades to
   * its deterministic natal halves and this is `undefined`. The Interpretation
   * SECTION still prints — carrying `labels.narrativeAbsentNote`, an honest
   * one-paragraph explanation — so a reader is never left wondering what is
   * missing (never a blank page, never a fabricated narrative).
   */
  readonly narrative?: ReadonlyArray<ReportPdfNarrativeSection>;
  /**
   * Section VIII — Evidence & Confidence. Deterministic: it needs only the
   * engine chart, so it is present whenever the caller built it, with or
   * without a model reading. OPTIONAL only so that callers predating it (and
   * the narrower fixtures) keep type-checking.
   */
  readonly evidence?: ReportPdfEvidence;

  /* Comprehensive sections — present only when the on-device predictive
     contexts were computed (transits/vargas/strength/domains) or a confirmed
     rectification record exists. The document omits absent sections entirely
     (never a blank page): the PDF mirrors exactly what the web report shows. */
  readonly transits?: ReportPdfTransits;
  readonly vargas?: ReportPdfVargas;
  readonly strength?: ReportPdfStrength;
  readonly domains?: ReportPdfDomains;
  readonly rectification?: ReportPdfRectification;
  /** Section XIII — assumptions & provenance (assembled; present when supplied). */
  readonly assumptions?: ReportPdfAssumptions;

  /** Localized static labels the document needs (keeps i18n out of the PDF layer). */
  readonly labels: ReportPdfLabels;
}

/** Localized chrome strings the document renders verbatim. */
export interface ReportPdfLabels {
  readonly preparedFor: string;
  readonly birthDetailsTitle: string;
  readonly birthDetailsEyebrow: string;
  readonly birthDetailsIntro: string;
  readonly technicalNote: string;
  readonly footerNote: string;

  /** Planetary-positions section. */
  readonly planetsEyebrow: string;
  readonly planetsTitle: string;
  readonly planetsIntro: string;
  /** Column headers for the planet table. */
  readonly colPlanet: string;
  readonly colSign: string;
  readonly colDegree: string;
  readonly colNakshatra: string;
  readonly colHouse: string;
  readonly colDignity: string;
  /** Header of the State column ("State") — the retro / combust readout. */
  readonly colState: string;
  /** The retrograde state word, e.g. "Retro (R)" (`report:planets.retrograde`). */
  readonly stateRetrograde: string;
  readonly lagnaRowName: string;

  /** Houses section. */
  readonly housesEyebrow: string;
  readonly housesTitle: string;
  readonly housesIntro: string;
  readonly colHouseNumber: string;
  readonly colHouseSign: string;
  readonly colHouseLord: string;
  readonly colOccupants: string;
  readonly housesNote: string;

  /** Kundli charts section. */
  readonly chartsEyebrow: string;
  readonly chartsTitle: string;
  readonly chartsIntro: string;

  /** Dasha section. */
  readonly dashaEyebrow: string;
  readonly dashaTitle: string;
  readonly dashaIntro: string;
  readonly dashaCurrentLabel: string;
  readonly dashaSequenceLabel: string;
  /**
   * The word printed on the running period's row, e.g. "Current". Load-bearing:
   * the brass tick beside it is a `<View>` and contributes no characters, so
   * without this all nine mahā rows extract as identical text.
   */
  readonly dashaCurrentMarker: string;

  /** Yogas section. */
  readonly yogasEyebrow: string;
  readonly yogasTitle: string;
  readonly yogasIntro: string;

  /** Interpretation section. */
  readonly narrativeEyebrow: string;
  readonly narrativeTitle: string;
  readonly narrativeIntro: string;
  /**
   * Printed INSTEAD of the reading when no AI interpretation was generated:
   * one short, honest paragraph saying the written interpretation appears once
   * a reading is generated (optional, bring-your-own-key) and that the rest of
   * the report is complete. OPTIONAL for callers that have not wired it yet —
   * the section then falls back to an English default rather than going blank.
   */
  readonly narrativeAbsentNote?: string;
}
