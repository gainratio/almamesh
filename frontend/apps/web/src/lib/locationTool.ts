/**
 * `set_current_location` tool: resolves a city offline on-device, persists it
 * to `useProfilesStore.getState().setCurrentPlace(profileId, ...)`, and updates
 * the active turn's mutable `homePlace` reference so subsequent `read_period`
 * calls in the same turn immediately use the saved city.
 *
 * Privacy contract: ONLY `{ label, timezone }` ever reaches the LLM; latitude
 * and longitude remain strictly on-device.
 */
import { defineTool, z, type ToolDef } from '@almamesh/llm/toolLoop';
import { useProfilesStore, type CurrentPlace } from '@almamesh/store';

import {
  READ_PERIOD_TIMEOUT_MS,
  resolveChatPlace,
  type ChatPlace,
  type DevicePlace,
  type PickPlace,
  type PlaceAsk,
} from './readPeriod';
import type { PlaceLookup } from './geo/placeLookup';

const SET_CURRENT_LOCATION_TOOL_NAME = 'set_current_location';
const SET_CURRENT_LOCATION_STATUS_LABEL = 'Saving your current location…';

export interface SetCurrentLocationArgs {
  readonly place: string;
}

interface SetCurrentLocationSaved {
  readonly status: 'saved';
  readonly place: ChatPlace;
  readonly previous_place?: ChatPlace;
}

type SetCurrentLocationResult = SetCurrentLocationSaved | PlaceAsk;

export interface LocationToolInput {
  readonly profileId: string | undefined;
  readonly getHomePlace: () => DevicePlace | undefined;
  readonly setTurnHomePlace: (place: DevicePlace) => void;
  readonly lookup?: (text: string) => Promise<PlaceLookup>;
  readonly pick?: PickPlace;
}

const ARGS_SCHEMA: z.ZodType<SetCurrentLocationArgs> = z
  .object({
    place: z
      .string()
      .trim()
      .min(2, 'place must name a city (at least 2 characters)')
      .max(80)
      .describe('City and region/country where the user currently lives or is now, e.g. "Novato, CA" or "Pune, India".'),
  })
  .strict();

const DESCRIPTION = [
  'Save the city where the user currently lives or is right now on this device.',
  'Call this whenever the user tells you their current city (e.g. "I am in Novato, CA", "I live in London", or answering where they are).',
  'Persists across all threads and reloads, and immediately updates read_period for this turn.',
  'Returns only { label, timezone }; coordinates never leave this device.',
].join(' ');

function persistProfileCurrentPlace(profileId: string | undefined, place: DevicePlace): void {
  if (!profileId || place.latitude === undefined || place.longitude === undefined) return;
  const store = useProfilesStore.getState();
  const targetId = store.profiles[profileId] ? profileId : store.activeProfileId;
  if (!targetId || !store.profiles[targetId]) return;
  const stored: CurrentPlace = {
    label: place.label,
    timezone: place.timezone,
    latitude: place.latitude,
    longitude: place.longitude,
  };
  store.setCurrentPlace(targetId, stored);
}

export function createSetCurrentLocationTool(input: LocationToolInput): ToolDef<SetCurrentLocationArgs> {
  return defineTool({
    name: SET_CURRENT_LOCATION_TOOL_NAME,
    description: DESCRIPTION,
    input: ARGS_SCHEMA,
    timeoutMs: READ_PERIOD_TIMEOUT_MS,
    statusLabel: SET_CURRENT_LOCATION_STATUS_LABEL,
    unlocksAnswer: (result) => (result as { status?: string } | null)?.status === 'saved',
    execute: async (args, context): Promise<SetCurrentLocationResult> => {
      const previous = input.getHomePlace();
      const outcome = await resolveChatPlace(
        args.place,
        {
          threadPlace: undefined,
          homePlace: previous,
          ...(input.lookup ? { lookup: input.lookup } : {}),
          ...(input.pick ? { pick: input.pick } : {}),
        },
        context.signal,
      );
      if (outcome.kind === 'ask') return outcome.result;
      if (outcome.kind === 'none') {
        return { status: 'place_not_found', ask: 'Ask for the nearest larger city.' };
      }
      persistProfileCurrentPlace(input.profileId, outcome.place);
      input.setTurnHomePlace(outcome.place);
      const saved: ChatPlace = { label: outcome.place.label, timezone: outcome.place.timezone };
      return {
        status: 'saved',
        place: saved,
        ...(previous?.label ? { previous_place: { label: previous.label, timezone: previous.timezone } } : {}),
      };
    },
  });
}
