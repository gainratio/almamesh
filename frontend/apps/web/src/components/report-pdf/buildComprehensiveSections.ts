/**
 * buildComprehensiveSections — pure reshapers from the on-device PREDICTIVE
 * contexts (TransitCtx / VargaCtxFull / StrengthCtx / DomainsCtx) into the
 * pre-formatted comprehensive slices of `ReportPdfData`.
 *
 * Like the other builders this RESHAPES and formats ONLY — no astrology is
 * recomputed. Unlike the natal builders, these sections carry per-row dynamic
 * copy (graha/sign names, severities, timeline sentences), so the caller
 * injects the SAME i18next `t` functions the on-screen report uses
 * (`report` + `predictive` namespaces) and the builders reuse the exact
 * `lib/predictiveEventCopy` helpers — PDF and web copy can never drift.
 * Every emitted string passes through `glyphSafe` for the print fonts.
 */

import type { TFunction } from 'i18next';
import type {
  BhinnashtakavargaData,
  DivisionalChartId,
  DomainsCtx,
  LifeDomainForecastData,
  PlanetShadbalaData,
  StrengthCtx,
  TransitCtx,
  TransitPlacementData,
  VargaCtxFull,
  ZodiacSign,
} from '@almamesh/shared-types';
import { buildVargaGeometry } from '@almamesh/store';
import type { StrengthProvenance } from '../../lib/strengthProvenance';
import { formatDegree } from '../../lib/reportData';
import { formatPct, formatPredictiveDate, formatReferenceDay, formatRupas, toVargaChart } from '../../lib/predictive';
import {
  domainWindowLabel,
  grahaName,
  sadeSatiPhaseName,
  signName,
  slowHitTargetLabel,
  timelineEventLabel,
} from '../../lib/predictiveEventCopy';
import { DOMAIN_ORDER } from '../features/predictive/DomainsPanel';
import { hasApproximatedComponents } from '../features/predictive/StrengthPanel';
import { domainClaimId } from '../../lib/stability';
import { paperTint, type StabilityFlagFor } from './buildReportSections';
import { glyphSafe } from './glyphSafe';
import type {
  ReportPdfDomains,
  ReportPdfDomainBlock,
  ReportPdfLabeledValue,
  ReportPdfSectionChrome,
  ReportPdfStrength,
  ReportPdfTable,
  ReportPdfTableRow,
  ReportPdfTransits,
  ReportPdfVargaPlate,
  ReportPdfVargas,
} from './types';

/** The i18next translators the comprehensive builders localize with. */
export interface ReportPdfTranslators {
  /** Bound to the `report` namespace. */
  readonly tr: TFunction;
  /** Bound to the `predictive` namespace. */
  readonly tp: TFunction;
}

const GRAHA_ORDER = [
  'sun', 'moon', 'mars', 'mercury', 'jupiter', 'venus', 'saturn', 'rahu', 'ketu',
] as const;

/** The seven classical grahas of Parashari Ashtakavarga/Shadbala, in order. */
const CLASSICAL_GRAHAS: readonly string[] = [
  'sun', 'moon', 'mars', 'mercury', 'jupiter', 'venus', 'saturn',
];

const SIGN_ORDER: readonly ZodiacSign[] = [
  'aries', 'taurus', 'gemini', 'cancer', 'leo', 'virgo',
  'libra', 'scorpio', 'sagittarius', 'capricorn', 'aquarius', 'pisces',
];

/** All sixteen Shodaśavarga plates, in canonical order (drawn when emitted). */
const PLATE_VARGAS: readonly DivisionalChartId[] = [
  'D1', 'D2', 'D3', 'D4', 'D7', 'D9', 'D10', 'D12',
  'D16', 'D20', 'D24', 'D27', 'D30', 'D40', 'D45', 'D60',
];

