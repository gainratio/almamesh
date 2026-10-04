/**
 * Profiles store — named, password-less people sharing one device.
 *
 * Multiple people use one browser; each profile owns its OWN saved charts.
 * Fully local-first: no account, no login, no server. Persisted as one row in
 * the canonical OPFS SQLite database, mirroring the chartLibrary pattern.
 *
 * Coupling: this store does NOT import chartLibrary directly. It pushes the
 * active profile id into chartLibrary via `setActiveProfileScope` (a thin
 * setter) so chart listing/primacy filters by the active person. chartLibrary
 * stays unaware of *what* a profile is — it only knows a scope id. This keeps
 * the two stores decoupled while letting "primary chart" resolve per-person.
 */

import { create, type StateCreator } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { useShallow } from 'zustand/react/shallow';
import {
  MEMBER_RELATIONSHIPS,
  type MemberRelationship,
  type Relationship,
} from '@almamesh/shared-types';

import {
  cascadeDeleteCharts,
  setActiveProfileScope,
  useChartLibraryStore,
  whenChartLibraryHydrated,
} from './chartLibrary';
import { assignOrphanChatThreads, whenChatHydrated } from './chat';
import { deletionAwareIdbStorage } from './deletionTombstones';
import { whenHydrated, type HydrationOutcome } from './hydrationBarrier';

/** A named person on this device. No credentials — local-first by design. */
export interface Profile {
  readonly id: string;
  readonly name: string;
  /** ISO-8601 creation timestamp; also the stable list ordering key. */
  readonly createdAt: string;
  /** A brass/lapis/planet accent hex used to tint the avatar chip. */
  readonly avatarTint: string;
  /**
   * Mesh relationship to the anchor. `self` marks the ONE anchor profile
   * (assigned via `setAnchor`); members carry a backend-aligned value; legacy
   * or unassigned profiles stay `undefined` (plain switchable users).
   */
  readonly relationship?: Relationship;
  /** The anchor profile id a member relates to (kept truthful by the store). */
  readonly relatedTo?: string;
}

/** One canonical SQLite row holding all profiles, persisted by Zustand. */
const PERSIST_NAME = 'almamesh-profiles';

/** Bump when the persisted `Profile` shape changes; always pair with `migrate`. */
export const PROFILES_PERSIST_VERSION = 1;

/** The slice of the store that `partialize` actually persists. */
export interface PersistedProfilesState {
  readonly profiles: Readonly<Record<string, Profile>>;
  readonly activeProfileId: string | null;
}

/** A plain (non-array) object — the only shape `profiles` may safely take. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * v0 → v1: profiles gained OPTIONAL `relationship`/`relatedTo` (the mesh
 * people layer). A v0 payload is a structural subset of v1, so legacy people
 * load unchanged — they stay plain switchable users with no relationship.
 * Deliberately NO auto-anointed anchor: the user marks "this is me".
 *
 * Also defensive: tolerate ANY old/unknown/corrupt persisted blob and always
 * return a valid `{ profiles, activeProfileId }`. A returning visitor whose
 * stored profiles map is malformed (a string, an array, a missing field) must
 * never crash the app — we fall back to clean defaults rather than throwing.
 */
export function migrateProfilesPersistedState(
  persisted: unknown,
  _fromVersion: number,
): PersistedProfilesState {
  if (!isPlainRecord(persisted)) {
    return { profiles: {}, activeProfileId: null };
  }
  const profiles = isPlainRecord(persisted.profiles)
    ? (persisted.profiles as PersistedProfilesState['profiles'])
    : {};
  const rawActive = persisted.activeProfileId;
  const activeProfileId =
    typeof rawActive === 'string' && rawActive in profiles ? rawActive : null;
  return { profiles, activeProfileId };
}

/**
 * Avatar tints, drawn from the observatory accent + planet palette
 * (@almamesh/constants colors). Assigned round-robin by creation order so two
 * people are visually distinct without any random source — deterministic and
 * testable.
 */
const AVATAR_TINTS: readonly string[] = [
  '#C9A24B', // brass-gold
  '#3A4FB0', // lapis
  '#C84A3A', // mars oxide-red
  '#5FA88A', // mercury verdigris
  '#C98AA8', // venus rose
  '#D9A23B', // jupiter amber
  '#5468C8', // lapis interactive
  '#D8D4C6', // moon silver
];

