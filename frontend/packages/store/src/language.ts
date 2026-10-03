/**
 * Language store — the on-device, local-first persistence for the UI + AI
 * language preference. There is no backend and no account: the choice lives in
 * the portable on-device SQLite database and survives a refresh / PWA reopen.
 *
 * Default language is DETECTED from `navigator.language` on first run (es* → es,
 * pt* → pt, everything else → en), then the user's explicit choice (persisted)
 * takes over. The web app wires `setLanguage` to `i18n.changeLanguage(lang)` and
 * `document.documentElement.lang`, and threads `language` into the LLM prompts so
 * readings/chat answer in the chosen language.
 *
 * Production persistence is canonical SQLite. Node-based SSR/tests use the
 * explicit in-memory fallback seam.
 */

import { create, type StateCreator } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { portablePreferenceStorage } from './deletionTombstones';

/** The supported UI + AI languages (kept in lockstep with i18next `supportedLngs`). */
export type Language = 'en' | 'es' | 'pt';

/** Portable SQLite key for the persisted language choice. */
export const LANGUAGE_PERSIST_NAME = 'almamesh-language';

/** Bump when the persisted language shape changes; always pair with `migrate`. */
export const LANGUAGE_PERSIST_VERSION = 1;

/** The slice of the store that `partialize` actually persists. */
export interface PersistedLanguageState {
  readonly language: Language;
}

const SUPPORTED_LANGUAGES: readonly Language[] = ['en', 'es', 'pt'];

/**
 * Defensive hydration: tolerate ANY old/unknown/corrupt persisted blob and
 * always return a valid `{ language }`. A returning visitor whose stored value
 * is malformed (or an unsupported tag from a future build) must never crash the
 * app — we fall back to English. Mirrors `migrateProfilesPersistedState`.
 */
export function migrateLanguagePersistedState(
  persisted: unknown,
  _fromVersion: number,
): PersistedLanguageState {
  if (persisted === null || typeof persisted !== 'object') {
    return { language: 'en' };
  }
  const raw = (persisted as { language?: unknown }).language;
  const language =
    typeof raw === 'string' && SUPPORTED_LANGUAGES.includes(raw as Language)
      ? (raw as Language)
      : 'en';
  return { language };
}

/**
 * Map a raw BCP-47 tag (e.g. `es-AR`, `pt-BR`, `en-US`) to a supported language.
 * Anything outside Spanish/Portuguese falls back to English.
 */
export function detectLanguage(raw: string | undefined | null): Language {
  const tag = (raw ?? '').toLowerCase();
  if (tag.startsWith('es')) {
    return 'es';
  }
  if (tag.startsWith('pt')) {
    return 'pt';
  }
  return 'en';
}

/**
 * The boot-time default: the browser's preferred language, mapped to a supported
 * one. Used by the i18n init (`lng`) so the very first render is already in the
 * right language before the store hydrates.
 */
export function getInitialLanguage(): Language {
  const nav = (globalThis as { navigator?: { language?: string } }).navigator;
  return detectLanguage(nav?.language);
}

export interface LanguageStore {
  /** The active language: persisted, defaults to the detected browser language. */
  language: Language;
  /** Set the active language (persisted). */
  setLanguage: (language: Language) => void;
}

const languageStoreCreator: StateCreator<LanguageStore> = (set) => ({
  language: getInitialLanguage(),
  setLanguage: (language) => set({ language }),
});

/**
 * Persisted language store. Only the `language` field is written; the actions
 * are recreated on rehydrate. Production uses portable SQLite exclusively;
 * legacy Web Storage is read only by the one-time migration boundary.
 */
export const useLanguageStore = create<LanguageStore>()(
  persist<LanguageStore, [], [], PersistedLanguageState>(languageStoreCreator, {
    name: LANGUAGE_PERSIST_NAME,
    version: LANGUAGE_PERSIST_VERSION,
    migrate: migrateLanguagePersistedState,
    storage: createJSONStorage(() => portablePreferenceStorage),
    partialize: (state) => ({ language: state.language }),
  }),
);
