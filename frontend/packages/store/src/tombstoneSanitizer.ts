/**
 * Pure, stateless deletion-tombstone sanitizer shared by live storage reads/writes
 * (`deletionTombstones.ts`) and raw OPFS SQLite import healing (`portableState.ts`).
 */

export interface TombstoneIdSets {
  readonly profileIds: readonly string[];
  readonly threadIds: readonly string[];
  readonly chartIds: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function dropRecordKeys(
  value: unknown,
  shouldDrop: (key: string, entry: unknown) => boolean,
): Record<string, unknown> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([key, entry]) => !shouldDrop(key, entry)),
  );
}

function entryOwner(entry: unknown): string | undefined {
  return isRecord(entry) && typeof entry.profile_id === 'string' ? entry.profile_id : undefined;
}

function interpretationOwner(entry: unknown): string | undefined {
  return isRecord(entry) && typeof entry.profileId === 'string' ? entry.profileId : undefined;
}

function firstProfileByCreatedAt(profiles: Record<string, unknown>): string | null {
  const profileIds = Object.keys(profiles);
  profileIds.sort((leftId, rightId) => {
    const left = profiles[leftId];
    const right = profiles[rightId];
    const leftCreatedAt = isRecord(left) && typeof left.createdAt === 'string' ? left.createdAt : null;
    const rightCreatedAt =
      isRecord(right) && typeof right.createdAt === 'string' ? right.createdAt : null;
    if (leftCreatedAt !== null && rightCreatedAt !== null) {
      return leftCreatedAt.localeCompare(rightCreatedAt) || leftId.localeCompare(rightId);
    }
    if (leftCreatedAt !== null) return -1;
    if (rightCreatedAt !== null) return 1;
    return leftId.localeCompare(rightId);
  });
  return profileIds[0] ?? null;
}

function sanitizeProfiles(
  state: Record<string, unknown>,
  profileIds: ReadonlySet<string>,
): Record<string, unknown> {
  const kept = dropRecordKeys(state.profiles, (profileId) => profileIds.has(profileId));
  const profiles = Object.fromEntries(
    Object.entries(kept).map(([profileId, profile]) => {
      if (!isRecord(profile) || !profileIds.has(String(profile.relatedTo ?? ''))) {
        return [profileId, profile];
      }
      const { relationship: _relationship, relatedTo: _relatedTo, ...unlinked } = profile;
      return [profileId, unlinked];
    }),
  );
  const active = state.activeProfileId;
  const activeProfileId =
    typeof active === 'string' && active in profiles ? active : firstProfileByCreatedAt(profiles);
  return { ...state, profiles, activeProfileId };
}

function sanitizeChat(
  state: Record<string, unknown>,
  profileIds: ReadonlySet<string>,
  threadIds: ReadonlySet<string>,
): Record<string, unknown> {
  const threads = dropRecordKeys(
    state.threads,
    (threadId, thread) => threadIds.has(threadId) || profileIds.has(entryOwner(thread) ?? ''),
  );
  const messages = dropRecordKeys(state.messages, (threadId) => !(threadId in threads));
  const summaries = dropRecordKeys(state.summaries, (threadId) => !(threadId in threads));
  return { ...state, threads, messages, summaries };
}

function sanitizeState(
  name: string,
  state: Record<string, unknown>,
  tombstones: TombstoneIdSets,
): Record<string, unknown> {
  const profileIds = new Set(tombstones.profileIds);
  const threadIds = new Set(tombstones.threadIds);
  const chartIds = new Set(tombstones.chartIds);
  switch (name) {
    case 'almamesh-profiles':
      return sanitizeProfiles(state, profileIds);
    case 'almamesh-chart-library':
      return {
        ...state,
        charts: dropRecordKeys(
          state.charts,
          (chartId, chart) => chartIds.has(chartId) || profileIds.has(entryOwner(chart) ?? ''),
        ),
      };
    case 'almamesh-life-events':
      return {
        ...state,
        eventsByProfile: dropRecordKeys(state.eventsByProfile, (profileId) =>
          profileIds.has(profileId),
        ),
      };
    case 'almamesh-rectification-records':
      return {
        ...state,
        recordsByProfile: dropRecordKeys(state.recordsByProfile, (profileId) =>
          profileIds.has(profileId),
        ),
      };
    case 'almamesh-chat-history':
      return sanitizeChat(state, profileIds, threadIds);
    case 'almamesh-predictive':
      return typeof state.profileKey === 'string' &&
        (profileIds.has(state.profileKey) || chartIds.has(state.profileKey))
        ? { status: 'idle' }
        : state;
    case 'almamesh-interpretations':
      return {
        ...state,
        byChart: dropRecordKeys(
          state.byChart,
          (chartId, entry) =>
            chartIds.has(chartId) || profileIds.has(interpretationOwner(entry) ?? ''),
        ),
      };
    case 'almamesh-mesh-readings':
      return {
        ...state,
        byPair: dropRecordKeys(state.byPair, (_pairKey, entry) => {
          if (!isRecord(entry) || !Array.isArray(entry.profileIds)) return true;
          return entry.profileIds.some(
            (profileId) => typeof profileId === 'string' && profileIds.has(profileId),
          );
        }),
      };
    default:
      return state;
  }
}

export function sanitizePersistedValue(
  name: string,
  value: string,
  tombstones: TombstoneIdSets,
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return value;
  }
  if (!isRecord(parsed) || !isRecord(parsed.state)) {
    return value;
  }
  return JSON.stringify({
    ...parsed,
    state: sanitizeState(name, parsed.state, tombstones),
  });
}
