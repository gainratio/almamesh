/** In-memory `DeviceRows` and `CredentialStore` doubles for unit tests. */
import type { DeviceRows } from '@almamesh/store';
import type { DriveProviderId } from '../backupDrive';
import type { CredentialStore, StoredCredential } from '../credentialStore';

export function createMemoryDeviceRows(): DeviceRows & { readonly map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    read: async (key) => map.get(key) ?? null,
    write: async (key, value) => {
      map.set(key, value);
    },
    insertIfAbsent: async (key, value) => {
      const cur = map.get(key);
      if (cur !== undefined) return cur;
      map.set(key, value);
      return value;
    },
    remove: async (keys) => {
      for (const key of keys) map.delete(key);
    },
    list: async (prefix) => new Map([...map].filter(([key]) => key.startsWith(prefix))),
  };
}

export function createMemoryCredentials(): CredentialStore & {
  readonly map: Map<DriveProviderId, StoredCredential>;
} {
  const map = new Map<DriveProviderId, StoredCredential>();
  return {
    map,
    read: async (provider) => map.get(provider) ?? null,
    write: async (provider, cred) => {
      map.set(provider, cred);
    },
    remove: async (provider) => {
      map.delete(provider);
    },
  };
}
