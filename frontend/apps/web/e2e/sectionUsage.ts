/**
 * Per-section numbers for the [real] specs: which section a request was,
 * how many words each voice got, and what OpenRouter charged for it.
 */
import type { ModelPricing, NatalInterpretation, ReportTimelineContent } from '@almamesh/llm';

import { completionUsage } from './openrouterUsage';

const SECTION_MARKER = /SECTION:([a-z0-9_]+)/;

export function sectionOf(requestBody: string): string | null {
  return SECTION_MARKER.exec(requestBody)?.[1] ?? null;
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

export interface Voices {
  layman: number;
  technical: number;
}

function addVoices(value: unknown, into: Voices): void {
  if (Array.isArray(value)) {
    for (const item of value) addVoices(item, into);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'layman' && typeof child === 'string') into.layman += countWords(child);
    else if (key === 'technical' && typeof child === 'string') into.technical += countWords(child);
    else addVoices(child, into);
  }
}

function voicesOf(...values: unknown[]): Voices {
  const voices: Voices = { layman: 0, technical: 0 };
  for (const value of values) addVoices(value, voices);
  return voices;
}

/** Words per voice for one report section, read from what reached the screen. */
export function reportSectionWords(
  section: string,
  natal: NatalInterpretation,
  timeline: ReportTimelineContent,
): Voices {
  switch (section) {
    case 'core':
      return voicesOf(natal.summary, natal.strengths, natal.challenges, natal.life_themes);
    case 'yoga':
      return voicesOf(natal.integrated_yoga_narrative);
    case 'guidance1':
      return voicesOf(
        natal.health_guidance,
        natal.education_guidance,
        natal.career_guidance,
        natal.relationship_guidance,
        natal.family_guidance,
      );
    case 'guidance2':
      return voicesOf(natal.finances_guidance, natal.spiritual_guidance, natal.life_evolution_guidance);
    case 'remedial':
      return voicesOf(natal.remedial_measures);
    case 'current_period':
      return voicesOf(timeline.current_period);
    case 'year_ahead':
      return voicesOf(timeline.year_ahead);
    case 'life_outlook_1':
    case 'life_outlook_2':
      return voicesOf(timeline.life_outlook[section]?.domains.map((row) => row.outlook));
    default:
      return { layman: 0, technical: 0 };
  }
}

export function wordsPerVoice(content: string): Voices {
  const voices: Voices = { layman: 0, technical: 0 };
  try {
    addVoices(JSON.parse(content) as unknown, voices);
  } catch {
    return voices;
  }
  return voices;
}

export interface SectionUsageRow {
  readonly section: string;
  readonly status: number;
  readonly layman: number;
  readonly technical: number;
  readonly costUsd: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly reasoningTokens: number;
  readonly provider: string;
}

export function sectionUsageRow(requestBody: string, status: number, responseBody: string): SectionUsageRow | null {
  const section = sectionOf(requestBody);
  if (section === null) return null;
  const usage = completionUsage(responseBody);
  return {
    section,
    status,
    ...wordsPerVoice(usage.content),
    costUsd: usage.cost,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    reasoningTokens: usage.reasoningTokens,
    provider: usage.provider,
  };
}

/**
 * What the responses cost at the catalog price the estimate uses. OpenRouter
 * counts reasoning inside completion_tokens, so it is not added again. The
 * billed usage.cost can differ: it depends on the upstream provider.
 */
export function catalogCostUsd(rows: readonly SectionUsageRow[], pricing: ModelPricing): number {
  return rows.reduce(
    (sum, row) => sum + row.promptTokens * pricing.promptUsdPerToken + row.completionTokens * pricing.completionUsdPerToken,
    0,
  );
}

/** Responses whose reasoning went past the requested cap (the provider ignored it). */
export function reasoningCapOverruns(rows: readonly SectionUsageRow[], cap: number): string[] {
  return rows
    .filter((row) => row.reasoningTokens > cap)
    .map((row) => `${row.section} (${row.provider}): ${row.reasoningTokens} reasoning tokens`);
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** Per-voice median across runs. */
export function medianVoices(runs: readonly Voices[]): Voices {
  if (runs.length === 0) throw new Error('medianVoices: no runs');
  return { layman: median(runs.map((r) => r.layman)), technical: median(runs.map((r) => r.technical)) };
}

/** What the run summary reads from one live run. */
export interface RunOutcome {
  readonly totalMs: number;
  readonly words: Readonly<Record<string, Voices>>;
  /** Non-empty when the run failed (a section error or an aborted run). */
  readonly errors: readonly string[];
}

export interface RunStats {
  readonly completedRuns: number;
  /** Nearest-rank P90 of completed runs' wall time; NaN when none completed. */
  readonly p90Ms: number;
  /** Per-section median words over completed runs; empty when none completed. */
  readonly medianWords: Readonly<Record<string, Voices>>;
}

function nearestRankP90(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(0.9 * sorted.length) - 1] as number;
}

/**
 * P90 and median words over the runs that completed. A failed run (often a
 * 0 s fetch rejection with no words) would drag both down, so it is left out
 * here; it stays in the recorded runs and fails the run's own checks.
 */
export function completedRunStats(runs: readonly RunOutcome[], sections: readonly string[]): RunStats {
  const done = runs.filter((run) => run.errors.length === 0);
  if (done.length === 0) return { completedRuns: 0, p90Ms: Number.NaN, medianWords: {} };
  const medianWords = Object.fromEntries(
    sections.map((s) => [s, medianVoices(done.map((run) => run.words[s] ?? { layman: 0, technical: 0 }))]),
  );
  return { completedRuns: done.length, p90Ms: nearestRankP90(done.map((run) => run.totalMs)), medianWords };
}
