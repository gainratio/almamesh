import type { NatalInterpretation, ReportTimelineContent } from '@almamesh/llm';
import { describe, expect, it } from 'vitest';

import { countWords, reportSectionWords, sectionOf, sectionUsageRow, wordsPerVoice } from '../../e2e/sectionUsage';

describe('sectionOf', () => {
  it('reads the SECTION marker the structured generator embeds', () => {
    const body = JSON.stringify({ messages: [{ role: 'user', content: 'SECTION:guidance1\n\nTASK' }] });
    expect(sectionOf(body)).toBe('guidance1');
  });

  it('tells current_period from current_sky', () => {
    expect(sectionOf('"SECTION:current_period\\n"')).toBe('current_period');
    expect(sectionOf('"SECTION:current_sky\\n"')).toBe('current_sky');
  });

  it('returns null for a body with no marker', () => {
    expect(sectionOf('{"messages":[]}')).toBeNull();
  });
});

describe('wordsPerVoice', () => {
  it('sums every layman and every technical string, at any depth', () => {
    const content = JSON.stringify({
      summary: { layman: 'one two three', technical: 'four five' },
      strengths: [{ title: 'Ignored title', layman: 'six', technical: 'seven eight nine ten' }],
    });
    expect(wordsPerVoice(content)).toEqual({ layman: 4, technical: 6 });
  });

  it('counts a quarter object (key + layman + technical) by voice', () => {
    const content = JSON.stringify({ quarters: [{ key: 'Q1', layman: 'a b', technical: 'c' }] });
    expect(wordsPerVoice(content)).toEqual({ layman: 2, technical: 1 });
  });

  it('is zero for content that is not JSON', () => {
    expect(wordsPerVoice('not json')).toEqual({ layman: 0, technical: 0 });
  });
});

describe('countWords', () => {
  it('splits on whitespace and ignores empties', () => {
    expect(countWords('  a  b\n c ')).toBe(3);
  });
});

describe('sectionUsageRow', () => {
  it('joins the marker, the voices and OpenRouter usage', () => {
    const request = JSON.stringify({ messages: [{ role: 'user', content: 'SECTION:remedial' }] });
    const response = JSON.stringify({
      provider: 'DeepSeek',
      usage: { cost: 0.0012, prompt_tokens: 900, completion_tokens: 300, completion_tokens_details: { reasoning_tokens: 100 } },
      choices: [{ message: { content: JSON.stringify({ remedial_measures: { layman: 'walk daily', technical: 'Saturn' } }) } }],
    });
    expect(sectionUsageRow(request, 200, response)).toEqual({
      section: 'remedial', status: 200, layman: 2, technical: 1, costUsd: 0.0012,
      promptTokens: 900, completionTokens: 300, reasoningTokens: 100, provider: 'DeepSeek',
    });
  });
});

describe('reportSectionWords', () => {
  const p = (l: string, t: string) => ({ layman: l, technical: t });
  const natal = {
    summary: p('a b', 'c'), strengths: [{ title: 'x', ...p('d', 'e f') }], challenges: [], life_themes: [],
    health_guidance: p('h', 'h'), family_guidance: p('one two three', 'four'),
  } as unknown as NatalInterpretation;
  const timeline: ReportTimelineContent = {
    current_period: { maha: p('m', 'm'), antar: p('a', 'a'), activates: [], next_change: p('n', 'n') },
    year_ahead: { headline: p('h', 'h'), quarters: [{ key: 'Q1', ...p('q one', 'q') }] },
    life_outlook: {
      life_outlook_1: { domains: [{ domain: 'career', outlook: p('c c', 'c') }] },
      life_outlook_2: { domains: [{ domain: 'health', outlook: p('h', 'h h') }] },
    },
  };

  it('counts core, guidance1 (with family) and the outlook groups per voice', () => {
    expect(reportSectionWords('core', natal, timeline)).toEqual({ layman: 3, technical: 3 });
    expect(reportSectionWords('guidance1', natal, timeline)).toEqual({ layman: 4, technical: 2 });
    expect(reportSectionWords('year_ahead', natal, timeline)).toEqual({ layman: 3, technical: 2 });
    expect(reportSectionWords('life_outlook_1', natal, timeline)).toEqual({ layman: 2, technical: 1 });
    expect(reportSectionWords('life_outlook_2', natal, timeline)).toEqual({ layman: 1, technical: 2 });
  });
});
