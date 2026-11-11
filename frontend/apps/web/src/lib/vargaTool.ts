/**
 * `read_varga` tool: inspects any Shodasavarga divisional chart (`D1`–`D60`)
 * via the deterministic Python engine (`computeVargaDetail`), falling back to
 * `chart.varga_context_full` / `chart.navamsa` when the Worker is unavailable.
 */
import type { VargaDetailPlacement, VargaDetailResult, VargaLagnaSensitivity } from '@almamesh/browser';
import type { DivisionalChartId, SiderealChart } from '@almamesh/browser/types';
import { defineTool, z, type ToolContext, type ToolDef } from '@almamesh/llm/toolLoop';
import { useProfilesStore, useRectificationRecordsStore } from '@almamesh/store';

import type { ChartEngineContextValue } from '../providers/chartEngineContext';
import { readyEngine } from './periodChart';
import { buildVargaDetailInput } from './vargaDetailClient';

export const READ_VARGA_TOOL_NAME = 'read_varga';
const READ_VARGA_TIMEOUT_MS = 30_000;

const VARGA_DIVISIONS = [
  'D1', 'D2', 'D3', 'D4', 'D7', 'D9', 'D10', 'D12',
  'D16', 'D20', 'D24', 'D27', 'D30', 'D40', 'D45', 'D60',
] as const;

const PLANET_NAMES = ['sun', 'moon', 'mars', 'mercury', 'jupiter', 'venus', 'saturn', 'rahu', 'ketu'] as const;
type PlanetKey = (typeof PLANET_NAMES)[number];

export interface ReadVargaArgs {
  readonly division: DivisionalChartId;
  readonly focus_planets: readonly PlanetKey[] | null;
}

interface ActiveDashaVargaPlacement {
  readonly level: 'maha' | 'antar' | 'pratyantar';
  readonly lord: string;
  readonly sign: string;
  readonly house: number | null;
  readonly dignity: string | null;
  readonly vargottama: boolean;
}

export interface ReadVargaResult {
  readonly chart: DivisionalChartId;
  readonly source: 'engine' | 'cached_varga_context';
  readonly lagna_sign: string;
  readonly lagna_sign_lord: string;
  readonly lagna_vargottama: boolean;
  readonly lagna_shashtiamsa: VargaDetailResult['lagna_shashtiamsa'];
  readonly sensitivity: VargaLagnaSensitivity | null;
  readonly birth_time_rectified: boolean;
  readonly rectification_band: string | null;
  readonly rectify_available: boolean;
  readonly placements: Readonly<Record<string, Partial<VargaDetailPlacement> & { readonly graha: string; readonly sign: string; readonly sign_lord: string }>>;
  readonly active_dasha_lords: readonly ActiveDashaVargaPlacement[];
  readonly vimshopaka?: Readonly<Record<string, number>>;
  readonly shadvarga_own_sign?: Readonly<Record<string, number>>;
  readonly highlights: readonly string[];
}

export interface VargaToolInput {
  readonly chart: SiderealChart;
  readonly engine: ChartEngineContextValue | null;
  readonly profileId: string | undefined;
}

const ARGS_SCHEMA: z.ZodType<ReadVargaArgs> = z.object({
  division: z.preprocess(
    (v) => (typeof v === 'string' ? v.trim().toUpperCase() : v),
    z.enum(VARGA_DIVISIONS),
  ).describe('Divisional chart ID: D1 (Rasi), D2 (Hora), D3 (Drekkana), D4, D7 (Saptamsa), D9 (Navamsa), D10 (Dasamsa), D12, D16, D20, D24, D27, D30, D40, D45, or D60 (Shashtiamsa).'),
  focus_planets: z.array(z.enum(PLANET_NAMES)).nullable().describe('Optional subset of grahas to focus on, or null for all 9 grahas.'),
}).strict();

const DESCRIPTION = 'Inspect a Vedic divisional chart (Shodasavarga D1–D60, including D9 Navamsa, D10 Dasamsa, and D60 Shashtiamsa) computed deterministically on-device. Returns Varga Lagna, sign lord, planetary signs/houses/dignities, Vargottama status, D60 Shashtiamsa amsa names & natures (saumya/krura), active Dasha lords in that Varga, Vimshopaka scores, and exact birth-time cusp sensitivity.';

function rectificationStatus(profileId: string | undefined): { rectified: boolean; band: string | null } {
  const profiles = useProfilesStore.getState();
  const id = profileId && profiles.profiles[profileId] ? profileId : profiles.activeProfileId;
  const record = id ? useRectificationRecordsStore.getState().getRecord(id) : null;
  return record ? { rectified: true, band: record.band } : { rectified: false, band: null };
}

function activeDashaPlacements(chart: SiderealChart, placements: ReadVargaResult['placements']): ActiveDashaVargaPlacement[] {
  const d = chart.dashas;
  const levels = [['maha', d?.current_maha?.lord], ['antar', d?.current_antar?.lord], ['pratyantar', d?.current_pratyantar?.lord]] as const;
  return levels.flatMap(([level, rawLord]) => {
    const lord = rawLord?.toLowerCase();
    const row = lord ? placements[lord] : undefined;
    return lord && row ? [{ level, lord, sign: row.sign, house: row.house ?? null, dignity: row.dignity ?? null, vargottama: Boolean(row.vargottama) }] : [];
  });
}

