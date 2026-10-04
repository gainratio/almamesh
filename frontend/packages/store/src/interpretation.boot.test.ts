import { describe, expect, it } from 'vitest';

import {
  INTERPRETATION_QUARANTINE_KEY,
  interpretationsWereSetAside,
  useInterpretationStore,
  whenInterpretationHydrated,
} from './interpretation';

// Own file on purpose: the set-aside notice is page-load (module) state, so a
// fresh module proves THIS boot raised it, not an earlier test.
const NAME = 'almamesh-interpretations';

function memoryStorage(entries: Record<string, string>) {
  const map = new Map(Object.entries(entries));
  return {
    map,
    getItem: (name: string) => map.get(name) ?? null,
    setItem: (name: string, value: string) => void map.set(name, value),
    removeItem: (name: string) => void map.delete(name),
  };
}

describe('interpretation store boot with an unreadable saved row', () => {
  it('a corrupt legacy row settles hydration and raises the set-aside notice', async () => {
    const original = (globalThis as { localStorage?: unknown }).localStorage;
    const legacy = memoryStorage({ [NAME]: 'reset-proof' });
    (globalThis as { localStorage?: unknown }).localStorage = legacy;
    try {
      void useInterpretationStore.persist.rehydrate();
      const outcome = await Promise.race([
        whenInterpretationHydrated(),
        new Promise((resolve) => setTimeout(() => resolve('hung'), 500)),
      ]);
      expect(outcome).toEqual({ status: 'hydrated' });
      expect(useInterpretationStore.getState().byChart).toEqual({});
      expect(legacy.map.get(INTERPRETATION_QUARANTINE_KEY)).toContain('reset-proof');
      expect(interpretationsWereSetAside()).toBe(true);
    } finally {
      (globalThis as { localStorage?: unknown }).localStorage = original;
    }
  });
});
