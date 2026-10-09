import { describe, expect, it } from "vitest";

import type {
  LifeDomainForecast,
  LifeDomainsContext,
  StrengthContext,
  TransitContext,
  VargaContextFull,
} from "@almamesh/browser/types";

import strengthGolden from "../../../../../backend/tests/fixtures/strength_golden_de421.json";
import transitGolden from "../../../../../backend/tests/fixtures/transit_golden_de421.json";
import vargaGolden from "../../../../../backend/tests/fixtures/varga_golden_de421.json";
import {
  toDomainsCtx,
  toStrengthCtx,
  toTransitCtx,
  toVargaCtx,
} from "./predictive";

// ---------------------------------------------------------------------------
// Fixtures: the committed backend goldens ARE the serialized contract
// (Pydantic model_dump(mode="json")), exactly what the Pyodide worker emits.
// ---------------------------------------------------------------------------

const DELHI_KEY = "1990-01-15T12:00:00+00:00";
const SADE_SATI_KEY = "2019-11-09T17:45:00+00:00";
const transitRaw = (transitGolden as Record<string, TransitContext>)[DELHI_KEY];
const transitSadeSatiRaw = (transitGolden as Record<string, TransitContext>)[
  SADE_SATI_KEY
];

// Lookup key into the backend golden fixture (varga_golden_de421.json). This is
// the fixture's opaque dictionary key, NOT a birth fixture — it must stay byte-
// identical to the committed golden or the lookup returns undefined.
const REFERENCE_KEY = "1988-08-08T01:14:00+00:00";
const vargaRaw = (vargaGolden as Record<string, VargaContextFull>)[REFERENCE_KEY];

const strengthRaw = (
  strengthGolden as { cases: ReadonlyArray<{ expected: StrengthContext }> }
).cases[0].expected;

// `domains_context` has no committed golden yet (built in a parallel wave), so
// this is a hand-constructed, minimal-but-valid LifeDomainsContext mirroring
// backend/src/almamesh/schemas/domains.py exactly.
const DOMAIN_NAMES = [
  "career",
  "finances",
  "health",
  "relationships",
  "spiritual",
  "education",
  "family",
] as const;

const CAREER_ASSAY = {
  schema: "assay.result/v1",
  method: { id: "minimum", version: "almamesh.domain-strength.v1" },
  score: 0.5179,
  interval: null,
  clamp: "reject",
  intercept: null,
  weight_total: null,
  components: [
    {
      id: "shadbala_pct",
      raw: 82.5,
      normalized: 0.825,
      declared_weight: null,
      operation: "add",
      coefficient: 1,
      contribution: 0.825,
      contribution_interval: null,
    },
    {
      id: "sav_pct",
      raw: 51.79,
      normalized: 0.5179,
      declared_weight: null,
      operation: "add",
      coefficient: 1,
      contribution: 0.5179,
      contribution_interval: null,
    },
  ],
  inputs_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  selected_component_id: "sav_pct",
} as const;

function rawForecast(domain: string): LifeDomainForecast {
  return {
    domain,
    houses: [
      {
        house: 10,
        sign: "Scorpio",
        lord: "mars",
        lord_house: 3,
        lord_sign: "Aries",
        lord_dignity: "own",
        rule: "career: 10th house of karma",
      },
    ],
    karakas: [
      {
        graha: "saturn",
        house: 4,
        sign: "Taurus",
        dignity: "friend",
        is_retrograde: false,
        rule: "Saturn is the karaka of career",
      },
    ],
    varga: {
      chart: "D10",
      graha: "saturn",
      sign: "Leo",
      sign_lord: "sun",
      same_sign_as_d1: true,
      vargottama: false,
      rule: "D10 Dasamsa governs career & public status",
    },
    strength_summary: {
      key_graha: "saturn",
      key_graha_rupas: 7.2,
      key_graha_meets_minimum: true,
      sav_bindus: 58,
      band: "strong",
      shadbala_pct: 82.5,
      sav_pct: 51.79,
      strength_pct: 51.79,
      strength_tier: "model",
      approximated: true,
      note: "band = AlmaMesh heuristic over exact Shadbala Rupas + SAV bindus",
    },
    current_emphasis: {
      active_dasha_significator: true,
      dasha_levels: ["maha", "antar"],
      matched_dasha_lords: ["saturn"],
      under_sade_sati: false,
      transit_severity: "supportive",
      approximated: true,
      note: "transit_severity = sign of a coarse vote-sum over domain-relevant transit signals",
      rule: "running maha lord is a domain significator",
    },
    upcoming_windows: [
      {
        date: "2026-12-07T16:42:12Z",
        source: "dasha",
        kind: "dasha_change",
        trigger: "jupiter",
        severity: "supportive",
        descriptor: "career.dasha.antar.jupiter",
      },
    ],
  };
}

