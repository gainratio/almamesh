/**
 * Life-events store — per-profile, local-first notes the user enters during
 * onboarding (and later) as optional context for MANUAL birth-time
 * rectification.
 *
 * These are plain free-text/dated notes the person writes about their own life
 * (marriage, a career change, a move). The app NEVER auto-matches them to
 * planetary timing — they survive locally so that when the user rectifies their
 * birth time by hand in Settings they have their own reference points to weigh
 * against the live Ascendant.
 *
 * Fully local-first: no account, no server. Persisted as one canonical SQLite
 * row, mirroring the chartLibrary / profiles pattern,
 * keyed by the owning profile id so each person keeps their own notes.
 */

import type { EventDatePrecision, LifeEventCategory } from '@almamesh/shared-types';
import { create, type StateCreator } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { deletionAwareIdbStorage } from './deletionTombstones';
import { whenHydrated, type HydrationOutcome } from './hydrationBarrier';

/** A persisted life-event note belonging to one profile. */
export interface LifeEvent {
  /** Stable id (uuid where available). */
  readonly id: string;
  /**
   * Free-text note from the onboarding capture path (legacy/backward-compat).
   * New events from the structured wizard use `note` instead.
   */
  readonly description?: string;
  /**
   * Structured text note for the rectification wizard path.
   * Also populated from `description` during v1→v2 migration.
   */
  readonly note?: string;
  /**
   * Human-readable description of WHAT happened on this date, in the user's own
   * words (e.g. "Moved to Bangalore for a job"). This is the headline shown for
   * each gathered event so otherwise-identical rows (same date + category) are
   * distinguishable at a glance. Stays fully on-device.
   *
   * Sources: the conversational interview attaches the user's own message text;
   * the manual tray lets the user type/edit it directly; the v3→v4 migration
   * backfills it from any legacy `note`/`description`. Absent ⇒ no summary yet.
   */
  readonly summary?: string;
  /**
   * ISO `YYYY-MM-DD` date of the event.
   * Empty string `""` for migrated/unstructured (needsStructuring) events.
   */
  readonly date: string;
  /**
   * Life-event category for rectification analysis.
   * Absent on migrated legacy events (drafts awaiting user completion).
   */
  readonly category?: LifeEventCategory;
  /**
   * True for events migrated from v1 that still need the user to supply
   * a structured date + category before they can be sent to the engine.
   */
  readonly needsStructuring?: boolean;
  /** How precisely the user knows the date (drives engine weighting). Absent ⇒ treated as 'exact'. */
  readonly precision?: EventDatePrecision;
  /** ISO-8601 creation timestamp; also the stable ordering key within a profile. */
  readonly createdAt: string;
}

/**
 * What a caller supplies to persist an event — id/createdAt are assigned here.
 *
 * Kept draft-tolerant for backward compatibility: the Onboarding page calls
 * `setEvents(profileId, [{ description }])` without a date or category, and
 * that call must continue to typecheck without changes to Onboarding.tsx.
 */
export interface LifeEventInput {
  readonly description: string;
  readonly date?: string;
  /** Typed category supplied by the validated onboarding/rectification structurer. */
  readonly category?: LifeEventCategory;
  /** Honest date precision supplied with a structured row. */
  readonly precision?: EventDatePrecision;
  /** Human-readable "what happened" summary in the user's own words (optional). */
  readonly summary?: string;
}

/** One canonical SQLite row holding all profiles' life events, persisted by Zustand. */
const PERSIST_NAME = 'almamesh-life-events';

/** Bump when the persisted `LifeEvent` shape changes; always pair with `migrate`. */
export const LIFE_EVENTS_PERSIST_VERSION = 4;

/** The slice of the store that `partialize` actually persists. */
export interface PersistedLifeEventsState {
  readonly eventsByProfile: Readonly<Record<string, readonly LifeEvent[]>>;
}

/** A plain (non-array) object — the only shape `eventsByProfile` may safely take. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Coerce a single unknown persisted blob into a valid v2 `LifeEvent`.
 * Called for every event in a profile when migrating from v1 (or v0).
 */
