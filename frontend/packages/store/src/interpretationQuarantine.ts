/**
 * The interpretation quarantine: saved interpretation rows the app cannot read
 * are held here instead of being destroyed, so a bad upgrade never silently
 * erases a paid reading. The rows are personal data.
 *
 * Storage: SQLite only — the `quarantine` namespace of the portable state file
 * (see PORTABLE_QUARANTINE_NAMESPACE). Rows are keyed `<owner>/<sha256>`, where
 * owner is the one profile the row belongs to, or `-` when it cannot be told.
 *
 * Lifetime: dropped 30 days after being set aside; Start fresh clears all of
 * them; deleting a profile removes every row holding that profile's readings
 * (in the same SQLite transaction as the deletion). Backups exclude them.
 */
import { safeWarn } from '@almamesh/shared-types';

import type {
  PortableQuarantineMutation,
  PortableStateRepository,
} from './portableState';
import { PORTABLE_QUARANTINE_NAMESPACE } from './portableState';
import type { LegacyWebStorage } from './webStorage';

/**
 * The localStorage key older builds held the quarantine under. Read only by
 * the one-time migration below.
 * TODO(remove after 2026-11-04, one release after the SQLite move): drop this
 * key and `migrateLegacyInterpretationQuarantine` once returning visitors have
 * migrated.
 */
export const INTERPRETATION_QUARANTINE_KEY = 'almamesh-interpretations.quarantine';

export const INTERPRETATION_QUARANTINE_TTL_DAYS = 30;
const QUARANTINE_TTL_MS = INTERPRETATION_QUARANTINE_TTL_DAYS * 24 * 60 * 60 * 1000;
const UNATTRIBUTED_OWNER = '-';

export interface UnreadableInterpretation {
  readonly source: 'legacy-local-storage' | 'canonical-sqlite';
  readonly raw: string;
}

export interface QuarantinedInterpretation extends UnreadableInterpretation {
  readonly quarantinedAt: string;
  /** Profiles whose readings this row holds (best effort; empty when unknown). */
  readonly profileIds: readonly string[];
}

/** The SQLite rows behind the quarantine: list them, or change them in one batch. */
export interface InterpretationQuarantineRows {
  list(): Promise<ReadonlyMap<string, string>>;
  apply(mutations: readonly PortableQuarantineMutation[]): Promise<void>;
}

export function repositoryQuarantineRows(
  repository: PortableStateRepository,
): InterpretationQuarantineRows {
  return {
    list: () => repository.listQuarantine(),
    apply: (mutations) => repository.applyQuarantine(mutations),
  };
}

/** Session-only rows for runtimes without a SQLite repository (Node tests, SSR). */
export function memoryQuarantineRows(
  rows: Map<string, string> = new Map(),
): InterpretationQuarantineRows {
  return {
    list: async () => new Map(rows),
    apply: async (mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'put') rows.set(mutation.key, mutation.value);
        else rows.delete(mutation.key);
      }
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The profiles a raw interpretations envelope holds readings for, if it parses that far. */
function profileIdsIn(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    const byChart = isRecord(parsed) && isRecord(parsed.state) ? parsed.state.byChart : undefined;
    if (!isRecord(byChart)) return [];
    const ids = Object.values(byChart).flatMap((entry) =>
      isRecord(entry) && typeof entry.profileId === 'string' ? [entry.profileId] : [],
    );
    return [...new Set(ids)].sort();
  } catch {
    return [];
  }
}