function tintForIndex(index: number): string {
  return AVATAR_TINTS[index % AVATAR_TINTS.length] ?? AVATAR_TINTS[0];
}

/**
 * Generate a profile id. Uses `crypto.randomUUID` where available (all real
 * browsers + Node test env), with a deterministic-enough counter fallback so
 * the store never throws in an exotic runtime.
 */
let idFallbackCounter = 0;
function nextProfileId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) {
    return c.randomUUID();
  }
  idFallbackCounter += 1;
  return `profile-${Date.now()}-${idFallbackCounter}`;
}

/** Typed outcome of `setAnchor` — a second self is rejected, never silent. */
export type SetAnchorResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'not-found' }
  | { readonly ok: false; readonly reason: 'anchor-exists'; readonly anchorId: string };

/** Typed outcome of `setRelationship`. */
export type SetRelationshipResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'not-found' | 'self-requires-set-anchor' };

export interface ProfilesStore {
  /** All profiles, keyed by id. */
  readonly profiles: Readonly<Record<string, Profile>>;
  /** The active person, or null when none exist yet. */
  readonly activeProfileId: string | null;
  /** True once Zustand has rehydrated from portable storage. */
  readonly hydrated: boolean;

  /** Create a person; the FIRST profile created becomes active. Returns its id. */
  createProfile: (name: string) => string;
  renameProfile: (id: string, name: string) => void;
  /**
   * Delete a person. THROWS when it is the last remaining profile (at least one
   * must always exist). Cascade-deletes the person's charts from the chart
   * library, and re-points `activeProfileId` to the earliest remaining profile
   * when the deleted one was active. No-op for an unknown id.
   */
  deleteProfile: (id: string) => void;
  setActiveProfile: (id: string) => void;

  /**
   * Mark a profile as the anchor ("this is me"). EXACTLY ONE profile may be
   * `self`: marking while a DIFFERENT anchor exists is rejected with
   * `anchor-exists` (unmark or reassign first); re-marking the current anchor
   * is an ok no-op. On success, every member's `relatedTo` is synced to the
   * new anchor id (including pre-anchor assignments being backfilled).
   */
  setAnchor: (id: string) => SetAnchorResult;
  /**
   * Assign a member relationship (spouse/mother/…) to a profile. `relatedTo`
   * is linked to the current anchor, or backfilled by a later `setAnchor`.
   * Assigning to the current anchor demotes it (the mesh loses its anchor).
   * `self` is refused at runtime — anchors go through `setAnchor`.
   */
  setRelationship: (id: string, relationship: MemberRelationship) => SetRelationshipResult;
  /** Remove a profile's relationship (and its anchor status when it is self). */
  clearRelationship: (id: string) => void;

  getActiveProfile: () => Profile | undefined;
  /** All profiles ordered by `createdAt` (stable creation order). */
  listProfiles: () => Profile[];

  /** The anchor profile (`relationship === 'self'`), if the user assigned one. */
  getAnchorProfile: () => Profile | undefined;
  /** Members (related, non-self), sorted by relationship order, then name. */
  listMembers: () => Profile[];
  /** True when an anchor AND at least one member exist — the mesh can form. */
  isMeshReady: () => boolean;

  /**
   * Wipe every profile and reset active focus — the "start fresh" reset.
   * Unlike `deleteProfile` this is unconditional (no last-profile guard) and
   * pushes the now-empty scope into the chart library so listing resolves to
   * nothing. Pair with the other stores' `clearAll`; the user re-onboards from
   * a clean slate.
   */
  clearAll: () => void;
}

/** The anchor (`relationship === 'self'`) in a profiles record, if any. */
export function anchorProfileOf(
  profiles: Readonly<Record<string, Profile>>,
): Profile | undefined {
  return Object.values(profiles).find((p) => p.relationship === 'self');
}

/** Members (related, non-self) sorted by canonical relationship order, then name. */
export function listMembersOf(profiles: Readonly<Record<string, Profile>>): Profile[] {
  const rank = (r: MemberRelationship): number => MEMBER_RELATIONSHIPS.indexOf(r);
  return Object.values(profiles)
    .filter(
      (p): p is Profile & { relationship: MemberRelationship } =>
        p.relationship !== undefined && p.relationship !== 'self',
    )
    .sort((a, b) => rank(a.relationship) - rank(b.relationship) || a.name.localeCompare(b.name));
}

