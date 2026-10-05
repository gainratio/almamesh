import { StorageGate } from './StorageGate';
import { UpdateBanner } from './UpdateBanner';

/**
 * What startup renders while the browser refuses storage: the block screen,
 * plus the UpdateBanner, which registers the service worker. Without it a
 * visitor stuck here could never be offered the update that fixes what
 * stranded them (and a gate awaiting `serviceWorker.ready` hung in CI).
 */
export function BlockedStartup() {
  return (
    <>
      <StorageGate>{null}</StorageGate>
      <UpdateBanner />
    </>
  );
}
