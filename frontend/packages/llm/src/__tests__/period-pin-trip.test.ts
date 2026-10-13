import { describe, expect, it } from 'vitest';

import { buildChatMessages, pinnedPeriodRules, type PinnedPrompt } from '../index';
import type { SanitizedChart } from '../sanitize';

const MAY_2019_SG: PinnedPrompt = {
  start: '2019-05-01', end: '2019-05-31', relative: 'past', granularity: 'month', label: 'May 2019',
  place: { label: 'Singapore', timezone: 'Asia/Singapore', source: 'trip' },
};

describe('pinnedPeriodRules is a trip brief', () => {
  it('names the period, its granularity, tense and the place', () => {
    const brief = pinnedPeriodRules(MAY_2019_SG);
    expect(brief).toContain('PINNED PERIOD: this conversation is about 2019-05-01 to 2019-05-31 (relative: past)');
    expect(brief).toContain('a time-travel trip to May 2019 (month, past)');
    expect(brief).toContain('when the user lived in Singapore (Asia/Singapore)');
    expect(brief).toContain('past tense');
  });

  it('tells the model which trip-bound tools ground it, and that they need no dates or place', () => {
    const brief = pinnedPeriodRules(MAY_2019_SG);
    for (const name of ['get_natal_summary', 'get_trip_context', 'get_timing']) expect(brief).toContain(name);
    expect(brief).toContain('dashas, transits, strength, domains');
    expect(brief).toContain("already read this trip's period and place");
  });

  it('says so when an old trip has no place, without naming or marking the birth place', () => {
    const brief = pinnedPeriodRules({ ...MAY_2019_SG, place: { label: 'unspecified place', source: 'default' } });
    expect(brief).toContain('No place was chosen for this trip');
    expect(brief).not.toMatch(/Kolkata|undefined/);
    expect(brief).not.toContain('when the user lived in');
    expect(brief).not.toMatch(/birth/i);
  });

  it('a future trip is in the future tense', () => {
    const brief = pinnedPeriodRules({ ...MAY_2019_SG, start: '2027-01-01', end: '2027-01-31', relative: 'future', label: 'January 2027',
      place: { label: 'San Francisco', timezone: 'America/Los_Angeles', source: 'trip' } });
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
  });

  it('a today thread keeps its chart facts', () => {
    const [, user] = buildChatMessages(CHART, 'How is work?');
    expect(user?.content).toContain('Scorpio-LAGNA-MARK');
  });
});
