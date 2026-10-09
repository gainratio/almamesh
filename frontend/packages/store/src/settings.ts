/**
 * Settings Store - Zustand state for pending settings changes (in-memory, no persistence)
 *
 * Spec 036 (Cache Consolidation): Removed persist middleware.
 * Settings are fetched from API endpoint /users/me/settings.
 */

import { create, StateCreator } from 'zustand';
import type { DstFold } from './adapters/localBirthTime';

export type RegenerationScope = 'none' | 'interpretation' | 'chart+interpretation';

/**
 * Structural shape of a resolved birth location (mirrors the web app's
 * `LocationResult`). Declared here so the store stays self-contained — it must
 * not depend on a consumer-app component. Any `LocationResult` is structurally
 * assignable to this.
 */
export interface PendingLocationValue {
  displayName: string;
  city: string;
  state: string;
  country: string;
  lat: number;
  lon: number;
  timezone?: string;
}

/**
 * The full set of birth-info fields a pending edit can target, each typed to
 * the value it actually carries. Text fields are `string`; `birth_location`
 * carries a structured location (or `null` when cleared).
 */
export interface PendingChanges {
  name: string;
  birth_date: string;
  birth_time: string;
  birth_location: PendingLocationValue | null;
  rectified_time: string;
  time_confidence: string;
  /** The chosen occurrence of a repeated DST hour; '' clears a stale choice. */
  dst_fold: DstFold | '';
}

/** A field that a pending edit can target. */
export type PendingChangeField = keyof PendingChanges;

export interface SettingsState {
  /** Only the fields the user has edited are present (others fall back to the source profile). */
  pendingChanges: Partial<PendingChanges>;
  regenerationScope: RegenerationScope;
  estimatedCost: number;
  isDirty: boolean;
}

export interface SettingsActions {
  setPendingChange: <K extends PendingChangeField>(field: K, value: PendingChanges[K]) => void;
  clearPendingChanges: () => void;
  calculateRegenerationScope: (regenerationFields: Record<string, { scope: RegenerationScope; base_cost: number }>) => void;
  reset: () => void;
}

export type SettingsStore = SettingsState & SettingsActions;

const initialState: SettingsState = {
  pendingChanges: {},
  regenerationScope: 'none',
  estimatedCost: 0,
  isDirty: false,
};

export const settingsStoreCreator: StateCreator<SettingsStore> = (set, get) => ({
  ...initialState,

  setPendingChange: (field, value) => {
    const newPendingChanges = { ...get().pendingChanges, [field]: value };
    set({
      pendingChanges: newPendingChanges,
      isDirty: Object.keys(newPendingChanges).length > 0,
    });
  },

  clearPendingChanges: () => {
    set({
      pendingChanges: {},
      regenerationScope: 'none',
      estimatedCost: 0,
      isDirty: false,
    });
  },

  calculateRegenerationScope: (regenerationFields) => {
    const { pendingChanges } = get();
    let maxScope: RegenerationScope = 'none';
    let totalCost = 0;

    Object.keys(pendingChanges).forEach((field) => {
      const fieldMeta = regenerationFields[field];
      if (fieldMeta) {
        totalCost += fieldMeta.base_cost;
        if (fieldMeta.scope === 'chart+interpretation') {
          maxScope = 'chart+interpretation';
        } else if (fieldMeta.scope === 'interpretation' && maxScope !== 'chart+interpretation') {
          maxScope = 'interpretation';
        }
      }
    });

    set({
      regenerationScope: maxScope,
      estimatedCost: totalCost,
    });
  },

  reset: () => {
    set(initialState);
  },
});

/**
 * Settings store (in-memory only, no persistence)
 *
 * Spec 036 (Cache Consolidation): Removed persistence.
 * Settings are fetched from API endpoint.
 */
export const useSettingsStore = create<SettingsStore>()(settingsStoreCreator);
