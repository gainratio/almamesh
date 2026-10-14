import { describe, expect, it } from 'vitest';

import { PERIOD_DETAIL_TOOL_NAME, PERIOD_READING_TOOL_NAME, TRIP_GROUNDING_TOOLS, buildChatMessages, pinnedPeriodRules, type PinnedPrompt } from '../index';
import type { SanitizedChart } from '../sanitize';

const MAY_2019_SG: PinnedPrompt = {
  start: '2019-05-01', end: '2019-05-31', relative: 'past', granularity: 'month', label: 'May 2019',
  place: { label: 'Singapore', timezone: 'Asia/Singapore' },
};

describe('pinnedPeriodRules is a trip brief', () => {
  it('names the period, its granularity, tense and the place', () => {
    const brief = pinnedPeriodRules(MAY_2019_SG);
    expect(brief).toContain('PINNED PERIOD: this conversation is about 2019-05-01 to 2019-05-31 (relative: past)');
    expect(brief).toContain('a time-travel trip to May 2019 (month, past)');
    expect(brief).toContain('when the user lived in Singapore (Asia/Singapore)');
    expect(brief).toContain('past tense');
  });

  // Contract reversed 2026-10-13 (period reading): the reading carries the period and place, so a trip is
  // grounded by get_period_reading + get_natal_summary; get_trip_context and get_timing stay optional.
  it('the period reading and the natal summary ground a trip; the tool names are one exported contract', () => {
    expect(PERIOD_READING_TOOL_NAME).toBe('get_period_reading');
    expect(PERIOD_DETAIL_TOOL_NAME).toBe('get_period_detail');
    expect(TRIP_GROUNDING_TOOLS).toEqual(['get_period_reading', 'get_natal_summary']);
    const brief = pinnedPeriodRules(MAY_2019_SG);
    expect(brief).toContain("Before interpreting, call get_period_reading and get_natal_summary: with no arguments they read this trip's period and place.");
    expect(brief).toContain('get_period_detail');
    expect(brief).not.toContain('dashas, transits, strength, domains');
  });

  // 2026-10-14, Harish's 09:22 PT turn: a September question in a May trip read May. The brief now says
  // another month is read by naming it, and the trip month is only the default.
  it('another month the user asks about is read by naming it, at the trip place', () => {
    const brief = pinnedPeriodRules(MAY_2019_SG);
    expect(brief).toContain('For another month, now or earlier, send get_period_reading month "YYYY-MM".');
    expect(brief).toContain('for another, send its start and end');
    expect(brief).not.toContain('Answer about it unless the user asks about another one.');
  });

  // Contract reversed 2026-10-13: every trip names its place and zone; none is marked as the birth place.
  it('a trip at the birth place reads like any other: label and zone, no marker', () => {
    const brief = pinnedPeriodRules({ ...MAY_2019_SG, place: { label: 'Delhi, India', timezone: 'Asia/Kolkata' } });
    expect(brief).toContain('when the user lived in Delhi, India (Asia/Kolkata)');
    expect(brief).not.toMatch(/birth|No place was chosen/i);
  });

  it('a future trip is in the future tense', () => {
    const brief = pinnedPeriodRules({ ...MAY_2019_SG, start: '2027-01-01', end: '2027-01-31', relative: 'future', label: 'January 2027',
      place: { label: 'San Francisco', timezone: 'America/Los_Angeles' } });
    expect(brief).toContain('a time-travel trip to January 2027 (month, future)');
    expect(brief).toContain('San Francisco (America/Los_Angeles)');
    expect(brief).toContain('future tense');
  });
});

const CHART = {
  as_of: { basis: 'period', start: '2019-05-01', end: '2019-05-31' },
  ayanamsa_value: 24.1, lagna: { sign: 'Scorpio-LAGNA-MARK' }, planets: {}, houses: {}, yogas: [],
} as unknown as SanitizedChart;

describe('a trip prompt carries the brief, not pre-computed facts', () => {
  it('omits the chart facts block from the user turn and points at the tools instead', () => {
    const [system, user] = buildChatMessages(CHART, 'How was work?', 'layman', [], [], undefined, 'en', undefined, undefined, undefined, true, MAY_2019_SG);
    expect(system?.content).toContain('time-travel trip to May 2019');
    expect(user?.content).not.toContain('Scorpio-LAGNA-MARK');
    expect(user?.content).toContain('get_natal_summary');
    expect(user?.content).toContain('get_period_reading');
  });

  it('a today thread keeps its chart facts', () => {
    const [, user] = buildChatMessages(CHART, 'How is work?');
    expect(user?.content).toContain('Scorpio-LAGNA-MARK');
  });
});
