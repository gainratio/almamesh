import { describe, expect, it, vi } from 'vitest';
import { AGENT_LIMITS, streamAgentChat } from '@almamesh/llm';

import type { PlaceLookup } from '../geo/placeLookup';
import { createResolvePlaceTool, RESOLVE_PLACE_STATUS_LABEL, RESOLVE_PLACE_TOOL_NAME } from '../placeTool';
import { NO_PLACE_PICKER } from '../placePick';
import { installCityTestDatabase } from '../geo/__tests__/cityTestDb';

installCityTestDatabase();

const context = () => ({ now: new Date('2026-06-20T00:00:00Z'), signal: new AbortController().signal });
const BOGOTA = { summary: { place_ref: 'city:42', label: 'Bogotá, Colombia', timezone: 'America/Bogota' }, latitude: 4.711, longitude: -74.0721 };

function numbersIn(value: unknown): number[] {
  if (typeof value === 'number') return [value];
  if (value && typeof value === 'object') return Object.values(value).flatMap(numbersIn);
  return [];
}

describe('resolve_place', () => {
  it('finishes a cold local lookup beyond the generic two-second agent deadline', async () => {
    vi.useFakeTimers();
    try {
      const lookup = vi.fn(() => new Promise<PlaceLookup>((resolve) => setTimeout(() => resolve({ status: 'found', place: BOGOTA }), 2_500)));
      const bodies: Array<{ messages: unknown[] }> = [];
      const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return Response.json({ choices: [{ message: bodies.length === 1
          ? { role: 'assistant', content: null, tool_calls: [{ id: 'place-call', type: 'function', function: { name: 'resolve_place', arguments: '{"query":"Bogotá"}' } }] }
          : { role: 'assistant', content: 'Bogotá is resolved.' } }] });
      });
      const answer = (async () => {
        let text = '';
        for await (const token of streamAgentChat({
          config: { engine: 'openai-http', model: 'fixture', baseUrl: 'http://localhost:11434/v1', privacyMode: 'local_only' },
          messages: [{ role: 'user', content: 'Look up Bogotá' }], tools: [createResolvePlaceTool(lookup)],
          now: context().now, fetchImpl: fetchImpl as typeof fetch,
        })) text += token;
        return text;
      })();
      await vi.advanceTimersByTimeAsync(2_600);
      const text = await answer;
      const results = JSON.stringify(bodies[1]?.messages);
      expect(results).not.toContain('tool_timeout');
      expect(results).toContain('America/Bogota');
      expect(results).not.toMatch(/latitude|longitude/);
      expect(text).toBe('Bogotá is resolved.');
    } finally { vi.useRealTimers(); }
  });

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

  it('by default loads the offline list on first use and finds a real city', async () => {
    const result = await createResolvePlaceTool().execute({ query: 'Bogotá' }, context());
    expect(result).toMatchObject({ status: 'found', place: { timezone: 'America/Bogota' } });
    expect(numbersIn(result)).toEqual([]);
  });

  it.each([{}, { query: 7 }, { query: ' ' }, { query: 'x'.repeat(121) }])('refuses %j with a tool error', async (args) => {
    const lookup = vi.fn();
    const result = await createResolvePlaceTool(lookup).execute(args, context());
    expect(result).toEqual({ error: 'query must be a place name of 2–120 characters' });
    expect(lookup).not.toHaveBeenCalled();
  });

  describe('several places: the person picks in the chat, the model never guesses', () => {
    const MISSOURI = { ...BOGOTA, summary: { place_ref: 'city:2602', label: 'Springfield, Missouri, United States', timezone: 'America/Chicago' } };
    const ILLINOIS = { ...BOGOTA, summary: { place_ref: 'city:3823', label: 'Springfield, Illinois, United States', timezone: 'America/Chicago' } };
    const ambiguous = vi.fn(async (): Promise<PlaceLookup> => ({ status: 'ambiguous', candidates: [MISSOURI, ILLINOIS] }));

    it('asks the picker with the typed text and every candidate, and returns the pick as found', async () => {
      const pick = vi.fn(async () => ILLINOIS);
      const result = await createResolvePlaceTool(ambiguous, pick).execute({ query: 'Springfield' }, context());
      expect(pick).toHaveBeenCalledWith('Springfield', [MISSOURI, ILLINOIS], expect.any(AbortSignal));
      expect(result).toEqual({ status: 'found', place: ILLINOIS.summary });
      expect(numbersIn(result)).toEqual([]);
    });

    it('a cancel is a neutral "not picked", never an error and never a guessed city', async () => {
      const result = await createResolvePlaceTool(ambiguous, vi.fn(async () => undefined)).execute({ query: 'Springfield' }, context());
      expect(result).toMatchObject({ status: 'not_picked' });
      expect(JSON.stringify(result)).toMatch(/do not guess a place/i);
      expect(result).not.toHaveProperty('error');
    });

    it('with no picker on screen it lists the candidates for the model to ask about', async () => {
      const result = await createResolvePlaceTool(ambiguous, vi.fn(async () => NO_PLACE_PICKER as typeof NO_PLACE_PICKER)).execute({ query: 'Springfield' }, context());
      expect(result).toEqual({ status: 'ambiguous', candidates: [MISSOURI.summary, ILLINOIS.summary] });
    });

    it('a found place never opens the picker', async () => {
      const pick = vi.fn();
      await createResolvePlaceTool(vi.fn(async (): Promise<PlaceLookup> => ({ status: 'found', place: BOGOTA })), pick).execute({ query: 'Bogotá' }, context());
      expect(pick).not.toHaveBeenCalled();
    });

    it('waits for the person as long as the agent allows any tool', () => {
      expect(createResolvePlaceTool(ambiguous).timeoutMs).toBe(AGENT_LIMITS.maxToolTimeoutMs);
      expect(AGENT_LIMITS.maxToolTimeoutMs).toBe(150_000);
    });

  });
});
