// usePredictiveStore — IndexedDB persistence + safe rehydration.
//
// Bug fixed here ("Life Atlas keeps regenerating"): the store was a plain
// zustand `create(...)` with NO persistence, so every page reload / PWA relaunch
// reset it to `idle` and the auto-kickoff re-ran the ~30s predictive compute even
// though the chart + reference day were unchanged. These tests drive the reload
// path: seed a `ready` result, persist it, simulate a fresh hydration, and assert
// that the SAME input no longer recomputes — while a persisted `loading`/`error`
// state (a reload mid-compute or a cached failure) is coerced back to `idle`.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createJSONStorage, type StateStorage } from "zustand/middleware";

import type {
  LifeDomainsContext,
  PredictiveContexts,
  StrengthContext,
  TransitContext,
  VargaContextFull,
} from "@almamesh/browser/types";

import {
  usePredictiveStore,
  PREDICTIVE_PERSIST_NAME,
  PREDICTIVE_PERSIST_VERSION,
  predictiveRequestKey,
  type EnsurePredictiveInput,
} from "./predictive";
import * as predictiveModule from "./predictive";

// --- minimal but adapter-complete raw fixtures (mirrors predictive.test.ts) ---

const rawTransit: TransitContext = {
  instant: "2026-06-09T12:00:00Z",
  gochara: { instant: "2026-06-09T12:00:00Z", transit_ayanamsa: 24.2, placements: {} },
  sade_sati: {
    is_active: false,
    current_phase: "none",
    natal_moon_sign: "Cancer",
    cycle: [],
    cycle_start: null,
    cycle_end: null,
  },
  slow_hits: [],
  fusion: {
    instant: "2026-06-09T12:00:00Z",
    maha_lord: "saturn",
    antar_lord: null,
    maha_lord_transit_house_from_moon: 3,
    maha_lord_transit_house_from_lagna: 5,
    reinforcing: [],
    afflicting: [],
    net_weight: 0,
    severity: "neutral",
  },
  timeline: { window_start: "2026-06-09T12:00:00Z", window_end: "2027-06-09T12:00:00Z", events: [] },
};

const rawVargas: VargaContextFull = {
  charts: {},
  vargottama: [],
  shadvarga_own_sign: [],
  vimshopaka: [],
};

const rawStrength: StrengthContext = {
  sunrise_utc_iso: "1990-01-15T01:42:00+00:00",
  ashtakavarga: { bhinna: {}, sarva: { bindus: {}, total: 337 } },
  shadbala: { planets: {} },
};

const rawDomains = { instant: "2026-06-09T12:00:00Z", forecasts: {} } as LifeDomainsContext;

const RAW = {
  transit_context: rawTransit,
  varga_context_full: rawVargas,
  strength_context: rawStrength,
  domains_context: rawDomains,
  domain_strength_assays: {},
  domain_strength_receipts: { career: { stale: true } },
  strength_signer_public_key: "prior-worker-boot-key",
} as unknown as PredictiveContexts;

const INPUT: EnsurePredictiveInput = {
  profileKey: "profile-1",
  datetimeUtc: "1990-01-15T12:00:00+00:00",
  latitude: 28.6139,
  longitude: 77.209,
  referenceInstant: "2026-06-09T12:00:00+00:00",
};

const KEY = predictiveRequestKey(INPUT);

const makeRuntime = (impl?: () => Promise<PredictiveContexts>) => ({
  computePredictive: vi.fn(impl ?? (() => Promise.resolve(RAW))),
});

// --- an injectable, synchronous in-memory StateStorage (no IndexedDB in node) --

let memMap: Map<string, string>;

function installMemoryStorage(): void {
  const map = new Map<string, string>();
  memMap = map;
  const storage: StateStorage = {
    getItem: (name) => map.get(name) ?? null,
    setItem: (name, value) => void map.set(name, value),
    removeItem: (name) => void map.delete(name),
  };
  usePredictiveStore.persist.setOptions({ storage: createJSONStorage(() => storage) });
}

/** Persist a `ready` result via the real path, then simulate a page reload. */
async function seedReadyThenReload(): Promise<void> {
  await usePredictiveStore.getState().ensurePredictive(makeRuntime(), INPUT);
  const persisted = memMap.get(PREDICTIVE_PERSIST_NAME)!; // capture the ready blob
  usePredictiveStore.getState().reset(); // wipe live runtime state (fresh document)
  memMap.set(PREDICTIVE_PERSIST_NAME, persisted); // storage still holds it across "reload"
  await usePredictiveStore.persist.rehydrate();
}

