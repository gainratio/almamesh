import type { SiderealChart } from '@almamesh/browser/types';
import { AGENT_LIMITS, NEEDS_PLACE_ERROR, PLACE_REF_ERROR } from '@almamesh/llm';
import { describe, expect, it, vi } from 'vitest';

import { DASHAS_STATUS_LABEL, createTimingTool, withPin, type PinnedTiming } from '../timingTool';
import domainsGolden from '../../../../../../backend/tests/fixtures/domains_golden_de421.json';
import { CHART, SKY_CHART } from './timingFixtures';

const NOW = new Date('2026-03-08T09:30:00.000Z');
const context = () => ({ now: NOW, signal: new AbortController().signal });
const YEAR_PIN: PinnedTiming = { period: { start: '2027-01-01', end: '2027-12-31' } };
const DAY_PIN: PinnedTiming = { period: { start: '2026-06-15', end: '2026-06-15' }, placeRef: 'pinned' };
const PINNED_BOGOTA = {
  summary: { place_ref: 'pinned', label: 'Bogotá, Colombia', timezone: 'America/Bogota' },
  latitude: 4.711,
  longitude: -74.0721,
};

function tool(pinned: PinnedTiming | undefined, overrides: Partial<Parameters<typeof createTimingTool>[0]> = {}) {
  return createTimingTool({
    chart: CHART,
    birthYear: 1990,
    todayDay: () => '2026-03-08',
    loadPeriodChart: vi.fn(async () => SKY_CHART),
    periodSkyAllowed: true,
    placeFromRef: vi.fn(async (ref: string) => (ref === 'pinned' ? PINNED_BOGOTA : undefined)),
    pinned,
    ...overrides,
  });
}

describe('withPin', () => {
  it('turns "no dates" into the pinned period', () => {
    expect(withPin(YEAR_PIN, { kind: 'today' })).toEqual({ kind: 'period', period: YEAR_PIN.period });
    expect(withPin(DAY_PIN, { kind: 'today' })).toEqual({ kind: 'period', period: DAY_PIN.period, placeRef: 'pinned' });
  });

  it('lends the pin place only to a call for exactly the pinned day with no place of its own', () => {
    const same = { kind: 'period', period: DAY_PIN.period } as const;
    const other = { kind: 'period', period: { start: '2026-06-16', end: '2026-06-16' } } as const;
    const placed = { kind: 'period', period: DAY_PIN.period, placeRef: 'city:202' } as const;
    expect(withPin(DAY_PIN, same)).toEqual({ ...same, placeRef: 'pinned' });
    expect(withPin(DAY_PIN, other)).toEqual(other);
    expect(withPin(DAY_PIN, placed)).toEqual(placed);
  });

  it('leaves everything alone in an unpinned thread', () => {
    expect(withPin(undefined, { kind: 'today' })).toEqual({ kind: 'today' });
  });
});

describe('get_timing in a pinned thread', () => {
  it('reads the pinned period when called without dates, never today', async () => {
    const loadPeriodChart = vi.fn(async () => SKY_CHART);
    const loadCurrentChart = vi.fn();
    const result = (await tool(YEAR_PIN, { loadPeriodChart, loadCurrentChart }).execute({ section: 'transits' }, context())) as {
      period: unknown;
    };
    expect(result.period).toEqual({ start: '2027-01-01', end: '2027-12-31', days: 365, basis: 'period' });
    expect(loadPeriodChart).toHaveBeenCalledWith(YEAR_PIN.period, expect.anything());
    expect(loadCurrentChart).not.toHaveBeenCalled();
  });

  it('still honours other dates the model sends to compare', async () => {
    const result = (await tool(YEAR_PIN).execute({ section: 'dashas', start: '2026-06-01', end: '2026-06-30' }, context())) as {
      period: { start: string };
    };
    expect(result.period.start).toBe('2026-06-01');
  });

  it('a Day pin reads its own place: no needs_place, label and zone only, no coordinates', async () => {
    const result = await tool(DAY_PIN).execute({ section: 'transits' }, context());
    expect(result).not.toEqual({ error: NEEDS_PLACE_ERROR });
    const text = JSON.stringify(result);
    expect(text).toContain('"label":"Bogotá, Colombia"');
    expect(text).not.toMatch(/4\.711|74\.07|latitude|longitude/);
  });

  it('a different single day in a Day-pinned thread still needs a place', async () => {
    const result = await tool(DAY_PIN).execute({ section: 'transits', start: '2026-07-03' }, context());
    expect(result).toEqual({ error: NEEDS_PLACE_ERROR });
  });

  it('says "reading dasha periods", not "working out the sky", on a weak device', () => {
    expect(tool(YEAR_PIN, { periodSkyAllowed: false }).statusLabelFor?.({ section: 'transits' })).toBe(DASHAS_STATUS_LABEL);
    expect(tool(undefined, { periodSkyAllowed: false }).statusLabelFor?.({ section: 'transits' })).toBeUndefined();
  });

  it('a pinned Day domains read of the heaviest committed sky still fits the tool-result cap', async () => {
    const heavy = { ...SKY_CHART, domains_context: domainsGolden['1988-08-08T06:44:00+05:30'] } as unknown as SiderealChart;
    const result = await tool(DAY_PIN, { loadPeriodChart: vi.fn(async () => heavy) }).execute({ section: 'domains' }, context());
    expect((result as { data: unknown[] }).data).toHaveLength(7);
    expect(JSON.stringify({ ok: true, value: result }).length).toBeLessThanOrEqual(AGENT_LIMITS.maxResultChars);
  });

  it('the model can never send the reserved "pinned" ref itself, at top level or in a segment', async () => {
    const placeFromRef = vi.fn(async (ref: string) => (ref === 'pinned' ? PINNED_BOGOTA : undefined));
    const top = await tool(DAY_PIN, { placeFromRef }).execute({ section: 'transits', start: '2026-06-15', place_ref: 'pinned' }, context());
    const segment = await tool(DAY_PIN, { placeFromRef }).execute(
      { section: 'transits', segments: [{ start: '2026-06-15', end: '2026-06-15', place_ref: 'pinned' }] },
      context(),
    );
    expect(top).toEqual({ error: PLACE_REF_ERROR });
    expect(segment).toEqual({ error: PLACE_REF_ERROR });
    expect(placeFromRef).not.toHaveBeenCalledWith('pinned');
  });

  it.each(['transits', 'dashas'])('a Day pin on a weak device answers %s with dashas only and no place', async (section) => {
    const placeFromRef = vi.fn(async (ref: string) => (ref === 'pinned' ? PINNED_BOGOTA : undefined));
    const loadPeriodChart = vi.fn(async () => SKY_CHART);
    const result = await tool(DAY_PIN, { periodSkyAllowed: false, placeFromRef, loadPeriodChart }).execute({ section }, context());
    expect(result).toMatchObject({ shown: 'dashas' });
    expect(placeFromRef).not.toHaveBeenCalled();
    expect(loadPeriodChart).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/Bogot|America\/|4\.711|74\.07|latitude|longitude|"places"/);
  });
});
