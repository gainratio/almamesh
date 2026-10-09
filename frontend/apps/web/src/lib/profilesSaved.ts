/**
 * The one wait a surface runs before it says a person was added, or navigates
 * as if they were. The profiles store changes memory at once and writes SQLite
 * later; a full page load in between used to lose the person.
 *
 * - A failed SQLite/OPFS write rejects with `ProfilesSaveError('failed')`.
 * - A write that never settles (another tab holds the dataset lease) rejects
 *   with `ProfilesSaveError('timed_out')` after `PROFILES_SAVE_TIMEOUT_MS`, so
 *   the surface shows its retry instead of "saving" forever.
 *
 * Either way it logs a fixed console code and never the cause, which could
 * carry a person's name. Same contract as `waitForChartSaved`.
 */
import { safeWarn } from '@almamesh/shared-types';
import { whenProfilesCommitted } from '@almamesh/store';

/** One SQLite row; same bound as a chart save (see `CHART_SAVE_TIMEOUT_MS`). */
export const PROFILES_SAVE_TIMEOUT_MS = 30_000;

export type ProfilesSaveFailure = 'failed' | 'timed_out';

export class ProfilesSaveError extends Error {
  readonly reason: ProfilesSaveFailure;

  constructor(reason: ProfilesSaveFailure) {
    super(reason === 'failed' ? 'The person could not be saved.' : 'Saving the person timed out.');
    this.name = 'ProfilesSaveError';
    this.reason = reason;
  }
}

/** Resolve once the profiles row is on disk; reject (and log a code) otherwise. */
export async function waitForProfilesSaved(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ProfilesSaveError('timed_out')), PROFILES_SAVE_TIMEOUT_MS);
  });
  try {
    await Promise.race([whenProfilesCommitted(), timedOut]);
  } catch (error) {
    const failure = error instanceof ProfilesSaveError ? error : new ProfilesSaveError('failed');
    safeWarn(failure.reason === 'timed_out' ? 'people.save_timed_out' : 'people.save_failed');
    throw failure;
  } finally {
    clearTimeout(timer);
  }
}
