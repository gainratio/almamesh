/**
 * The "user committed new birth information" payload.
 *
 * Onboarding, Rectify and Settings pass it to `requestRegeneration` (see
 * `regenerationRequests.ts`) and await the result; exactly one runner (wired in
 * `App.tsx`) regenerates the chart. This used to travel on a fire-and-forget
 * `mitt` bus, which let pages navigate before the chart existed.
 */

import type { BirthMeta } from './adapters/chart';

/** Payload emitted whenever the user commits new/edited birth information. */
export interface BirthInfoChanged {
  readonly birth: BirthMeta;
  /** The owning profile, or null when no profile is active yet (first run). */
  readonly profileId: string | null;
}