const domainsRaw: LifeDomainsContext = {
  instant: "2026-06-09T12:00:00Z",
  forecasts: Object.fromEntries(DOMAIN_NAMES.map((d) => [d, rawForecast(d)])),
};

// ---------------------------------------------------------------------------
// toTransitCtx
// ---------------------------------------------------------------------------

describe("toTransitCtx", () => {
  it("returns undefined for absent input (older bundles emit no transit_context)", () => {
    expect(toTransitCtx(undefined)).toBeUndefined();
    expect(toTransitCtx(null)).toBeUndefined();
  });

  it("surfaces the instant and audit ayanamsa verbatim", () => {
    const ctx = toTransitCtx(transitRaw);
    expect(ctx?.instant).toBe("2026-06-09T12:00:00Z");
    expect(ctx?.gochara.instant).toBe("2026-06-09T12:00:00Z");
    expect(ctx?.gochara.transit_ayanamsa).toBe(24.22575);
  });

  it("reshapes gochara placements: all 9 grahas, signs lowercased, houses verbatim", () => {
    const ctx = toTransitCtx(transitRaw);
    expect(Object.keys(ctx?.gochara.placements ?? {}).sort()).toEqual([
      "jupiter",
      "ketu",
      "mars",
      "mercury",
      "moon",
      "rahu",
      "saturn",
      "sun",
      "venus",
    ]);
    const jupiter = ctx?.gochara.placements.jupiter;
    expect(jupiter?.sign).toBe("cancer");
    expect(jupiter?.natal_sign_occupied).toBe("cancer");
    expect(jupiter?.house_from_lagna).toBe(2);
    expect(jupiter?.house_from_moon).toBe(12);
    expect(jupiter?.longitude).toBe(91.486331);
    expect(jupiter?.nakshatra).toBe("Punarvasu");
    expect(jupiter?.is_retrograde).toBe(false);
  });

  it("reshapes the dasha-transit fusion verbatim (no recomputation)", () => {
    const fusion = toTransitCtx(transitRaw)?.fusion;
    expect(fusion?.maha_lord).toBe("rahu");
    expect(fusion?.antar_lord).toBe("mercury");
    expect(fusion?.maha_lord_transit_house_from_moon).toBe(7);
    expect(fusion?.maha_lord_transit_house_from_lagna).toBe(9);
    expect(fusion?.net_weight).toBe(0.05);
    expect(fusion?.severity).toBe("neutral");
    expect(fusion?.afflicting).toEqual(["ketu"]);
    expect(fusion?.reinforcing).toEqual([]);
  });

  it("reshapes an INACTIVE sade sati (empty cycle, null bounds preserved)", () => {
    const ss = toTransitCtx(transitRaw)?.sade_sati;
    expect(ss?.is_active).toBe(false);
    expect(ss?.current_phase).toBe("none");
    expect(ss?.natal_moon_sign).toBe("leo");
    expect(ss?.cycle).toEqual([]);
    expect(ss?.cycle_start).toBeNull();
    expect(ss?.cycle_end).toBeNull();
  });

  it("reshapes an ACTIVE sade sati cycle with lowercased saturn signs", () => {
    const ss = toTransitCtx(transitSadeSatiRaw)?.sade_sati;
    expect(ss?.is_active).toBe(true);
    expect(ss?.current_phase).toBe("peak");
    expect(ss?.natal_moon_sign).toBe("pisces");
    expect(ss?.cycle).toHaveLength(3);
    expect(ss?.cycle[0].phase).toBe("rising");
    expect(ss?.cycle[0].saturn_sign).toBe("aquarius");
    expect(ss?.cycle_start).toBe("2023-01-17T13:01:08.956683Z");
  });

  it("reshapes slow hits and the forward timeline (descriptors verbatim)", () => {
    const ctx = toTransitCtx(transitRaw);
    expect(ctx?.slow_hits[0].graha).toBe("jupiter");
    expect(ctx?.slow_hits[0].kind).toBe("sign_ingress");
    expect(ctx?.slow_hits[0].severity).toBe("supportive");
    expect(ctx?.slow_hits[0].natal_point).toBe("moon");

    expect(ctx?.timeline.window_start).toBe("2026-06-09T12:00:00Z");
    const first = ctx?.timeline.events.find((e) => e.descriptor === "jupiter.ingress.leo");
    expect(first?.descriptor).toBe("jupiter.ingress.leo");
    expect(first?.kind).toBe("sign_ingress");
    expect(first?.from_sign).toBe("cancer");
    expect(first?.to_sign).toBe("leo");
    expect(first?.from_lord).toBeNull();
    expect(first?.severity).toBe("neutral");
  });
});

