import { supportsPortableState } from '@almamesh/store';
import { safeWarn } from '@almamesh/shared-types';

import { removeDerivedDb } from './derivedDb';
import { periodSkyRows } from './periodSkyRows';

/** Node/prerender has no durable derived database. The browser never falls back. */
export async function deletePeriodSkyForProfile(profileId: string): Promise<void> {
  if (supportsPortableState()) await periodSkyRows().deleteForProfile(profileId);
}

export async function clearPeriodSky(): Promise<void> {
  if (supportsPortableState()) await periodSkyRows().clear();
}

export async function removeDerivedData(): Promise<void> {
  if (!supportsPortableState()) return;
  // Clear personal rows before removing the reference-data database. Another
  // open tab may still hold its connection, so removal itself is best effort.
  await periodSkyRows().clear();
  await removeDerivedDb().catch(() => safeWarn('lifecycle.derived_database_remove_failed'));
}
