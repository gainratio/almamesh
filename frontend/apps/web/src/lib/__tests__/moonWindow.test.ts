import { LocalTimeError } from '@almamesh/store';
import { describe, expect, it, vi } from 'vitest';

import type { ChartEngineContextValue } from '../../providers/chartEngineContext';
import { createMoonWindowLoader, eventInstantUtc, localPeriodBounds, moonWindowInput } from '../moonWindow';

const context = () => ({ now: new Date('2026-06-20T00:00:00Z'), signal: new AbortController().signal });
const BOGOTA = { latitude: 4.711, longitude: -74.0721 };

describe('localPeriodBounds', () => {
  it('is local midnight of the first day to local midnight after the last day, in UTC', () => {
    expect(localPeriodBounds('2026-06-15', '2026-06-15', 'America/Bogota')).toEqual({
      startUtc: '2026-06-15T05:00:00.000Z',
      endUtc: '2026-06-16T05:00:00.000Z',
    });
    expect(localPeriodBounds('2026-06-01', '2026-06-03', 'America/Los_Angeles')).toEqual({
      startUtc: '2026-06-01T07:00:00.000Z',
      endUtc: '2026-06-04T07:00:00.000Z',
    });
  });

  it('is 23 hours on a spring-forward day', () => {
    const { startUtc, endUtc } = localPeriodBounds('2026-03-08', '2026-03-08', 'America/Los_Angeles');
    expect(Date.parse(endUtc) - Date.parse(startUtc)).toBe(23 * 3_600_000);
  });

  it('starts at the first real instant when local midnight is skipped', () => {
    // Intl shows America/Santiago 2026-09-06 jumps 00:00 GMT-4 -> 01:00 GMT-3 at 04:00Z.
    const { startUtc } = localPeriodBounds('2026-09-06', '2026-09-06', 'America/Santiago');
    expect(startUtc).toBe('2026-09-06T04:00:00.000Z');
  });
});

describe('localPeriodBounds edge zones', () => {
  it('starts at the earlier midnight when local midnight happens twice', () => {
    // America/Havana ends DST at 01:00 on 2026-11-01, repeating 00:00-01:00.
    const { startUtc } = localPeriodBounds('2026-11-01', '2026-11-01', 'America/Havana');
    expect(startUtc).toBe('2026-11-01T04:00:00.000Z');
  });

  it('ends at the skipped-midnight day start when the day after the last day skips midnight', () => {
    const { endUtc } = localPeriodBounds('2026-09-05', '2026-09-05', 'America/Santiago');
    expect(endUtc).toBe('2026-09-06T04:00:00.000Z');
  });

  it('refuses a day with neither 00:00 nor 01:00 (Samoa skipped 30 Dec 2011)', () => {
    expect(() => localPeriodBounds('2011-12-30', '2011-12-30', 'Pacific/Apia')).toThrow(RangeError);
  });
});

describe('eventInstantUtc', () => {
  it('turns 15:00 in Bogotá into 20:00 UTC', () => {
    expect(eventInstantUtc('2026-06-15', '15:00', 'America/Bogota')).toBe('2026-06-15T20:00:00.000Z');
  });

  it('refuses a time that never happened', () => {
    expect(() => eventInstantUtc('2026-03-08', '02:30', 'America/Los_Angeles')).toThrow(LocalTimeError);
  });

  it('refuses a time that happened twice', () => {
    expect(() => eventInstantUtc('2026-11-01', '01:30', 'America/Los_Angeles')).toThrow(LocalTimeError);
  });
});

describe('moonWindowInput', () => {
  it('sends the place bounds and the event; coordinates go only to the on-device worker', () => {
    expect(
      moonWindowInput({ start: '2026-06-15', end: '2026-06-15', zone: 'America/Bogota', place: BOGOTA, time: '15:00' }),
    ).toEqual({
      placeStartUtc: '2026-06-15T05:00:00.000Z',
      placeEndUtc: '2026-06-16T05:00:00.000Z',
      event: { datetimeUtc: '2026-06-15T20:00:00.000Z', latitude: 4.711, longitude: -74.0721 },
    });
  });

  it('sends no event without a time', () => {
    expect(moonWindowInput({ start: '2026-06-15', end: '2026-06-15', zone: 'America/Bogota', place: BOGOTA })).toEqual({
      placeStartUtc: '2026-06-15T05:00:00.000Z',
      placeEndUtc: '2026-06-16T05:00:00.000Z',
    });
  });
});

describe('createMoonWindowLoader', () => {
  it('calls the engine once with the built input', async () => {
    const computeMoonWindow = vi.fn(async () => ({ at_place: null, event: null }));
    const engine = {
      engine: { computeMoonWindow },
      startBootstrap: vi.fn(),
      whenReady: vi.fn(),
    } as unknown as ChartEngineContextValue;
    const request = { start: '2026-06-15', end: '2026-06-15', zone: 'America/Bogota', place: BOGOTA };
    await createMoonWindowLoader(engine)(request, context());
    expect(computeMoonWindow).toHaveBeenCalledTimes(1);
    expect(computeMoonWindow).toHaveBeenCalledWith(moonWindowInput(request));
  });

  it('refuses a bad time before the engine is touched', async () => {
    const startBootstrap = vi.fn();
    const engine = { engine: null, startBootstrap, whenReady: vi.fn() } as unknown as ChartEngineContextValue;
    const request = { start: '2026-03-08', end: '2026-03-08', zone: 'America/Los_Angeles', place: BOGOTA, time: '02:30' };
    await expect(createMoonWindowLoader(engine)(request, context())).rejects.toBeInstanceOf(LocalTimeError);
    expect(startBootstrap).not.toHaveBeenCalled();
  });

  it('fails as engine_unavailable without an engine', async () => {
    const request = { start: '2026-06-15', end: '2026-06-15', zone: 'UTC', place: BOGOTA };
    await expect(createMoonWindowLoader(null)(request, context())).rejects.toMatchObject({ reason: 'engine_unavailable' });
  });
});
