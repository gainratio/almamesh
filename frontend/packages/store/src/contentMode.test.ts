import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CONTENT_MODE_PREFERENCE_KEY,
  hydrateContentModePreference,
  useContentModeStore,
} from './contentMode';
import {
  flushPortablePersistence,
  portablePreferenceStorage,
  setPortableStateRepositoryForTests,
} from './deletionTombstones';

describe('content mode portable preference', () => {
  beforeEach(() => {
    setPortableStateRepositoryForTests(null);
    useContentModeStore.setState({ contentMode: 'layman' });
  });

  afterEach(() => {
    setPortableStateRepositoryForTests(undefined);
  });

  it('persists a toggle through the canonical preference adapter', async () => {
    useContentModeStore.getState().setContentMode('technical');
    await flushPortablePersistence();
    await expect(portablePreferenceStorage.getItem(CONTENT_MODE_PREFERENCE_KEY)).resolves.toBe(
      JSON.stringify({ contentMode: 'technical' }),
    );
  });

  it('hydrates the in-memory store from the canonical preference adapter', async () => {
    await portablePreferenceStorage.setItem(
      CONTENT_MODE_PREFERENCE_KEY,
      JSON.stringify({ contentMode: 'technical' }),
    );

    await expect(hydrateContentModePreference()).resolves.toBe('technical');
    expect(useContentModeStore.getState().contentMode).toBe('technical');
  });
});
