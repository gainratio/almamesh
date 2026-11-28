/**
 * Encrypted provider credential storage in device-local SQLite (`device` namespace).
 * Tokens are sealed with AES-GCM-256 using `deviceKey.ts` and bound to the provider's
 * row key via AAD so moving ciphertext across keys fails authentication.
 */
import { type DeviceRows, deviceRows } from '@almamesh/store';
import type { DriveProviderId } from './backupDrive';
import { getDeviceKey } from './deviceKey';

export const CREDENTIAL_ROW_PREFIX = 'drive-credential/';
export const DRIVE_ROW_PREFIX = 'drive-';
const IV_BYTES = 12;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface StoredCredential {
  readonly accessToken: string;
  readonly expiresAt: number;
  readonly refreshToken?: string;
}

export interface CredentialStore {
  read(provider: DriveProviderId): Promise<StoredCredential | null>;
  write(provider: DriveProviderId, credential: StoredCredential): Promise<void>;
  remove(provider: DriveProviderId): Promise<void>;
}

interface SealedEnvelope {
  readonly v: 1;
  readonly iv: string;
  readonly ct: string;
}

const toBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function isStoredCredential(value: unknown): value is StoredCredential {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.accessToken !== 'string' || candidate.accessToken.length === 0) return false;
  if (typeof candidate.expiresAt !== 'number' || !Number.isFinite(candidate.expiresAt)) return false;
  return candidate.refreshToken === undefined || typeof candidate.refreshToken === 'string';
}

async function sealCredential(rowKey: string, credential: StoredCredential, key: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(IV_BYTES)));
  const additionalData = encoder.encode(rowKey);
  const plaintext = encoder.encode(JSON.stringify(credential));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData }, key, plaintext);
  const envelope: SealedEnvelope = { v: 1, iv: toBase64(iv), ct: toBase64(new Uint8Array(encrypted)) };
  return JSON.stringify(envelope);
}

async function openCredential(rowKey: string, raw: string, key: CryptoKey): Promise<StoredCredential | null> {
  const parsed = JSON.parse(raw) as Partial<SealedEnvelope>;
  if (parsed.v !== 1 || typeof parsed.iv !== 'string' || typeof parsed.ct !== 'string') return null;
  const iv = fromBase64(parsed.iv);
  if (iv.byteLength !== IV_BYTES) return null;
  const additionalData = encoder.encode(rowKey);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData }, key, fromBase64(parsed.ct));
  const candidate: unknown = JSON.parse(decoder.decode(decrypted));
  return isStoredCredential(candidate) ? candidate : null;
}

export function createCredentialStore(
  rows: DeviceRows = deviceRows,
  keyLoader: () => Promise<CryptoKey> = getDeviceKey,
): CredentialStore {
  const keyOf = (provider: DriveProviderId): string => `${CREDENTIAL_ROW_PREFIX}${provider}`;
  return {
    read: async (provider) => {
      const rowKey = keyOf(provider);
      const raw = await rows.read(rowKey);
      if (raw === null) return null;
      try {
        const opened = await openCredential(rowKey, raw, await keyLoader());
        if (opened === null) await rows.remove([rowKey]);
        return opened;
      } catch {
        await rows.remove([rowKey]);
        return null;
      }
    },
    write: async (provider, credential) => {
      const rowKey = keyOf(provider);
      await rows.write(rowKey, await sealCredential(rowKey, credential, await keyLoader()));
    },
    remove: async (provider) => rows.remove([keyOf(provider)]),
  };
}

export const credentialStore: CredentialStore = createCredentialStore();

/** Deletes all device-local Drive rows (`drive-*`), preserving `device-code`. */
export async function deleteDriveDeviceRows(rows: DeviceRows = deviceRows): Promise<void> {
  const existing = await rows.list(DRIVE_ROW_PREFIX);
  const keys = [...existing.keys()];
  if (keys.length > 0) await rows.remove(keys);
}
