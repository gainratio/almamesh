import {
  configureLlmSettingsPersistence,
  hydrateLlmSettings,
  LLM_SETTINGS_KEY,
} from '@almamesh/llm';
import {
  hydrateContentModePreference,
  portablePreferenceStorage,
  useLanguageStore,
  whenChartLibraryHydrated,
  whenInterpretationHydrated,
} from '@almamesh/store';
import {
  hydrateSlowModelSuggestion,
  MODEL_SUGGESTION_DISMISSED_KEY,
} from './modelSuggestion';

/**
 * Establish SQLite preference authority before any status/settings consumer
 * renders. Opening the adapter performs verified one-time legacy migration;
 * synchronous consumers use only these in-memory snapshots.
 */
export async function initializePortablePreferences(): Promise<void> {
  configureLlmSettingsPersistence(async (serialized) => {
    await portablePreferenceStorage.setItem(LLM_SETTINGS_KEY, serialized);
  });
  await rehydratePortablePreferences();
}

/** Refresh every synchronous preference snapshot from canonical SQLite. */
export async function rehydratePortablePreferences(): Promise<void> {
  hydrateLlmSettings(await portablePreferenceStorage.getItem(LLM_SETTINGS_KEY));
  await hydrateContentModePreference();
  hydrateSlowModelSuggestion(
    await portablePreferenceStorage.getItem(MODEL_SUGGESTION_DISMISSED_KEY),
  );
}

/**
 * Hydrate every SQLite-backed value needed by the first React render.
 * Route guards can then read chart state synchronously without a Web Storage
 * mirror, and language/settings consumers start from the imported dataset.
 */
export async function initializePortableState(): Promise<void> {
  await initializePortablePreferences();
  await Promise.all([
    useLanguageStore.persist.hasHydrated()
      ? Promise.resolve()
      : useLanguageStore.persist.rehydrate(),
    whenChartLibraryHydrated(),
    whenInterpretationHydrated(),
  ]);
}
