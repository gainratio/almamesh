/**
 * Durable, user-paid AI narrations for deterministic relationship edges.
 *
 * The engine-computed mesh edge remains derived and is rebuilt on demand. Only
 * a successfully completed narration is persisted, with the complete input
 * identity needed to prove it still describes the edge currently on screen.
 */

import type {
  MeshReading,
  PromptLanguage,
  ReadingProvenance,
  ViewMode,
} from '@almamesh/llm';
import { create, type StateCreator } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import {
  deletionAwareIdbStorage,
  mergeDeletionAwarePersistedValue,
} from './deletionTombstones';
import { whenHydrated, type HydrationOutcome } from './hydrationBarrier';

export const MESH_READINGS_PERSIST_KEY = 'almamesh-mesh-readings';
export const MESH_READINGS_PERSIST_VERSION = 1;

export interface MeshReadingIdentity {
  /** Stable anchor/member slot. */
  readonly pairKey: string;
  /** Explicit owners make profile deletion independent of key parsing. */
  readonly profileIds: readonly [string, string];
  /** Both births, relationship, roles and the deterministic timing window. */
  readonly edgeRequestKey: string;
  readonly language: PromptLanguage;
}

export interface MeshReadingEntry extends MeshReadingIdentity {
  /** Prompt foreground at generation time; both voices are still persisted. */
  readonly generationMode: ViewMode;
  readonly provider: ReadingProvenance;
  readonly generatedAt: string;
  readonly reading: MeshReading;
}

export interface PersistedMeshReadingsState {
  readonly byPair: Readonly<Record<string, MeshReadingEntry>>;
}