/** Hand-seed a raw persisted blob (bypassing partialize) for coercion tests. */
async function reloadWithPersistedState(state: Record<string, unknown>): Promise<void> {
  usePredictiveStore.getState().reset();
  memMap.set(
    PREDICTIVE_PERSIST_NAME,
    JSON.stringify({ state, version: PREDICTIVE_PERSIST_VERSION }),
  );
  await usePredictiveStore.persist.rehydrate();
}

describe("usePredictiveStore persistence", () => {
  beforeEach(() => {
    installMemoryStorage();
    usePredictiveStore.getState().reset();
  });

  it("partialize persists ONLY a ready result's contexts + identity (never actions)", async () => {
    await usePredictiveStore.getState().ensurePredictive(makeRuntime(), INPUT);

    const blob = JSON.parse(memMap.get(PREDICTIVE_PERSIST_NAME)!);
    expect(blob.version).toBe(PREDICTIVE_PERSIST_VERSION);
    expect(blob.state.status).toBe("ready");
    expect(blob.state.requestKey).toBe(KEY);
    expect(blob.state.profileKey).toBe("profile-1");
    expect(blob.state.transitCtx).toBeDefined();
    expect(blob.state.strengthCtx.ashtakavarga.sarva.total).toBe(337);
    // Actions are not serializable and must never be persisted.
    expect(blob.state.ensurePredictive).toBeUndefined();
    expect(blob.state.reset).toBeUndefined();
  });

  it("never persists a live error state — partialize writes idle instead", async () => {
    const failing = makeRuntime(() => Promise.reject(new Error("engine not booted")));
    await usePredictiveStore.getState().ensurePredictive(failing, INPUT);
    expect(usePredictiveStore.getState().status).toBe("error");

    const blob = JSON.parse(memMap.get(PREDICTIVE_PERSIST_NAME)!);
    expect(blob.state.status).toBe("idle");
    expect(blob.state.requestKey).toBeUndefined();
    expect(blob.state.transitCtx).toBeUndefined();
  });

  it("rehydrates a ready result intact across a reload", async () => {
    await seedReadyThenReload();

    const s = usePredictiveStore.getState();
    expect(s.status).toBe("ready");
    expect(s.requestKey).toBe(KEY);
    expect(s.profileKey).toBe("profile-1");
    // Adapted (UI-shaped) contexts survive: Title-Case signs stay lowercased.
    expect(s.transitCtx?.sade_sati.natal_moon_sign).toBe("cancer");
    expect(s.strengthCtx?.ashtakavarga.sarva.total).toBe(337);
    expect(s.error).toBeUndefined();
  });

  it("after a reload, the SAME input does NOT recompute (the regenerating-bug fix)", async () => {
    await seedReadyThenReload();

    const fresh = makeRuntime();
    await usePredictiveStore.getState().ensurePredictive(fresh, INPUT);

    expect(fresh.computePredictive).not.toHaveBeenCalled();
    expect(usePredictiveStore.getState().status).toBe("ready");
  });

  it("after a reload, a DIFFERENT reference instant DOES recompute", async () => {
    await seedReadyThenReload();

    const fresh = makeRuntime();
    await usePredictiveStore
      .getState()
      .ensurePredictive(fresh, { ...INPUT, referenceInstant: "2026-07-01T00:00:00+00:00" });

    expect(fresh.computePredictive).toHaveBeenCalledTimes(1);
    expect(usePredictiveStore.getState().status).toBe("ready");
  });

  it("after a reload, a DIFFERENT profile DOES recompute", async () => {
    await seedReadyThenReload();

    const fresh = makeRuntime();
    await usePredictiveStore
      .getState()
      .ensurePredictive(fresh, { ...INPUT, profileKey: "profile-2" });

    expect(fresh.computePredictive).toHaveBeenCalledTimes(1);
    expect(usePredictiveStore.getState().profileKey).toBe("profile-2");
  });

  it("after a reload, a rectified birth instant on the SAME profile/day recomputes", async () => {
    await seedReadyThenReload();

    const fresh = makeRuntime();
    await usePredictiveStore.getState().ensurePredictive(fresh, {
      ...INPUT,
      datetimeUtc: "1990-01-15T12:15:00+00:00",
    });

    expect(fresh.computePredictive).toHaveBeenCalledTimes(1);
    expect(usePredictiveStore.getState().requestKey).toBe(
      predictiveRequestKey({
        ...INPUT,
        datetimeUtc: "1990-01-15T12:15:00+00:00",
      }),
    );
  });

  it("coerces a persisted 'loading' status to idle with empty contexts (reload mid-compute)", async () => {
    await reloadWithPersistedState({
      status: "loading",
      error: undefined,
      transitCtx: rawTransit,
      profileKey: "profile-1",
      requestKey: KEY,
    });

    const s = usePredictiveStore.getState();
    expect(s.status).toBe("idle");
    expect(s.transitCtx).toBeUndefined();
    expect(s.strengthCtx).toBeUndefined();
    expect(s.requestKey).toBeUndefined();

    // Not wedged: a compute for that key now runs cleanly.
    const runtime = makeRuntime();
    await usePredictiveStore.getState().ensurePredictive(runtime, INPUT);
    expect(runtime.computePredictive).toHaveBeenCalledTimes(1);
  });

  it("coerces a persisted 'error' status to idle with empty contexts (cached failure)", async () => {
    await reloadWithPersistedState({
      status: "error",
      error: "engine not booted",
      transitCtx: rawTransit,
      profileKey: "profile-1",
      requestKey: KEY,
    });

    const s = usePredictiveStore.getState();
    expect(s.status).toBe("idle");
    expect(s.transitCtx).toBeUndefined();
    expect(s.requestKey).toBeUndefined();
    expect(s.error).toBeUndefined();

    const runtime = makeRuntime();
    await usePredictiveStore.getState().ensurePredictive(runtime, INPUT);
    expect(runtime.computePredictive).toHaveBeenCalledTimes(1);
  });

  it("coerces a corrupt / unknown persisted blob to idle", async () => {
    await reloadWithPersistedState({ status: "ready" }); // 'ready' but no requestKey/contexts

    expect(usePredictiveStore.getState().status).toBe("idle");
    expect(usePredictiveStore.getState().requestKey).toBeUndefined();
  });

  it("exposes a barrier that stays pending until IndexedDB hydration finishes", async () => {
    const waitForHydration = (
      predictiveModule as typeof predictiveModule & {
        whenPredictiveHydrated?: () => Promise<void>;
      }
    ).whenPredictiveHydrated;
    expect(waitForHydration).toBeTypeOf("function");
    if (waitForHydration === undefined) return;

    let finishHydration: (() => void) | undefined;
    const hasHydrated = vi
      .spyOn(usePredictiveStore.persist, "hasHydrated")
      .mockReturnValue(false);
    const onFinishHydration = vi
      .spyOn(usePredictiveStore.persist, "onFinishHydration")
      .mockImplementation((callback) => {
        finishHydration = () => callback(usePredictiveStore.getState());
        return vi.fn();
      });

    try {
      let settled = false;
      const pending = waitForHydration().then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      finishHydration?.();
      await pending;
      expect(settled).toBe(true);
    } finally {
      hasHydrated.mockRestore();
      onFinishHydration.mockRestore();
    }
  });

  it("resolves when hydration finishes between its initial check and subscription", async () => {
    const hasHydrated = vi
      .spyOn(usePredictiveStore.persist, "hasHydrated")
      .mockReturnValueOnce(false)
      .mockReturnValue(true);
    const onFinishHydration = vi
      .spyOn(usePredictiveStore.persist, "onFinishHydration")
      .mockReturnValue(vi.fn());

    try {
      let settled = false;
      void predictiveModule.whenPredictiveHydrated().then(() => {
        settled = true;
      });
      await Promise.resolve();

      expect(settled).toBe(true);
      expect(onFinishHydration).toHaveBeenCalledTimes(1);
    } finally {
      hasHydrated.mockRestore();
      onFinishHydration.mockRestore();
    }
  });
});

