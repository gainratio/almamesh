/**
 * The one wait a surface runs before it says user data is saved, or moves on
 * as if it were. Each persisted store changes memory at once and writes SQLite
 * later; a full page load in between used to lose the write (a person added on
 * /mesh, a life-event note, the last chat answer).
 *
 * - A failed SQLite/OPFS write rejects with `StoreSaveError('failed')`.
 * - A write that never settles (another tab holds the dataset lease) rejects
 *   with `StoreSaveError('timed_out')` after `STORE_SAVE_TIMEOUT_MS`, so the
 *   surface shows its retry instead of "saving" forever.
 *
 * Either way it logs a fixed console code and never the cause, which could
 * carry a name or a message. Same contract as `waitForChartSaved`.
 */
import { safeWarn, type SafeDiagnosticCode } from '@almamesh/shared-types';
import { whenChatCommitted, whenLifeEventsCommitted, whenProfilesCommitted } from '@almamesh/store';

/** One SQLite row; same bound as a chart save (see `CHART_SAVE_TIMEOUT_MS`). */
export const STORE_SAVE_TIMEOUT_MS = 30_000;

export type SavedStore = 'people' | 'life_events' | 'chat';

export type StoreSaveFailure = 'failed' | 'timed_out';

interface StoreBarrier {
  readonly committed: () => Promise<void>;
  readonly codes: Readonly<Record<StoreSaveFailure, SafeDiagnosticCode>>;
}

const BARRIERS: Readonly<Record<SavedStore, StoreBarrier>> = {
  people: {
    committed: whenProfilesCommitted,
    codes: { failed: 'people.save_failed', timed_out: 'people.save_timed_out' },
  },
  life_events: {
    committed: whenLifeEventsCommitted,
    codes: { failed: 'life_events.save_failed', timed_out: 'life_events.save_timed_out' },
  },
  chat: {
    committed: whenChatCommitted,
    codes: { failed: 'chat.save_failed', timed_out: 'chat.save_timed_out' },
  },
};

export class StoreSaveError extends Error {
  readonly store: SavedStore;
  readonly reason: StoreSaveFailure;

  constructor(store: SavedStore, reason: StoreSaveFailure) {
    super(reason === 'failed' ? `Saving ${store} failed.` : `Saving ${store} timed out.`);
    this.name = 'StoreSaveError';
    this.store = store;
    this.reason = reason;
  }
}

/** Resolve once `store`'s row is on disk; reject (and log a code) otherwise. */
export async function waitForStoreSaved(store: SavedStore): Promise<void> {
  const barrier = BARRIERS[store];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new StoreSaveError(store, 'timed_out')), STORE_SAVE_TIMEOUT_MS);
  });
  try {
    await Promise.race([barrier.committed(), timedOut]);
  } catch (error) {
    const failure =
      error instanceof StoreSaveError ? error : new StoreSaveError(store, 'failed');
    safeWarn(barrier.codes[failure.reason]);
    throw failure;
  } finally {
    clearTimeout(timer);
  }
}
