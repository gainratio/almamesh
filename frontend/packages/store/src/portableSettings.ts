/**
 * Device settings that travel with a backup (format v2).
 *
 * Canonical personal data lives in portable SQLite. These keys live in
 * localStorage instead, and they include secrets (the AI provider API key), so
 * they only ever leave the device inside the passphrase-encrypted bundle
 * (`portableBundle.ts`). Language is not listed here: it is already a canonical
 * SQLite row.
 */

/**
 * localStorage keys carried by an export: AI provider, models, and API key.
 * A literal (not an import of `@almamesh/llm`'s LLM_SETTINGS_KEY) so modules
 * that mock the llm package still load; a test pins the two together.
 */
export const PORTABLE_SETTINGS_KEYS: readonly string[] = ['almamesh-llm-settings'];

/** Raw localStorage values keyed by their storage key. */
export type PortableSettings = Readonly<Record<string, string>>;

/** Read every carried setting that exists on this device. */
export function collectPortableSettings(storage: Pick<Storage, 'getItem'>): PortableSettings {
  const settings: Record<string, string> = {};
  for (const key of PORTABLE_SETTINGS_KEYS) {
    const value = storage.getItem(key);
    if (value !== null) settings[key] = value;
  }
  return settings;
}

/** Keep only allowlisted string values (a bundle is untrusted input). */
export function filterPortableSettings(candidate: unknown): PortableSettings {
  const settings: Record<string, string> = {};
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return settings;
  }
  for (const key of PORTABLE_SETTINGS_KEYS) {
    const value = (candidate as Record<string, unknown>)[key];
    if (typeof value === 'string') settings[key] = value;
  }
  return settings;
}

/** Replace this device's carried settings with the bundle's (absent keys are removed). */
export function applyPortableSettings(
  storage: Pick<Storage, 'setItem' | 'removeItem'>,
  settings: PortableSettings,
): void {
  const carried = filterPortableSettings(settings);
  for (const key of PORTABLE_SETTINGS_KEYS) {
    const value = carried[key];
    if (value === undefined) storage.removeItem(key);
    else storage.setItem(key, value);
  }
}
