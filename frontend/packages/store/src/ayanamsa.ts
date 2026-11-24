/**
 * Ayanamsa Store — Zustand state for the sidereal zero-point convention.
 *
 * Mirrors `contentMode.ts`: SQLite owns the portable preference (`almamesh-ayanamsa`),
 * hydrated before the first render. Defaults to `'LAHIRI'` (official Chitrapaksha)
 * so existing charts and golden outputs remain 100% unchanged unless the user
 * selects another convention in Settings.
 */

import { create, type StateCreator } from 'zustand';
import type { AyanamsaType } from '@almamesh/browser/types';
import { portablePreferenceStorage } from './deletionTombstones';

export const AYANAMSA_PREFERENCE_KEY = 'almamesh-ayanamsa';
export const DEFAULT_AYANAMSA: AyanamsaType = 'LAHIRI';
export const SUPPORTED_AYANAMSAS: readonly AyanamsaType[] = [
  'LAHIRI',
  'TRUE_CHITRA',
  'RAMAN',
  'KP',
  'FAGAN_BRADLEY',
];

export function isSupportedAyanamsa(value: unknown): value is AyanamsaType {
  return typeof value === 'string' && (SUPPORTED_AYANAMSAS as readonly string[]).includes(value);
}

function decodeAyanamsa(raw: string | null): AyanamsaType | null {
  if (raw === null) return null;
  try {
    const parsed = (JSON.parse(raw) as { ayanamsa?: unknown }).ayanamsa;
    return isSupportedAyanamsa(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function persistAyanamsa(ayanamsa: AyanamsaType): void {
  try {
    const pending = portablePreferenceStorage.setItem(
      AYANAMSA_PREFERENCE_KEY,
      JSON.stringify({ ayanamsa }),
    );
    void Promise.resolve(pending).catch(() => undefined);
  } catch {
    // In-memory session preference remains usable when durable storage is unavailable.
  }
}

export interface AyanamsaStore {
  ayanamsa: AyanamsaType;
  setAyanamsa: (ayanamsa: AyanamsaType) => void;
}

export const ayanamsaStoreCreator: StateCreator<AyanamsaStore> = (set) => ({
  ayanamsa: DEFAULT_AYANAMSA,
  setAyanamsa: (ayanamsa) => {
    const next = isSupportedAyanamsa(ayanamsa) ? ayanamsa : DEFAULT_AYANAMSA;
    set({ ayanamsa: next });
    persistAyanamsa(next);
  },
});

export const useAyanamsaStore = create<AyanamsaStore>()(ayanamsaStoreCreator);

/** Hydrate from canonical SQLite before first render. */
export async function hydrateAyanamsaPreference(): Promise<AyanamsaType> {
  const raw = await portablePreferenceStorage.getItem(AYANAMSA_PREFERENCE_KEY);
  const ayanamsa = decodeAyanamsa(raw) ?? DEFAULT_AYANAMSA;
  useAyanamsaStore.setState({ ayanamsa });
  return ayanamsa;
}
