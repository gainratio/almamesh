import {
  portableStatePersistence,
  siteStorageBlocked,
  subscribePortableStatePersistence,
  type PortableStatePersistence,
} from '@almamesh/store';

/** The persistence signals startup needs (injected in tests). */
export interface StorageStartupDeps {
  readonly read: () => PortableStatePersistence;
  readonly subscribe: (listener: () => void) => () => void;
  readonly siteBlocked: () => boolean;
}

export type StartupOutcome = 'ready' | 'blocked';

const STORE_DEPS: StorageStartupDeps = {
  read: portableStatePersistence,
  subscribe: subscribePortableStatePersistence,
  siteBlocked: siteStorageBlocked,
};

/**
 * Whether the app can render now. Hydration waits (by design) while the
 * browser refuses storage, so the first render must not wait for it: as soon
 * as storage is reported blocked, startup renders the block screen instead of
 * a blank page. A failed hydration is 'ready' too, so the app can explain it.
 */
export function startupOutcome(
  hydration: Promise<void>,
  deps: StorageStartupDeps = STORE_DEPS,
): Promise<StartupOutcome> {
  if (deps.siteBlocked() || deps.read() === 'blocked') return Promise.resolve('blocked');
  return new Promise((resolve) => {
    const unsubscribe = deps.subscribe(() => {
      if (deps.read() !== 'blocked') return;
      unsubscribe();
      resolve('blocked');
    });
    hydration.then(
      () => {
        unsubscribe();
        resolve('ready');
      },
      () => {
        unsubscribe();
        resolve('ready');
      },
    );
  });
}