// Spec 062 (LLM delta 1): the engine's calculation contexts are persisted
// alongside the UI reshape so the LLM composition layer can put
// transit_context/strength_context/varga_context_full/domains_context back
// onto the chart. A v1 blob (no raw slice) keeps its ready UI contexts; v3 also
// expires v2 proof from a previous Worker boot without discarding calculations.
describe("usePredictiveStore — raw contexts persistence (Spec 062 delta 1)", () => {
  beforeEach(() => {
    installMemoryStorage();
    usePredictiveStore.getState().reset();
  });

  it("holds and persists the raw engine contexts on a ready result", async () => {
    await usePredictiveStore.getState().ensurePredictive(makeRuntime(), INPUT);

    expect(usePredictiveStore.getState().rawContexts).toEqual(RAW);
    const blob = JSON.parse(memMap.get(PREDICTIVE_PERSIST_NAME)!);
    expect(blob.version).toBe(PREDICTIVE_PERSIST_VERSION);
    expect(blob.state.rawContexts.transit_context).toBeDefined();
    expect(blob.state.rawContexts.strength_context.ashtakavarga.sarva.total).toBe(337);
  });

  it("rehydrates cached calculations and Assay details without prior-boot proof", async () => {
    await seedReadyThenReload();
    const raw = usePredictiveStore.getState().rawContexts;
    expect(raw?.transit_context).toEqual(RAW.transit_context);
    expect(raw?.domains_context).toEqual(RAW.domains_context);
    expect(raw?.domain_strength_assays).toEqual(RAW.domain_strength_assays);
    expect(raw).not.toHaveProperty("domain_strength_receipts");
    expect(raw).not.toHaveProperty("strength_signer_public_key");
  });

  it("migrates a v2 cache by preserving calculations and deleting its stale proof", async () => {
    memMap.set(
      PREDICTIVE_PERSIST_NAME,
      JSON.stringify({
        version: 2,
        state: {
          status: "ready",
          transitCtx: rawTransit,
          strengthCtx: rawStrength,
          rawContexts: RAW,
          profileKey: INPUT.profileKey,
          requestKey: KEY,
        },
      }),
    );

    await usePredictiveStore.persist.rehydrate();

    expect(usePredictiveStore.getState().rawContexts?.strength_context).toEqual(rawStrength);
    const rewritten = JSON.parse(memMap.get(PREDICTIVE_PERSIST_NAME)!);
    expect(rewritten.version).toBe(PREDICTIVE_PERSIST_VERSION);
    expect(rewritten.state.rawContexts).not.toHaveProperty("domain_strength_receipts");
    expect(rewritten.state.rawContexts).not.toHaveProperty("strength_signer_public_key");
  });

  it("reset clears the raw contexts", async () => {
    await usePredictiveStore.getState().ensurePredictive(makeRuntime(), INPUT);
    usePredictiveStore.getState().reset();
    expect(usePredictiveStore.getState().rawContexts).toBeUndefined();
  });

  it("migrates a v1 blob (no rawContexts): ready UI contexts survive, raw stays absent, NO recompute", async () => {
    // Build a genuine ready blob via the real path, then rewind it to v1 by
    // stripping the raw slice — exactly what an upgrading device carries.
    await usePredictiveStore.getState().ensurePredictive(makeRuntime(), INPUT);
    const blob = JSON.parse(memMap.get(PREDICTIVE_PERSIST_NAME)!);
    delete blob.state.rawContexts;
    blob.version = 1;
    usePredictiveStore.getState().reset();
    memMap.set(PREDICTIVE_PERSIST_NAME, JSON.stringify(blob));
    await usePredictiveStore.persist.rehydrate();

    const s = usePredictiveStore.getState();
    expect(s.status).toBe("ready"); // graceful: features degrade, never an error
    expect(s.rawContexts).toBeUndefined();
    expect(s.strengthCtx?.ashtakavarga.sarva.total).toBe(337);

    const fresh = makeRuntime();
    await usePredictiveStore.getState().ensurePredictive(fresh, INPUT);
    expect(fresh.computePredictive).not.toHaveBeenCalled();
  });

  it("reads an older build's timeline events (no station keys) as null after a reload", async () => {
    const ingress = {
      date: "2026-10-26T00:00:00Z",
      kind: "sign_ingress",
      graha: "jupiter",
      from_sign: "Gemini",
      to_sign: "Cancer",
      from_lord: null,
      to_lord: null,
      sade_sati_phase: null,
      severity: "neutral",
      descriptor: "jupiter.ingress.cancer",
    };
    const withEvent = {
      ...RAW,
      transit_context: { ...rawTransit, timeline: { ...rawTransit.timeline, events: [ingress] } },
    } as unknown as PredictiveContexts;
    await usePredictiveStore.getState().ensurePredictive(makeRuntime(() => Promise.resolve(withEvent)), INPUT);
    // Rewind the persisted UI event to the pre-Inc-B shape: no station keys at all.
    const blob = JSON.parse(memMap.get(PREDICTIVE_PERSIST_NAME)!);
    const [event] = blob.state.transitCtx.timeline.events;
    delete event.station_direction;
    delete event.station_sign;
    usePredictiveStore.getState().reset();
    memMap.set(PREDICTIVE_PERSIST_NAME, JSON.stringify(blob));
    await usePredictiveStore.persist.rehydrate();

    const events = usePredictiveStore.getState().transitCtx?.timeline.events ?? [];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ to_sign: "cancer", station_direction: null, station_sign: null });
  });

  it("drops non-object timeline events from a persisted blob instead of throwing", async () => {
    const ingress = {
      date: "2026-10-26T00:00:00Z",
      kind: "sign_ingress",
      graha: "jupiter",
      from_sign: "Gemini",
      to_sign: "Cancer",
      from_lord: null,
      to_lord: null,
      sade_sati_phase: null,
      severity: "neutral",
      descriptor: "jupiter.ingress.cancer",
    };
    const withEvent = {
      ...RAW,
      transit_context: { ...rawTransit, timeline: { ...rawTransit.timeline, events: [ingress] } },
    } as unknown as PredictiveContexts;
    await usePredictiveStore.getState().ensurePredictive(makeRuntime(() => Promise.resolve(withEvent)), INPUT);
    const blob = JSON.parse(memMap.get(PREDICTIVE_PERSIST_NAME)!);
    blob.state.transitCtx.timeline.events = [null, 7, "x", [], blob.state.transitCtx.timeline.events[0]];
    usePredictiveStore.getState().reset();
    memMap.set(PREDICTIVE_PERSIST_NAME, JSON.stringify(blob));
    await usePredictiveStore.persist.rehydrate();

    const events = usePredictiveStore.getState().transitCtx?.timeline.events ?? [];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ to_sign: "cancer", station_direction: null });
  });

  it("flattens an unknown pre-v1 version to a clean idle", async () => {
    await usePredictiveStore.getState().ensurePredictive(makeRuntime(), INPUT);
    const blob = JSON.parse(memMap.get(PREDICTIVE_PERSIST_NAME)!);
    blob.version = 0;
    usePredictiveStore.getState().reset();
    memMap.set(PREDICTIVE_PERSIST_NAME, JSON.stringify(blob));
    await usePredictiveStore.persist.rehydrate();

    expect(usePredictiveStore.getState().status).toBe("idle");
    expect(usePredictiveStore.getState().rawContexts).toBeUndefined();
  });
});

