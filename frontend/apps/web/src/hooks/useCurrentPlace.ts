/**
 * The active person's "Where do you live now?" place, or undefined when they
 * never set one. Reads the profiles store through `getCurrentPlace`, so a
 * malformed stored value reads as unset. Never falls back to the birthplace.
 */
import { getCurrentPlace, useProfilesStore, type CurrentPlace } from '@almamesh/store';

export function useCurrentPlace(): CurrentPlace | undefined {
  return useProfilesStore((s) => getCurrentPlace(s.activeProfileId ? s.profiles[s.activeProfileId] : undefined));
}
