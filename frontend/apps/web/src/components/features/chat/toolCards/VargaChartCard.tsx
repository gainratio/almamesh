/**
 * Generative Shodasavarga divisional chart card (`D1`–`D60`) for `read_varga`.
 *
 * Reshapes `lagna_sign`, `lagna_sign_lord`, and `placements` into
 * `buildVargaGeometry` (`@almamesh/store`) and renders the authentic
 * `<NorthIndianChartSVG size={220} />` or `<SouthIndianChartSVG size={220} />`
 * respecting `useChartStore((s) => s.displayStyle)`.
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useInRouterContext } from 'react-router-dom';
import { buildVargaGeometry, useChartStore, useProfilesStore, type VargaChart, type VargaPlanet } from '@almamesh/store';

import { titleCaseToken } from '../../../../lib/predictive';
import { NorthIndianChartSVG } from '../../../chart/NorthIndianChartSVG';
import { SouthIndianChartSVG } from '../../../chart/SouthIndianChartSVG';

interface ShashtiamsaInfo {
  readonly number: number;
  readonly name: string;
  readonly nature: 'saumya' | 'krura';
}

interface VargaPlacementRow {
  readonly graha: string;
  readonly sign: string;
  readonly sign_lord: string;
  readonly house?: number;
  readonly dignity?: string;
  readonly is_combust?: boolean;
  readonly vargottama?: boolean;
  readonly shashtiamsa?: ShashtiamsaInfo | null;
}

interface VargaPayload {
  readonly chart: string;
  readonly lagna_sign: string;
  readonly lagna_sign_lord: string;
  readonly lagna_vargottama?: boolean;
  readonly lagna_shashtiamsa?: ShashtiamsaInfo | null;
  readonly sensitivity?: {
    readonly approx_minutes_to_cusp: number;
    readonly high_time_sensitivity: boolean;
  } | null;
  readonly rectify_available?: boolean;
  readonly placements: Readonly<Record<string, VargaPlacementRow>>;
}

const VARGA_LABELS: Readonly<Record<string, string>> = {
  D1: 'Rāśi', D2: 'Horā', D3: 'Drekkāṇa', D4: 'Chaturthāṁśa', D7: 'Saptāṁśa',
  D9: 'Navāṁśa', D10: 'Daśāṁśa', D12: 'Dvādaśāṁśa', D16: 'Ṣoḍaśāṁśa', D20: 'Viṁśāṁśa',
  D24: 'Chaturviṁśāṁśa', D27: 'Saptaviṁśāṁśa', D30: 'Triṁśāṁśa', D40: 'Khavedāṁśa',
  D45: 'Akṣavedāṁśa', D60: 'Ṣaṣṭyāṁśa',
};

function isVargaPayload(value: unknown): value is VargaPayload {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return typeof r.chart === 'string' && typeof r.lagna_sign === 'string' && Boolean(r.placements && typeof r.placements === 'object');
}

function toStoreVargaChart(payload: VargaPayload): VargaChart {
  const planets: Record<string, VargaPlanet> = {};
  for (const [key, row] of Object.entries(payload.placements)) {
    if (!row?.sign) continue;
    planets[key] = {
      name: row.graha || key,
      sign: titleCaseToken(row.sign),
      sign_lord: row.sign_lord ?? '',
      is_combust: Boolean(row.is_combust),
    };
  }
  return {
    name: payload.chart,
    lagna_sign: titleCaseToken(payload.lagna_sign),
    lagna_sign_lord: payload.lagna_sign_lord ?? '',
    planets,
  };
}

export function VargaChartCard({ result }: { readonly result: unknown }) {
  const { t } = useTranslation('chat');
  const displayStyle = useChartStore((s) => s.displayStyle);
  const activeProfileId = useProfilesStore((s) => s.activeProfileId);
  const inRouter = useInRouterContext();

  const valid = isVargaPayload(result) ? result : null;
  const geometry = useMemo(() => {
    if (!valid) return null;
    try {
      return buildVargaGeometry(toStoreVargaChart(valid));
    } catch {
      return null;
    }
  }, [valid]);

  if (!valid) return null;

  const vargaTitle = VARGA_LABELS[valid.chart] ?? valid.chart;
  const rows = Object.values(valid.placements);
  const showRectifyCta = Boolean(valid.sensitivity?.high_time_sensitivity || valid.rectify_available);
  const rectifyHref = activeProfileId ? `/rectify/${activeProfileId}` : '/rectify';

  return (
    <section
      aria-label={`${valid.chart} ${vargaTitle}`}
      data-testid="tool-card-varga-chart"
      data-varga={valid.chart}
      className="mb-2 overflow-hidden rounded-xl border border-ui-border bg-background-secondary p-3 text-xs"
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <span className="rounded-md border border-accent-gold/40 bg-accent-gold/10 px-2 py-0.5 font-mono font-semibold text-accent-gold">
            {valid.chart}
          </span>
          <span className="font-semibold text-text-primary">{vargaTitle}</span>
          <span className="text-text-secondary">
            · {t('cards.varga.lagna', { sign: titleCaseToken(valid.lagna_sign) })}
          </span>
        </div>
        {valid.lagna_vargottama && (
          <span className="rounded-full border border-accent-gold/50 bg-accent-gold/10 px-2 py-0.5 text-[10px] font-medium text-accent-gold">
            ★ {t('cards.varga.vargottama')}
          </span>
        )}
      </div>

      <div className="flex flex-col gap-3">
        {geometry && (
          <div className="mx-auto shrink-0" data-testid="varga-card-kundli">
            {displayStyle === 'north' ? (
              <NorthIndianChartSVG geometry={geometry} size={210} />
            ) : (
              <SouthIndianChartSVG geometry={geometry} size={210} centerCode={valid.chart} centerTitle={vargaTitle} />
            )}
          </div>
        )}

        <div className="min-w-0 space-y-1.5">
          {valid.lagna_shashtiamsa && (
            <p className="rounded-lg bg-background-primary px-2.5 py-1.5 text-[11px] text-text-secondary" data-testid="varga-lagna-amsa">
              Lagna Amsa #{valid.lagna_shashtiamsa.number}: <span className="font-medium text-text-primary">{valid.lagna_shashtiamsa.name}</span> ({valid.lagna_shashtiamsa.nature})
            </p>
          )}
          <div className="flex flex-wrap gap-1.5">
            {rows.map((row) => (
              <span
                key={row.graha}
                className="inline-flex max-w-full flex-wrap items-center gap-1 rounded-lg border border-ui-border/80 bg-background-primary px-2 py-1 text-[11px] text-text-secondary"
              >
                <span className="font-medium text-text-primary">{titleCaseToken(row.graha)}</span>
                <span>{titleCaseToken(row.sign)}</span>
                {typeof row.house === 'number' && <span className="text-text-muted">H{row.house}</span>}
                {row.vargottama && <span className="text-accent-gold" title={t('cards.varga.vargottama')}>★</span>}
                {row.dignity && row.dignity !== 'neutral' && (
                  <span className="rounded bg-background-tertiary px-1 text-[10px] text-text-muted">{row.dignity}</span>
                )}
                {row.shashtiamsa && (
                  <span className="rounded bg-accent-purple/10 px-1 text-[10px] text-accent-purple">
                    {row.shashtiamsa.name} ({row.shashtiamsa.nature})
                  </span>
                )}
              </span>
            ))}
          </div>
        </div>
      </div>

      {valid.sensitivity && (
        <div
          data-testid="varga-sensitivity-footer"
          className="mt-2.5 flex flex-wrap items-center justify-between gap-2 border-t border-ui-border/60 pt-2 text-[11px] text-text-muted"
        >
          <span>
            <span aria-hidden="true">⏱ </span>
            {t('cards.varga.cusp_minutes', { minutes: Math.round(valid.sensitivity.approx_minutes_to_cusp * 10) / 10 })}
          </span>
          {showRectifyCta && (
            inRouter ? (
              <Link to={rectifyHref} data-testid="varga-rectify-link" className="font-medium text-accent-gold underline hover:no-underline">
                {t('cards.varga.rectify_cta')}
              </Link>
            ) : (
              <a href={rectifyHref} data-testid="varga-rectify-link" className="font-medium text-accent-gold underline hover:no-underline">
                {t('cards.varga.rectify_cta')}
              </a>
            )
          )}
        </div>
      )}
    </section>
  );
}
