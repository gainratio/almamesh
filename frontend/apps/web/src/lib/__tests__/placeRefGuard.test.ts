import type { AgentTool } from '@almamesh/llm';
import { describe, expect, it, vi } from 'vitest';

import { buildChatToolset, type BuildChatToolsetInput } from '../chatToolset';
import type { ResolvedPlace } from '../geo/placeLookup';
import { RESOLVE_PLACE_TOOL_NAME } from '../placeTool';
import { TIME_TRAVEL_TOOL_NAME } from '../legacyTimeTravelTool';
import { TIMING_TOOL_NAME } from '../timingTool';
import { CHART } from './timingFixtures';

/**
 * Live on ba4430ce the model invented `place_ref: "city:0"` and get_timing read it as
 * Shanghai (row 0 of the bundled city list). A place_ref is valid only when resolve_place
 * handed it out in this turn (or it is a trip's reserved "pinned"). Anything else is a tool
 * error naming the valid refs, on every tool that takes a place_ref.
 */
const SHANGHAI: ResolvedPlace = { summary: { place_ref: 'city:0', label: 'Shanghai, China', timezone: 'Asia/Shanghai' }, latitude: 31.2, longitude: 121.5 };
const SINGAPORE = { place_ref: 'city:7', label: 'Singapore', timezone: 'Asia/Singapore' };
const now = new Date('2026-10-14T17:00:00Z');
const options = () => ({ now, signal: new AbortController().signal });
const MAY_2019 = { start: '2019-05-01', end: '2019-05-31', granularity: 'month', place: { label: 'Singapore', timezone: 'Asia/Singapore', latitude: 1.29, longitude: 103.85 } } as const;

const RESOLVE_STUB: AgentTool = {
  name: RESOLVE_PLACE_TOOL_NAME, description: 'stub', statusLabel: 'stub',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  execute: async () => ({ status: 'found', place: SINGAPORE }),
};

function toolset(overrides: Partial<BuildChatToolsetInput> = {}) {
  const placeFromRef = vi.fn(async () => SHANGHAI);
  const record = vi.fn();
  const built = buildChatToolset({
    chart: CHART, chartAsOf: { basis: 'chart', instant: now }, chartTimeZone: 'UTC', profileKey: 'fixture',
    birth: undefined, engine: null, viewerZone: () => 'America/Los_Angeles', periodSkyAllowed: true,
    placeFromRef, onTravel: record, toolOverrides: [RESOLVE_STUB], ...overrides,
  });
  const tool = (name: string) => {
    const found = built.tools.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`${name} is missing`);
    return found;
  };
  return { tool, placeFromRef, record };
}

