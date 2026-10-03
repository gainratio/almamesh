/**
 * Compatibility decoder for the separate settings section in legacy v2
 * backups. Current v3 backups keep these values in canonical SQLite.
 */

/**
 * Legacy-v2 localStorage keys accepted during import: provider, models and key.
 * A literal (not an import of `@almamesh/llm`'s LLM_SETTINGS_KEY) so modules
 * that mock the llm package still load; a test pins the two together.
 */
export const PORTABLE_SETTINGS_KEYS: readonly string[] = ['almamesh-llm-settings'];

/** Raw localStorage values keyed by their storage key. */
export type PortableSettings = Readonly<Record<string, string>>;

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
