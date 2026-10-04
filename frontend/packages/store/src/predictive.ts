/**
 * Predictive Store - the LAZY predictive contexts (transits, full vargas,
 * strength, life domains) for the active profile.
 *
 * Architecture (Wave C integration spine):
 * - The natal chart pipeline stays fast and byte-identical; the predictive
 *   superset takes ~35s under Pyodide, so it is computed LAZILY through the
 *   engine's second entrypoint (`computePredictive`) and cached here.
 * - `ensurePredictive(runtime, input)` is IDEMPOTENT per natal input + reference
 *   instant: a repeat call while `ready` or `loading` for the same key is a
 *   no-op. A failed run can always be retried.
 * - The reference instant is EXPLICIT (never a silent now()): callers pin it,
 *   which pins both the "current" dasha and the transit "now".
 * - Raw engine contexts are adapted through the pure `to*Ctx` adapters; this
 *   store holds only UI-shaped data (`@almamesh/shared-types`). No astrology
 *   is computed in TypeScript.
 */

import { create, type StateCreator } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type {
  DomainsCtx,
  StrengthCtx,
  TransitCtx,
  VargaCtxFull,
} from '@almamesh/shared-types';
import type { PredictiveContexts, PredictiveInput } from '@almamesh/browser/types';
import {
  toDomainsCtx,
  toStrengthCtx,
  toTransitCtx,
  toVargaCtx,
} from './adapters/predictive';
import { deletionAwareIdbStorage } from './deletionTombstones';
import { whenHydrated, type HydrationOutcome } from './hydrationBarrier';

export type PredictiveStatus = 'idle' | 'loading' | 'ready' | 'error';

type WorkerResultKeys =
  | 'domain_strength_assays'
  | 'domain_strength_receipts'
  | 'strength_signer_public_key';

/** A cached result keeps calculations; its current-boot proof fields may be absent. */
export type CachedPredictiveContexts = Omit<PredictiveContexts, WorkerResultKeys> &
  Partial<Pick<PredictiveContexts, WorkerResultKeys>>;

/**
 * What the store needs from the runtime: the ready engine surface. The
 * `ChartEngine` returned by `AlmaMeshRuntime.bootstrap()` / `.engine()`
 * satisfies this structurally.
 */
export interface PredictiveRuntime {
  computePredictive(input: PredictiveInput): Promise<PredictiveContexts>;
}

/** Birth + instant input for `ensurePredictive`. `referenceInstant` is REQUIRED. */
export interface EnsurePredictiveInput {
  /** Cache identity: the profile this chart belongs to. */
  readonly profileKey: string;
  readonly datetimeUtc: string; // ISO-8601 UTC birth instant
  readonly latitude: number;
  readonly longitude: number;
  /** ISO-8601 — explicit, never wall-clock; pins dasha "current" + transit "now". */
  readonly referenceInstant: string;
}

export interface PredictiveStore {
  status: PredictiveStatus;
  error?: string;
  transitCtx?: TransitCtx;
  vargaCtxFull?: VargaCtxFull;
  strengthCtx?: StrengthCtx;
  domainsCtx?: DomainsCtx;
  /**
   * The raw calculation contexts from `computePredictive` (Spec 062, LLM delta
   * 1). Kept alongside the UI reshape so the optional
   * LLM layer can compose `transit_context`/`strength_context`/
   * `varga_context_full`/`domains_context` back onto the chart before the
   * `@almamesh/llm` sanitizer reduces them to month precision. Stays entirely
   * on-device; absent on pre-v2 persisted blobs (features then degrade
   * gracefully to natal-only narration). Same-boot proof is present on a live
   * result but deliberately removed from the persisted cache.
   */
  rawContexts?: CachedPredictiveContexts;
  /** The profile the loaded/loading contexts belong to. */
  profileKey?: string;
  /** Internal idempotency key over profile, natal birth input, and reference instant. */
  requestKey?: string;
  /**
   * Compute (once) the predictive contexts for `input` via the engine.
   * No-op when already `ready` or `loading` for the same profile + reference
   * instant; an `error` state can always be retried.
   */
  ensurePredictive(runtime: PredictiveRuntime, input: EnsurePredictiveInput): Promise<void>;
  /** Back to `idle` with no contexts (e.g. on profile deletion). */
  reset(): void;
}

const EMPTY_CONTEXTS = {
  transitCtx: undefined,
  vargaCtxFull: undefined,
  strengthCtx: undefined,
  domainsCtx: undefined,
  rawContexts: undefined,
} as const;