function filterPlacements<T extends { readonly graha: string }>(all: Readonly<Record<string, T>>, focus: readonly PlanetKey[] | null): Readonly<Record<string, T>> {
  if (!focus?.length) return all;
  const keep = new Set<string>(focus);
  return Object.fromEntries(Object.entries(all).filter(([k, v]) => keep.has(k) || keep.has(v.graha)));
}

function fallbackFromChart(chart: SiderealChart, division: DivisionalChartId, focus: readonly PlanetKey[] | null, rect: { rectified: boolean; band: string | null }): ReadVargaResult {
  const full = chart.varga_context_full?.charts?.[division];
  const vargottamaSet = new Set((chart.varga_context_full?.vargottama ?? []).map((v) => v.point.toLowerCase()));
  const raw = full?.placements ?? (division === 'D9' && chart.navamsa ? Object.fromEntries(
    Object.entries(chart.navamsa.planets).map(([k, p]) => [k, { graha: k, sign: p.sign, sign_lord: p.sign_lord }]),
  ) : {});
  const placements = filterPlacements(
    Object.fromEntries(Object.entries(raw).map(([k, p]) => [
      k.toLowerCase(),
      { graha: k.toLowerCase(), sign: p.sign, sign_lord: p.sign_lord, vargottama: division === 'D9' && vargottamaSet.has(k.toLowerCase()) },
    ])),
    focus,
  );
  const lagnaSign = full?.lagna_sign ?? (division === 'D9' ? chart.navamsa?.lagna_sign : undefined) ?? chart.lagna?.sign ?? 'unknown';
  const lagnaLord = full?.lagna_sign_lord ?? (division === 'D9' ? chart.navamsa?.lagna_sign_lord : undefined) ?? chart.lagna?.sign_lord ?? 'unknown';
  return {
    chart: division, source: 'cached_varga_context', lagna_sign: lagnaSign, lagna_sign_lord: lagnaLord,
    lagna_vargottama: division === 'D9' && vargottamaSet.has('lagna'), lagna_shashtiamsa: null, sensitivity: null,
    birth_time_rectified: rect.rectified, rectification_band: rect.band, rectify_available: !rect.rectified,
    placements, active_dasha_lords: activeDashaPlacements(chart, placements), highlights: [`${division} Lagna ${lagnaSign}`],
  };
}

export function createReadVargaTool(input: VargaToolInput): ToolDef<ReadVargaArgs> {
  return defineTool({
    name: READ_VARGA_TOOL_NAME,
    description: DESCRIPTION,
    input: ARGS_SCHEMA,
    timeoutMs: READ_VARGA_TIMEOUT_MS,
    statusLabel: 'Inspecting divisional chart…',
    reads: true,
    execute: async (args, context: ToolContext): Promise<ReadVargaResult> => {
      const rect = rectificationStatus(input.profileId);
      try {
        const runtime = await readyEngine(input.engine);
        context.signal.throwIfAborted();
        const detailInput = buildVargaDetailInput(input.chart, args.division);
        if (!detailInput || typeof runtime.computeVargaDetail !== 'function') {
          return fallbackFromChart(input.chart, args.division, args.focus_planets, rect);
        }
        const detail = await runtime.computeVargaDetail(detailInput);
        const placements = filterPlacements(detail.placements, args.focus_planets);
        const vargaCtx = input.chart.varga_context_full;
        const vimshopaka = vargaCtx?.vimshopaka?.length ? Object.fromEntries(vargaCtx.vimshopaka.map((v) => [v.graha, v.score])) : undefined;
        const shadvarga = vargaCtx?.shadvarga_own_sign?.length ? Object.fromEntries(vargaCtx.shadvarga_own_sign.map((s) => [s.graha, s.own_sign_count])) : undefined;
        const highlights = Object.values(placements)
          .filter((p) => p.vargottama || p.dignity === 'exalted' || p.dignity === 'own' || p.shashtiamsa)
          .slice(0, 5)
          .map((p) => `${p.graha} in ${p.sign} H${p.house} (${p.vargottama ? 'vargottama' : p.shashtiamsa ? p.shashtiamsa.name : p.dignity})`);
        return {
          chart: args.division, source: 'engine', lagna_sign: detail.lagna_sign, lagna_sign_lord: detail.lagna_sign_lord,
          lagna_vargottama: detail.lagna_vargottama, lagna_shashtiamsa: detail.lagna_shashtiamsa, sensitivity: detail.sensitivity,
          birth_time_rectified: rect.rectified, rectification_band: rect.band, rectify_available: !rect.rectified,
          placements, active_dasha_lords: activeDashaPlacements(input.chart, placements),
          ...(vimshopaka ? { vimshopaka } : {}), ...(shadvarga ? { shadvarga_own_sign: shadvarga } : {}), highlights,
        };
      } catch (error) {
        if (context.signal.aborted) throw error;
        return fallbackFromChart(input.chart, args.division, args.focus_planets, rect);
      }
    },
  });
}
