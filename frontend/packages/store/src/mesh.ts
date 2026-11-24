/**
 * Mesh Store - relational mesh edges between the ANCHOR profile ("self") and
 * its members, computed on-device by the in-browser engine.
 *
 * Architecture (mesh foundations spine):
 * - The edge is computed by the engine's `computeMeshEdge` entrypoint from the
 *   TWO bare birth inputs — the Python side recomputes both natal contexts
 *   internally; no chart crosses the worker boundary, and NO astrology is
 *   computed in TypeScript.
 * - `ensureMeshEdge(runtime, anchorProfile, memberProfile, window)` is
 *   IDEMPOTENT per pair + births + window: a repeat call while `ready` or
 *   `loading` for the same derived request key is a no-op; an `error` state
 *   can always be retried.
 * - Both profiles' birth data is READ FROM THE CHART LIBRARY (each person's
 *   primary chart). Invalidation follows the chart convention — identity is
 *   derived from the inputs — so when either profile's birth data changes
 *   (regeneration saves a new primary), the derived request key changes and
 *   the next ensure recomputes the edge.
 * - Every instant is EXPLICIT (`referenceInstant` + the synchrony window);
 *   there is no silent `now()` and no `Date.now()` anywhere in this store.
 * - Raw engine edges are adapted through the pure `toMeshEdgeCtx`; this store
 *   holds only UI-shaped data (`@almamesh/shared-types`).
 */

import { create } from 'zustand';
import type { MatchRole, MeshEdgeCtx } from '@almamesh/shared-types';
import type {
  AyanamsaType,
  MeshBirthInput,
  MeshEdgeContext,
  MeshEdgeInput,
} from '@almamesh/browser/types';

import { toMeshEdgeCtx } from './adapters/mesh';
import { useChartLibraryStore, whenChartLibraryHydrated } from './chartLibrary';
import type { Profile } from './profiles';

export type MeshEdgeStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * What the store needs from the runtime: the ready engine surface. The
 * `ChartEngine` returned by `AlmaMeshRuntime.bootstrap()` / `.engine()`
 * satisfies this structurally.
 */
export interface MeshRuntime {
  computeMeshEdge(input: MeshEdgeInput): Promise<MeshEdgeContext>;
}

/**
 * The EXPLICIT instants of one mesh-edge request. `referenceInstant` pins both
 * charts' "current" dasha; `start`/`end` bound the dasha synchrony — never a
 * silent wall clock; the caller pins all three.
 *
 * Melapaka roles are explicit per the engine's no-guessing rule; when omitted
 * the store applies the documented golden-fixture convention (anchor=bride,
 * member=groom) and a UI can override either side.
 */
export interface MeshEdgeWindow {
  readonly start: string; // ISO-8601 — synchrony window start
  readonly end: string; // ISO-8601 — synchrony window end
  readonly referenceInstant: string; // ISO-8601 — pins both "current" dashas
  readonly anchorRole?: MatchRole;
  readonly memberRole?: MatchRole;
  readonly ayanamsaType?: AyanamsaType;
}

/** One pair's edge slot: status + the adapted edge + its request identity. */
export interface MeshEdgeEntry {
  readonly status: MeshEdgeStatus;
  readonly error?: string;
  readonly edge?: MeshEdgeCtx;
  /** Derived from both births + relationship + roles + window (invalidation). */
  readonly requestKey?: string;
}

/** The empty slot an unrequested pair reads as. */
export const IDLE_MESH_EDGE: MeshEdgeEntry = { status: 'idle' };

/** Stable pair key: the anchor profile id + the member profile id. */
export function pairKeyOf(anchorId: string, memberId: string): string {
  return `${anchorId}|${memberId}`;
}

export interface MeshStore {
  /** Edge slots keyed by `pairKeyOf(anchorId, memberId)`. */
  edges: Readonly<Record<string, MeshEdgeEntry>>;
  /**
   * Compute (once) the anchor<->member edge via the engine. Reads both
   * profiles' birth data from the chart library; no-op while `ready` or
   * `loading` for the same derived request; recomputes when either profile's
   * birth data — or the window/roles — changed. Errors are retryable.
   */
  ensureMeshEdge(
    runtime: MeshRuntime,
    anchorProfile: Profile,
    memberProfile: Profile,
    window: MeshEdgeWindow,
  ): Promise<void>;
  /** Drop every edge touching a profile (either side) — e.g. on deletion. */
  invalidateEdgesFor(profileId: string): void;
  /** Back to no edges at all. */
  reset(): void;
}

