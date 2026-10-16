import { describe, expect, it } from 'vitest';

import { buildChatMessages, pinnedPeriodRules, type PinnedPrompt, type ThreadFacts } from '../index';
import type { SanitizedChart } from '../sanitize';

const MAY_2019_SG: PinnedPrompt = { start: '2019-05-01', end: '2019-05-31', relative: 'past', granularity: 'month' };
const NOW = 'Wednesday 14 October 2026, America/Los_Angeles';

describe('pinnedPeriodRules is the period and its tense', () => {
  it('names the period and the tense', () => {
    const brief = pinnedPeriodRules(MAY_2019_SG);
    expect(brief).toContain('PINNED PERIOD: this conversation is about 2019-05-01 to 2019-05-31 (relative: past)');
    expect(brief).toContain('past tense');
  });

  // Contract reversed 2026-10-14 (chat tool layer redesign): the brief used to name the grounding tools
  // (get_period_reading, get_natal_summary, get_period_detail, get_timing) and carry the trip line. The
  // tools are now read_period and travel, named once in the TOOLS line; the trip rides in THIS THREAD.
  it('names no tool and no trip line', () => {
    const brief = pinnedPeriodRules(MAY_2019_SG);
    expect(brief).not.toMatch(/get_|read_period|travel|TIME-TRAVEL TRIP|Singapore/);
  });

  // dashboard.agentic.real 2026-10-15: in a September 2017 trip, "outlook today?" was read as
  // September 2017 again. The pin is the default time, never a cap on the time the user names.
  it('a message that names another time is read for that time, in its own tense', () => {
    const brief = pinnedPeriodRules(MAY_2019_SG);
    expect(brief).toContain('This period is the default when a message names no time. When a message names another time (today, a date, a month, a year), read and answer that time instead, in its own tense.');
  });

  it('a future trip is in the future tense', () => {
    const brief = pinnedPeriodRules({ ...MAY_2019_SG, start: '2027-01-01', end: '2027-01-31', relative: 'future', label: 'January 2027' });
    expect(brief).toContain('2027-01-01 to 2027-01-31 (relative: future)');
    expect(brief).toContain('future tense');
  });
});

describe('the THIS THREAD line', () => {
  const threadAt = (place: string, timezone: string): ThreadFacts => ({ now: NOW, trip: { label: 'May 2019', place, timezone } });
  const systemFor = (thread: ThreadFacts) =>
    buildChatMessages(CHART, 'How was work?', 'layman', [], [], undefined, 'en', undefined, undefined, undefined, MAY_2019_SG, thread)[0]?.content ?? '';

  // Contract kept from 2026-10-13: every trip names its place and zone; none is marked as the birth place.
  it('a trip at the birth place reads like any other: label and zone, no marker', () => {
    const line = systemFor(threadAt('Delhi, India', 'Asia/Kolkata')).split('\n').find((text) => text.startsWith('THIS THREAD:')) ?? '';
    expect(line).toBe('THIS THREAD: a trip to May 2019, when the user lived in Delhi, India (Asia/Kolkata).');
    expect(line).not.toMatch(/birth|No place was chosen/i);
  });
});

const CHART = {
  as_of: { basis: 'period', start: '2019-05-01', end: '2019-05-31' },
  ayanamsa_value: 24.1, lagna: { sign: 'Scorpio-LAGNA-MARK' }, planets: {}, houses: {}, yogas: [],
} as unknown as SanitizedChart;

describe('a trip prompt carries the natal facts', () => {
  // Contract reversed 2026-10-14: a trip used to omit the facts block and point at get_natal_summary,
  // a call forced in every trip turn. The compact facts block now rides in every mode.
  it('keeps the chart facts block in the user turn and names no grounding tool', () => {
    const thread: ThreadFacts = { now: NOW, trip: { label: 'May 2019', place: 'Singapore', timezone: 'Asia/Singapore' } };
    const [system, user] = buildChatMessages(CHART, 'How was work?', 'layman', [], [], undefined, 'en', undefined, undefined, undefined, MAY_2019_SG, thread);
    expect(system?.content).toContain('THIS THREAD: a trip to May 2019');
    expect(user?.content).toContain('Scorpio-LAGNA-MARK');
    expect(user?.content).not.toContain('get_natal_summary');
    expect(user?.content).not.toContain('get_period_reading');
  });

  it('a today thread keeps its chart facts', () => {
    const [, user] = buildChatMessages(CHART, 'How is work?');
    expect(user?.content).toContain('Scorpio-LAGNA-MARK');
  });
});
