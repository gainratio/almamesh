import { describe, expect, it } from 'vitest';

import { setPortableStateRepositoryForTests } from './deletionTombstones';
import { useInterpretationStore, whenInterpretationHydrated } from './interpretation';
import { PortableStateRepository } from './portableState';
import { PortableMemoryStore } from './portableMemoryStore.testkit';

// Own file: it breaks the durable read for the whole module on purpose.
describe('interpretation store hydration error', () => {
  it('settles the boot barrier as failed instead of hanging the first render', async () => {
    const broken = new PortableMemoryStore();
    broken.list = async () => {
      throw new Error('SQLite unavailable mid-boot');
    };
    setPortableStateRepositoryForTests(new PortableStateRepository(broken));
    try {
      void useInterpretationStore.persist.rehydrate();
      const outcome = await Promise.race([
        whenInterpretationHydrated(),
        new Promise((resolve) => setTimeout(() => resolve('hung'), 500)),
      ]);
      expect(outcome).toMatchObject({ status: 'failed' });
    } finally {
      setPortableStateRepositoryForTests(undefined);
    }
  });
});
