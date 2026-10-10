/**
 * Device-local SQLite rows (never backed up): this device's backup code and
 * its encrypted drive credentials. They live in the `device` namespace, which
 * no snapshot, export, or restore reads or writes.
 */
import { requirePortableStateRepository } from './deletionTombstones';

export interface DeviceRows {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  remove(keys: readonly string[]): Promise<void>;
  list(prefix: string): Promise<ReadonlyMap<string, string>>;
}

export const DEVICE_CODE_KEY = 'device-code';
const DEVICE_CODE = /^[0-9a-f]{6}$/;

export const deviceRows: DeviceRows = {
  read: async (key) => (await requirePortableStateRepository()).readDevice(key),
  write: async (key, value) => (await requirePortableStateRepository()).writeDevice(key, value),
  remove: async (keys) => (await requirePortableStateRepository()).deleteDevice(keys),
  list: async (prefix) => (await requirePortableStateRepository()).listDevice(prefix),
};

function mintCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(3));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** This device's 6-hex backup code, minted on first use. */
export async function getDeviceCode(rows: DeviceRows = deviceRows): Promise<string> {
  const stored = await rows.read(DEVICE_CODE_KEY);
  if (stored !== null && DEVICE_CODE.test(stored)) return stored;
  const code = mintCode();
  await rows.write(DEVICE_CODE_KEY, code);
  return code;
}
