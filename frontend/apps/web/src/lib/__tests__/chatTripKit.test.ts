import type { ProcessedBirthData } from '@almamesh/shared-types';
import { describe, expect, it, vi } from 'vitest';

import type { ChartEngineContextValue } from '../../providers/chartEngineContext';
import { buildChatToolset } from '../chatToolset';
import { chatTripKit } from '../chatTripKit';
import { CHART } from './timingFixtures';

const BIRTH = { birth_location_details: { city: 'Delhi', latitude: 28.6, longitude: 77.2, timezone: 'Asia/Kolkata' } } as unknown as ProcessedBirthData;
const INPUT = {
  chart: CHART, chartAsOf: { basis: 'chart', instant: new Date('2025-01-01T00:00:00Z') } as const, chartTimeZone: 'Asia/Kolkata',
  profileKey: 'p1', birth: BIRTH, periodSkyAllowed: true, language: 'en',
  engine: { engine: null, startBootstrap: vi.fn(), whenReady: vi.fn() } as unknown as ChartEngineContextValue,
};
const SG = { start: '2019-05-01', end: '2019-05-31', granularity: 'month', place: { label: 'Singapore', timezone: 'Asia/Singapore', latitude: 1.3, longitude: 103.8 } } as const;

describe('chatTripKit lists what a live turn registers', () => {
  it('a trip lists the same tools a live trip turn gets', () => {
    const live = buildChatToolset({ ...INPUT, pinned: SG, onTravel: vi.fn() }).tools.map((tool) => tool.name);
    expect(chatTripKit(INPUT).toolsFor(SG).map((tool) => tool.name)).toEqual(live);
  });

  it('a today thread lists the today tools', () => {
    const live = buildChatToolset({ ...INPUT, onTravel: vi.fn() }).tools.map((tool) => tool.name);
    expect(chatTripKit(INPUT).toolsFor(undefined).map((tool) => tool.name)).toEqual(live);
  });

  it('a trip has its context for the card', () => {
    expect(chatTripKit(INPUT).tripFor(SG)?.place).toMatchObject({ label: 'Singapore', source: 'trip' });
  });
});
