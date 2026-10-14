// The trip acceptance matrix (e2e/trip-acceptance.real.spec.ts) checks live
// answers with the regexes in e2e/answerChecks.ts. Here the typed answer's
// renderer is held to those same regexes, so a grounded answer passes the
// matrix by how it phrases the facts, and the two can never drift apart.
import { describe, expect, it } from 'vitest';

import { answerSchema, renderAnswer, type AnswerGrounding, type PeriodAnswer, type RenderOptions } from '@almamesh/llm/answer';

import { CONFIDENCE, DATED_WINDOW, LORDSHIP, obstaclesMisses, tableConfidence, tagPattern } from '../../../e2e/answerChecks';

interface Fixture {
  readonly name: string;
  readonly answer: PeriodAnswer;
  readonly reading: AnswerGrounding['readings'][number];
  readonly place: RegExp;
  readonly sadeSati: boolean;
  readonly obstacles: boolean;
}

/** The matrix's checkAnswer, minus the tool-row checks: what the answer text must say. */
function misses(text: string, f: Fixture): string[] {
  const out: string[] = [];
  const names = (lords: readonly string[]) => lords.some((name) => new RegExp(`\\b${name}\\b`, 'i').test(text));
  if (!names(f.reading.maha)) out.push('no maha lord');
  if (!names(f.reading.antar)) out.push('no antar lord');
  if (!LORDSHIP.test(text)) out.push('no lordship');
  if (f.sadeSati && !/sade[\s-]*sati/i.test(text)) out.push('no Sade Sati');
  if (f.reading.tags.length > 0 && !f.reading.tags.some((tag) => tagPattern(tag).test(text))) out.push('no Moon tag');
  if (!DATED_WINDOW.test(text)) out.push('no dated window');
  if (!CONFIDENCE.test(text) && !tableConfidence(text)) out.push('no confidence');
  if (!f.place.test(text)) out.push('no place');
  if (f.obstacles) out.push(...obstaclesMisses(text));
  return out;
}

/** The forms the matrix reads: the markdown, the page's text (no markup), and the log's collapsed text. */
function forms(markdown: string): string[] {
  const page = markdown.replace(/\*\*/g, '').replace(/^- /gm, '');
  return [markdown, page, page.replace(/\s+/g, ' ').trim()];
}

const SEPTEMBER = { start: '2019-09-01', end: '2019-09-30', label: 'September 2019' };
const VADODARA = { label: 'Vadodara, Gujarat, India' };
/** Aquarius lagna (both synthetic personas): Jupiter rules 2, 11; Saturn 1, 12; Mercury 5, 8. */
const AQUARIUS_RULES = { jupiter: [2, 11], saturn: [1, 12], mercury: [5, 8], mars: [3, 10] };

const SADE_SATI: Fixture = {
  name: 'Sade Sati (T1, trip to Vadodara)',
  reading: {
    period: SEPTEMBER, place: VADODARA, maha: ['jupiter'], antar: ['saturn'], rules: AQUARIUS_RULES,
    tags: ['sade_sati_phase_1'], windows: ['2019-09-12'], domains: ['career', 'health'],
  },
  answer: {
    kind: 'period', period: 'September 2019', place: 'Vadodara, India',
    opening: 'September is a slow, serious month. Work holds steady, but your energy runs lower than usual.',
    dashas: {
      maha: { lord: 'jupiter', rules: [2, 11], note: 'Money and friendships are the long story of these years.' },
      antar: { lord: 'saturn', rules: [1, 12], note: 'It asks you to carry more on your own for a while.' },
      pratyantar: null,
    },
    moon: [{ tag: 'sade_sati_phase_1', meaning: 'Saturn has started its long walk over your Moon, so feelings can sit heavier.' }],
    themes: [
      { area: 'Career', direction: 'mixed', confidence: 'medium', text: 'Steady work, slow credit.', obstacle: null },
      { area: 'Health', direction: 'challenging', confidence: 'high', text: 'Guard your sleep.', obstacle: null },
    ],
    windows: [{ date: '2019-09-12', what: 'A good day to finish something you started.' }],
    advice: 'Go easy on yourself and keep a simple routine.',
  },
  place: /Vadodara/,
  sadeSati: true,
  obstacles: false,
};