/** Emitted rows of a per-planet map, in canonical classical-graha order. */
function orderedByGraha<T>(byPlanet: Partial<Record<string, T | undefined>>): readonly T[] {
  return CLASSICAL_GRAHAS.map((name) => byPlanet[name]).filter(
    (row): row is T => row !== undefined,
  );
}

function chrome(tr: TFunction, key: string, titleKey: string): ReportPdfSectionChrome {
  return {
    eyebrow: glyphSafe(tr(`pdf.${key}_eyebrow`)),
    title: glyphSafe(tr(titleKey)),
    intro: glyphSafe(tr(`pdf.${key}_intro`)),
  };
}

function row(cells: readonly string[], emphasis?: boolean): ReportPdfTableRow {
  return { cells: cells.map((cell) => glyphSafe(cell)), ...(emphasis ? { emphasis } : {}) };
}

/* ── Section VIII: Transits & Timing ─────────────────────────────────────── */

/** Reshape the engine TransitCtx into the pre-formatted transits slice. */
export function buildTransitsSection(
  ctx: TransitCtx,
  { tr, tp }: ReportPdfTranslators,
): ReportPdfTransits {
  const placements = GRAHA_ORDER.map((g) => ctx.gochara.placements[g]).filter(
    (p): p is TransitPlacementData => p !== undefined,
  );
  const gochara: ReportPdfTable = {
    headers: [
      tp('gochara.col_graha'),
      tp('gochara.col_sign'),
      tp('gochara.col_degree'),
      tp('gochara.col_house_moon'),
      tp('gochara.col_house_lagna'),
      tp('gochara.col_motion'),
    ].map((h) => glyphSafe(h)),
    rows: placements.map((p) =>
      row([
        grahaName(tp, p.graha),
        signName(tp, p.sign),
        formatDegree(p.sign_degrees),
        String(p.house_from_moon),
        String(p.house_from_lagna),
        p.is_retrograde ? tp('gochara.retrograde') : tp('gochara.direct'),
      ]),
    ),
    widths: [1.2, 1.2, 1, 0.8, 0.8, 1],
  };

  const sadeSati: ReportPdfLabeledValue[] = [
    {
      label: glyphSafe(tp('sade_sati.heading')),
      value: glyphSafe(ctx.sade_sati.is_active ? tp('sade_sati.active') : tp('sade_sati.inactive')),
    },
    {
      label: glyphSafe(
        tp('sade_sati.natal_moon', { sign: signName(tp, ctx.sade_sati.natal_moon_sign) }),
      ),
      value: glyphSafe(
        ctx.sade_sati.is_active && ctx.sade_sati.current_phase !== 'none'
          ? tp('sade_sati.phase_label', {
              phase: sadeSatiPhaseName(tp, ctx.sade_sati.current_phase),
            })
          : tp('sade_sati.phase.none'),
      ),
    },
    ...ctx.sade_sati.cycle.map((segment) => ({
      label: glyphSafe(
        `${tp('sade_sati.phase_label', { phase: sadeSatiPhaseName(tp, segment.phase) })} · ${tp(
          'sade_sati.saturn_in',
          { sign: signName(tp, segment.saturn_sign) },
        )}`,
      ),
      value: glyphSafe(
        tp('sade_sati.window', {
          start: formatPredictiveDate(segment.start),
          end: formatPredictiveDate(segment.end),
        }),
      ),
    })),
  ];

  const slowHits: ReportPdfTable = {
    headers: [tr('transits.col_date'), tr('transits.col_event'), tr('transits.col_tone')].map(
      (h) => glyphSafe(h),
    ),
    rows: ctx.slow_hits.map((hit) =>
      row([
        formatPredictiveDate(hit.exact),
        `${grahaName(tp, hit.graha)} → ${slowHitTargetLabel(tp, hit.natal_point)}`,
        tp(`severity.${hit.severity}`),
      ]),
    ),
    widths: [1, 2.4, 1],
  };

  const list = (names: readonly string[]): string =>
    names.length > 0 ? names.map((n) => grahaName(tp, n)).join(', ') : tp('fusion.none');
  const fusion: ReportPdfLabeledValue[] = [
    {
      label: glyphSafe(tp('fusion.maha_lord')),
      value: glyphSafe(
        `${grahaName(tp, ctx.fusion.maha_lord)} — ${tp('fusion.house_from_moon', {
          house: ctx.fusion.maha_lord_transit_house_from_moon,
        })}`,
      ),
    },
    {
      label: glyphSafe(tp('fusion.antar_lord')),
      value: glyphSafe(ctx.fusion.antar_lord ? grahaName(tp, ctx.fusion.antar_lord) : tp('fusion.none')),
    },
    { label: glyphSafe(tp('fusion.reinforcing')), value: glyphSafe(list(ctx.fusion.reinforcing)) },
    { label: glyphSafe(tp('fusion.afflicting')), value: glyphSafe(list(ctx.fusion.afflicting)) },
  ];

  const timeline: ReportPdfTable = {
    headers: [tr('transits.col_date'), tr('transits.col_event'), tr('transits.col_tone')].map(
      (h) => glyphSafe(h),
    ),
    rows: ctx.timeline.events.map((event) =>
      row([
        formatPredictiveDate(event.date),
        timelineEventLabel(tp, event),
        tp(`severity.${event.severity}`),
      ]),
    ),
    widths: [1, 2.4, 1],
  };

  return {
    chrome: chrome(tr, 'transits', 'transits.heading'),
    asOf: glyphSafe(tr('transits.as_of', { date: formatReferenceDay(ctx.gochara.instant) })),
    gochara,
    sadeSatiHeading: glyphSafe(tr('transits.sade_sati_heading')),
    sadeSati,
    slowHitsHeading: glyphSafe(tr('transits.slow_hits_heading')),
    slowHits,
    slowHitsEmpty: glyphSafe(tp('slow_hits.empty')),
    fusionHeading: glyphSafe(tr('transits.fusion_heading')),
    fusion,
    timelineHeading: glyphSafe(tr('transits.timeline_heading')),
    timeline,
    timelineEmpty: glyphSafe(tp('timeline.empty')),
  };
}

