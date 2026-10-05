/**
 * Found by the portable-state invariants e2e: after deleting a person, a
 * language change in the same tab was silently dropped and reverted on reload.
 * The tab's own deletion moved the dataset generation, but its preference
 * hydration epochs stayed on the old one, so the fence refused every later
 * preference write. Preferences are not part of the dataset generation; the
 * tab's own commit must carry them forward.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  beginDatasetMutation,
  commitDatasetGeneration,
  flushPortablePersistence,
  portablePreferenceStorage,
  setPortableStateRepositoryForTests,
} from './deletionTombstones';
import { PortableMemoryStore } from './portableMemoryStore.testkit';
import { PortableStateRepository } from './portableState';

const LANGUAGE = 'almamesh-language';

function language(code: string): string {
  return JSON.stringify({ state: { language: code }, version: 1 });
}

afterEach(() => setPortableStateRepositoryForTests(undefined));

describe('preferences after this tab deletes a person', () => {
  it('keeps saving a language change made after the deletion', async () => {
    const repository = new PortableStateRepository(new PortableMemoryStore());
    setPortableStateRepositoryForTests(repository);
    await portablePreferenceStorage.setItem(LANGUAGE, language('en'));
    await flushPortablePersistence();
    await portablePreferenceStorage.getItem(LANGUAGE);

    const epoch = await beginDatasetMutation();
    await commitDatasetGeneration(
      epoch,
      [{ key: 'almamesh-profiles', value: JSON.stringify({ state: { profiles: {} }, version: 1 }) }],
      { adoptLocalWrites: true },
    );
    await portablePreferenceStorage.setItem(LANGUAGE, language('es'));
    await flushPortablePersistence();

    expect(await repository.read(LANGUAGE)).toBe(language('es'));
  });

  it('still refuses a preference write from a tab that hydrated before another tab replaced the data', async () => {
    const repository = new PortableStateRepository(new PortableMemoryStore());
    setPortableStateRepositoryForTests(repository);
    await portablePreferenceStorage.setItem(LANGUAGE, language('en'));
    await flushPortablePersistence();
    await portablePreferenceStorage.getItem(LANGUAGE);

    // Another realm imports a backup: a new generation that carries its own language.
    const epoch = await beginDatasetMutation();
    await commitDatasetGeneration(epoch, [{ key: LANGUAGE, value: language('pt') }]);
    await portablePreferenceStorage.setItem(LANGUAGE, language('es'));
    await flushPortablePersistence();

    expect(await repository.read(LANGUAGE)).toBe(language('pt'));
  });

  it('keeps saving a language change made after Start fresh in the same tab', async () => {
    const repository = new PortableStateRepository(new PortableMemoryStore());
    setPortableStateRepositoryForTests(repository);
    await portablePreferenceStorage.setItem(LANGUAGE, language('en'));
    await flushPortablePersistence();
    await portablePreferenceStorage.getItem(LANGUAGE);

    const epoch = await beginDatasetMutation();
    await commitDatasetGeneration(epoch, [{ key: 'almamesh-profiles', value: null }]);
    await portablePreferenceStorage.setItem(LANGUAGE, language('es'));
    await flushPortablePersistence();

    expect(await repository.read(LANGUAGE)).toBe(language('es'));
  });
});
