import type { AgentTool } from '@almamesh/llm';
import { describe, expect, it, vi } from 'vitest';

import { buildChatToolset, type BuildChatToolsetInput } from '../chatToolset';
import type { ResolvedPlace } from '../geo/placeLookup';
import { RESOLVE_PLACE_TOOL_NAME } from '../placeTool';
import { TIME_TRAVEL_TOOL_NAME } from '../timeTravelTool';
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

  it("a trip's error names its reserved pinned ref as valid", async () => {
    const { tool } = toolset({ pinned: MAY_2019 });
    const result = await tool(TIMING_TOOL_NAME).execute({ section: 'transits', start: '2019-05-03', place_ref: 'city:0' }, options());
    expect(result).toEqual({ error: expect.stringContaining('pinned (this trip\'s place, Singapore)') });
  });
});