/* ── Section IX: Divisional Charts (all sixteen) ─────────────────────────── */

/** Reshape the engine VargaCtxFull into plates + tallies (sign-precision). */
export function buildVargasSection(
  ctx: VargaCtxFull,
  { tr, tp }: ReportPdfTranslators,
): ReportPdfVargas {
  const plates: ReportPdfVargaPlate[] = [];
  for (const id of PLATE_VARGAS) {
    const chart = ctx.charts[id];
    if (chart) {
      plates.push({
        id,
        caption: glyphSafe(`${id} · ${tp(`vargas.names.${id}`)}`),
        geometry: paperTint(buildVargaGeometry(toVargaChart(chart))),
      });
    }
  }

  const vargottamaLine =
    ctx.vargottama.length === 0
      ? tp('vargas.vargottama_empty')
      : ctx.vargottama
          .map((flag) =>
            tp('vargas.vargottama_point', {
              point: flag.point === 'lagna' ? tp('vargas.lagna') : grahaName(tp, flag.point),
              sign: signName(tp, flag.sign),
            }),
          )
          .join(' · ');

  const ownSignByGraha = new Map(ctx.shadvarga_own_sign.map((r) => [r.graha, r.own_sign_count]));
  const vimshopaka: ReportPdfTable = {
    headers: [
      tr('vargas_full.col_graha'),
      tr('vargas_full.col_score'),
      tr('vargas_full.col_own_charts'),
    ].map((h) => glyphSafe(h)),
    rows: ctx.vimshopaka.map((score) =>
      row([
        grahaName(tp, score.graha),
        `${score.score}${score.approximated ? ' ≈' : ''}`,
        ownSignByGraha.has(score.graha)
          ? tp('vargas.own_signs', { count: ownSignByGraha.get(score.graha) })
          : '—',
      ]),
    ),
    widths: [1, 1, 2],
  };

  const anyApprox = ctx.vimshopaka.some((score) => score.approximated);
  return {
    chrome: chrome(tr, 'vargas', 'vargas_full.heading'),
    note: glyphSafe(tr('vargas_full.all_charts_note')),
    plates,
    vargottamaHeading: glyphSafe(tr('vargas_full.vargottama_heading')),
    vargottamaLine: glyphSafe(vargottamaLine),
    vimshopakaHeading: glyphSafe(tr('vargas_full.vimshopaka_heading')),
    vimshopaka,
    ...(anyApprox ? { approxNote: glyphSafe(tp('vargas.approx_note')) } : {}),
  };
}