function migrateEventToV2(e: unknown): LifeEvent {
  if (!isPlainRecord(e)) {
    return { id: nextEventId(), date: '', createdAt: new Date().toISOString(), needsStructuring: true };
  }
  // This function is only called when fromVersion < 2 (v0/v1 blobs).
  // Every event is treated as a legacy free-text note: promote to a
  // needsStructuring draft so the user re-enters a structured date + category
  // in the wizard. Do NOT content-sniff for v2 fields — the version gate in
  // migrateLifeEventsPersistedState is the authoritative guard.
  return {
    id: typeof e.id === 'string' ? e.id : nextEventId(),
    note: typeof e.description === 'string' && e.description.length > 0 ? e.description : undefined,
    date: '',
    needsStructuring: true,
    createdAt: typeof e.createdAt === 'string' ? e.createdAt : new Date().toISOString(),
  };
}

/**
 * Coerce a single unknown persisted blob into a valid v3 `LifeEvent`.
 * Called for every event in a profile when migrating from v2.
 * Events that already have a `precision` are passed through unchanged.
 */
function migrateEventToV3(e: unknown): LifeEvent {
  const base = e as LifeEvent;
  return base.precision ? base : { ...base, precision: 'exact' };
}

/**
 * Coerce a single persisted blob into a valid v4 `LifeEvent`.
 * Called for every event when migrating from v3 (or earlier, via the chain).
 *
 * Backfills the human-readable `summary` from any legacy `note`/`description`
 * so existing events become distinguishable in the gathered list — without
 * losing any other field. Events that already have a `summary` (or have no text
 * to derive one from) pass through unchanged.
 */
function migrateEventToV4(e: unknown): LifeEvent {
  const base = e as LifeEvent;
  if (typeof base.summary === 'string') {
    return base;
  }
  const derived = base.note ?? base.description;
  return typeof derived === 'string' && derived.length > 0 ? { ...base, summary: derived } : base;
}

/**
 * Defensive hydration: tolerate ANY old/unknown/corrupt persisted blob and
 * always return a valid `{ eventsByProfile }`. A returning visitor whose stored
 * notes are malformed must never crash the app — we fall back to an empty map.
 *
 * The migration chain is CUMULATIVE: an old store is carried forward through
 * every intermediate step in order, not just the first matching one.
 *   v0/v1 → v2: legacy `{ description }` events become `{ note, date: "", needsStructuring: true }` drafts.
 *   v2 → v3: backfill `precision: 'exact'` on all existing structured events.
 *   v3 → v4: backfill the human-readable `summary` from any legacy `note`/`description`.
 */
export function migrateLifeEventsPersistedState(
  persisted: unknown,
  fromVersion: number,
): PersistedLifeEventsState {
  if (!isPlainRecord(persisted)) {
    return { eventsByProfile: {} };
  }
  const byProfile = persisted.eventsByProfile;
  if (!isPlainRecord(byProfile)) {
    return { eventsByProfile: {} };
  }

  const migrated: Record<string, readonly LifeEvent[]> = {};
  for (const [profileId, events] of Object.entries(byProfile)) {
    let list: readonly LifeEvent[] = Array.isArray(events) ? (events as LifeEvent[]) : [];
    if (fromVersion < 2) {
      list = list.map(migrateEventToV2);
    }
    if (fromVersion < 3) {
      list = list.map(migrateEventToV3);
    }
    if (fromVersion < 4) {
      list = list.map(migrateEventToV4);
    }
    migrated[profileId] = list;
  }
  return { eventsByProfile: migrated };
}

/** Generate an event id (uuid where available, deterministic counter fallback). */
let idFallbackCounter = 0;
function nextEventId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) {
    return c.randomUUID();
  }
  idFallbackCounter += 1;
  return `life-event-${Date.now()}-${idFallbackCounter}`;
}

/**
 * Promote a raw input into a stored event.
 * Blank descriptions are rejected (returns null); callers filter those out.
 * Date defaults to `""` (required field in v2 shape) when not provided.
 */
function toLifeEvent(input: LifeEventInput): LifeEvent | null {
  const description = input.description.trim();
  if (description.length === 0) {
    return null;
  }
  const summary = input.summary?.trim();
  return {
    id: nextEventId(),
    description,
    date: input.date?.trim() ?? '',
    createdAt: new Date().toISOString(),
    ...(input.category ? { category: input.category } : {}),
    ...(input.precision ? { precision: input.precision } : {}),
    ...(summary ? { summary } : {}),
  };
}

/**
 * Returns true when an event has both a non-empty date and a category —
 * i.e. it is fully structured and eligible to be sent to the rectification engine.
 *
 * Events with `needsStructuring: true` (migrated legacy notes) return false until
 * the user fills in date + category in the wizard.
 */
export function isStructuredLifeEvent(e: LifeEvent): boolean {
  return Boolean(e.date) && Boolean(e.category);
}

