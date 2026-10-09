import { describe, expect, it, vi } from 'vitest';

import type { PlaceLookup } from '../geo/placeLookup';
import { createResolvePlaceTool, RESOLVE_PLACE_STATUS_LABEL, RESOLVE_PLACE_TOOL_NAME } from '../placeTool';

const context = () => ({ now: new Date('2026-06-20T00:00:00Z'), signal: new AbortController().signal });
const BOGOTA = { summary: { place_ref: 'city:42', label: 'Bogotá, Colombia', timezone: 'America/Bogota' }, latitude: 4.711, longitude: -74.0721 };

function numbersIn(value: unknown): number[] {
  if (typeof value === 'number') return [value];
  if (value && typeof value === 'object') return Object.values(value).flatMap(numbersIn);
  return [];
}

describe('resolve_place', () => {
  it('is named resolve_place and takes only a query string', () => {
    const tool = createResolvePlaceTool(vi.fn());
    expect(tool.name).toBe(RESOLVE_PLACE_TOOL_NAME);
    expect(tool.name).toBe('resolve_place');
    expect(tool.statusLabel).toBe(RESOLVE_PLACE_STATUS_LABEL);
    expect(RESOLVE_PLACE_STATUS_LABEL).toBe('Looking up the place on this device');
    expect(tool.parameters).toEqual({
      type: 'object',
      properties: { query: { type: 'string', minLength: 2, maxLength: 120 } },
      required: ['query'],
      additionalProperties: false,
    });
  });

  it('returns the label, zone and ref of a found place and no coordinates', async () => {
    const lookup = vi.fn(async (): Promise<PlaceLookup> => ({ status: 'found', place: BOGOTA }));
    const result = await createResolvePlaceTool(lookup).execute({ query: 'Bogotá' }, context());
    expect(result).toEqual({ status: 'found', place: BOGOTA.summary });
    expect(numbersIn(result)).toEqual([]);
    expect(JSON.stringify(result)).not.toMatch(/latitude|longitude|4\.71|74\.07/);
  });

  it('returns candidates without coordinates when ambiguous', async () => {
    const lookup = vi.fn(async (): Promise<PlaceLookup> => ({ status: 'ambiguous', candidates: [BOGOTA, BOGOTA] }));
    const result = await createResolvePlaceTool(lookup).execute({ query: 'Springfield' }, context());
    expect(result).toEqual({ status: 'ambiguous', candidates: [BOGOTA.summary, BOGOTA.summary] });
    expect(numbersIn(result)).toEqual([]);
  });

  it('passes not_found through', async () => {
    const lookup = vi.fn(async (): Promise<PlaceLookup> => ({ status: 'not_found' }));
    expect(await createResolvePlaceTool(lookup).execute({ query: 'Nowhere' }, context())).toEqual({ status: 'not_found' });
  });

  it.each([{}, { query: 7 }, { query: ' ' }, { query: 'x'.repeat(121) }])('refuses %j with a tool error', async (args) => {
    const lookup = vi.fn();
    const result = await createResolvePlaceTool(lookup).execute(args, context());
    expect(result).toEqual({ error: 'query must be a place name of 2–120 characters' });
    expect(lookup).not.toHaveBeenCalled();
  });
});
