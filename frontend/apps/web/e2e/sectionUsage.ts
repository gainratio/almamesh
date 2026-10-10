/**
 * Per-section numbers for the [real] specs: which section a request was,
 * how many words each voice got, and what OpenRouter charged for it.
 */
import type { NatalInterpretation, ReportTimelineContent } from '@almamesh/llm';

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
