// usePredictiveStore — the lazy predictive slice over the in-browser engine.
//
// The runtime is mocked (an object with `computePredictive`); the store must
// drive status idle -> loading -> ready, adapt the raw engine contexts through
// the pure to*Ctx adapters, and be IDEMPOTENT per profile + reference instant.

import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  LifeDomainsContext,
  PredictiveContexts,
  StrengthContext,
  TransitContext,
  VargaContextFull,
} from "@almamesh/browser/types";

import {
  predictiveRequestKey,
  usePredictiveStore,
  type EnsurePredictiveInput,
} from "./predictive";

// --- minimal but adapter-complete raw fixtures ---

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

const RAW: PredictiveContexts = {
  transit_context: rawTransit,
  varga_context_full: rawVargas,
  strength_context: rawStrength,
  domains_context: rawDomains,
};

const INPUT: EnsurePredictiveInput = {
  profileKey: "profile-1",
  datetimeUtc: "1990-01-15T12:00:00+00:00",
  latitude: 28.6139,
  longitude: 77.209,
  referenceInstant: "2026-06-09T12:00:00+00:00",
  utcOffsetMinutes: 330,
};

const makeRuntime = (impl?: () => Promise<PredictiveContexts>) => ({
  computePredictive: vi.fn(impl ?? (() => Promise.resolve(RAW))),
});

