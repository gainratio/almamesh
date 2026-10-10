import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { SiderealChart } from '@almamesh/browser/types';
import {
  buildReportMessages,
  estimateReadingCost,
  fetchOpenRouterModels,
  findModelPricing,
  READING_OUTPUT_BUDGET,
  REPORT_PROMPT_SET,
  REPORT_SECTIONS,
  REPORT_WORD_TARGETS,
  streamNatalInterpretation,
  streamReportTimeline,
  type AnalysisInstant,
  type ModelPricing,
  type NatalInterpretation,
  type ProviderConfig,
  type ReportTimelineContent,
} from '@almamesh/llm';
import { E2E_REAL_MODEL } from './realModel';
import {
  catalogCostUsd,
  medianVoices,
  reasoningCapOverruns,
  reportSectionWords,
  sectionUsageRow,
  type SectionUsageRow,
  type Voices,
} from './sectionUsage';

/**
 * Full report REAL check (no browser): the nine report-v2 sections against
 * live OpenRouter, three runs. Records per run: wall time (natal and timeline
 * run concurrently, as the app does), billed usage.cost and the upstream
 * provider per section, words per voice per section. Asserts: every section
 * lands; each run's CATALOG-priced cost (its tokens at the catalog price the
 * estimate uses) is inside estimateReadingCost's range; the per-section,
 * per-voice MEDIAN of words across runs is within REPORT_WORD_TARGETS +/-30 %;
 * every request carries reasoning.max_tokens 6000, the report provider
 * preference (sort "price", preferred p50 throughput floor) and no max_tokens;
 * each run's 200 usage rows cover all nine sections. P90 is asserted only when
 * REPORT_P90_BUDGET_MS is set (the default-model run). Each run is aborted at
 * RUN_DEADLINE_MS; section failures and aborts are soft, and the result JSON
 * (with per-section wall times) is written even when a run fails.
 *
 * Billed usage.cost depends on which upstream provider OpenRouter routes to.
 * The library asks for the cheapest first but fallbacks stay allowed: a billed
 * total above the estimate, and any provider that ignored the reasoning cap,
 * are annotations, not failures.
 *
 * Nightly:  OPENROUTER_API_KEY=... bun run test:e2e:report:real
 * Default model (PR evidence): set REPORT_REAL_MODEL to the app's default
 * model and REPORT_P90_BUDGET_MS=150000 (the exact command is in the PR body).
 */

const MODEL = process.env.REPORT_REAL_MODEL ?? E2E_REAL_MODEL;
const RUNS = 3;
const P90_BUDGET_MS = process.env.REPORT_P90_BUDGET_MS ? Number(process.env.REPORT_P90_BUDGET_MS) : null;
const KEY = '1990-01-15T12:00:00+00:00';
const FIXTURES = new URL('../../../../backend/tests/fixtures/', import.meta.url);
const REASONING_CAP = 6000;
const PROVIDER_ROUTING = { sort: 'price', preferred_min_throughput: { p50: 25 } };
/** Per-run wall-clock cap: twice the P90 budget, at least 10 minutes. */
const RUN_DEADLINE_MS = Math.max(2 * (P90_BUDGET_MS ?? 0), 600_000);
const AS_OF: AnalysisInstant = { basis: 'chart', instant: new Date('2026-06-09T12:00:00Z') };

interface ReportRun {
  readonly totalMs: number;
  readonly billedUsd: number;
  readonly catalogUsd: number;
  readonly providers: readonly string[];
  readonly rows: readonly SectionUsageRow[];
  readonly sectionMs: readonly SectionTiming[];
  readonly words: Readonly<Record<string, Voices>>;
  readonly errors: readonly string[];
}

/** Wall time of one section request, from send to the full response body. */
interface SectionTiming {
  readonly section: string;
  readonly status: number;
  readonly ms: number;
}

interface ReportOutput {
  natal: NatalInterpretation | null;
  timeline: ReportTimelineContent | null;
}

function goldenChart(): SiderealChart {
  const read = (name: string) => JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8')) as Record<string, object>;
  return { ...read('chart_golden_de421.json')[KEY], ...read('predictive_golden_de421.json')[KEY] } as SiderealChart;
}