async function digest(entry: UnreadableInterpretation): Promise<string> {
  const bytes = new TextEncoder().encode(`${entry.source}\u0000${entry.raw}`);
  const hash = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  return [...hash].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function rowFor(
  entry: UnreadableInterpretation,
  quarantinedAt: string,
): Promise<{ readonly key: string; readonly record: QuarantinedInterpretation }> {
  const profileIds = profileIdsIn(entry.raw);
  const owner =
    // eslint-disable-next-line no-control-regex -- a profile id containing a C0 control character is refused as an owner
    profileIds.length === 1 && /^[^\u0000-\u001f/]{1,512}$/.test(profileIds[0]!)
      ? profileIds[0]!
      : UNATTRIBUTED_OWNER;
  const record = { quarantinedAt, source: entry.source, raw: entry.raw, profileIds };
  return { key: `${owner}/${await digest(entry)}`, record };
}

function parseRecord(value: string): QuarantinedInterpretation | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !isRecord(parsed) ||
      typeof parsed.raw !== 'string' ||
      typeof parsed.quarantinedAt !== 'string' ||
      (parsed.source !== 'legacy-local-storage' && parsed.source !== 'canonical-sqlite')
    ) {
      return undefined;
    }
    const profileIds = Array.isArray(parsed.profileIds)
      ? parsed.profileIds.filter((id): id is string => typeof id === 'string')
      : [];
    return {
      quarantinedAt: parsed.quarantinedAt,
      source: parsed.source,
      raw: parsed.raw,
      profileIds,
    };
  } catch {
    return undefined;
  }
}

/** Every held record, oldest first. */
export async function readInterpretationQuarantine(
  rows: InterpretationQuarantineRows,
): Promise<QuarantinedInterpretation[]> {
  const records = [...(await rows.list()).values()].flatMap((value) => {
    const record = parseRecord(value);
    return record === undefined ? [] : [record];
  });
  return records.sort((a, b) => a.quarantinedAt.localeCompare(b.quarantinedAt));
}

/**
 * Hold an unreadable row (idempotent: the key is a digest of source + bytes).
 * Resolves true only once SQLite provably holds it, so callers never drop the
 * only copy.
 */
export async function holdUnreadableInterpretation(
  entry: UnreadableInterpretation,
  rows: InterpretationQuarantineRows,
  now: () => Date = () => new Date(),
): Promise<boolean> {
  try {
    const { key, record } = await rowFor(entry, now().toISOString());
    if (!(await rows.list()).has(key)) {
      await rows.apply([
        { type: 'put', namespace: PORTABLE_QUARANTINE_NAMESPACE, key, value: JSON.stringify(record) },
      ]);
    }
    return (await rows.list()).has(key);
  } catch (error) {
    // Not held: the caller keeps writes refused so the only copy survives.
    safeWarn('storage.interpretation_quarantine_hold_failed', error);
    return false;
  }
}

/** Drop expired or unreadable quarantine rows. Never throws. */
export async function pruneExpiredInterpretationQuarantine(
  rows: InterpretationQuarantineRows,
  now: () => Date = () => new Date(),
): Promise<void> {
  try {
    const cutoff = now().getTime() - QUARANTINE_TTL_MS;
    const expired = [...(await rows.list())].flatMap(([key, value]) => {
      const record = parseRecord(value);
      const at = record === undefined ? Number.NaN : Date.parse(record.quarantinedAt);
      return Number.isNaN(at) || at < cutoff ? [key] : [];
    });
    await rows.apply(
      expired.map((key) => ({ type: 'delete', namespace: PORTABLE_QUARANTINE_NAMESPACE, key })),
    );
  } catch (error) {
    // Hydration must not fail on housekeeping; the next boot retries expiry.
    safeWarn('storage.interpretation_quarantine_prune_failed', error);
  }
}

/** Keys of every row holding readings of any of these profiles (pure). */
export function quarantineKeysOwnedBy(
  held: ReadonlyMap<string, string>,
  profileIds: readonly string[],
): string[] {
  if (profileIds.length === 0) return [];
  const deleted = new Set(profileIds);
  return [...held].flatMap(([key, value]) => {
    const owner = key.slice(0, key.lastIndexOf('/'));
    const ids = parseRecord(value)?.profileIds ?? [];
    return deleted.has(owner) || ids.some((id) => deleted.has(id)) ? [key] : [];
  });
}