// ---------------------------------------------------------------------------
// toVargaCtx (the FULL 16-chart Shodasavarga; distinct from the legacy D9-only
// varga_ctx the chart adapter keeps emitting unchanged)
// ---------------------------------------------------------------------------

describe("toVargaCtx (full Shodasavarga)", () => {
  it("returns undefined for absent input", () => {
    expect(toVargaCtx(undefined)).toBeUndefined();
    expect(toVargaCtx(null)).toBeUndefined();
  });

  it("carries all 16 divisional charts", () => {
    const ctx = toVargaCtx(vargaRaw);
    expect(Object.keys(ctx?.charts ?? {})).toHaveLength(16);
    expect(ctx?.charts.D1).toBeDefined();
    expect(ctx?.charts.D60).toBeDefined();
  });

  it("reshapes a chart: lagna + placements with lowercased signs, lords verbatim", () => {
    const ctx = toVargaCtx(vargaRaw);
    expect(ctx?.charts.D1?.lagna_sign).toBe("leo");
    expect(ctx?.charts.D1?.lagna_sign_lord).toBe("sun");
    const d10 = ctx?.charts.D10;
    expect(d10?.chart).toBe("D10");
    expect(d10?.lagna_sign).toBe("leo");
    expect(d10?.placements.sun?.sign).toBe("libra");
    expect(d10?.placements.sun?.sign_lord).toBe("venus");
    expect(Object.keys(d10?.placements ?? {})).toHaveLength(9);
  });

  it("carries the engine's D1 combustion flag onto every divisional placement", () => {
    // The Bengaluru reference native has Mercury combust in D1; the engine
    // carries that fact onto every varga, so the adapter must preserve it (it
    // used to be dropped, dimming only the D1 table).
    const ctx = toVargaCtx(vargaRaw);
    for (const chart of Object.values(ctx?.charts ?? {})) {
      expect(chart?.placements.mercury?.is_combust).toBe(true);
      // The Sun is never combust; a non-combust graha stays false.
      expect(chart?.placements.sun?.is_combust).toBe(false);
      expect(chart?.placements.jupiter?.is_combust).toBe(false);
    }
  });

  it("surfaces the strength tallies verbatim (no rescoring in TS)", () => {
    const ctx = toVargaCtx(vargaRaw);
    expect(ctx?.vargottama).toEqual([]);
    const sun = ctx?.shadvarga_own_sign.find((s) => s.graha === "sun");
    expect(sun?.own_sign_count).toBe(1);
    expect(sun?.charts_in_own_sign).toEqual(["D2"]);
    const sunScore = ctx?.vimshopaka.find((v) => v.graha === "sun");
    expect(sunScore?.score).toBe(2.0);
    expect(sunScore?.approximated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// toStrengthCtx
// ---------------------------------------------------------------------------

describe("toStrengthCtx", () => {
  it("returns undefined for absent input", () => {
    expect(toStrengthCtx(undefined)).toBeUndefined();
    expect(toStrengthCtx(null)).toBeUndefined();
  });

  it("echoes the Kalabala sunrise instant verbatim", () => {
    expect(toStrengthCtx(strengthRaw)?.sunrise_utc_iso).toBe(
      "1988-08-08T00:36:24.354119+00:00",
    );
  });

  it("reshapes Ashtakavarga: SAV total 337, sign keys lowercased, bindus verbatim", () => {
    const av = toStrengthCtx(strengthRaw)?.ashtakavarga;
    expect(av?.sarva.total).toBe(337);
    expect(Object.keys(av?.sarva.bindus ?? {})).toHaveLength(12);
    expect(av?.sarva.bindus.scorpio).toBe(29);
    expect(av?.bhinna.jupiter?.total).toBe(56);
    expect(av?.bhinna.jupiter?.bindus.aquarius).toBe(6);
    expect(av?.bhinna.jupiter?.planet).toBe("jupiter");
  });

  it("reshapes Shadbala: sub-balas with citations, totals and minimums verbatim", () => {
    const sb = toStrengthCtx(strengthRaw)?.shadbala;
    const jupiter = sb?.planets.jupiter;
    expect(jupiter?.total_virupas).toBe(389.061977);
    expect(jupiter?.total_rupas).toBe(6.484366);
    expect(jupiter?.required_rupas).toBe(6.5);
    expect(jupiter?.meets_minimum).toBe(false);
    expect(jupiter?.sthana.uccha.virupas).toBe(41.315728);
    expect(jupiter?.sthana.uccha.approximated).toBe(false);
    expect(jupiter?.sthana.uccha.citation).toContain("Uchchabala");
    expect(jupiter?.kala.total_virupas).toEqual(expect.any(Number));
    expect(jupiter?.dig.citation).toContain("Digbala");
  });
});

// ---------------------------------------------------------------------------
// toDomainsCtx
// ---------------------------------------------------------------------------

describe("toDomainsCtx", () => {
  it("returns undefined for absent input", () => {
    expect(toDomainsCtx(undefined)).toBeUndefined();
    expect(toDomainsCtx(null)).toBeUndefined();
  });

  it("carries every one of the 7 life domains", () => {
    const ctx = toDomainsCtx(domainsRaw);
    expect(ctx?.instant).toBe("2026-06-09T12:00:00Z");
    expect(Object.keys(ctx?.forecasts ?? {}).sort()).toEqual(
      [...DOMAIN_NAMES].sort(),
    );
    expect(ctx?.forecasts.career.domain).toBe("career");
  });

  it("reshapes significators with lowercased signs; citations + dignities verbatim", () => {
    const career = toDomainsCtx(domainsRaw)?.forecasts.career;
    const house = career?.houses[0];
    expect(house?.house).toBe(10);
    expect(house?.sign).toBe("scorpio");
    expect(house?.lord).toBe("mars");
    expect(house?.lord_sign).toBe("aries");
    expect(house?.lord_dignity).toBe("own");
    expect(house?.rule).toBe("career: 10th house of karma");

    const karaka = career?.karakas[0];
    expect(karaka?.graha).toBe("saturn");
    expect(karaka?.sign).toBe("taurus");
    expect(karaka?.dignity).toBe("friend");

    expect(career?.varga.chart).toBe("D10");
    expect(career?.varga.sign).toBe("leo");
    // Honest split: the generalized D1-repeat flag passes through verbatim,
    // while the classical vargottama label stays D9-only (false here on D10).
    expect(career?.varga.same_sign_as_d1).toBe(true);
    expect(career?.varga.vargottama).toBe(false);
  });

  it("surfaces strength bands, emphasis, and dated windows verbatim", () => {
    const career = toDomainsCtx(domainsRaw)?.forecasts.career;
    expect(career?.strength_summary.band).toBe("strong");
    expect(career?.strength_summary.sav_bindus).toBe(58);
    expect(career?.strength_summary.approximated).toBe(true);
    // Stage 2: the calibrated Tier-M %s thread through field-for-field (no rescore in TS).
    expect(career?.strength_summary.shadbala_pct).toBe(82.5);
    expect(career?.strength_summary.sav_pct).toBe(51.79);
    expect(career?.strength_summary.strength_pct).toBe(51.79);
    expect(career?.strength_summary.strength_tier).toBe("model");

    expect(career?.current_emphasis.active_dasha_significator).toBe(true);
    expect(career?.current_emphasis.dasha_levels).toEqual(["maha", "antar"]);
    expect(career?.current_emphasis.transit_severity).toBe("supportive");
    expect(career?.current_emphasis.approximated).toBe(true);
    expect(career?.current_emphasis.note).toContain("vote-sum");

    const win = career?.upcoming_windows[0];
    expect(win?.source).toBe("dasha");
    expect(win?.kind).toBe("dasha_change");
    expect(win?.trigger).toBe("jupiter");
    expect(win?.descriptor).toBe("career.dasha.antar.jupiter");
  });

  it("carries the Worker's typed Assay minimum explanation without recomputing it", () => {
    const career = toDomainsCtx(domainsRaw, { career: CAREER_ASSAY })?.forecasts.career;

    expect(career?.strength_assay).toEqual(CAREER_ASSAY);
    expect(career?.strength_assay?.selected_component_id).toBe("sav_pct");
    expect(career?.strength_summary.strength_pct).toBe(51.79);
  });
});