const JUPITER_FROM_MOON: Fixture = {
  name: 'Jupiter 11th from the Moon (S1, trip to Singapore)',
  reading: {
    period: { start: '2019-05-01', end: '2019-05-31', label: 'May 2019' }, place: { label: 'Singapore' },
    maha: ['jupiter'], antar: ['saturn'], rules: AQUARIUS_RULES,
    tags: ['jupiter_from_moon_11'], windows: ['2019-05-20'], domains: ['wealth'],
  },
  answer: {
    kind: 'period', period: 'May 2019', place: 'Singapore',
    opening: 'May brings help from people around you, and money matters look brighter.',
    dashas: {
      maha: { lord: 'jupiter', rules: [2, 11], note: 'Gains come through people you know.' },
      antar: { lord: 'saturn', rules: [1, 12], note: 'Patience pays more than speed.' },
      pratyantar: null,
    },
    moon: [{ tag: 'jupiter_from_moon_11', meaning: 'Friends and contacts are generous now.' }],
    themes: [{ area: 'Money', direction: 'supportive', confidence: 'high', text: 'A raise or a useful lead is likely.', obstacle: null }],
    windows: [{ date: '2019-05-20', what: 'Ask for what you want.' }],
    advice: null,
  },
  place: /Singapore/,
  sadeSati: false,
  obstacles: false,
};

const OBSTACLES: Fixture = {
  name: 'Obstacles (O1, Saturn rules the 12th, 25 Sep window)',
  reading: {
    period: SEPTEMBER, place: VADODARA, maha: ['saturn'], antar: ['mercury'], rules: AQUARIUS_RULES,
    tags: ['sade_sati_phase_1'], windows: ['2019-09-25'], domains: ['obstacles', 'career'],
  },
  answer: {
    kind: 'period', period: 'September 2019', place: 'Vadodara, India',
    opening: 'September asks for care with paperwork and money. Things move, but slowly and with some friction.',
    dashas: {
      maha: { lord: 'saturn', rules: [1, 12], note: 'This long chapter is about discipline and letting go of what no longer fits.' },
      antar: { lord: 'mercury', rules: [5, 8], note: 'Contracts, messages and details need a second look.' },
      pratyantar: null,
    },
    moon: [{ tag: 'sade_sati_phase_1', meaning: 'Saturn has started its long walk over your Moon, so pressure feels personal.' }],
    themes: [
      {
        area: 'Obstacles', direction: 'challenging', confidence: 'medium',
        text: 'Expect friction with rules or authorities, slow legal or administrative matters, and losses and expenses you did not plan.',
        obstacle: 'The cause is Saturn, which runs this chapter and looks after your 12th house of losses.',
      },
      { area: 'Career', direction: 'mixed', confidence: 'low', text: 'Hold your ground and document your work.', obstacle: null },
    ],
    windows: [{ date: '2019-09-25', what: 'Mars stirs tempers; avoid signing or arguing that day.' }],
    advice: 'Keep copies of every form you send and a small cash buffer.',
  },
  place: /Vadodara/,
  sadeSati: true,
  obstacles: true,
};

const VOICES: readonly RenderOptions[] = [
  { voice: 'layman', language: 'en' },
  { voice: 'expert', language: 'en' },
];

describe('rendered answers pass the trip matrix checks', () => {
  for (const fixture of [SADE_SATI, JUPITER_FROM_MOON, OBSTACLES]) {
    it(`${fixture.name}: the fixture is a valid answer for its reading`, () => {
      const parsed = answerSchema(() => ({ readings: [fixture.reading] })).safeParse({ markdown: null, ...fixture.answer });
      expect(parsed.success ? [] : parsed.error.issues.map((issue) => issue.message)).toEqual([]);
    });

    for (const options of VOICES) {
      it(`${fixture.name}, ${options.voice}-${options.language}`, () => {
        const markdown = renderAnswer(fixture.answer, options);
        for (const text of forms(markdown)) expect(misses(text, fixture), text).toEqual([]);
      });
    }
  }

  it('the checks can fail: the same answer without its window, confidence or lordship misses all three', () => {
    const bare = renderAnswer(OBSTACLES.answer, { voice: 'layman', language: 'en' })
      .replace(/\*\*Dates to watch\*\*\n.*\n/, '')
      .replace(/medium confidence|low confidence/g, 'steady')
      .replace(/Saturn rules your 1st and 12th houses\. |Mercury rules your 5th and 8th houses\. /g, '')
      .replace(/looks after your 12th house/, 'touches');
    expect(misses(bare, OBSTACLES)).toEqual([
      'no lordship',
      'no dated window',
      'no confidence',
      'answer names no obstacles factor (Saturn rules the 12th / Rahu in the 12th)',
      'answer does not give the 25 Sep Mars window',
    ]);
  });
});