export interface LifeEventsStore {
  /** All life-event notes, keyed by owning profile id. */
  readonly eventsByProfile: Readonly<Record<string, readonly LifeEvent[]>>;
  /** True once Zustand has rehydrated from portable storage. */
  readonly hydrated: boolean;

  /** Replace a profile's notes with a fresh set (blank descriptions dropped). */
  setEvents: (profileId: string, events: readonly LifeEventInput[]) => void;
  /** Append a single note to a profile (no-op for a blank description). */
  addEvent: (profileId: string, event: LifeEventInput) => void;
  /** A profile's notes in creation order (empty array when none). */
  getEvents: (profileId: string) => readonly LifeEvent[];
  /** Remove every note for a profile (e.g. when the person is deleted). */
  clearEvents: (profileId: string) => void;
  /** Wipe every profile's notes — the "start fresh" reset. */
  clearAll: () => void;
  /**
   * Patch mutable fields on one event. A no-op when `id` is not found.
   * Patchable fields: `date`, `category`, `note`, `summary`, `needsStructuring`, `precision`.
   */
  editEvent: (
    profileId: string,
    id: string,
    patch: Partial<
      Pick<LifeEvent, 'date' | 'category' | 'note' | 'summary' | 'needsStructuring' | 'precision'>
    >,
  ) => void;
  /** Remove a single event by id. A no-op when `id` is not found. */
  removeEvent: (profileId: string, id: string) => void;
}

export const lifeEventsStoreCreator: StateCreator<LifeEventsStore> = (set, get) => ({
  eventsByProfile: {},
  hydrated: false,

  setEvents: (profileId, events) => {
    const mapped = events.map(toLifeEvent).filter((e): e is LifeEvent => e !== null);
    set((state) => ({
      eventsByProfile: { ...state.eventsByProfile, [profileId]: mapped },
    }));
  },

  addEvent: (profileId, event) => {
    const mapped = toLifeEvent(event);
    if (!mapped) {
      return;
    }
    set((state) => ({
      eventsByProfile: {
        ...state.eventsByProfile,
        [profileId]: [...(state.eventsByProfile[profileId] ?? []), mapped],
      },
    }));
  },

  getEvents: (profileId) => get().eventsByProfile[profileId] ?? [],

  clearEvents: (profileId) => {
    set((state) => {
      if (!(profileId in state.eventsByProfile)) {
        return state;
      }
      const next = { ...state.eventsByProfile };
      delete next[profileId];
      return { eventsByProfile: next };
    });
  },

  clearAll: () => {
    set({ eventsByProfile: {} });
  },

  editEvent: (profileId, id, patch) => {
    set((state) => {
      const events = state.eventsByProfile[profileId];
      if (!events) {
        return state;
      }
      const idx = events.findIndex((e) => e.id === id);
      if (idx === -1) {
        return state;
      }
      const updated = [
        ...events.slice(0, idx),
        { ...events[idx], ...patch },
        ...events.slice(idx + 1),
      ] as readonly LifeEvent[];
      return { eventsByProfile: { ...state.eventsByProfile, [profileId]: updated } };
    });
  },

  removeEvent: (profileId, id) => {
    set((state) => {
      const events = state.eventsByProfile[profileId];
      if (!events) {
        return state;
      }
      const filtered = events.filter((e) => e.id !== id);
      if (filtered.length === events.length) {
        return state;
      }
      return { eventsByProfile: { ...state.eventsByProfile, [profileId]: filtered } };
    });
  },
});

export const useLifeEventsStore = create<LifeEventsStore>()(
  persist<LifeEventsStore, [], [], PersistedLifeEventsState>(lifeEventsStoreCreator, {
    name: PERSIST_NAME,
    version: LIFE_EVENTS_PERSIST_VERSION,
    migrate: migrateLifeEventsPersistedState,
    storage: createJSONStorage(() => deletionAwareIdbStorage),
    partialize: (state) => ({ eventsByProfile: state.eventsByProfile }),
    onRehydrateStorage: () => () => {
      useLifeEventsStore.setState({ hydrated: true });
    },
  }),
);

/**
 * Resolve once the life-events store has finished rehydrating from portable storage.
 * Mirrors `whenChartLibraryHydrated` — await before any read that must reflect
 * the persisted truth (avoids the async-rehydrate false-empty race).
 */
export function whenLifeEventsHydrated(): Promise<HydrationOutcome> {
  return whenHydrated(useLifeEventsStore.persist);
}