/* ── Section X: Planetary Strength ───────────────────────────────────────── */

/** Reshape the engine StrengthCtx into SAV cells + BAV matrix + Shadbala. */
export function buildStrengthSection(
  ctx: StrengthCtx,
  { tr, tp }: ReportPdfTranslators,
): ReportPdfStrength {
  const sarva = ctx.ashtakavarga.sarva;
  const savCells: ReportPdfLabeledValue[] = SIGN_ORDER.map((sign) => ({
    label: glyphSafe(signName(tp, sign)),
    value: String(sarva.bindus[sign]),
  }));

  const bavRows: readonly BhinnashtakavargaData[] = orderedByGraha(ctx.ashtakavarga.bhinna);
  const bav: ReportPdfTable = {
    headers: [tr('strength.col_sign'), ...bavRows.map((r) => grahaName(tp, r.planet))].map((h) =>
      glyphSafe(h),
    ),
    rows: [
      ...SIGN_ORDER.map((sign) =>
        row([signName(tp, sign), ...bavRows.map((r) => String(r.bindus[sign]))]),
      ),
      row([tr('strength.bav_total_row'), ...bavRows.map((r) => String(r.total))], true),
    ],
    widths: [1.6, ...bavRows.map(() => 1)],
  };

  const shadbalaRows: readonly PlanetShadbalaData[] = orderedByGraha(ctx.shadbala.planets);
  const anyApprox = shadbalaRows.some(hasApproximatedComponents);
  const shadbala: ReportPdfTable = {
    headers: [
      tr('strength.col_graha'),
      tr('strength.col_sthana'),
      tr('strength.col_dig'),
      tr('strength.col_kala'),
      tr('strength.col_cheshta'),
      tr('strength.col_naisargika'),
      tr('strength.col_drik'),
      tr('strength.col_rupas'),
      tr('strength.col_required'),
      tr('strength.col_verdict'),
    ].map((h) => glyphSafe(h)),
    rows: shadbalaRows.map((planet) =>
      row([
        `${grahaName(tp, planet.planet)}${hasApproximatedComponents(planet) ? ' ≈' : ''}`,
        formatRupas(planet.sthana.total_virupas),
        formatRupas(planet.dig.virupas),
        formatRupas(planet.kala.total_virupas),
        formatRupas(planet.cheshta.virupas),
        formatRupas(planet.naisargika.virupas),
        formatRupas(planet.drik.virupas),
        formatRupas(planet.total_rupas),
        formatRupas(planet.required_rupas),
        planet.meets_minimum ? tr('strength.meets') : tr('strength.below'),
      ]),
    ),
    widths: [1.6, 1.05, 0.8, 1.05, 1.05, 1.4, 0.85, 1, 1.25, 1.5],
  };

  return {
    chrome: chrome(tr, 'strength', 'strength.heading'),
    savHeading: glyphSafe(
      `${tr('strength.sav_heading')} — ${tr('strength.sav_total', { total: sarva.total })}`,
    ),
    savCells,
    bavHeading: glyphSafe(tr('strength.bav_heading')),
    bav,
    shadbalaHeading: glyphSafe(tr('strength.shadbala_heading')),
    shadbala,
    componentsNote: glyphSafe(tr('strength.components_note')),
    ...(anyApprox ? { approxNote: glyphSafe(tp('strength.approx_footnote')) } : {}),
    sunriseNote: glyphSafe(
      tp('strength.sunrise_basis', { date: formatPredictiveDate(ctx.sunrise_utc_iso) }),
    ),
  };
}

