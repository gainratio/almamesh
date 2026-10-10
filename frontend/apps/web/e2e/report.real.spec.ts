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
  type NatalInterpretation,
  type ProviderConfig,
  type ReportTimelineContent,
} from '@almamesh/llm';
import { E2E_REAL_MODEL } from './realModel';
import { reportSectionWords, sectionUsageRow, type SectionUsageRow, type Voices } from './sectionUsage';

/**
 * Full report REAL check (no browser): the nine report-v2 sections against
 * live OpenRouter, three runs. Records per run: wall time (natal and timeline
 * run concurrently, as the app does), usage.cost per section, words per voice
 * per section. Asserts: every section lands; usage.cost is inside
 * estimateReadingCost's range; words are within REPORT_WORD_TARGETS +/-30 %;
 * every request carries reasoning.max_tokens 6000 and no max_tokens. P90 is
 * asserted only when REPORT_P90_BUDGET_MS is set (the default-model run).
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
const AS_OF: AnalysisInstant = { basis: 'chart', instant: new Date('2026-06-09T12:00:00Z') };

interface ReportRun {
  readonly totalMs: number;
  readonly costUsd: number;
  readonly rows: readonly SectionUsageRow[];
  readonly words: Readonly<Record<string, Voices>>;
  readonly errors: readonly string[];
}

interface ReportOutput {
  natal: NatalInterpretation | null;
  timeline: ReportTimelineContent | null;
}

function goldenChart(): SiderealChart {
  const read = (name: string) => JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8')) as Record<string, object>;
  return { ...read('chart_golden_de421.json')[KEY], ...read('predictive_golden_de421.json')[KEY] } as SiderealChart;
}

function nearestRankP90(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(0.9 * sorted.length) - 1];
}

test('[real] full report-v2 reading against live OpenRouter (3 runs)', async () => {
  const apiKey = process.env.OPENROUTER_API_KEY;
  test.skip(!apiKey, 'OPENROUTER_API_KEY not set');
  test.setTimeout(2_400_000);

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

  const runs: ReportRun[] = [];
  for (let run = 0; run < RUNS; run += 1) {
    const rows: SectionUsageRow[] = [];
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const requestBody = String(init?.body ?? '');
      bodies.push(JSON.parse(requestBody) as Record<string, unknown>);
      const res = await fetch(input, init);
      const row = sectionUsageRow(requestBody, res.status, await res.clone().text());
      if (row) rows.push(row);
      return res;
    };
    const errors: string[] = [];
    const out: ReportOutput = { natal: null, timeline: null };
    const t0 = Date.now();
    await Promise.all([
      (async () => {
        for await (const e of streamNatalInterpretation({ chart, asOf: AS_OF, config, fetchImpl, promptSet: REPORT_PROMPT_SET })) {
          if (e.type === 'error') errors.push(`${e.section}: ${e.message}`);
          if (e.type === 'complete') out.natal = e.interpretation;
        }
      })(),
      (async () => {
        for await (const e of streamReportTimeline({ chart, asOf: AS_OF, config, fetchImpl })) {
          if (e.type === 'error') errors.push(`${e.section}: ${e.message}`);
          if (e.type === 'complete') out.timeline = e.timeline;
        }
      })(),
    ]);
    const totalMs = Date.now() - t0;
    const { natal, timeline } = out;
    expect(natal).not.toBeNull();
    expect(timeline).not.toBeNull();
    if (natal === null || timeline === null) return;
    const words = Object.fromEntries(REPORT_SECTIONS.map((s) => [s, reportSectionWords(s, natal, timeline)]));
    for (const body of bodies) {
      expect(body.reasoning).toEqual({ max_tokens: 6000 });
      expect(body).not.toHaveProperty('max_tokens');
    }
    runs.push({ totalMs, costUsd: rows.reduce((s, r) => s + r.costUsd, 0), rows, words, errors });
  }

  const p90Ms = nearestRankP90(runs.map((r) => r.totalMs));
  mkdirSync('test-results', { recursive: true });
  writeFileSync(
    `test-results/report-real-${MODEL.replace(/\W/g, '_')}.json`,
    JSON.stringify({ model: MODEL, estimate, p90Ms, runs }, null, 2),
  );

  for (const run of runs) {
    expect(run.errors, 'every section lands').toEqual([]);
    expect.soft(run.costUsd, 'usage.cost >= estimate low').toBeGreaterThanOrEqual(estimate?.lowUsd ?? Infinity);
    expect.soft(run.costUsd, 'usage.cost <= estimate high').toBeLessThanOrEqual(estimate?.highUsd ?? -Infinity);
    for (const section of REPORT_SECTIONS) {
      const target = REPORT_WORD_TARGETS[section];
      const low = Math.floor(target.low * 0.7);
      const high = Math.ceil(target.high * 1.3);
      for (const voice of ['layman', 'technical'] as const) {
        const n = run.words[section][voice];
        expect.soft(n, `${section} ${voice} words >= ${low}`).toBeGreaterThanOrEqual(low);
        expect.soft(n, `${section} ${voice} words <= ${high}`).toBeLessThanOrEqual(high);
      }
    }
  }
  if (P90_BUDGET_MS !== null) expect(p90Ms, `P90 over ${RUNS} runs`).toBeLessThan(P90_BUDGET_MS);
});
