import { beforeEach, describe, expect, it } from 'vitest';
import { getCurrentPlace, useProfilesStore } from '@almamesh/store';

import { createSetCurrentLocationTool } from '../locationTool';
import type { DevicePlace } from '../readPeriod';

const NOVATO = {
  summary: {
    place_ref: 'city:novato',
    label: 'Novato, California, United States',
    timezone: 'America/Los_Angeles',
  },
  latitude: 38.1074,
  longitude: -122.5697,
};

const CTX = { now: new Date('2026-11-11T18:00:00Z'), signal: new AbortController().signal };

beforeEach(() => {
  useProfilesStore.setState({ profiles: {}, activeProfileId: null });
});

describe('set_current_location tool', () => {
  it('resolves a city offline, persists to useProfilesStore, updates turn homePlace, and strips coordinates', async () => {
    const profileId = useProfilesStore.getState().createProfile('Asha');
    let turnPlace: DevicePlace | undefined;
    const tool = createSetCurrentLocationTool({
      profileId,
      getHomePlace: () => turnPlace,
      setTurnHomePlace: (place) => {
        turnPlace = place;
      },
      lookup: async () => ({ status: 'found', place: NOVATO }),
    });

    const result = await tool.execute({ place: 'Novato, CA' }, CTX);

    expect(result).toEqual({
      status: 'saved',
      place: { label: 'Novato, California, United States', timezone: 'America/Los_Angeles' },
    });
    expect(JSON.stringify(result)).not.toContain('38.1074');
    expect(JSON.stringify(result)).not.toContain('-122.5697');
    expect(turnPlace).toMatchObject({ label: 'Novato, California, United States', latitude: 38.1074 });
    expect(getCurrentPlace(useProfilesStore.getState().profiles[profileId])).toEqual({
      label: 'Novato, California, United States',
      timezone: 'America/Los_Angeles',
      latitude: 38.1074,
      longitude: -122.5697,
    });
  });

  it('includes previous_place when overwriting an existing current location', async () => {
    const profileId = useProfilesStore.getState().createProfile('Asha');
    let turnPlace: DevicePlace | undefined = {
      label: 'Pune, Maharashtra, India',
      timezone: 'Asia/Kolkata',
      latitude: 18.5204,
      longitude: 73.8567,
    };
    const tool = createSetCurrentLocationTool({
      profileId,
      getHomePlace: () => turnPlace,
      setTurnHomePlace: (place) => {
        turnPlace = place;
      },
      lookup: async () => ({ status: 'found', place: NOVATO }),
    });

    const result = await tool.execute({ place: 'Novato, CA' }, CTX);

    expect(result).toEqual({
      status: 'saved',
      place: { label: 'Novato, California, United States', timezone: 'America/Los_Angeles' },
      previous_place: { label: 'Pune, Maharashtra, India', timezone: 'Asia/Kolkata' },
    });
  });

  it('returns place_not_found without mutating profile store when lookup misses', async () => {
    const profileId = useProfilesStore.getState().createProfile('Asha');
    let turnPlace: DevicePlace | undefined;
    const tool = createSetCurrentLocationTool({
      profileId,
      getHomePlace: () => turnPlace,
      setTurnHomePlace: (place) => {
        turnPlace = place;
      },
      lookup: async () => ({ status: 'not_found' }),
    });

    const result = await tool.execute({ place: 'Atlantis' }, CTX);

    expect(result).toEqual({ status: 'place_not_found', ask: 'Ask for the nearest larger city.' });
    expect(turnPlace).toBeUndefined();
    expect(getCurrentPlace(useProfilesStore.getState().profiles[profileId])).toBeUndefined();
  });
});