/** Distinct providers whose billed cost for a section was above its catalog price. */
function pricierProviders(rows: readonly SectionUsageRow[], pricing: ModelPricing): string[] {
  const pricier = rows.filter((row) => row.costUsd > catalogCostUsd([row], pricing) * 1.01);
  return [...new Set(pricier.map((row) => `${row.provider} (${row.section} $${row.costUsd.toFixed(4)})`))];
}

function annotate(description: string): void {
  test.info().annotations.push({ type: 'warning', description });
  console.warn(description);
}

function nearestRankP90(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(0.9 * sorted.length) - 1];
}

interface RunSummary {
  readonly p90Ms: number;
  readonly medianWords: Readonly<Record<string, Voices>>;
  readonly capOverruns: readonly string[];
}

function summarize(runs: readonly ReportRun[]): RunSummary {
  return {
    p90Ms: runs.length > 0 ? nearestRankP90(runs.map((r) => r.totalMs)) : Number.NaN,
    medianWords: Object.fromEntries(
      REPORT_SECTIONS.map((s) => [s, medianVoices(runs.map((r) => r.words[s] ?? { layman: 0, technical: 0 }))]),
    ),
    capOverruns: runs.flatMap((r, i) => reasoningCapOverruns(r.rows, REASONING_CAP).map((o) => `run ${i + 1} ${o}`)),
  };
}

function writeResult(result: object): void {
  mkdirSync('test-results', { recursive: true });
  writeFileSync(`test-results/report-real-${MODEL.replace(/\W/g, '_')}.json`, JSON.stringify(result, null, 2));
}

/** Drain one generator, collecting its error events and its completed result. */
async function drain<E extends { readonly type: string }>(
  events: AsyncGenerator<E>,
  errors: string[],
  onComplete: (event: E) => void,
): Promise<void> {
  for await (const e of events) {
    if (e.type === 'error' && 'section' in e && 'message' in e) errors.push(`${String(e.section)}: ${String(e.message)}`);
    if (e.type === 'complete') onComplete(e);
  }
}

/**
 * One full reading, natal and timeline concurrently, as the app runs them.
 * Aborted at RUN_DEADLINE_MS so a slow upstream fails the run (with its
 * partial rows) instead of hanging the test to its timeout.
 */
async function runOnce(chart: SiderealChart, config: ProviderConfig, pricing: ModelPricing): Promise<ReportRun> {
  const rows: SectionUsageRow[] = [];
  const sectionMs: SectionTiming[] = [];
  const bodies: Record<string, unknown>[] = [];
  const t0 = Date.now();
  const fetchImpl: typeof fetch = async (input, init) => {
    const requestBody = String(init?.body ?? '');
    bodies.push(JSON.parse(requestBody) as Record<string, unknown>);
    const started = Date.now();
    const res = await fetch(input, init);
    const row = sectionUsageRow(requestBody, res.status, await res.clone().text());
    if (row) {
      rows.push(row);
      sectionMs.push({ section: row.section, status: res.status, ms: Date.now() - started });
    }
    return res;
  };
  const errors: string[] = [];
  const out: ReportOutput = { natal: null, timeline: null };
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), RUN_DEADLINE_MS);
  const signal = deadline.signal;
  try {
    await Promise.all([
      drain(streamNatalInterpretation({ chart, asOf: AS_OF, config, fetchImpl, signal, promptSet: REPORT_PROMPT_SET }), errors, (e) => {
        if (e.type === 'complete') out.natal = e.interpretation;
      }),
      drain(streamReportTimeline({ chart, asOf: AS_OF, config, fetchImpl, signal }), errors, (e) => {
        if (e.type === 'complete') out.timeline = e.timeline;
      }),
    ]);
  } catch (err) {
    const reason = signal.aborted ? `deadline ${RUN_DEADLINE_MS / 1000} s exceeded` : String(err);
    errors.push(`run aborted: ${reason}`);
  } finally {
    clearTimeout(timer);
  }
  const totalMs = Date.now() - t0;
  for (const body of bodies) {
    expect.soft(body.reasoning).toEqual({ max_tokens: REASONING_CAP });
    expect.soft(body.provider).toEqual(PROVIDER_ROUTING);
    expect.soft(body).not.toHaveProperty('max_tokens');
  }
  const { natal, timeline } = out;
  const words =
    natal !== null && timeline !== null
      ? Object.fromEntries(REPORT_SECTIONS.map((s) => [s, reportSectionWords(s, natal, timeline)]))
      : {};
  return {
    totalMs,
    billedUsd: rows.reduce((s, r) => s + r.costUsd, 0),
    catalogUsd: catalogCostUsd(rows, pricing),
    providers: [...new Set(rows.map((r) => r.provider))],
    rows,
    sectionMs,
    words,
    errors,
  };
}