/* ── Section XI: Life-Domain Forecasts ───────────────────────────────────── */

/** The emphasis one-liner, mirroring the on-screen ReportDomains copy. */
function emphasisLine(forecast: LifeDomainForecastData, tp: TFunction): string {
  const emphasis = forecast.current_emphasis;
  const parts: string[] = [
    emphasis.active_dasha_significator
      ? tp('domains.active_dasha', { levels: emphasis.dasha_levels.join(' · ') })
      : tp('domains.no_active_dasha'),
  ];
  if (emphasis.matched_dasha_lords.length > 0) {
    parts.push(
      tp('domains.matched_lords', {
        lords: emphasis.matched_dasha_lords.map((lord) => grahaName(tp, lord)).join(', '),
      }),
    );
  }
  let line = `${parts.join(' ')} · ${tp('domains.transit_tone', {
    severity: tp(`severity.${emphasis.transit_severity}`),
  })}`;
  if (emphasis.under_sade_sati) {
    line += ` · ${tp('domains.under_sade_sati')}`;
  }
  if (emphasis.approximated) {
    line += ` (${tp('domains.approx_mark')})`;
  }
  return line;
}

/**
 * True when THIS domain's strength receipt was PRESENT but failed to verify
 * against the pinned signer — the only condition under which a domain's
 * numeric percentages are withheld. Absent `provenance` (no receipts, older
 * persisted payload) never withholds anything: `undefined` is not "failed".
 */
function isStrengthUnverified(domain: string, provenance: StrengthProvenance | undefined): boolean {
  return provenance !== undefined && provenance.failed.includes(domain);
}

/**
 * The band line for one domain. When its receipt failed verification the
 * numeric `strength_pct` is WITHHELD — never guessed, never re-derived —
 * leaving only the non-numeric band/tier label; happy path (no provenance, or
 * a verified domain) is byte-identical to before this existed.
 */
function domainBand(
  strength: LifeDomainForecastData['strength_summary'],
  unverified: boolean,
  tp: TFunction,
): string {
  const label = `${tp(`domains.band.${strength.band}`)}${strength.approximated ? ' ≈' : ''}`;
  return unverified ? label : `${formatPct(strength.strength_pct)} · ${label}`;
}

/**
 * The Śaḍbala/Aṣṭakavarga axes line. When unverified this becomes the honest
 * withheld-note instead of the two percentages — the report never fabricates
 * a substitute number and never re-labels a withheld figure as "verified".
 */
function domainStrengthAxes(
  strength: LifeDomainForecastData['strength_summary'],
  unverified: boolean,
  { tr, tp }: ReportPdfTranslators,
): string {
  if (unverified) {
    return tr('domains.strength_withheld_note');
  }
  return `${tp('domains.strength_axes', {
    shadbala: formatPct(strength.shadbala_pct),
    sav: formatPct(strength.sav_pct),
  })} · ${tp('domains.strength_tier_model')}`;
}

function exactPct(value: number): string {
  return `${value.toFixed(2)}%`;
}

