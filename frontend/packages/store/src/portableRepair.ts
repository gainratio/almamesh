/**
 * One repair pass for references that normal use can leave dangling.
 *
 * The portable validator refuses any row that points at a missing person or
 * chart. That is right for a hostile file, but our own app could create such
 * rows: a rename regenerated the chart under a new id and left the old chart's
 * chat link and AI reading behind, and Export then refused the whole dataset
 * (production, 2026-10-05). This pass runs at export, at import, and at boot,
 * and repairs exactly what the validator would refuse for a missing target:
 *
 * - chat thread -> missing chart: the link is dropped, the conversation kept;
 * - AI reading for a missing chart or person: dropped (derived, regenerable);
 * - life events / rectification record for a missing person: dropped;
 * - relationship reading with a missing person: dropped;
 * - `relatedTo` / `activeProfileId` -> missing person: cleared;
 * - cached predictive result for a missing person or chart: reset to idle.
 *
 * Everything else (bad JSON, mismatched ids, wrong shapes, a chart or chat
 * thread owned by a missing person) is left untouched so the validator still
 * refuses real corruption. Every drop is reported, so the UI can say so.
 */

import { unlinkMissingChartLinks } from './chatChartLinks';

export interface PortableRepairReport {
  /** Chat threads kept in full, without their link to a missing chart. */
  readonly unlinkedChatThreadIds: readonly string[];
  /** AI readings left out because their chart or person no longer exists. */
  readonly droppedReadingChartIds: readonly string[];
  /** `<row>/<key>` records left out because their person no longer exists. */
  readonly droppedPersonRecords: readonly string[];
  /** Profile ids whose `relatedTo` was cleared, plus `activeProfileId` if reset. */
  readonly clearedProfileLinks: readonly string[];
  /** True when a cached predictive result for a missing target was reset. */
  readonly resetPredictive: boolean;
}

export interface PortableRepair {
  /** The input map itself when nothing needed repair. */
  readonly values: ReadonlyMap<string, string>;
  readonly repairs: PortableRepairReport;
}

export const EMPTY_PORTABLE_REPAIR_REPORT: PortableRepairReport = {
  unlinkedChatThreadIds: [],
  droppedReadingChartIds: [],
  droppedPersonRecords: [],
  clearedProfileLinks: [],
  resetPredictive: false,
};

/** True when any repair happened. */
export function hasPortableRepairs(report: PortableRepairReport): boolean {
  return (
    report.unlinkedChatThreadIds.length > 0 ||
    report.droppedReadingChartIds.length > 0 ||
    report.droppedPersonRecords.length > 0 ||
    report.clearedProfileLinks.length > 0 ||
    report.resetPredictive
  );
}

type Row = Record<string, unknown>;

interface Envelope {
  readonly envelope: Row;
  readonly state: Row;
}

