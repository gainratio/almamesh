import { useCallback, useRef, useState } from 'react';
import { checkPortableStorageAgain, siteStorageBlocked } from '@almamesh/store';
import { safeWarn } from '@almamesh/shared-types';
import { requestPersistentStorage } from '../../lib/storagePermission';

export type RecheckStatus = 'idle' | 'checking' | 'still-blocked';

export interface StorageRecheck {
  /** Whole-site storage refused (localStorage throws), as of the last check. */
  readonly siteBlocked: boolean;
  readonly status: RecheckStatus;
  /** Re-run the SQLite/OPFS probe in place. Never reloads the page. */
  readonly checkAgain: () => Promise<void>;
  /** Ask for persistent storage (a real prompt in Firefox), then check again. */
  readonly allowStorage: () => Promise<void>;
}

async function probe(askFirst: boolean): Promise<boolean> {
  try {
    if (askFirst) await requestPersistentStorage();
    const next = await checkPortableStorageAgain();
    // 'pending' means storage is allowed and SQLite is still opening: not blocked.
    return next !== 'blocked' && next !== 'unavailable' && !siteStorageBlocked();
  } catch (error) {
    // The screen stays up and says "Still blocked"; the cause goes to the console.
    safeWarn('storage.opfs_unavailable', error);
    return false;
  }
}

export function useStorageRecheck(): StorageRecheck {
  const [siteBlocked, setSiteBlocked] = useState(siteStorageBlocked);
  const [status, setStatus] = useState<RecheckStatus>('idle');
  const running = useRef(false);

  const run = useCallback(async (askFirst: boolean) => {
    if (running.current) return;
    running.current = true;
    setStatus('checking');
    const allowed = await probe(askFirst);
    running.current = false;
    setSiteBlocked(siteStorageBlocked());
    setStatus(allowed ? 'idle' : 'still-blocked');
  }, []);

  const checkAgain = useCallback(() => run(false), [run]);
  const allowStorage = useCallback(() => run(true), [run]);
  return { siteBlocked, status, checkAgain, allowStorage };
}
