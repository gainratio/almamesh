/**
 * Ask the browser to keep this site's storage (StorageManager.persist()).
 *
 * Firefox shows the user a real permission prompt; Chromium and Safari answer
 * on their own. It never opens browser settings (no web page can), and a
 * missing or failing API resolves false so the caller can still re-check.
 */
export interface PersistCapableStorage {
  readonly persist?: () => Promise<boolean>;
}

function defaultStorage(): PersistCapableStorage | undefined {
  return typeof navigator === 'undefined' ? undefined : navigator.storage;
}

export async function requestPersistentStorage(
  storage: PersistCapableStorage | undefined = defaultStorage(),
): Promise<boolean> {
  if (typeof storage?.persist !== 'function') return false;
  try {
    return await storage.persist();
  } catch {
    return false;
  }
}