function buildAssayPanel(
  forecast: LifeDomainForecastData,
  unverified: boolean,
  { tr, tp }: ReportPdfTranslators,
): ReportPdfDomainBlock['assay'] {
  if (unverified) {
    return {
      heading: glyphSafe(tp('domains.assay_heading')),
      method: glyphSafe(tr('domains.strength_withheld_note')),
      components: [],
    };
  }
  const assay = forecast.strength_assay;
  const shadbala = assay?.components.find((component) => component.id === 'shadbala_pct');
  const sav = assay?.components.find((component) => component.id === 'sav_pct');
  const selected = assay?.components.find(
    (component) => component.id === assay.selected_component_id,
  );
  if (!assay || !shadbala || !sav || !selected) {
    return {
      heading: glyphSafe(tp('domains.assay_heading')),
      method: glyphSafe(tp('domains.assay_unavailable')),
      components: [],
    };
  }
  return {
    heading: glyphSafe(tp('domains.assay_heading')),
    method: glyphSafe(tp('domains.assay_method')),
    components: [
      { label: glyphSafe(tp('domains.assay_shadbala')), value: exactPct(shadbala.raw) },
      { label: glyphSafe(tp('domains.assay_sav')), value: exactPct(sav.raw) },
      { label: glyphSafe(tp('domains.assay_result')), value: exactPct(selected.raw) },
    ],
  };
}

function avowStatus(
  domain: string,
  provenance: StrengthProvenance | undefined,
): 'verified' | 'failed' | 'unavailable' {
  if (provenance?.verified.has(domain)) return 'verified';
  if (provenance?.failed.includes(domain)) return 'failed';
  return 'unavailable';
}

function buildAvowPanel(
  domain: string,
  provenance: StrengthProvenance | undefined,
  tp: TFunction,
): ReportPdfDomainBlock['avow'] {
  const status = avowStatus(domain, provenance);
  return {
    heading: glyphSafe(tp('domains.avow_heading')),
    status: glyphSafe(tp(`domains.avow_status.${status}`)),
    scope: glyphSafe(tp('domains.avow_scope')),
  };
}

/**
 * Reshape the engine DomainsCtx into the seven pre-formatted domain blocks.
 *
 * `stabilityFlagFor` optionally supplies each domain's pre-localized birth-time
 * stability mark (the screen's `StabilityChip` wording). Omit it and every
 * block is byte-identical to before.
 */
export function buildDomainsSection(
  ctx: DomainsCtx,
  translators: ReportPdfTranslators,
  provenance?: StrengthProvenance,
  stabilityFlagFor?: StabilityFlagFor,
): ReportPdfDomains {
  const { tr, tp } = translators;
  const blocks = DOMAIN_ORDER.map((domain) => {
    const forecast = ctx.forecasts[domain];
    const strength = forecast.strength_summary;
    const unverified = isStrengthUnverified(domain, provenance);
    const stability = stabilityFlagFor?.(domainClaimId(domain));
    return {
      ...(stability ? { stability } : {}),
      name: glyphSafe(tp(`domains.names.${domain}`)),
      band: glyphSafe(domainBand(strength, unverified, tp)),
      strengthAxes: glyphSafe(domainStrengthAxes(strength, unverified, translators)),
      strengthLine: glyphSafe(
        tp('domains.strength_line', {
          graha: grahaName(tp, strength.key_graha),
          rupas: formatRupas(strength.key_graha_rupas),
          bindus: strength.sav_bindus,
        }),
      ),
      assay: buildAssayPanel(forecast, unverified, translators),
      avow: buildAvowPanel(domain, provenance, tp),
      emphasisLine: glyphSafe(emphasisLine(forecast, tp)),
      windowsLabel: glyphSafe(tr('domains.windows_heading')),
      windows: forecast.upcoming_windows.map((window) =>
        glyphSafe(
          `${formatPredictiveDate(window.date)} — ${domainWindowLabel(tp, window)} (${tp(
            `domains.source.${window.source}`,
          )}, ${tp(`severity.${window.severity}`)})`,
        ),
      ),
      windowsEmpty: glyphSafe(tr('domains.windows_empty')),
    };
  });

  return { chrome: chrome(tr, 'domains', 'domains.heading'), blocks };
}