describe("usePredictiveStore", () => {
  beforeEach(() => {
    usePredictiveStore.getState().reset();
  });

  it("starts idle with no contexts", () => {
    const s = usePredictiveStore.getState();
    expect(s.status).toBe("idle");
    expect(s.transitCtx).toBeUndefined();
    expect(s.vargaCtxFull).toBeUndefined();
    expect(s.strengthCtx).toBeUndefined();
    expect(s.domainsCtx).toBeUndefined();
    expect(s.profileKey).toBeUndefined();
    expect(s.error).toBeUndefined();
  });

  it("runs the worker call with the birth + EXPLICIT reference instant and stores adapted contexts", async () => {
    const runtime = makeRuntime();

    await usePredictiveStore.getState().ensurePredictive(runtime, INPUT);

    expect(runtime.computePredictive).toHaveBeenCalledWith({
      datetimeUtc: INPUT.datetimeUtc,
      latitude: INPUT.latitude,
      longitude: INPUT.longitude,
      referenceInstant: INPUT.referenceInstant,
      utcOffsetMinutes: 330,
    });
    const s = usePredictiveStore.getState();
    expect(s.status).toBe("ready");
    expect(s.profileKey).toBe("profile-1");
    // Adapted (UI-shaped) contexts, e.g. Title-Case signs lowercased.
    expect(s.transitCtx?.instant).toBe("2026-06-09T12:00:00Z");
    expect(s.transitCtx?.sade_sati.natal_moon_sign).toBe("cancer");
    expect(s.vargaCtxFull).toBeDefined();
    expect(s.strengthCtx?.ashtakavarga.sarva.total).toBe(337);
    expect(s.domainsCtx?.instant).toBe("2026-06-09T12:00:00Z");
    expect(s.error).toBeUndefined();
  });

  it("reports loading while the worker call is in flight", async () => {
    let resolve!: (value: PredictiveContexts) => void;
    const runtime = makeRuntime(
      () => new Promise<PredictiveContexts>((res) => (resolve = res)),
    );

    const pending = usePredictiveStore.getState().ensurePredictive(runtime, INPUT);
    expect(usePredictiveStore.getState().status).toBe("loading");

    resolve(RAW);
    await pending;
    expect(usePredictiveStore.getState().status).toBe("ready");
  });

  it("is idempotent: a repeat call for the same profile + reference instant is a no-op", async () => {
    const runtime = makeRuntime();

    await usePredictiveStore.getState().ensurePredictive(runtime, INPUT);
    await usePredictiveStore.getState().ensurePredictive(runtime, INPUT);

    expect(runtime.computePredictive).toHaveBeenCalledTimes(1);
  });

  it("recomputes when rectification changes the birth instant for the same profile and day", async () => {
    const runtime = makeRuntime();

    await usePredictiveStore.getState().ensurePredictive(runtime, INPUT);
    await usePredictiveStore.getState().ensurePredictive(runtime, {
      ...INPUT,
      datetimeUtc: "1990-01-15T12:15:00+00:00",
    });

    expect(runtime.computePredictive).toHaveBeenCalledTimes(2);
    expect(runtime.computePredictive).toHaveBeenLastCalledWith({
      datetimeUtc: "1990-01-15T12:15:00+00:00",
      latitude: INPUT.latitude,
      longitude: INPUT.longitude,
      referenceInstant: INPUT.referenceInstant,
      utcOffsetMinutes: INPUT.utcOffsetMinutes,
    });
  });

  it("does not double-compute while a call for the same key is already loading", async () => {
    let resolve!: (value: PredictiveContexts) => void;
    const runtime = makeRuntime(
      () => new Promise<PredictiveContexts>((res) => (resolve = res)),
    );

    const first = usePredictiveStore.getState().ensurePredictive(runtime, INPUT);
    const second = usePredictiveStore.getState().ensurePredictive(runtime, INPUT);
    resolve(RAW);
    await Promise.all([first, second]);

    expect(runtime.computePredictive).toHaveBeenCalledTimes(1);
  });

  it("recomputes for a different profile or a different reference instant", async () => {
    const runtime = makeRuntime();

    await usePredictiveStore.getState().ensurePredictive(runtime, INPUT);
    await usePredictiveStore
      .getState()
      .ensurePredictive(runtime, { ...INPUT, profileKey: "profile-2" });
    await usePredictiveStore
      .getState()
      .ensurePredictive(runtime, { ...INPUT, referenceInstant: "2026-07-01T00:00:00+00:00" });

    expect(runtime.computePredictive).toHaveBeenCalledTimes(3);
    expect(usePredictiveStore.getState().profileKey).toBe("profile-1");
  });

  it("surfaces a worker failure as status error and allows a retry", async () => {
    const failing = makeRuntime(() => Promise.reject(new Error("engine not booted")));

    await usePredictiveStore.getState().ensurePredictive(failing, INPUT);
    expect(usePredictiveStore.getState().status).toBe("error");
    expect(usePredictiveStore.getState().error).toBe("engine not booted");

    const ok = makeRuntime();
    await usePredictiveStore.getState().ensurePredictive(ok, INPUT);
    expect(ok.computePredictive).toHaveBeenCalledTimes(1);
    expect(usePredictiveStore.getState().status).toBe("ready");
  });

  it("drops a stale response when a newer profile superseded it", async () => {
    let resolveSlow!: (value: PredictiveContexts) => void;
    const slow = makeRuntime(
      () => new Promise<PredictiveContexts>((res) => (resolveSlow = res)),
    );
    const fast = makeRuntime();

    const slowCall = usePredictiveStore.getState().ensurePredictive(slow, INPUT);
    await usePredictiveStore
      .getState()
      .ensurePredictive(fast, { ...INPUT, profileKey: "profile-2" });
    resolveSlow(RAW);
    await slowCall;

    expect(usePredictiveStore.getState().profileKey).toBe("profile-2");
    expect(usePredictiveStore.getState().status).toBe("ready");
  });

  it("drops an in-flight response when rectification supersedes its birth instant", async () => {
    let resolveOldBirth!: (value: PredictiveContexts) => void;
    const oldBirth = makeRuntime(
      () => new Promise<PredictiveContexts>((resolve) => (resolveOldBirth = resolve)),
    );
    const rectifiedBirth = makeRuntime();

    const oldCall = usePredictiveStore.getState().ensurePredictive(oldBirth, INPUT);
    await usePredictiveStore.getState().ensurePredictive(rectifiedBirth, {
      ...INPUT,
      datetimeUtc: "1990-01-15T12:15:00+00:00",
    });
    resolveOldBirth(RAW);
    await oldCall;

    expect(usePredictiveStore.getState().requestKey).toBe(
      predictiveRequestKey({
        ...INPUT,
        datetimeUtc: "1990-01-15T12:15:00+00:00",
      }),
    );
    expect(usePredictiveStore.getState().status).toBe("ready");
  });

  it("reset returns to idle and clears contexts", async () => {
    await usePredictiveStore.getState().ensurePredictive(makeRuntime(), INPUT);

    usePredictiveStore.getState().reset();

    const s = usePredictiveStore.getState();
    expect(s.status).toBe("idle");
    expect(s.transitCtx).toBeUndefined();
    expect(s.profileKey).toBeUndefined();
  });
});

describe("predictiveRequestKey — the civil offset is part of the identity", () => {
  it("changes when only the birthplace civil offset changes", () => {
    expect(predictiveRequestKey(INPUT)).not.toBe(
      predictiveRequestKey({ ...INPUT, utcOffsetMinutes: 780 }),
    );
  });
});
