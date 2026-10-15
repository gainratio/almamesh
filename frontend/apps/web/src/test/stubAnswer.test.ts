import { answerSchema, type AnswerGrounding } from '@almamesh/llm/answer';
import { describe, expect, it } from 'vitest';

import { periodAnswerFrom } from './stubAnswer';

// The stubbed journeys answer from the reading they got; a span that crosses a dasha change
// (2027-01..2028-06: antar Mercury, then Ketu) must name every running lord, or answer.ts
// rejects it and the journey ends in "The AI request failed".
const CROSSING = {
  period: { label: 'Jan 2027 – Jun 2028' },
  dashas: { maha: [{ lord: 'rahu' }], antar: [{ lord: 'mercury' }, { lord: 'ketu' }] },
  lords: [{ lord: 'rahu', rules: [] }, { lord: 'mercury', rules: [1, 4] }, { lord: 'ketu', rules: [] }],
  themes: [{ domain: 'career', direction: 'mixed', confidence: 'medium' }],
};

const GROUNDING: AnswerGrounding = {
  readings: [{
    period: { start: '2027-01-01', end: '2028-06-30', label: 'Jan 2027 – Jun 2028' },
    place: { label: '' },
    maha: ['rahu'],
    antar: ['mercury', 'ketu'],
    pratyantar: [],
    rules: { rahu: [], mercury: [1, 4], ketu: [] },
    tags: [],
    windows: [],
    themes: { career: { direction: 'mixed', confidence: 'medium' } },
  }],
};

describe('periodAnswerFrom', () => {
  it('names every running lord of a span that crosses a dasha change', () => {
    const parsed = answerSchema(() => GROUNDING).safeParse(periodAnswerFrom([CROSSING]));
    expect(parsed.success ? [] : parsed.error.issues.map((issue) => issue.message)).toEqual([]);
  });
});
