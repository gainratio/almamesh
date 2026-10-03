/**
 * Content Mode Store - Zustand state for interpretation display preferences.
 *
 * Manages the global "For You" (layman) vs "For Astrologer" (technical) toggle
 * that applies to all interpretation sections across the app.
 *
 * SQLite owns the preference. A synchronous in-memory view is hydrated before
 * the app renders; Web Storage is not a fallback or mirror.
 */

import { create, StateCreator } from 'zustand';
import { portablePreferenceStorage } from './deletionTombstones';

export type ContentMode = 'layman' | 'technical';
export const CONTENT_MODE_PREFERENCE_KEY = 'almamesh-content-mode';

function decodeContentMode(raw: string | null): ContentMode | null {
  if (raw === null) return null;
  try {
    const mode = (JSON.parse(raw) as { contentMode?: unknown }).contentMode;
    return mode === 'layman' || mode === 'technical' ? mode : null;
  } catch {
    return null;
  }
}

function persistContentMode(mode: ContentMode): void {
  try {
    const pending = portablePreferenceStorage.setItem(
      CONTENT_MODE_PREFERENCE_KEY,
      JSON.stringify({ contentMode: mode }),
    );
    void Promise.resolve(pending).catch(() => undefined);
  } catch {
    // The in-memory UI preference remains usable for this session.
  }
}

export interface ContentModeStore {
  // State
  contentMode: ContentMode;

  // Actions
  setContentMode: (mode: ContentMode) => void;
  toggleContentMode: () => void;
}

/**
 * Content mode store state creator (without persistence)
 */
export const contentModeStoreCreator: StateCreator<ContentModeStore> = (set) => ({
  contentMode: 'layman',

  setContentMode: (mode) => {
    set({ contentMode: mode });
    persistContentMode(mode);
  },

  toggleContentMode: () =>
    set((state) => {
      const contentMode = state.contentMode === 'layman' ? 'technical' : 'layman';
      persistContentMode(contentMode);
      return { contentMode };
    }),
});

/** Content mode store with canonical SQLite persistence and an in-memory view. */
export const useContentModeStore = create<ContentModeStore>()(contentModeStoreCreator);

/** Hydrate from SQLite after mirror migration and before application render. */
export async function hydrateContentModePreference(): Promise<ContentMode> {
  const raw = await portablePreferenceStorage.getItem(CONTENT_MODE_PREFERENCE_KEY);
  const contentMode = decodeContentMode(raw) ?? 'layman';
  useContentModeStore.setState({ contentMode });
  return contentMode;
}