describe('place_ref: only refs resolve_place handed out', () => {
  it('get_timing refuses an invented place_ref instead of reading it as a city', async () => {
    const { tool, placeFromRef } = toolset();
    const result = await tool(TIMING_TOOL_NAME).execute({ section: 'transits', start: '2026-10-14', place_ref: 'city:0' }, options());
    expect(result).toEqual({ error: expect.stringMatching(/unknown place_ref "city:0".*resolve_place.*Valid refs: none yet/) });
    expect(JSON.stringify(result)).not.toContain('Shanghai');
    expect(placeFromRef).not.toHaveBeenCalled();
  });

  it('after resolve_place, the error lists the refs it handed out, and those refs are read', async () => {
    const { tool, placeFromRef } = toolset();
    await tool(RESOLVE_PLACE_TOOL_NAME).execute({ query: 'Singapore' }, options());
    const refused = await tool(TIMING_TOOL_NAME).execute({ section: 'transits', start: '2026-10-14', place_ref: 'city:0' }, options());
    expect(refused).toEqual({ error: expect.stringContaining('Valid refs: city:7 (Singapore)') });
    expect(placeFromRef).not.toHaveBeenCalled();
    await Promise.resolve(tool(TIMING_TOOL_NAME).execute({ section: 'transits', start: '2026-10-14', place_ref: 'city:7' }, options())).catch(() => undefined);
    expect(placeFromRef).toHaveBeenCalledWith('city:7');
  });

  it('an ambiguous lookup hands out every candidate ref', async () => {
    const ambiguous: AgentTool = { ...RESOLVE_STUB, execute: async () => ({ status: 'ambiguous', candidates: [SINGAPORE, { place_ref: 'city:9', label: 'Portland, Oregon', timezone: 'America/Los_Angeles' }] }) };
    const { tool } = toolset({ toolOverrides: [ambiguous] });
    await tool(RESOLVE_PLACE_TOOL_NAME).execute({ query: 'x' }, options());
    const refused = await tool(TIMING_TOOL_NAME).execute({ section: 'transits', start: '2026-10-14', place_ref: 'city:1' }, options());
    expect(refused).toEqual({ error: expect.stringContaining('city:7 (Singapore), city:9 (Portland, Oregon)') });
  });

  it('get_timing refuses an invented ref inside segments too', async () => {
    const { tool, placeFromRef } = toolset();
    const segments = [{ start: '2026-10-14', end: '2026-10-15', place_ref: 'city:0' }];
    const result = await tool(TIMING_TOOL_NAME).execute({ section: 'transits', start: '2026-10-14', end: '2026-10-15', segments }, options());
    expect(result).toEqual({ error: expect.stringMatching(/unknown place_ref "city:0"/) });
    expect(placeFromRef).not.toHaveBeenCalled();
  });

  it('time_travel refuses an invented place_ref and records no move', async () => {
    const { tool, placeFromRef, record } = toolset();
    const result = await tool(TIME_TRAVEL_TOOL_NAME).execute({ action: 'travel', period: 'day', date: '2026-10-20', place_ref: 'city:0' }, options());
    expect(result).toEqual({ error: expect.stringMatching(/unknown place_ref "city:0"/) });
    expect(placeFromRef).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

});

/**
 * Contract reversed (2026-10-14, Harish's 09:22 PT turn): b4710b23 turned an invented ref into an
 * error row, so the model gave up ("Could not look up life areas", "Could not look up dashas").
 * An invented `city:N` now reads the THREAD's place (the trip's, or today's current place) and the
 * result says so in `place_note`. It never reads a city from the list, and it is never an error.
 */
const HARISH_0922_ARGS = {
  start: '2019-09-01', end: '2019-09-30', place_ref: 'city:1', time: '00:00',
  segments: [{ start: '2019-09-01', end: '2019-09-30', place_ref: 'city:1' }],
} as const;
const VADODARA_MAY_2019 = { start: '2019-05-01', end: '2019-05-31', granularity: 'month', place: { label: 'Vadodara, Gujarat, India', timezone: 'Asia/Kolkata', latitude: 22.31, longitude: 73.18 } } as const;

describe("an invented place_ref reads the thread's place", () => {
  for (const section of ['domains', 'dashas'] as const) {
    it(`Harish's exact ${section} call in a May 2019 trip asking about September reads September at the trip's place`, async () => {
      const { tool, placeFromRef } = toolset({ pinned: VADODARA_MAY_2019 });
      const result = await tool(TIMING_TOOL_NAME).execute({ section, ...HARISH_0922_ARGS }, options()) as Record<string, unknown>;
      expect(result.error).toBeUndefined();
      expect(result.period).toMatchObject({ start: '2019-09-01', end: '2019-09-30' });
      expect(result.place_note).toBe("used this thread's place (Vadodara, Gujarat, India)");
      expect(JSON.stringify(result)).not.toMatch(/Shanghai/);
      expect(placeFromRef).not.toHaveBeenCalled();
    });
  }

  it("a trip's invented ref for a single day reads that day at the trip's place", async () => {
    const { tool, placeFromRef } = toolset({ pinned: MAY_2019 });
    const result = await tool(TIMING_TOOL_NAME).execute({ section: 'transits', start: '2019-05-03', place_ref: 'city:0' }, options()) as Record<string, unknown>;
    expect(result.error).toBeUndefined();
    expect(result.place_note).toBe("used this thread's place (Singapore)");
    expect(JSON.stringify(result)).not.toMatch(/Shanghai/);
    expect(placeFromRef).not.toHaveBeenCalled();
  });

  it("a today thread's invented ref reads the profile's current place", async () => {
    const birth = { transit_location_details: { location_name: 'Portland, Oregon', latitude: 45.52, longitude: -122.68, timezone: 'America/Los_Angeles' } } as unknown as BuildChatToolsetInput['birth'];
    const { tool, placeFromRef } = toolset({ birth });
    const result = await tool(TIMING_TOOL_NAME).execute({ section: 'transits', start: '2026-10-14', place_ref: 'city:0' }, options()) as Record<string, unknown>;
    expect(result.error).toBeUndefined();
    expect(result.place_note).toBe("used this thread's place (Portland, Oregon)");
    expect(placeFromRef).not.toHaveBeenCalled();
  });

  it('an issued ref is still read as itself, with no place_note', async () => {
    const { tool, placeFromRef } = toolset({ pinned: MAY_2019 });
    await tool(RESOLVE_PLACE_TOOL_NAME).execute({ query: 'Singapore' }, options());
    const result = await tool(TIMING_TOOL_NAME).execute({ section: 'dashas', start: '2019-09-01', end: '2019-09-30', place_ref: 'city:7' }, options()) as Record<string, unknown>;
    expect(placeFromRef).toHaveBeenCalledWith('city:7');
    expect(result.place_note).toBeUndefined();
  });

  it("a trip's error for another period keeps its dates in the retry hint, never 'already bound'", async () => {
    const { tool } = toolset({ pinned: MAY_2019 });
    const result = await tool(TIMING_TOOL_NAME).execute({ section: 'transits', start: '2019-09-01', end: '2019-08-01' }, options()) as { error: string };
    expect(result.error).toMatch(/Retry: keep start and end/);
    expect(result.error).not.toMatch(/already bound/);
  });
});