describe("usePredictiveStore — persisted rawContexts SHAPE validation", () => {
  beforeEach(() => {
    installMemoryStorage();
    usePredictiveStore.getState().reset();
  });

  // A tampered/corrupt persisted blob must never wedge rehydration: malformed
  // rawContexts are DROPPED (LLM composition degrades to natal-only) while the
  // ready UI contexts survive. Never a throw.
  const MALFORMED: readonly unknown[] = [
    "garbage",
    42,
    null,
    [],
    { transit_context: "not-a-record" },
    { transit_context: {} }, // missing the other three context slices
    { transit_context: {}, varga_context_full: {}, strength_context: {}, domains_context: null },
  ];

  it.each(MALFORMED.map((m) => [JSON.stringify(m) ?? String(m), m]))(
    "drops malformed rawContexts %s on rehydrate, keeping the ready UI contexts",
    async (_label, malformed) => {
      await usePredictiveStore.getState().ensurePredictive(makeRuntime(), INPUT);
      const blob = JSON.parse(memMap.get(PREDICTIVE_PERSIST_NAME)!);
      blob.state.rawContexts = malformed;
      usePredictiveStore.getState().reset();
      memMap.set(PREDICTIVE_PERSIST_NAME, JSON.stringify(blob));
      await expect(usePredictiveStore.persist.rehydrate()).resolves.not.toThrow();

      const s = usePredictiveStore.getState();
      expect(s.status).toBe("ready");
      expect(s.rawContexts).toBeUndefined();
      expect(s.strengthCtx?.ashtakavarga.sarva.total).toBe(337);
    },
  );

  it("keeps calculations but expires prior-boot proof from well-formed rawContexts", async () => {
    await seedReadyThenReload();
    const raw = usePredictiveStore.getState().rawContexts;
    expect(raw?.strength_context).toEqual(RAW.strength_context);
    expect(raw?.domain_strength_assays).toEqual(RAW.domain_strength_assays);
    expect(raw).not.toHaveProperty("domain_strength_receipts");
    expect(raw).not.toHaveProperty("strength_signer_public_key");
  });
});