/** The mesh can form once an anchor and at least one member exist. */
export function meshReadyOf(profiles: Readonly<Record<string, Profile>>): boolean {
  return anchorProfileOf(profiles) !== undefined && listMembersOf(profiles).length > 0;
}

/**
 * Keep `relatedTo` truthful everywhere: members point at the current anchor
 * (or nothing while no anchor exists); the anchor and plain profiles carry
 * none. Preserves object identity for untouched profiles.
 */
function normalizeRelatedTo(profiles: Record<string, Profile>): Record<string, Profile> {
  const anchorId = anchorProfileOf(profiles)?.id;
  const next: Record<string, Profile> = {};
  for (const [id, p] of Object.entries(profiles)) {
    const isMember = p.relationship !== undefined && p.relationship !== 'self';
    const relatedTo = isMember ? anchorId : undefined;
    next[id] = p.relatedTo === relatedTo ? p : { ...p, relatedTo };
  }
  return next;
}

/** The earliest-created remaining profile id (stable reassignment target). */
function firstByCreatedAt(profiles: Record<string, Profile>): string | null {
  return (
    Object.keys(profiles).sort((a, b) =>
      profiles[a].createdAt.localeCompare(profiles[b].createdAt),
    )[0] ?? null
  );
}

/**
 * Pure delete: drop the profile, cascade-clear relationship references to it
 * (a deleted anchor's members revert to plain profiles — their "mother of…"
 * label is meaningless without the person it pointed at), and re-point active
 * focus if it was active.
 */
function removeProfile(
  state: ProfilesStore,
  id: string,
): Pick<ProfilesStore, 'profiles' | 'activeProfileId'> {
  const profiles: Record<string, Profile> = {};
  for (const [pid, p] of Object.entries(state.profiles)) {
    if (pid === id) {
      continue;
    }
    profiles[pid] =
      p.relatedTo === id ? { ...p, relationship: undefined, relatedTo: undefined } : p;
  }
  const activeProfileId =
    state.activeProfileId === id ? firstByCreatedAt(profiles) : state.activeProfileId;
  return { profiles, activeProfileId };
}

export const profilesStoreCreator: StateCreator<ProfilesStore> = (set, get) => ({
  profiles: {},
  activeProfileId: null,
  hydrated: false,

  createProfile: (name) => {
    const id = nextProfileId();
    set((state) => {
      const index = Object.keys(state.profiles).length;
      const profile: Profile = {
        id,
        name: name.trim() || 'Me',
        createdAt: new Date().toISOString(),
        avatarTint: tintForIndex(index),
      };
      const profiles = { ...state.profiles, [id]: profile };
      // First profile created claims active focus; later ones do not.
      const activeProfileId = state.activeProfileId ?? id;
      return { profiles, activeProfileId };
    });
    setActiveProfileScope(get().activeProfileId);
    return id;
  },

  renameProfile: (id, name) => {
    set((state) => {
      const existing = state.profiles[id];
      if (!existing) {
        return state;
      }
      const next = { ...existing, name: name.trim() || existing.name };
      return { profiles: { ...state.profiles, [id]: next } };
    });
  },

  deleteProfile: (id) => {
    const { profiles } = get();
    if (!profiles[id]) {
      return;
    }
    if (Object.keys(profiles).length <= 1) {
      throw new Error('Cannot delete the last profile — at least one person must remain.');
    }
    set((state) => removeProfile(state, id));
    // Cascade: remove the person's charts, then push the new active scope.
    cascadeDeleteCharts(id);
    setActiveProfileScope(get().activeProfileId);
  },

  setActiveProfile: (id) => {
    set((state) => (state.profiles[id] ? { activeProfileId: id } : state));
    setActiveProfileScope(get().activeProfileId);
  },

  setAnchor: (id) => {
    const { profiles } = get();
    if (!profiles[id]) {
      return { ok: false, reason: 'not-found' };
    }
    const anchor = anchorProfileOf(profiles);
    if (anchor && anchor.id !== id) {
      return { ok: false, reason: 'anchor-exists', anchorId: anchor.id };
    }
    set((state) => {
      const target = state.profiles[id];
      if (!target) {
        return state;
      }
      const marked: Profile = { ...target, relationship: 'self', relatedTo: undefined };
      return { profiles: normalizeRelatedTo({ ...state.profiles, [id]: marked }) };
    });
    return { ok: true };
  },

  setRelationship: (id, relationship) => {
    if ((relationship as Relationship) === 'self') {
      return { ok: false, reason: 'self-requires-set-anchor' };
    }
    if (!get().profiles[id]) {
      return { ok: false, reason: 'not-found' };
    }
    set((state) => {
      const target = state.profiles[id];
      if (!target) {
        return state;
      }
      const related: Profile = { ...target, relationship };
      return { profiles: normalizeRelatedTo({ ...state.profiles, [id]: related }) };
    });
    return { ok: true };
  },

  clearRelationship: (id) => {
    set((state) => {
      const target = state.profiles[id];
      if (!target) {
        return state;
      }
      const cleared: Profile = { ...target, relationship: undefined, relatedTo: undefined };
      return { profiles: normalizeRelatedTo({ ...state.profiles, [id]: cleared }) };
    });
  },

  getActiveProfile: () => {
    const { activeProfileId, profiles } = get();
    return activeProfileId ? profiles[activeProfileId] : undefined;
  },

  listProfiles: () =>
    Object.values(get().profiles).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),

  getAnchorProfile: () => anchorProfileOf(get().profiles),

  listMembers: () => listMembersOf(get().profiles),

  isMeshReady: () => meshReadyOf(get().profiles),

  clearAll: () => {
    set({ profiles: {}, activeProfileId: null });
    setActiveProfileScope(null);
  },
});

