import { describe, expect, it } from 'vitest';

import { interpretationQuarantineRows } from './deletionTombstones';
import {
  interpretationsWereSetAside,
  useInterpretationStore,
  whenInterpretationHydrated,
} from './interpretation';
import { readInterpretationQuarantine } from './interpretationQuarantine';

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
      // Held in the SQLite-side quarantine, never written back to localStorage.
      const held = await readInterpretationQuarantine(await interpretationQuarantineRows());
      expect(held.map((record) => record.raw)).toEqual(['reset-proof']);
      expect(legacy.map.has('almamesh-interpretations.quarantine')).toBe(false);
      expect(interpretationsWereSetAside()).toBe(true);
    } finally {
      (globalThis as { localStorage?: unknown }).localStorage = original;
    }
  });
});