/**
 * Complete identity of one predictive computation.
 *
 * Birth time and coordinates are load-bearing: rectification or a profile edit
 * can change the natal lagna while retaining the same profile and reference
 * day. Omitting them re-serves transit houses rotated from the previous chart.
 * JSON over an ordered tuple is deterministic and avoids delimiter collisions.
 */
export function predictiveRequestKey(input: EnsurePredictiveInput): string {
  return JSON.stringify([
    input.profileKey,
    input.datetimeUtc,
    input.latitude,
    input.longitude,
    input.referenceInstant,
  ]);
}

// --- Persistence (canonical OPFS SQLite) ------------------------------------
//
// The predictive superset takes ~30s under Pyodide. Without persistence the
// store reset to `idle` on every page reload / PWA relaunch, so the auto-kickoff
// re-ran the whole compute even though the chart + reference day were unchanged
// ("Life Atlas keeps regenerating"). We persist ONLY a completed (`ready`)
// result keyed by the complete natal input + reference instant, so a reload
// with the same chart + day rehydrates to `ready` and `ensurePredictive`
// short-circuits without ever crossing a rectification boundary.

/**
 * Bump when the persisted predictive shape changes; always pair with `migrate`.
 * v1 → v2 (Spec 062, LLM delta 1): added the OPTIONAL `rawContexts` slice.
 * v2 → v3: expired receipts and signer keys that belonged to a prior Worker boot.
 */
export const PREDICTIVE_PERSIST_VERSION = 3;

/** The canonical SQLite key holding the persisted predictive slice. */
export const PREDICTIVE_PERSIST_NAME = 'almamesh-predictive';

/**
 * The slice `partialize` persists. Written ONLY when `status === 'ready'` (a
 * completed result); a `loading`/`error` state is flattened to `idle` so a
 * reload mid-compute or a cached failure never re-serves a broken/half state.
 */
export interface PersistedPredictiveState {
  status: PredictiveStatus;
  error?: string;
  transitCtx?: TransitCtx;
  vargaCtxFull?: VargaCtxFull;
  strengthCtx?: StrengthCtx;
  domainsCtx?: DomainsCtx;
  /** Cached calculations (v2+); per-boot receipts/signer are never durable. */
  rawContexts?: CachedPredictiveContexts;
  profileKey?: string;
  requestKey?: string;
}

