/**
 * Set-aside records: user-written data (life events, a birth-time check) whose
 * person is no longer on this device. The portable repair takes them out of
 * the dataset so Export and Import never block, and holds them in SQLite's
 * `set-aside` namespace instead of deleting them (see portableRepair.ts).
 *
 * This module is what Settings → Backup & Restore shows: list them, restore
 * one onto a person who is here (re-attach), or delete one for good.
 *
 * Expiry policy: none. They are the user's own words, small, and never leave
 * the device; AlmaMesh does not delete them on its own. They are removed only
 * when the user restores or deletes them, or chooses Start fresh. They are not
 * part of a backup file, so the screen says so.
 */
import type { RectificationRecord } from '@almamesh/shared-types';

import {
  readCanonicalDatasetValue,
  requirePortableStateRepository,
  whenPersistenceSettled,
} from './deletionTombstones';
import {
  LIFE_EVENTS_PERSIST_VERSION,
  migrateLifeEventsPersistedState,
  useLifeEventsStore,
  type LifeEvent,
} from './lifeEvents';
import type { SetAsideRecord } from './portableRepair';
import { useProfilesStore } from './profiles';
import {
  migrateRectificationRecordsPersistedState,
  RECTIFICATION_RECORDS_PERSIST_VERSION,
  useRectificationRecordsStore,
} from './rectificationRecords';

/** No automatic expiry: removed only by the user (restore, delete, Start fresh). */
export const SET_ASIDE_EXPIRY_POLICY = 'never';

const LIFE_EVENTS_ROW = 'almamesh-life-events';
const RECTIFICATION_ROW = 'almamesh-rectification-records';

/** One held record, shaped for the screen. */
export interface HeldSetAsideRecord {
  readonly key: string;
  readonly row: SetAsideRecord['row'];
  /** The id of the person it belonged to (no longer on this device). */
  readonly personId: string;
  readonly setAsideAt: string;
  /** Life events in the record, or 1 for a birth-time check. */
  readonly itemCount: number;
  /** Short, user-written lines so the user can recognise the record. */
  readonly preview: readonly string[];
}

export type SetAsideRestoreErrorCode = 'missing' | 'unreadable' | 'unknown_person' | 'has_record' | 'not_saved';

/** A restore that changed nothing: the held copy is still there. */
export class SetAsideRestoreError extends Error {
  public override readonly name = 'SetAsideRestoreError';

  public constructor(public readonly code: SetAsideRestoreErrorCode) {
    super(`Set-aside record could not be restored (${code}).`);
  }
}

/** The SQLite operations this module needs (the real repository implements them). */
export interface SetAsideRepository {
  listSetAside(): Promise<ReadonlyMap<string, string>>;
  readSetAside(key: string): Promise<string | null>;
  releaseSetAside(keys: readonly string[]): Promise<void>;
}

export interface SetAsideDeps {
  readonly repository?: SetAsideRepository;
  /** Test seam: the saved canonical row read back after a restore. */
  readonly readSaved?: (row: SetAsideRecord['row']) => Promise<string | null>;
}

interface HeldRow extends SetAsideRecord {
  readonly setAsideAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseHeld(raw: string): HeldRow | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return null;
    const { row, personId, value, setAsideAt, version } = parsed;
    if ((row !== LIFE_EVENTS_ROW && row !== RECTIFICATION_ROW) || typeof personId !== 'string') return null;
    if (typeof value !== 'string') return null;
    return {
      row,
      personId,
      value,
      setAsideAt: typeof setAsideAt === 'string' ? setAsideAt : '',
      ...(typeof version === 'number' && Number.isSafeInteger(version) ? { version } : {}),
    };
  } catch {
    return null;
  }
}

/** The held life events, migrated from the version they were held at. */
function heldEvents(held: HeldRow): readonly LifeEvent[] {
  const migrated = migrateLifeEventsPersistedState(
    { eventsByProfile: { [held.personId]: JSON.parse(held.value) as unknown } },
    held.version ?? LIFE_EVENTS_PERSIST_VERSION,
  );
  return migrated.eventsByProfile[held.personId] ?? [];
}

function heldRecord(held: HeldRow): RectificationRecord | null {
  const migrated = migrateRectificationRecordsPersistedState(
    { recordsByProfile: { [held.personId]: JSON.parse(held.value) as unknown } },
    held.version ?? RECTIFICATION_RECORDS_PERSIST_VERSION,
  );
  return migrated.recordsByProfile[held.personId] ?? null;
}

function eventLine(event: LifeEvent): string {
  return event.summary ?? event.note ?? event.description ?? event.date;
}

function toListed(key: string, held: HeldRow): HeldSetAsideRecord {
  const base = { key, row: held.row, personId: held.personId, setAsideAt: held.setAsideAt };
  try {
    if (held.row === LIFE_EVENTS_ROW) {
      const events = heldEvents(held);
      return { ...base, itemCount: events.length, preview: events.map(eventLine).filter(Boolean) };
    }
    const record = heldRecord(held);
    return {
      ...base,
      itemCount: 1,
      preview: record === null ? [] : [`${record.originalTime || '?'} → ${record.rectifiedTime}`],
    };
  } catch {
    return { ...base, itemCount: 0, preview: [] };
  }
}