export interface MeshReadingsStore extends PersistedMeshReadingsState {
  saveCompleted(entry: MeshReadingEntry): Promise<void>;
  getExact(identity: MeshReadingIdentity): MeshReadingEntry | undefined;
  deleteForProfile(profileId: string): void;
  clearAll(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPersona(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.title === 'string' &&
    typeof value.layman === 'string' &&
    typeof value.technical === 'string'
  );
}

function isMeshReadingEntry(value: unknown, pairKey: string): value is MeshReadingEntry {
  if (!isRecord(value)) return false;
  const profileIds = value.profileIds;
  const provider = value.provider;
  const reading = value.reading;
  return (
    value.pairKey === pairKey &&
    Array.isArray(profileIds) &&
    profileIds.length === 2 &&
    profileIds.every((profileId) => typeof profileId === 'string' && profileId.length > 0) &&
    typeof value.edgeRequestKey === 'string' &&
    value.edgeRequestKey.length > 0 &&
    (value.language === 'en' || value.language === 'es' || value.language === 'pt') &&
    (value.generationMode === 'layman' || value.generationMode === 'expert') &&
    isRecord(provider) &&
    provider.engine === 'openai-http' &&
    typeof provider.model === 'string' &&
    (provider.baseUrl === undefined || typeof provider.baseUrl === 'string') &&
    typeof value.generatedAt === 'string' &&
    isRecord(reading) &&
    isPersona(reading.connection) &&
    isPersona(reading.timing_together) &&
    isPersona(reading.care)
  );
}

export function meshReadingIdentityMatches(
  entry: MeshReadingEntry,
  identity: MeshReadingIdentity,
): boolean {
  return (
    entry.pairKey === identity.pairKey &&
    entry.profileIds[0] === identity.profileIds[0] &&
    entry.profileIds[1] === identity.profileIds[1] &&
    entry.edgeRequestKey === identity.edgeRequestKey &&
    entry.language === identity.language
  );
}

export function migrateMeshReadingsPersistedState(
  persisted: unknown,
  _fromVersion: number,
): PersistedMeshReadingsState {
  if (!isRecord(persisted) || !isRecord(persisted.byPair)) return { byPair: {} };
  const byPair: Record<string, MeshReadingEntry> = {};
  for (const [pairKey, value] of Object.entries(persisted.byPair)) {
    if (isMeshReadingEntry(value, pairKey)) byPair[pairKey] = value;
  }
  return { byPair };
}

function mergeCompletedPair(
  currentRaw: string | null,
  incomingRaw: string,
  pairKey: string,
): string {
  const incomingEnvelope = isRecord(JSON.parse(incomingRaw))
    ? (JSON.parse(incomingRaw) as Record<string, unknown>)
    : {};
  const incomingState = isRecord(incomingEnvelope.state) ? incomingEnvelope.state : {};
  const incoming = migrateMeshReadingsPersistedState(incomingState, MESH_READINGS_PERSIST_VERSION)
    .byPair[pairKey];
  if (incoming === undefined) throw new Error('Completed mesh reading is missing from persistence.');

  let currentByPair: Readonly<Record<string, MeshReadingEntry>> = {};
  let currentEnvelope: Record<string, unknown> = {};
  if (currentRaw !== null) {
    const parsed = JSON.parse(currentRaw) as unknown;
    if (isRecord(parsed)) {
      currentEnvelope = parsed;
      currentByPair = migrateMeshReadingsPersistedState(
        isRecord(parsed.state) ? parsed.state : {},
        MESH_READINGS_PERSIST_VERSION,
      ).byPair;
    }
  }
  return JSON.stringify({
    ...currentEnvelope,
    ...incomingEnvelope,
    state: { byPair: { ...currentByPair, [pairKey]: incoming } },
    version: MESH_READINGS_PERSIST_VERSION,
  });
}

let suppressMeshPersistence = false;
const meshReadingsStorage = {
  getItem: deletionAwareIdbStorage.getItem,
  setItem: (name: string, value: string) => {
    return suppressMeshPersistence
      ? Promise.resolve()
      : deletionAwareIdbStorage.setItem(name, value);
  },
  removeItem: deletionAwareIdbStorage.removeItem,
};

type PersistCompletedMeshReading = (
  entry: MeshReadingEntry,
  localByPair: Readonly<Record<string, MeshReadingEntry>>,
) => Promise<Readonly<Record<string, MeshReadingEntry>>>;

export function createMeshReadingsStoreCreator(
  persistCompleted?: PersistCompletedMeshReading,
): StateCreator<MeshReadingsStore> {
  return (set, get) => ({
  byPair: {},

  saveCompleted: async (entry) => {
    const localByPair = get().byPair;
    const byPair = persistCompleted === undefined
      ? { ...localByPair, [entry.pairKey]: entry }
      : await persistCompleted(entry, localByPair);
    // The CAS merge above is already canonical. Update only the live selector;
    // never follow it with a whole-row write that could erase another tab's pair.
    suppressMeshPersistence = true;
    try {
      set({ byPair });
    } finally {
      suppressMeshPersistence = false;
    }
  },

  getExact: (identity) => {
    const entry = get().byPair[identity.pairKey];
    return entry !== undefined && meshReadingIdentityMatches(entry, identity) ? entry : undefined;
  },

  deleteForProfile: (profileId) => {
    set((state) => ({
      byPair: Object.fromEntries(
        Object.entries(state.byPair).filter(
          ([, entry]) => !entry.profileIds.includes(profileId),
        ),
      ),
    }));
  },

  clearAll: () => set({ byPair: {} }),
  });
}

/** In-memory creator used by pure unit tests. */
export const meshReadingsStoreCreator = createMeshReadingsStoreCreator();

async function persistCompletedEntry(
  entry: MeshReadingEntry,
  localByPair: Readonly<Record<string, MeshReadingEntry>>,
): Promise<Readonly<Record<string, MeshReadingEntry>>> {
  const incoming = JSON.stringify({
    state: { byPair: { ...localByPair, [entry.pairKey]: entry } },
    version: MESH_READINGS_PERSIST_VERSION,
  });
  const merged = await mergeDeletionAwarePersistedValue(
    MESH_READINGS_PERSIST_KEY,
    (current) => mergeCompletedPair(current, incoming, entry.pairKey),
  );
  const envelope = JSON.parse(merged) as unknown;
  return migrateMeshReadingsPersistedState(
    isRecord(envelope) && isRecord(envelope.state) ? envelope.state : {},
    MESH_READINGS_PERSIST_VERSION,
  ).byPair;
}

export const useMeshReadingsStore = create<MeshReadingsStore>()(
  persist<MeshReadingsStore, [], [], PersistedMeshReadingsState>(
    createMeshReadingsStoreCreator(persistCompletedEntry),
    {
    name: MESH_READINGS_PERSIST_KEY,
    version: MESH_READINGS_PERSIST_VERSION,
    migrate: migrateMeshReadingsPersistedState,
    storage: createJSONStorage(() => meshReadingsStorage),
    partialize: (state) => ({ byPair: state.byPair }),
    },
  ),
);

export function whenMeshReadingsHydrated(): Promise<HydrationOutcome> {
  return whenHydrated(useMeshReadingsStore.persist);
}