export const useProfilesStore = create<ProfilesStore>()(
  persist<ProfilesStore, [], [], PersistedProfilesState>(profilesStoreCreator, {
    name: PERSIST_NAME,
    version: PROFILES_PERSIST_VERSION,
    migrate: migrateProfilesPersistedState,
    storage: createJSONStorage(() => deletionAwareIdbStorage),
    partialize: (state) => ({
      profiles: state.profiles,
      activeProfileId: state.activeProfileId,
    }),
    onRehydrateStorage: () => (state) => {
      // Push the rehydrated active scope into chartLibrary so per-profile chart
      // resolution is correct on first paint, then mark hydrated.
      setActiveProfileScope(state?.activeProfileId ?? null);
      useProfilesStore.setState({ hydrated: true });
    },
  }),
);

// ---------------------------------------------------------------------------
// Mesh selector hooks (React) — thin, render-stable views over the profiles.
// ---------------------------------------------------------------------------

/** The anchor profile ("this is me"), or undefined until the user assigns one. */
export function useAnchorProfile(): Profile | undefined {
  return useProfilesStore((s) => anchorProfileOf(s.profiles));
}

/** Mesh members (related, non-self profiles), relationship-sorted. */
export function useMembers(): Profile[] {
  return useProfilesStore(useShallow((s) => listMembersOf(s.profiles)));
}

/** True once the mesh can form: an anchor plus at least one member. */
export function useMeshReady(): boolean {
  return useProfilesStore((s) => meshReadyOf(s.profiles));
}

/**
 * Resolve once the profiles store has finished rehydrating from portable storage.
 * Mirrors `whenChartLibraryHydrated` — await before any read that must reflect
 * the persisted truth (avoids the async-rehydrate false-empty race).
 */
export function whenProfilesHydrated(): Promise<HydrationOutcome> {
  return whenHydrated(useProfilesStore.persist);
}

/**
 * One-shot, idempotent migration so existing charts AND chat threads survive the
 * introduction of named profiles (no data loss). After ALL three stores
 * rehydrate:
 *
 *   - if no profiles exist yet AND there are charts on the device, create a
 *     default profile ("Me"), make it active, and assign every orphan
 *     (profile-less) chart AND chat thread to it;
 *   - if profiles already exist with one active, claim any remaining orphan
 *     charts and chat threads into the active profile.
 *
 * Idempotent: a second run finds no orphans / already-created profile and does
 * nothing. Safe to call on every app boot.
 */
export async function runProfileMigration(): Promise<void> {
  await Promise.all([whenProfilesHydrated(), whenChartLibraryHydrated(), whenChatHydrated()]);

  const profiles = useProfilesStore.getState();
  const hasCharts = useChartLibraryStore.getState().listAllCharts().length > 0;
  const hasProfiles = profiles.listProfiles().length > 0;

  const target =
    !hasProfiles && hasCharts ? profiles.createProfile('Me') : profiles.activeProfileId;
  if (!target) {
    return;
  }
  useChartLibraryStore.getState().assignOrphanChartsToProfile(target);
  assignOrphanChatThreads(target);
}