async function repositoryOf(deps: SetAsideDeps): Promise<SetAsideRepository> {
  return deps.repository ?? (await requirePortableStateRepository());
}

/** Every held record, oldest first. */
export async function listSetAsideRecords(deps: SetAsideDeps = {}): Promise<readonly HeldSetAsideRecord[]> {
  const rows = await (await repositoryOf(deps)).listSetAside();
  const listed: HeldSetAsideRecord[] = [];
  for (const [key, raw] of rows) {
    const held = parseHeld(raw);
    if (held !== null) listed.push(toListed(key, held));
  }
  return listed.sort((a, b) => a.setAsideAt.localeCompare(b.setAsideAt) || a.row.localeCompare(b.row));
}

function attachEvents(held: HeldRow, targetProfileId: string): readonly string[] {
  const events = heldEvents(held);
  useLifeEventsStore.setState((state) => {
    const own = state.eventsByProfile[targetProfileId] ?? [];
    const ownIds = new Set(own.map((event) => event.id));
    return {
      eventsByProfile: {
        ...state.eventsByProfile,
        [targetProfileId]: [...own, ...events.filter((event) => !ownIds.has(event.id))],
      },
    };
  });
  return events.map((event) => event.id);
}

function attachRecord(held: HeldRow, targetProfileId: string): void {
  const record = heldRecord(held);
  if (record === null) throw new SetAsideRestoreError('unreadable');
  if (useRectificationRecordsStore.getState().recordsByProfile[targetProfileId] !== undefined) {
    throw new SetAsideRestoreError('has_record');
  }
  useRectificationRecordsStore.getState().setRecord({ ...record, profileId: targetProfileId });
}

/** True when the saved canonical row holds what the restore attached. */
function savedHolds(raw: string | null, held: HeldRow, targetProfileId: string, eventIds: readonly string[]): boolean {
  if (raw === null) return false;
  try {
    const state = (JSON.parse(raw) as { state?: Record<string, unknown> }).state ?? {};
    if (held.row === LIFE_EVENTS_ROW) {
      const saved = (state.eventsByProfile as Record<string, readonly { id: string }[]> | undefined)?.[targetProfileId] ?? [];
      const savedIds = new Set(saved.map((event) => event.id));
      return eventIds.every((id) => savedIds.has(id));
    }
    const saved = (state.recordsByProfile as Record<string, { profileId?: string }> | undefined)?.[targetProfileId];
    return saved?.profileId === targetProfileId;
  } catch {
    return false;
  }
}

/**
 * Re-attach one held record to a person who is on this device. The held copy
 * is released only after the restored data is provably saved, so a failure at
 * any step leaves it held (and a retry never duplicates an event).
 */
export async function restoreSetAsideRecord(
  key: string,
  targetProfileId: string,
  deps: SetAsideDeps = {},
): Promise<void> {
  const repository = await repositoryOf(deps);
  const raw = await repository.readSetAside(key);
  if (raw === null) throw new SetAsideRestoreError('missing');
  const held = parseHeld(raw);
  if (held === null) throw new SetAsideRestoreError('unreadable');
  if (useProfilesStore.getState().profiles[targetProfileId] === undefined) {
    throw new SetAsideRestoreError('unknown_person');
  }
  let eventIds: readonly string[] = [];
  try {
    if (held.row === LIFE_EVENTS_ROW) eventIds = attachEvents(held, targetProfileId);
    else attachRecord(held, targetProfileId);
  } catch (error) {
    throw error instanceof SetAsideRestoreError ? error : new SetAsideRestoreError('unreadable');
  }
  await whenPersistenceSettled(held.row);
  const saved = await (deps.readSaved ?? readCanonicalDatasetValue)(held.row);
  if (!savedHolds(saved, held, targetProfileId, eventIds)) {
    // Not saved means not shown. attachRecord refused unless the person had no
    // check, so clearing restores exactly the prior state, and a retry is not
    // refused as `has_record` by this attempt's leftover. (Re-attached events
    // need no rollback: a retry never duplicates them.)
    if (held.row !== LIFE_EVENTS_ROW) useRectificationRecordsStore.getState().clearRecord(targetProfileId);
    throw new SetAsideRestoreError('not_saved');
  }
  await repository.releaseSetAside([key]);
}

/** Delete one held record for good. */
export async function deleteSetAsideRecord(key: string, deps: SetAsideDeps = {}): Promise<void> {
  await (await repositoryOf(deps)).releaseSetAside([key]);
}

/** Start fresh: every held record goes with the rest of the data. */
export async function clearSetAsideRecords(deps: SetAsideDeps = {}): Promise<void> {
  const repository = await repositoryOf(deps);
  await repository.releaseSetAside([...(await repository.listSetAside()).keys()]);
}
