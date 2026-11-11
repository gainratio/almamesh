/**
 * `find_best_windows` tool: queries deterministic upcoming life-domain windows
 * (`domains_context.forecasts[domain]`), Sarvashtakavarga sign bindus, and
 * Vimshottari dasha transitions across a 3, 6, 12, or 24-month horizon.
 *
 * Zero astrology math in TypeScript and zero birth/coordinate egress.
 */
import type { DomainWindow, LifeDomainForecast, SiderealChart } from '@almamesh/browser/types';
import { defineTool, z, type ToolContext, type ToolDef } from '@almamesh/llm/toolLoop';

import type { PeriodChartLoader } from './periodChart';
import { predictiveReferenceInstant } from './predictive';

export const FIND_BEST_WINDOWS_TOOL_NAME = 'find_best_windows';
const FIND_BEST_WINDOWS_TIMEOUT_MS = 90_000;
const FIND_BEST_WINDOWS_STATUS_LABEL = 'Scanning upcoming timing windows…';

const BEST_WINDOW_DOMAINS = [
  'career',
  'finances',
  'relationships',
  'health',
  'spiritual',
  'education',
  'family',
] as const;
type BestWindowDomain = (typeof BEST_WINDOW_DOMAINS)[number];

type WindowHorizonMonths = 3 | 6 | 12 | 24;

export interface FindBestWindowsArgs {
  readonly domain: BestWindowDomain;
  readonly months: WindowHorizonMonths | null;
}

interface UpcomingDashaShift {
  readonly level: string;
  readonly lord: string;
  readonly start: string;
  readonly end: string;
}

interface BestWindowsResult {
  readonly domain: BestWindowDomain;
  readonly horizon_months: WindowHorizonMonths;
  readonly window: { readonly start: string; readonly end: string };
  readonly strength_summary: LifeDomainForecast['strength_summary'] | null;
  readonly current_emphasis: LifeDomainForecast['current_emphasis'] | null;
  readonly houses: LifeDomainForecast['houses'];
  readonly karakas: LifeDomainForecast['karakas'];
  readonly varga: LifeDomainForecast['varga'] | null;
  readonly sarva_bindus?: Readonly<Record<string, number>>;
  readonly sarva_total?: number;
  readonly upcoming_windows: readonly DomainWindow[];
  readonly dasha_transitions: readonly UpcomingDashaShift[];
  readonly theme_direction?: 'supportive' | 'mixed' | 'challenging';
  readonly theme_confidence?: 'high' | 'medium' | 'low';
}

interface BestWindowsUnavailable {
  readonly domain: BestWindowDomain;
  readonly available: false;
  readonly reason: string;
}

export interface BestWindowsToolInput {
  readonly chart: SiderealChart;
  readonly viewerZone: () => string;
  readonly loadPeriodChart: PeriodChartLoader;
}

function addMonthsIsoDay(startDay: string, months: number): string {
  const [y, m, d] = startDay.split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastOfTarget = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastOfTarget));
  return target.toISOString().slice(0, 10);
}

const ARGS_SCHEMA: z.ZodType<FindBestWindowsArgs> = z
  .object({
    domain: z
      .enum(BEST_WINDOW_DOMAINS)
      .describe('Life domain to scan: "career", "finances", "relationships", "health", "spiritual", "education", or "family".'),
    months: z
      .union([z.literal(3), z.literal(6), z.literal(12), z.literal(24)])
      .nullable()
      .describe('Lookahead horizon in months: 3, 6, 12, or 24 (null defaults to 6 months).'),
  })
  .strict();

const DESCRIPTION = [
  'Scan deterministic upcoming timing windows for a specific life domain over the next 3, 6, 12, or 24 months.',
  'Returns engine-computed domain strength, house & karaka significators, D-varga placement, Sarvashtakavarga bindus, supportive/challenging transit & dasha windows, and upcoming Antardasha/Pratyantardasha transitions.',
].join(' ');

function extractDashaTransitions(chart: SiderealChart, start: string, end: string): UpcomingDashaShift[] {
  const spans = chart.period_reading?.dasha_spans ?? [];
  return spans
    .filter((span) => span.start.slice(0, 10) > start && span.start.slice(0, 10) <= end)
    .slice(0, 10)
    .map((span) => ({
      level: span.level,
      lord: span.lord,
      start: span.start.slice(0, 10),
      end: span.end.slice(0, 10),
    }));
}

export function createFindBestWindowsTool(input: BestWindowsToolInput): ToolDef<FindBestWindowsArgs> {
  return defineTool({
    name: FIND_BEST_WINDOWS_TOOL_NAME,
    description: DESCRIPTION,
    input: ARGS_SCHEMA,
    timeoutMs: FIND_BEST_WINDOWS_TIMEOUT_MS,
    statusLabel: FIND_BEST_WINDOWS_STATUS_LABEL,
    reads: true,
    execute: async (args, context: ToolContext): Promise<BestWindowsResult | BestWindowsUnavailable> => {
      const months: WindowHorizonMonths = args.months ?? 6;
      const start = predictiveReferenceInstant(context.now, input.viewerZone()).slice(0, 10);
      const end = addMonthsIsoDay(start, months);
      try {
        const loaded = await input.loadPeriodChart({ start, end }, context);
        const forecast =
          loaded.domains_context?.forecasts?.[args.domain] ??
          input.chart.domains_context?.forecasts?.[args.domain];
        const sarva = (loaded.strength_context ?? input.chart.strength_context)?.ashtakavarga?.sarva;
        const periodTheme = loaded.period_reading?.themes?.find((t) => t.domain === args.domain);
        const windows = (forecast?.upcoming_windows ?? []).filter(
          (w) => w.date.slice(0, 10) >= start && w.date.slice(0, 10) <= end,
        );
        return {
          domain: args.domain,
          horizon_months: months,
          window: { start, end },
          strength_summary: forecast?.strength_summary ?? null,
          current_emphasis: forecast?.current_emphasis ?? null,
          houses: forecast?.houses ?? [],
          karakas: forecast?.karakas ?? [],
          varga: forecast?.varga ?? null,
          ...(sarva ? { sarva_bindus: sarva.bindus, sarva_total: sarva.total } : {}),
          upcoming_windows: windows,
          dasha_transitions: extractDashaTransitions(loaded, start, end),
          ...(periodTheme ? { theme_direction: periodTheme.direction, theme_confidence: periodTheme.confidence } : {}),
        };
      } catch (error) {
        if (context.signal.aborted) throw error;
        return { domain: args.domain, available: false, reason: 'engine_unavailable' };
      }
    },
  });
}