function isRecord(value: unknown): value is Row {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function envelopeOf(rows: ReadonlyMap<string, string>, key: string): Envelope | null {
  const raw = rows.get(key);
  if (raw === undefined) return null;
  try {
    const envelope = JSON.parse(raw) as unknown;
    if (!isRecord(envelope) || !isRecord(envelope.state)) return null;
    return { envelope, state: envelope.state };
  } catch {
    return null;
  }
}

function mapOf(rows: ReadonlyMap<string, string>, key: string, field: string): Row | undefined {
  const value = envelopeOf(rows, key)?.state[field];
  return isRecord(value) ? value : undefined;
}

function idsOf(map: Row | undefined): ReadonlySet<string> | undefined {
  return map === undefined ? undefined : new Set(Object.keys(map));
}

const missing = (id: unknown, known: ReadonlySet<string> | undefined): boolean =>
  known !== undefined && typeof id === 'string' && !known.has(id);

class Repairer {
  readonly rows: Map<string, string>;
  readonly unlinkedChatThreadIds: string[] = [];
  readonly droppedReadingChartIds: string[] = [];
  readonly droppedPersonRecords: string[] = [];
  readonly clearedProfileLinks: string[] = [];
  resetPredictive = false;

  constructor(values: ReadonlyMap<string, string>) {
    this.rows = new Map(values);
  }

  rewrite(key: string, state: Row): void {
    const current = envelopeOf(this.rows, key);
    if (current === null) return;
    this.rows.set(key, JSON.stringify({ ...current.envelope, state }));
  }

  /** Drop entries of `state[field]` that `isOrphan` names, reporting each key. */
  dropEntries(key: string, field: string, isOrphan: (id: string, value: unknown) => boolean): string[] {
    const current = envelopeOf(this.rows, key);
    const map = current?.state[field];
    if (current === null || !isRecord(map)) return [];
    const dropped = Object.keys(map).filter((id) => isOrphan(id, map[id]));
    if (dropped.length === 0) return [];
    const kept = Object.fromEntries(Object.entries(map).filter(([id]) => !dropped.includes(id)));
    this.rewrite(key, { ...current.state, [field]: kept });
    return dropped.sort();
  }
}

function repairProfiles(repair: Repairer, profileIds: ReadonlySet<string> | undefined): void {
  const current = envelopeOf(repair.rows, 'almamesh-profiles');
  if (current === null || profileIds === undefined || !isRecord(current.state.profiles)) return;
  const profiles: Row = { ...current.state.profiles };
  const cleared: string[] = [];
  for (const [id, profile] of Object.entries(profiles)) {
    if (isRecord(profile) && missing(profile.relatedTo, profileIds)) {
      const { relatedTo: _gone, ...kept } = profile;
      profiles[id] = kept;
      cleared.push(id);
    }
  }
  const resetActive = missing(current.state.activeProfileId, profileIds);
  if (cleared.length === 0 && !resetActive) return;
  repair.rewrite('almamesh-profiles', {
    ...current.state,
    profiles,
    ...(resetActive ? { activeProfileId: null } : {}),
  });
  repair.clearedProfileLinks.push(...cleared.sort(), ...(resetActive ? ['activeProfileId'] : []));
}

function repairChat(repair: Repairer, chartIds: ReadonlySet<string> | undefined): void {
  const current = envelopeOf(repair.rows, 'almamesh-chat-history');
  if (current === null || chartIds === undefined || !isRecord(current.state.threads)) return;
  const result = unlinkMissingChartLinks(current.state.threads, chartIds);
  if (result.unlinkedThreadIds.length === 0) return;
  repair.rewrite('almamesh-chat-history', { ...current.state, threads: result.threads });
  repair.unlinkedChatThreadIds.push(...result.unlinkedThreadIds);
}

function repairPredictive(
  repair: Repairer,
  profileIds: ReadonlySet<string> | undefined,
  chartIds: ReadonlySet<string> | undefined,
): void {
  const current = envelopeOf(repair.rows, 'almamesh-predictive');
  if (current === null || profileIds === undefined || chartIds === undefined) return;
  const key = current.state.profileKey;
  if (typeof key !== 'string' || profileIds.has(key) || chartIds.has(key)) return;
  repair.rewrite('almamesh-predictive', { status: 'idle' });
  repair.resetPredictive = true;
}

function repairPersonRows(repair: Repairer, profileIds: ReadonlySet<string> | undefined): void {
  for (const [key, field] of [
    ['almamesh-life-events', 'eventsByProfile'],
    ['almamesh-rectification-records', 'recordsByProfile'],
  ] as const) {
    const dropped = repair.dropEntries(key, field, (id) => missing(id, profileIds));
    repair.droppedPersonRecords.push(...dropped.map((id) => `${key}/${id}`));
  }
  const pairs = repair.dropEntries('almamesh-mesh-readings', 'byPair', (_id, reading) => {
    const owners = isRecord(reading) ? reading.profileIds : undefined;
    return Array.isArray(owners) && owners.length === 2 && owners.some((owner) => missing(owner, profileIds));
  });
  repair.droppedPersonRecords.push(...pairs.map((id) => `almamesh-mesh-readings/${id}`));
}

/** Repair every dangling reference the validator would refuse; see the module doc. */
export function repairPortableReferences(values: ReadonlyMap<string, string>): PortableRepair {
  const repair = new Repairer(values);
  const profileIds = idsOf(mapOf(values, 'almamesh-profiles', 'profiles'));
  const chartIds = idsOf(mapOf(values, 'almamesh-chart-library', 'charts'));
  repairProfiles(repair, profileIds);
  repairPersonRows(repair, profileIds);
  repairChat(repair, chartIds);
  repair.droppedReadingChartIds.push(
    ...repair.dropEntries(
      'almamesh-interpretations',
      'byChart',
      (chartId, reading) =>
        missing(chartId, chartIds) || (isRecord(reading) && missing(reading.profileId, profileIds)),
    ),
  );
  repairPredictive(repair, profileIds, chartIds);
  const repairs: PortableRepairReport = {
    unlinkedChatThreadIds: repair.unlinkedChatThreadIds,
    droppedReadingChartIds: repair.droppedReadingChartIds,
    droppedPersonRecords: repair.droppedPersonRecords,
    clearedProfileLinks: repair.clearedProfileLinks,
    resetPredictive: repair.resetPredictive,
  };
  return { values: hasPortableRepairs(repairs) ? repair.rows : values, repairs };
}
