import { useSyncExternalStore, type ReactNode } from 'react';
import { portableStatePersistence, subscribePortableStatePersistence } from '@almamesh/store';
import { DatabaseUnavailableCard, StorageBlockedScreen } from './storage/StorageBlockedScreen';
import { useStorageRecheck } from './storage/useStorageRecheck';

/**
 * AlmaMesh keeps product data in one on-device SQLite database: on OPFS, or in
 * memory for this tab when the browser refuses OPFS (Safari Private Browsing;
 * InMemoryStorageNotice says nothing is kept, and the page renders).
 *
 * - site storage refused (Safari "Block all cookies" makes every storage API
 *   throw) or an OPFS probe that never answers: show the block screen with
 *   this browser's steps and an in-place "Check again";
 * - no on-device database can start at all: say so instead of hydrating forever;
 * - 'pending', 'opfs' and 'memory': render the page (it shows its own loading state).
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
