/**
 * Non-extractable AES-GCM-256 device key stored in IndexedDB (`almamesh-device-keys`).
 * Owner ruling R0: this database holds ONLY one non-extractable CryptoKey handle —
 * never user data, never tokens. Credentials live encrypted in device-local SQLite.
 */
import { portableStatePersistence } from '@almamesh/store';

export const DEVICE_KEY_DB = 'almamesh-device-keys';
const STORE_NAME = 'keys';
const KEY_ID = 'credential-key';
const DELETE_BLOCKED_FALLBACK_MS = 2_000;

let inflightKey: Promise<CryptoKey> | null = null;

function isNonExtractableKey(value: unknown): value is CryptoKey {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<CryptoKey>;
  return candidate.type === 'secret' && candidate.extractable === false;
}

function openKeyDb(create: boolean): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined' || typeof indexedDB.open !== 'function') {
    if (!create) return Promise.resolve(null);
    throw new Error('IndexedDB is unavailable for device key storage.');
  }
  return new Promise((resolve, reject) => {
    const request = create ? indexedDB.open(DEVICE_KEY_DB, 1) : indexedDB.open(DEVICE_KEY_DB);
    let abortedMissing = false;
    request.onupgradeneeded = () => {
      if (!create) {
        abortedMissing = true;
        request.transaction?.abort();
        return;
      }
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => (abortedMissing ? resolve(null) : reject(request.error));
  });
}

function readStoredKey(db: IDBDatabase): Promise<CryptoKey | null> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(KEY_ID);
    req.onsuccess = () => resolve(isNonExtractableKey(req.result) ? req.result : null);
    req.onerror = () => reject(req.error);
  });
}

function writeSingleKey(db: IDBDatabase, key: CryptoKey): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.clear();
    store.put(key, KEY_ID);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function loadOrMintKey(): Promise<CryptoKey> {
  if (portableStatePersistence() === 'memory') {
    throw new Error('Device key storage is disabled while running in in-memory mode.');
  }
  const db = await openKeyDb(true);
  if (db === null) throw new Error('IndexedDB is unavailable for device key storage.');
  try {
    const existing = await readStoredKey(db);
    if (existing !== null) return existing;
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await writeSingleKey(db, key);
    return key;
  } finally {
    db.close();
  }
}

export function getDeviceKey(): Promise<CryptoKey> {
  if (inflightKey === null) {
    inflightKey = loadOrMintKey().finally(() => {
      inflightKey = null;
    });
  }
  return inflightKey;
}

export async function deleteDeviceKey(): Promise<void> {
  await inflightKey?.catch(() => undefined);
  if (typeof indexedDB === 'undefined' || typeof indexedDB.deleteDatabase !== 'function') return;
  await new Promise<void>((resolve, reject) => {
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
    const settle = (fn: () => void) => {
      if (fallbackTimer !== null) clearTimeout(fallbackTimer);
      fn();
    };
    const req = indexedDB.deleteDatabase(DEVICE_KEY_DB);
    req.onsuccess = () => settle(resolve);
    req.onblocked = () => {
      // Wait for open handles' onversionchange to close and fire onsuccess; bound if wedged.
      if (fallbackTimer === null) fallbackTimer = setTimeout(resolve, DELETE_BLOCKED_FALLBACK_MS);
    };
    req.onerror = () => settle(() => reject(req.error ?? new Error('Failed to delete device key database.')));
  });
}

export async function readDeviceKeyRecords(): Promise<readonly { key: IDBValidKey; value: unknown }[]> {
  if (typeof indexedDB?.databases === 'function') {
    const dbs = await indexedDB.databases();
    if (!dbs.some((entry) => entry.name === DEVICE_KEY_DB)) return [];
  }
  const db = await openKeyDb(false);
  if (db === null) return [];
  try {
    return await new Promise((resolve, reject) => {
      const store = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME);
      const keysReq = store.getAllKeys();
      const valsReq = store.getAll();
      valsReq.onsuccess = () =>
        resolve(keysReq.result.map((key, idx) => ({ key, value: valsReq.result[idx] })));
      valsReq.onerror = () => reject(valsReq.error);
    });
  } finally {
    db.close();
  }
}
