import { useSyncExternalStore, type ReactNode } from 'react';
import { portableStatePersistence, subscribePortableStatePersistence } from '@almamesh/store';
import { DatabaseUnavailableCard, StorageBlockedScreen } from './storage/StorageBlockedScreen';
import { useStorageRecheck } from './storage/useStorageRecheck';

/**
 * AlmaMesh keeps product data in one persistent on-device SQLite database
 * (OPFS). That is the only option: there is no in-memory fallback.
 *
 * - site storage refused (Safari "Block all cookies" makes every storage API
 *   throw) or OPFS refused (private windows, blocked site data): show the
 *   block screen with this browser's steps and an in-place "Check again";
 * - no on-device database can start at all: say so instead of hydrating forever;
 * - 'pending' and 'opfs': render the page (it shows its own loading state).
 */
interface StorageGateProps {
  readonly children: ReactNode;
}

export function StorageGate({ children }: StorageGateProps) {
  const persistence = useSyncExternalStore(
    subscribePortableStatePersistence,
    portableStatePersistence,
    portableStatePersistence,
  );
  const recheck = useStorageRecheck();
  if (recheck.siteBlocked) return <StorageBlockedScreen reason="site-storage-blocked" recheck={recheck} />;
  if (persistence === 'blocked') return <StorageBlockedScreen reason="storage-blocked" recheck={recheck} />;
  if (persistence === 'unavailable') return <DatabaseUnavailableCard />;
  return <>{children}</>;
}