test('[real] full report-v2 reading against live OpenRouter (3 runs)', async () => {
  const apiKey = process.env.OPENROUTER_API_KEY;
  test.skip(!apiKey, 'OPENROUTER_API_KEY not set');
  test.setTimeout(RUNS * RUN_DEADLINE_MS + 600_000);

  const config: ProviderConfig = {
    engine: 'openai-http',
    model: MODEL,
    privacyMode: 'cloud_premium',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey,
  };
  const chart = goldenChart();
  const pricing = findModelPricing(await fetchOpenRouterModels({ config }), MODEL);
  const messages = buildReportMessages({ chart, asOf: AS_OF }, { mode: 'layman', language: 'en', lite: false });
  const estimate = estimateReadingCost(
    REPORT_SECTIONS.map((s) => messages[s]),
    pricing,
    READING_OUTPUT_BUDGET,
  );
  expect(estimate, `OpenRouter lists no usable price for ${MODEL}`).not.toBeNull();
  if (estimate === null || pricing === null) return;

  const runs: ReportRun[] = [];
  try {
    for (let run = 0; run < RUNS; run += 1) runs.push(await runOnce(chart, config, pricing));
  } finally {
    writeResult({ model: MODEL, estimate, pricing, ...summarize(runs), runs });
  }
  const { p90Ms, medianWords, capOverruns } = summarize(runs);

  for (const overrun of capOverruns) annotate(`provider ignored the reasoning cap: ${overrun}`);
  runs.forEach((run, i) => {
    expect.soft(run.errors, `run ${i + 1} every section lands`).toEqual([]);
    const covered = new Set(run.rows.filter((row) => row.status === 200).map((row) => row.section));
    expect.soft([...covered].sort(), `run ${i + 1} usage rows cover all nine sections`).toEqual([...REPORT_SECTIONS].sort());
    expect.soft(run.catalogUsd, `run ${i + 1} catalog-priced cost >= estimate low`).toBeGreaterThanOrEqual(estimate.lowUsd);
    expect.soft(run.catalogUsd, `run ${i + 1} catalog-priced cost <= estimate high`).toBeLessThanOrEqual(estimate.highUsd);
    if (run.billedUsd > estimate.highUsd) {
      annotate(
        `run ${i + 1} billed $${run.billedUsd.toFixed(4)} > estimate high $${estimate.highUsd.toFixed(4)}; ` +
          `pricier upstream: ${pricierProviders(run.rows, pricing).join(', ') || 'none'}`,
      );
    }
  });
  for (const section of REPORT_SECTIONS) {
    const target = REPORT_WORD_TARGETS[section];
    const low = Math.floor(target.low * 0.7);
    const high = Math.ceil(target.high * 1.3);
    for (const voice of ['layman', 'technical'] as const) {
      const n = medianWords[section]?.[voice] ?? 0;
      expect.soft(n, `${section} ${voice} median words >= ${low}`).toBeGreaterThanOrEqual(low);
      expect.soft(n, `${section} ${voice} median words <= ${high}`).toBeLessThanOrEqual(high);
    }
  }
  if (P90_BUDGET_MS !== null) expect(p90Ms, `P90 over ${RUNS} runs`).toBeLessThan(P90_BUDGET_MS);
});