function legacyRecords(raw: string, now: () => Date): QuarantinedInterpretation[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.flatMap((item) => {
        const record = isRecord(item) ? parseRecord(JSON.stringify(item)) : undefined;
        return record === undefined ? [] : [record];
      });
    }
  } catch {
    // Fall through: hold the whole unreadable value rather than drop it.
  }
  return [
    { quarantinedAt: now().toISOString(), source: 'legacy-local-storage', raw, profileIds: [] },
  ];
}

/**
 * One-time, crash-resumable move of the old localStorage quarantine into
 * SQLite: copy every record in ONE batch, verify SQLite holds each, and only
 * then remove the localStorage key. Re-running is idempotent (digest keys). A
 * failure before the verified commit leaves the source untouched, so an older
 * build rolled back to still finds it. The key is retired even when SQLite is
 * session-only (OPFS refused): a key kept as the durable copy would be copied
 * back on every boot and resurrect readings of a profile deleted since.
 * TODO(remove after 2026-11-04, one release after the SQLite move).
 */
export async function migrateLegacyInterpretationQuarantine(
  legacy: LegacyWebStorage | undefined,
  rows: InterpretationQuarantineRows,
  now: () => Date = () => new Date(),
): Promise<void> {
  const raw = readLegacyQuarantine(legacy);
  if (raw === null) return;
  const copies = await Promise.all(
    legacyRecords(raw, now).map((record) => rowFor(record, record.quarantinedAt)),
  );
  const held = await rows.list();
  await rows.apply(
    copies
      .filter(({ key }) => !held.has(key))
      .map(({ key, record }) => ({
        type: 'put',
        namespace: PORTABLE_QUARANTINE_NAMESPACE,
        key,
        value: JSON.stringify(record),
      })),
  );
  const verified = await rows.list();
  const missing = copies.filter(
    ({ key, record }) => parseRecord(verified.get(key) ?? '')?.raw !== record.raw,
  );
  if (missing.length > 0) {
    throw new Error('Interpretation quarantine migration did not verify in SQLite.');
  }
  legacy?.removeItem(INTERPRETATION_QUARANTINE_KEY);
}

function readLegacyQuarantine(legacy: LegacyWebStorage | undefined): string | null {
  try {
    return legacy?.getItem(INTERPRETATION_QUARANTINE_KEY) ?? null;
  } catch (error) {
    // Blocked site storage: nothing can be read, so nothing is copied or retired.
    safeWarn('storage.interpretation_quarantine_legacy_unreadable', error);
    return null;
  }
}

/** Expiry for a legacy source that could not be migrated: drop it once every record is past 30 days. */
export function retireExpiredLegacyQuarantine(
  legacy: LegacyWebStorage | undefined,
  now: () => Date = () => new Date(),
): void {
  const raw = readLegacyQuarantine(legacy);
  if (raw === null) return;
  const cutoff = now().getTime() - QUARANTINE_TTL_MS;
  const live = legacyRecords(raw, now).some((record) => Date.parse(record.quarantinedAt) >= cutoff);
  if (!live) legacy?.removeItem(INTERPRETATION_QUARANTINE_KEY);
}

/**
 * Before a deletion generation commits: bring any legacy source into SQLite so
 * the commit purges it with everything else. If that copy fails, a source that
 * holds readings of a deleted profile (or any source, on Start fresh) is
 * removed outright: the user asked for that data to be erased.
 */
export async function absorbLegacyQuarantine(
  legacy: LegacyWebStorage | undefined,
  rows: InterpretationQuarantineRows,
  deletedProfileIds: readonly string[],
  clearAll: boolean,
): Promise<void> {
  try {
    await migrateLegacyInterpretationQuarantine(legacy, rows);
  } catch (error) {
    safeWarn('storage.interpretation_quarantine_migration_failed', error);
    const raw = readLegacyQuarantine(legacy);
    if (raw === null) return;
    const deleted = new Set(deletedProfileIds);
    const owned = legacyRecords(raw, () => new Date()).some((record) =>
      profileIdsIn(record.raw).some((id) => deleted.has(id)),
    );
    if (clearAll || owned) legacy?.removeItem(INTERPRETATION_QUARANTINE_KEY);
  }
}