/** A profile's birth input, read from its primary stored chart (engine truth). */
function birthInputFor(profile: Profile): MeshBirthInput | undefined {
  const charts = Object.values(useChartLibraryStore.getState().charts).filter(
    (chart) => chart.profile_id === profile.id,
  );
  const chart = charts.find((c) => c.is_primary) ?? charts[0];
  const birth = chart?.birth_data;
  const location = birth?.birth_location_details;
  if (birth === undefined || location === undefined) {
    return undefined;
  }
  return {
    datetimeUtc: birth.birth_datetime_utc,
    latitude: location.latitude,
    longitude: location.longitude,
  };
}

/** Roles per the explicit overrides, defaulting to anchor=bride, member=groom. */
function rolesOf(window: MeshEdgeWindow): { anchorRole: MatchRole; memberRole: MatchRole } {
  const anchorRole = window.anchorRole ?? 'bride';
  const memberRole = window.memberRole ?? (anchorRole === 'bride' ? 'groom' : 'bride');
  return { anchorRole, memberRole };
}

type MeshRequest =
  | { readonly ok: true; readonly key: string; readonly input: MeshEdgeInput }
  | { readonly ok: false; readonly error: string };

/** Resolve one request: validate the pair, read births, derive the identity key. */
function buildMeshRequest(
  anchorProfile: Profile,
  memberProfile: Profile,
  window: MeshEdgeWindow,
): MeshRequest {
  if (anchorProfile.relationship !== 'self') {
    return { ok: false, error: `profile "${anchorProfile.name}" is not the anchor ('self')` };
  }
  const relationship = memberProfile.relationship;
  if (relationship === undefined || relationship === 'self') {
    return {
      ok: false,
      error: `profile "${memberProfile.name}" has no member relationship to the anchor`,
    };
  }
  const a = birthInputFor(anchorProfile);
  const b = birthInputFor(memberProfile);
  if (a === undefined) {
    return { ok: false, error: `no stored chart with birth data for "${anchorProfile.name}"` };
  }
  if (b === undefined) {
    return { ok: false, error: `no stored chart with birth data for "${memberProfile.name}"` };
  }
  const { anchorRole, memberRole } = rolesOf(window);
  const input: MeshEdgeInput = {
    a,
    b,
    relationship,
    roleA: anchorRole,
    roleB: memberRole,
    windowStart: window.start,
    windowEnd: window.end,
    referenceInstant: window.referenceInstant,
    ...(window.ayanamsaType !== undefined && window.ayanamsaType !== 'LAHIRI'
      ? { ayanamsaType: window.ayanamsaType }
      : {}),
  };
  // The request identity IS the inputs (the chart-id convention): any birth,
  // relationship, role or window change yields a new key -> recompute.
  return { ok: true, key: JSON.stringify(input), input };
}

export const useMeshStore = create<MeshStore>()((set, get) => {
  const setEntry = (pairKey: string, entry: MeshEdgeEntry): void => {
    set((state) => ({ edges: { ...state.edges, [pairKey]: entry } }));
  };
  /** True while `key` still owns the pair slot (not superseded mid-flight). */
  const ownsSlot = (pairKey: string, key: string): boolean =>
    get().edges[pairKey]?.requestKey === key;

  return {
    edges: {},

    async ensureMeshEdge(runtime, anchorProfile, memberProfile, window) {
      await whenChartLibraryHydrated(); // birth data lives in the chart library
      const pairKey = pairKeyOf(anchorProfile.id, memberProfile.id);
      const request = buildMeshRequest(anchorProfile, memberProfile, window);
      if (!request.ok) {
        setEntry(pairKey, { status: 'error', error: request.error });
        return;
      }
      const existing = get().edges[pairKey];
      const settled = existing?.status === 'ready' || existing?.status === 'loading';
      if (settled && existing?.requestKey === request.key) {
        return; // idempotent: already computed (or computing) this exact request
      }
      setEntry(pairKey, { status: 'loading', requestKey: request.key });
      try {
        const raw = await runtime.computeMeshEdge(request.input);
        if (!ownsSlot(pairKey, request.key)) {
          return; // superseded by a newer request while in flight
        }
        const edge = toMeshEdgeCtx(raw);
        if (edge === undefined) {
          throw new Error('engine returned no mesh edge');
        }
        setEntry(pairKey, { status: 'ready', edge, requestKey: request.key });
      } catch (err) {
        if (!ownsSlot(pairKey, request.key)) {
          return; // a newer request owns the slot now; keep its state
        }
        setEntry(pairKey, {
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
          requestKey: request.key,
        });
      }
    },

    invalidateEdgesFor(profileId) {
      set((state) => {
        const edges: Record<string, MeshEdgeEntry> = {};
        for (const [pairKey, entry] of Object.entries(state.edges)) {
          if (!pairKey.split('|').includes(profileId)) {
            edges[pairKey] = entry;
          }
        }
        return { edges };
      });
    },

    reset() {
      set({ edges: {} });
    },
  };
});
