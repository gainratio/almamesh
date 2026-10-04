import { describe, expect, it } from 'vitest';

import { useInterpretationStore, whenInterpretationHydrated } from './interpretation';

// Own file: it breaks the durable read for the whole module on purpose.
describe('interpretation store hydration error', () => {
  it('settles the boot barrier as failed instead of hanging the first render', async () => {
    const original = (globalThis as { indexedDB?: unknown }).indexedDB;
    (globalThis as { indexedDB?: unknown }).indexedDB = {
      open: () => {
        throw new Error('IndexedDB unavailable mid-boot');
      },
    };
    try {
      void useInterpretationStore.persist.rehydrate();
      const outcome = await Promise.race([
        whenInterpretationHydrated(),
        new Promise((resolve) => setTimeout(() => resolve('hung'), 500)),
      ]);
      expect(outcome).toMatchObject({ status: 'failed' });
    } finally {
      (globalThis as { indexedDB?: unknown }).indexedDB = original;
    }
  });
});
