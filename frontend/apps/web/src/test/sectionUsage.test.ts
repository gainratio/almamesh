import { describe, expect, it } from 'vitest';

import { countWords, sectionOf, sectionUsageRow, wordsPerVoice } from '../../e2e/sectionUsage';

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
