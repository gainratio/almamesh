import {
  configureLlmSettingsPersistence,
  hydrateLlmSettings,
  LLM_SETTINGS_KEY,
} from '@almamesh/llm';
import {
  hydrateContentModePreference,
  markPortableStateUnavailable,
  portablePreferenceStorage,
  runProfileMigration,
  useLanguageStore,
  whenChartLibraryHydrated,
  whenChatHydrated,
  whenInterpretationHydrated,
  whenProfilesHydrated,
} from '@almamesh/store';
import { safeWarn } from '@almamesh/shared-types';
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
  try {
    await initializePortablePreferences();
    const stores = [
      whenChartLibraryHydrated(),
      whenProfilesHydrated(),
      whenChatHydrated(),
    ];
    await Promise.all([
      useLanguageStore.persist.hasHydrated()
        ? Promise.resolve()
        : useLanguageStore.persist.rehydrate(),
      // Unreadable interpretations already pause new readings and preserve
      // their rows. They do not prevent the chart and chat from opening.
      whenInterpretationHydrated(),
      ...stores.map(async (hydration) => {
        const outcome = await hydration;
        if (outcome.status === 'failed') {
          throw new Error('SQLite-backed state could not be read.', { cause: outcome.error });
        }
      }),
    ]);
  } catch (error) {
    // An open database does not imply its state was read successfully. Keep
    // route guards and writers behind StorageGate rather than exposing empty
    // default snapshots that could replace the user's existing dataset.
    markPortableStateUnavailable();
    throw error;
  }
}

/** Refuse route guards and background writers until state and ownership are safe. */
export async function preparePortableState(hydration: Promise<void>): Promise<boolean> {
  try {
    await hydration;
    await runProfileMigration();
    return true;
  } catch (error) {
    markPortableStateUnavailable();
    safeWarn('storage.state_open_failed', error);
    return false;
  }
}