/** The clean idle snapshot both `migrate` and the rehydration coercer fall back to. */
const IDLE_PERSISTED: PersistedPredictiveState = {
  status: 'idle',
  error: undefined,
  ...EMPTY_CONTEXTS,
  profileKey: undefined,
  requestKey: undefined,
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Keep cached calculations, but never carry per-Worker-boot proof across reloads. */
function withoutBootProof(
  raw: CachedPredictiveContexts | undefined,
): CachedPredictiveContexts | undefined {
  if (!raw) return undefined;
  const {
    domain_strength_receipts: _receipts,
    strength_signer_public_key: _signer,
    ...calculations
  } = raw;
  return calculations;
}

/** Persist ONLY a completed (`ready`) result + its identity; else persist idle. */
function partializePredictive(state: PredictiveStore): PersistedPredictiveState {
  if (state.status !== 'ready') {
    return IDLE_PERSISTED;
  }
  return {
    status: 'ready',
    error: undefined,
    transitCtx: state.transitCtx,
    vargaCtxFull: state.vargaCtxFull,
    strengthCtx: state.strengthCtx,
    domainsCtx: state.domainsCtx,
    rawContexts: withoutBootProof(state.rawContexts),
    profileKey: state.profileKey,
    requestKey: state.requestKey,
  };
}

/** The four raw engine slices a persisted `rawContexts` must carry. */
const RAW_CONTEXT_KEYS = [
  'transit_context',
  'varga_context_full',
  'strength_context',
  'domains_context',
] as const;

/**
 * Structurally validate a persisted `rawContexts` blob: a plain record whose
 * four engine slices are each plain records. Anything else (tampered storage,
 * a partial write, an old shape) is DROPPED — the LLM composition layer then
 * degrades to natal-only, exactly like a v1 blob. Never throws.
 */
function coerceRawContexts(value: unknown): CachedPredictiveContexts | undefined {
  if (!isPlainRecord(value)) {
    return undefined;
  }
  return RAW_CONTEXT_KEYS.every((key) => isPlainRecord(value[key]))
    ? withoutBootProof(value as unknown as CachedPredictiveContexts)
    : undefined;
}

/**
 * Coerce ANY persisted blob into a SAFE snapshot. Only a fully-formed `ready`
 * result (its contexts plus a `requestKey` identity) survives a reload; a
 * persisted `loading`/`error`/unknown shape is flattened to a clean `idle` so a
 * reload mid-compute or a cached failure never wedges the store or serves stale
 * or half-computed data.
 */
export function coercePersistedPredictive(persisted: unknown): PersistedPredictiveState {
  if (
    !isPlainRecord(persisted) ||
    persisted.status !== 'ready' ||
    typeof persisted.requestKey !== 'string'
  ) {
    return IDLE_PERSISTED;
  }
  return {
    status: 'ready',
    error: undefined,
    transitCtx: persisted.transitCtx as TransitCtx | undefined,
    vargaCtxFull: persisted.vargaCtxFull as VargaCtxFull | undefined,
    strengthCtx: persisted.strengthCtx as StrengthCtx | undefined,
    domainsCtx: persisted.domainsCtx as DomainsCtx | undefined,
    // Absent on v1 blobs, and DROPPED when malformed: LLM composition then
    // degrades to natal-only (never an error, never a throw).
    rawContexts: coerceRawContexts(persisted.rawContexts),
    profileKey: typeof persisted.profileKey === 'string' ? persisted.profileKey : undefined,
    requestKey: persisted.requestKey,
  };
}

/**
 * A v1 blob simply lacks `rawContexts`; keep its ready UI contexts and let the
 * LLM layer degrade to natal-only. A v2 blob keeps its calculations while
 * `coercePersistedPredictive` strips proof from the previous Worker boot. Any
 * other old/unknown version becomes a clean idle slate. Current-version blobs
 * still flow through `merge`, which applies the same proof-expiry rule.
 */
export function migratePredictivePersistedState(
  persisted: unknown,
  fromVersion: number,
): PersistedPredictiveState {
  if (fromVersion === 1 || fromVersion === 2) {
    return coercePersistedPredictive(persisted);
  }
  return IDLE_PERSISTED;
}

/** Merge the (coerced) persisted slice onto the live store, keeping its actions. */
function mergePredictivePersisted(persisted: unknown, current: PredictiveStore): PredictiveStore {
  return { ...current, ...coercePersistedPredictive(persisted) };
}

export const predictiveStoreCreator: StateCreator<PredictiveStore> = (set, get) => ({
  status: 'idle',
  error: undefined,
  ...EMPTY_CONTEXTS,
  profileKey: undefined,
  requestKey: undefined,

  async ensurePredictive(runtime, input) {
    const key = predictiveRequestKey(input);
    const { status, requestKey } = get();
    const settledForKey = status === 'ready' || status === 'loading';
    if (settledForKey && requestKey === key) {
      return; // idempotent: already computed (or computing) this exact request
    }
    set({
      status: 'loading',
      error: undefined,
      ...EMPTY_CONTEXTS,
      profileKey: input.profileKey,
      requestKey: key,
    });
    try {
      const raw = await runtime.computePredictive({
        datetimeUtc: input.datetimeUtc,
        latitude: input.latitude,
        longitude: input.longitude,
        referenceInstant: input.referenceInstant,
      });
      if (get().requestKey !== key) {
        return; // superseded by a newer profile/instant while in flight
      }
      set({
        status: 'ready',
        error: undefined,
        transitCtx: toTransitCtx(raw.transit_context),
        vargaCtxFull: toVargaCtx(raw.varga_context_full),
        strengthCtx: toStrengthCtx(raw.strength_context),
        domainsCtx: toDomainsCtx(raw.domains_context, raw.domain_strength_assays),
        // The raw engine contexts, verbatim, for the LLM composition layer
        // (Spec 062 delta 1) — persisted with the reshape, never re-derived.
        rawContexts: raw,
      });
    } catch (err) {
      if (get().requestKey !== key) {
        return; // a newer request owns the store now; keep its state
      }
      set({
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        ...EMPTY_CONTEXTS,
      });
    }
  },

  reset() {
    set({
      status: 'idle',
      error: undefined,
      ...EMPTY_CONTEXTS,
      profileKey: undefined,
      requestKey: undefined,
    });
  },
});

export const usePredictiveStore = create<PredictiveStore>()(
  persist<PredictiveStore, [], [], PersistedPredictiveState>(predictiveStoreCreator, {
    name: PREDICTIVE_PERSIST_NAME,
    version: PREDICTIVE_PERSIST_VERSION,
    storage: createJSONStorage(() => deletionAwareIdbStorage),
    partialize: partializePredictive,
    migrate: migratePredictivePersistedState,
    merge: mergePredictivePersisted,
  }),
);

/** Resolve once the persisted predictive results have finished SQLite hydration. */
export function whenPredictiveHydrated(): Promise<HydrationOutcome> {
  return whenHydrated(usePredictiveStore.persist);
}
