import { describe, expect, it } from "vitest";

import type { SiderealChart } from "@almamesh/browser/types";

import golden from "../../../../../backend/tests/fixtures/chart_golden_de421.json";
import strengthGolden from "../../../../../backend/tests/fixtures/strength_golden_de421.json";
import transitGolden from "../../../../../backend/tests/fixtures/transit_golden_de421.json";
import vargaGolden from "../../../../../backend/tests/fixtures/varga_golden_de421.json";
import {
  type BirthMeta,
  chartId,
  siderealChartToChartData,
  toBirthData,
  toBirthInput,
  toDashaCtx,
} from "./chart";

// The committed golden is keyed by UTC instant; each value is a canonical
// SiderealChart (the engine's exact output shape). We use the Delhi entry.
const DELHI_KEY = "1990-01-15T12:00:00+00:00";
const delhiChart = (golden as Record<string, SiderealChart>)[DELHI_KEY];

const DELHI_BIRTH: BirthMeta = {
  name: "Delhi Native",
  // Asia/Kolkata is a fixed UTC+5:30, so 17:30 local == 12:00:00 UTC.
  date: "1990-01-15",
  time: "17:30",
  latitude: 28.6139,
  longitude: 77.209,
  timezone: "Asia/Kolkata",
  location_name: "New Delhi, India",
};

/** The chart's reference instant — a required ARGUMENT, never a birth field. */
const REF = "2024-01-01T00:00:00.000Z";

describe("toBirthInput", () => {
  it("converts a local civil time + IANA zone to a UTC ISO instant", () => {
    const result = toBirthInput({
      date: "1990-01-15",
      time: "17:30",
      latitude: 28.6139,
      longitude: 77.209,
      timezone: "Asia/Kolkata",
    }, REF);
    expect(result.datetimeUtc).toBe("1990-01-15T12:00:00.000Z");
    expect(result.latitude).toBe(28.6139);
    expect(result.longitude).toBe(77.209);
  });

  // INVERTED (was "passes referenceDate through when given, omits it
  // otherwise"). That test asserted the defect as the requirement: it PROVED
  // the engine input could be built with no reference instant, which is exactly
  // how the shipped chart came to read the wall clock. "Omits it" is no longer
  // a legal outcome — the instant is a required argument.
  it("always carries the reference instant it was given", () => {
    const result = toBirthInput(
      {
        date: "1990-01-15",
        time: "17:30",
        latitude: 28.6139,
        longitude: 77.209,
        timezone: "Asia/Kolkata",
      },
      "2024-01-01T00:00:00.000Z",
    );
    expect(result.referenceDate).toBe("2024-01-01T00:00:00.000Z");
  });

  it("fails closed when the reference instant is not a parseable ISO instant", () => {
    // A Worker turns a Python ValueError into an opaque string on the far side,
    // so the boundary rejects here, on the thread that supplied the bad value.
    expect(() =>
      toBirthInput(
        {
          date: "1990-01-15",
          time: "17:30",
          latitude: 28.6139,
          longitude: 77.209,
          timezone: "Asia/Kolkata",
        },
        "not-an-instant",
      ),
    ).toThrow(/referenceInstant/i);
  });

  it("honors DST-bearing zones (America/New_York EST offset)", () => {
    // 1990-01-15 is winter -> EST (UTC-5): 07:00 local == 12:00 UTC.
    const result = toBirthInput({
      date: "1990-01-15",
      time: "07:00",
      latitude: 40.7128,
      longitude: -74.006,
      timezone: "America/New_York",
    }, REF);
    expect(result.datetimeUtc).toBe("1990-01-15T12:00:00.000Z");
  });

  it("fails closed when timezone is missing", () => {
    expect(() =>
      toBirthInput({
        date: "1990-01-15",
        time: "17:30",
        latitude: 28.6139,
        longitude: 77.209,
        timezone: "",
      }, REF),
    ).toThrow(/timezone/i);
  });

  it("fails closed when latitude is NaN", () => {
    expect(() =>
      toBirthInput({
        date: "1990-01-15",
        time: "17:30",
        latitude: Number.NaN,
        longitude: 77.209,
        timezone: "Asia/Kolkata",
      }, REF),
    ).toThrow(/latitude/i);
  });

  it("fails closed when longitude is NaN", () => {
    expect(() =>
      toBirthInput({
        date: "1990-01-15",
        time: "17:30",
        latitude: 28.6139,
        longitude: Number.NaN,
        timezone: "Asia/Kolkata",
      }, REF),
    ).toThrow(/longitude/i);
  });
});

describe("toBirthInput coordinate validation (mirrors the engine's InvalidBirthInputError)", () => {
  const at = (latitude: number, longitude: number) => () =>
    toBirthInput(
      { date: "1990-01-15", time: "17:30", latitude, longitude, timezone: "Asia/Kolkata" },
      REF,
    );
  const LAT_RANGE = "toBirthInput: invalid coordinate: latitude out of range (-90, 90)";
  const LON_RANGE = "toBirthInput: invalid coordinate: longitude out of range [-180, 180]";
  const LAT_FINITE = "toBirthInput: invalid coordinate: latitude must be a finite number";
  const LON_FINITE = "toBirthInput: invalid coordinate: longitude must be a finite number";

  it.each([
    [200, 0, LAT_RANGE],
    [90, 0, LAT_RANGE], // pole: Ascendant undefined -> rejected (open interval)
    [-90, 0, LAT_RANGE],
    [-90.000001, 0, LAT_RANGE],
    [0, 180.000001, LON_RANGE],
    [0, -181, LON_RANGE],
    [Number.POSITIVE_INFINITY, 0, LAT_FINITE],
    [Number.NEGATIVE_INFINITY, 0, LAT_FINITE],
    [Number.NaN, 0, LAT_FINITE],
    [0, Number.POSITIVE_INFINITY, LON_FINITE],
  ])("rejects latitude=%s longitude=%s with a stable message", (lat, lon, message) => {
    expect(at(lat, lon)).toThrow(message);
  });

  it.each([
    [89.999999, 180],
    [-89.999999, -180],
    [0, 0],
  ])("accepts latitude=%s longitude=%s", (lat, lon) => {
    expect(at(lat, lon)).not.toThrow();
  });
});

describe("birth-time rectification", () => {
  it("uses the rectified time for the chart while preserving the original", () => {
    // Entered 17:30 IST, rectified to 18:00 IST (+5:30 -> 12:30 UTC).
    const meta: BirthMeta = {
      ...DELHI_BIRTH,
      time: "17:30",
      rectifiedTime: "18:00",
      timeConfidence: "approximate",
    };
    expect(toBirthInput(meta, REF).datetimeUtc).toBe("1990-01-15T12:30:00.000Z");

    const stored = toBirthData(meta);
    // The effective (rectified) instant drives the stored UTC + local clock.
    expect(stored.birth_datetime_utc).toBe("1990-01-15T12:30:00.000Z");
    expect(stored.birth_datetime_local).toBe("1990-01-15T18:00:00");
    // The originally-entered time + its confidence are preserved for reference.
    expect(stored.birth_time_original).toBe("17:30");
    expect(stored.birth_time_confidence).toBe("approximate");
  });

  it("falls back to the entered time when no rectification is set", () => {
    expect(toBirthInput(DELHI_BIRTH, REF).datetimeUtc).toBe("1990-01-15T12:00:00.000Z");
    const stored = toBirthData(DELHI_BIRTH);
    expect(stored.birth_datetime_utc).toBe("1990-01-15T12:00:00.000Z");
    expect(stored.birth_time_original).toBeUndefined();
    expect(stored.birth_time_confidence).toBeUndefined();
  });

  it("rectifying 05:45 -> 06:00 forces a regenerate: new UTC instant + new chartId", () => {
    // A synthetic Asia/Kolkata (UTC+5:30) native. Rectifying 05:45 -> 06:00 must
    // move the EFFECTIVE instant the engine consumes (which is how a near-cusp
    // lagna can cross a sign boundary) AND change the chartId, since Phase-5
    // change-detection regenerates only when the id differs.
    const entered: BirthMeta = {
      name: "Reference Native",
      date: "1990-01-15",
      time: "05:45",
      latitude: 12.9716,
      longitude: 77.5946,
      timezone: "Asia/Kolkata",
      location_name: "Bengaluru, India",
    };
    const rectified: BirthMeta = { ...entered, rectifiedTime: "06:00" };

    // 05:45 IST == 00:15 UTC; 06:00 IST == 00:30 UTC — a real 15-min move.
    expect(toBirthInput(entered, REF).datetimeUtc).toBe("1990-01-15T00:15:00.000Z");
    expect(toBirthInput(rectified, REF).datetimeUtc).toBe("1990-01-15T00:30:00.000Z");

    // The id the change-detector keys on must differ so the chart regenerates.
    expect(chartId(rectified)).not.toBe(chartId(entered));

    // The stored chart keeps the entered time AND carries the rectified clock.
    const stored = toBirthData(rectified);
    expect(stored.birth_datetime_local).toBe("1990-01-15T06:00:00");
    expect(stored.birth_time_original).toBe("05:45");
  });
});

describe("siderealChartToChartData", () => {
  const data = siderealChartToChartData(delhiChart, DELHI_BIRTH, REF);
  const astro = data.astronomical_calculations;

  it("wraps the flat chart into sidereal_ctx with all 9 planets", () => {
    expect(Object.keys(astro.sidereal_ctx.planets)).toHaveLength(9);
  });

  it("preserves the lagna sign (read by ChartVisualization)", () => {
    const lagna = astro.sidereal_ctx.lagna as { sign?: string };
    expect(lagna.sign).toBe("Gemini");
  });

  it("defaults the fields the engine does not emit", () => {
    expect(astro.sidereal_ctx.ayanamsa_type).toBe("lahiri");
    expect(astro.sidereal_ctx.house_system).toBe("whole_sign");
    expect(astro.sidereal_ctx.julian_day).toBe(0);
    expect(astro.sidereal_ctx.sidereal_time).toBe(0);
    expect(astro.sidereal_ctx.ayanamsa_value).toBe(delhiChart.ayanamsa_value);
  });

  it("remaps dasha_ctx: maha_dasha.lord comes from current_maha", () => {
    expect(delhiChart.dashas.current_maha?.lord).toBe("rahu");
    expect(astro.dasha_ctx?.maha_dasha.lord).toBe("rahu");
    expect(astro.dasha_ctx?.maha_dasha.level).toBe("maha");
  });

  it("surfaces the engine's antar/pratyantar legs with their own levels", () => {
    // The golden now pins all three active levels (dasha-depth wave).
    expect(delhiChart.dashas.current_antar?.lord).toBe("saturn");
    expect(astro.dasha_ctx?.antar_dasha?.lord).toBe("saturn");
    expect(astro.dasha_ctx?.antar_dasha?.level).toBe("antar");
    expect(delhiChart.dashas.current_pratyantar?.lord).toBe("jupiter");
    expect(astro.dasha_ctx?.pratyantar_dasha?.lord).toBe("jupiter");
    expect(astro.dasha_ctx?.pratyantar_dasha?.level).toBe("pratyantar");
  });

  it("surfaces the declared dasha-year convention (never silently switched)", () => {
    expect(delhiChart.dashas.convention).toBe("julian_365_25");
    expect(astro.dasha_ctx?.convention).toBe("julian_365_25");
  });

  it("builds full_sequence of length 9, every entry level 'maha'", () => {
    expect(astro.dasha_ctx?.full_sequence).toHaveLength(9);
    for (const entry of astro.dasha_ctx?.full_sequence ?? []) {
      expect(entry.level).toBe("maha");
      expect(entry.lord).toBeTruthy();
      expect(entry.start_date).toBeTruthy();
      expect(entry.end_date).toBeTruthy();
    }
  });

  it("maps yogas to the honest UI contract: grade + full trace, verbatim", () => {
    expect(Array.isArray(astro.yoga_ctx)).toBe(true);
    expect(astro.yoga_ctx?.length).toBe(delhiChart.yogas.length);
    expect(astro.yoga_ctx?.length).toBeGreaterThan(0);

    const ui = astro.yoga_ctx?.[0];
    const engine = delhiChart.yogas[0];
    expect(ui?.name).toBe(engine.name);
    expect(ui?.display_name).toBe(engine.display_name);
    expect(ui?.category).toBe(engine.category);
    expect(["strong", "moderate", "weak"]).toContain(ui?.grade);
    expect(ui?.description).toBe(engine.description);
    expect(ui?.effects).toBe(engine.effects);
    expect(ui?.planetary_signature).toBe(engine.planetary_signature);
    expect(ui?.planets_involved).toEqual(engine.planets_involved);
    expect(ui?.houses_involved).toEqual(engine.houses_involved);
    // The complete honest trace is surfaced verbatim (min-1 by engine schema).
    expect(ui?.strength_factors.length).toBeGreaterThanOrEqual(1);
    expect(ui?.strength_factors[0]).toEqual(engine.strength_factors[0]);
    expect(ui?.formation_rules.length).toBeGreaterThanOrEqual(1);
    expect(ui?.formation_rules[0].description).toBe(engine.formation_rules[0].description);
    expect(ui?.formation_rules[0].source).toBe(engine.formation_rules[0].source);
  });

  it("carries NO fake numeric yoga strength: strength/effective_strength/is_active are gone", () => {
    for (const yoga of astro.yoga_ctx ?? []) {
      expect(yoga).not.toHaveProperty("strength");
      expect(yoga).not.toHaveProperty("effective_strength");
      expect(yoga).not.toHaveProperty("is_active");
    }
  });

  it("populates varga_ctx.D9 (Navamsa) from the engine's navamsa", () => {
    expect(astro.varga_ctx).toBeDefined();
    const d9 = astro.varga_ctx?.D9;
    expect(d9?.name).toBe("D9");
    // Engine Title-Case signs are lowercased to the UI's ZodiacSign union.
    expect(d9?.lagna_sign).toBe(delhiChart.navamsa?.lagna_sign.toLowerCase());
    // All 9 grahas surfaced, each with a derived whole-sign house (1..12).
    expect(Object.keys(d9?.planets ?? {}).sort()).toEqual(
      Object.keys(delhiChart.navamsa?.planets ?? {}).sort(),
    );
    for (const p of Object.values(d9?.planets ?? {})) {
      expect(p.house).toBeGreaterThanOrEqual(1);
      expect(p.house).toBeLessThanOrEqual(12);
    }
    // D1 is also present (Rasi) per the VargaContext contract.
    expect(astro.varga_ctx?.D1.name).toBe("D1");
  });

  it("synthesizes the birth_data fields the UI reads", () => {
    const bd = data.birth_data;
    expect(bd?.name).toBe("Delhi Native");
    expect(bd?.birth_datetime_utc).toBe("1990-01-15T12:00:00.000Z");
    expect(bd?.birth_datetime_local).toBe("1990-01-15T17:30:00");
    expect(bd?.birth_location_details.latitude).toBe(28.6139);
    expect(bd?.birth_location_details.longitude).toBe(77.209);
    expect(bd?.birth_location_details.timezone).toBe("Asia/Kolkata");
    expect(bd?.birth_location_details.location_name).toBe("New Delhi, India");
  });

  it("leaves interpretation absent (LLM is a later phase)", () => {
    expect(data.interpretation).toBeUndefined();
  });

  it("produces a stable, deterministic chart_id", () => {
    const again = siderealChartToChartData(delhiChart, DELHI_BIRTH, REF);
    expect(data.chart_id).toBe(again.chart_id);
    expect(data.chart_id).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("siderealChartToChartData — calculation_timestamp (the epoch guard)", () => {
  // PREMISE INVERTED. This block used to open "The regenerate path passes NO
  // referenceDate" and build a `birthWithoutRef` to prove the stamp survived
  // that. It did survive — from a SECOND, independent `new Date()`, while the
  // engine read its own clock. So the printed generation date and the chart's
  // "current" dasha came from two different instants, and neither reproduced
  // the chart. The regenerate path now passes exactly one instant, and this
  // block asserts the stamp IS that instant. The epoch guard itself stays:
  // `new Date(0)` once rendered as "December 31, 1969" in report and dashboard.

  it("stamps the reference instant it was given, exactly", () => {
    const data = siderealChartToChartData(delhiChart, DELHI_BIRTH, REF);
    expect(data.astronomical_calculations.calculation_timestamp).toBe(REF);
  });

  it("never emits the Unix epoch as calculation_timestamp", () => {
    const data = siderealChartToChartData(delhiChart, DELHI_BIRTH, REF);
    const ts = data.astronomical_calculations.calculation_timestamp;
    expect(ts).not.toBe(new Date(0).toISOString());
    expect(new Date(ts).getFullYear()).toBeGreaterThan(1970);
  });

  it("is the SAME value the engine receives as referenceDate", () => {
    // The identity that makes the printed date a reproducibility key rather
    // than decoration: regenerate a chart from what the report shows and you
    // get the same bytes.
    const data = siderealChartToChartData(delhiChart, DELHI_BIRTH, REF);
    const engineInput = toBirthInput(DELHI_BIRTH, REF);
    expect(data.astronomical_calculations.calculation_timestamp).toBe(
      engineInput.referenceDate,
    );
  });

  it("fails closed on an unparseable reference instant", () => {
    expect(() => siderealChartToChartData(delhiChart, DELHI_BIRTH, "nonsense")).toThrow(
      /referenceInstant/i,
    );
  });
});

describe("toDashaCtx — current-maha selection from the sequence", () => {
  // The maha sequence the engine emits: rahu is the entry containing 2026.
  const seq = delhiChart.dashas.maha_dasha_sequence;

  it("uses a non-null current_maha as-is (no re-selection)", () => {
    // Deliberately set current_maha to the FIRST entry (venus) and assert the
    // adapter surfaces exactly that — it does not re-derive when given one.
    const chart = {
      ...delhiChart,
      dashas: {
        ...delhiChart.dashas,
        current_maha: seq[0],
      },
    } as typeof delhiChart;
    const ctx = toDashaCtx(chart, new Date("2030-01-01T00:00:00Z"));
    expect(ctx?.maha_dasha.lord).toBe(seq[0].lord);
  });

  it("selects the active maha from the sequence when current_maha is null", () => {
    const chart = {
      ...delhiChart,
      dashas: {
        ...delhiChart.dashas,
        current_maha: null,
        current_antar: null,
        current_pratyantar: null,
      },
    } as unknown as typeof delhiChart;
    // 2026-06-05 falls inside the rahu maha (2017–2035 per the golden).
    const ctx = toDashaCtx(chart, new Date("2026-06-05T00:00:00Z"));
    expect(ctx).toBeDefined();
    expect(ctx?.maha_dasha.lord).toBe("rahu");
    expect(ctx?.maha_dasha.level).toBe("maha");
    expect(ctx?.full_sequence).toHaveLength(9);
  });

  it("selects a DIFFERENT active maha for a different `now`", () => {
    const chart = {
      ...delhiChart,
      dashas: { ...delhiChart.dashas, current_maha: null },
    } as unknown as typeof delhiChart;
    // 1992 is inside the first (venus) maha (1990–1994 per the golden).
    const ctx = toDashaCtx(chart, new Date("1992-01-01T00:00:00Z"));
    expect(ctx?.maha_dasha.lord).toBe("venus");
  });

  it("falls back to the first entry when `now` precedes the whole sequence", () => {
    const chart = {
      ...delhiChart,
      dashas: { ...delhiChart.dashas, current_maha: null },
    } as unknown as typeof delhiChart;
    const ctx = toDashaCtx(chart, new Date("1900-01-01T00:00:00Z"));
    expect(ctx?.maha_dasha.lord).toBe(seq[0].lord);
  });

  it("returns undefined only when the engine emits NO sequence at all", () => {
    const chart = {
      ...delhiChart,
      dashas: {
        maha_dasha_sequence: [],
        current_maha: null,
        current_antar: null,
        current_pratyantar: null,
      },
    } as unknown as typeof delhiChart;
    expect(toDashaCtx(chart, new Date("2026-06-05T00:00:00Z"))).toBeUndefined();
  });

  it("surfaces antar/pratyantar legs as undefined when the engine emits null", () => {
    // Older bundles (or an out-of-span reference) emit null sub-period legs and
    // no convention; the adapter must tolerate both without fabricating values.
    const chart = {
      ...delhiChart,
      dashas: {
        maha_dasha_sequence: delhiChart.dashas.maha_dasha_sequence,
        current_maha: delhiChart.dashas.current_maha,
        current_antar: null,
        current_pratyantar: null,
      },
    } as unknown as typeof delhiChart;
    const ctx = toDashaCtx(chart, new Date("2026-06-05T00:00:00Z"));
    expect(ctx?.antar_dasha).toBeUndefined();
    expect(ctx?.pratyantar_dasha).toBeUndefined();
    expect(ctx?.convention).toBeUndefined();
  });
});

describe("siderealChartToChartData — additive predictive contexts", () => {
  it("omits the four predictive contexts when the engine payload lacks them", () => {
    const astro = siderealChartToChartData(
      delhiChart,
      DELHI_BIRTH,
      REF,
    ).astronomical_calculations;
    expect(astro.transit_ctx).toBeUndefined();
    expect(astro.varga_ctx_full).toBeUndefined();
    expect(astro.strength_ctx).toBeUndefined();
    expect(astro.domains_ctx).toBeUndefined();
  });

  it("carries the predictive contexts when the engine emits them, D9 varga_ctx untouched", () => {
    const enriched: SiderealChart = {
      ...delhiChart,
      transit_context: (
        transitGolden as Record<string, NonNullable<SiderealChart["transit_context"]>>
      )[DELHI_KEY],
      varga_context_full: (
        vargaGolden as Record<string, NonNullable<SiderealChart["varga_context_full"]>>
      )["1988-08-08T01:14:00+00:00"],
      strength_context: (
        strengthGolden as {
          cases: ReadonlyArray<{
            expected: NonNullable<SiderealChart["strength_context"]>;
          }>;
        }
      ).cases[0].expected,
    };
    const astro = siderealChartToChartData(
      enriched,
      DELHI_BIRTH,
      REF,
    ).astronomical_calculations;

    expect(astro.transit_ctx?.fusion.maha_lord).toBe("rahu");
    expect(Object.keys(astro.varga_ctx_full?.charts ?? {})).toHaveLength(16);
    expect(astro.strength_ctx?.ashtakavarga.sarva.total).toBe(337);
    expect(astro.domains_ctx).toBeUndefined();

    // The legacy D9-only varga_ctx (kundli renderers) is byte-compatible.
    expect(astro.varga_ctx).toEqual(
      siderealChartToChartData(delhiChart, DELHI_BIRTH, REF).astronomical_calculations
        .varga_ctx,
    );
  });
});

describe("toDashaCtx — dasha tree (antar + pratyantar sequences)", () => {
  // The reference chart pins the dasha-tree contract: Saturn maha 2025→2044 with
  // its 9 dated antardashas, and the current (Rahu) antar's 9 pratyantardashas.
  // The string below is the backend golden's opaque lookup key (chart_golden_de421.json),
  // NOT a birth fixture — it must stay byte-identical to the committed golden.
  const REFERENCE_KEY = "1988-08-08T01:14:00+00:00";
  const referenceChart = (golden as Record<string, SiderealChart>)[REFERENCE_KEY];
  const ctx = toDashaCtx(referenceChart, new Date("2026-06-11T00:00:00Z"));

  it("passes each maha row's antar_sequence through (9 antars per maha, level 'antar')", () => {
    expect(ctx?.full_sequence).toHaveLength(9);
    for (const maha of ctx?.full_sequence ?? []) {
      expect(maha.level).toBe("maha");
      expect(maha.antar_sequence).toHaveLength(9);
      for (const antar of maha.antar_sequence ?? []) {
        expect(antar.level).toBe("antar");
        expect(antar.lord).toBeTruthy();
        expect(antar.start_date).toBeTruthy();
        expect(antar.end_date).toBeTruthy();
        expect(antar.duration_years).toBeGreaterThan(0);
      }
    }
  });

  it("round-trips the reference Saturn-maha antar tree verbatim (engine dates untouched)", () => {
    const saturnMaha = ctx?.full_sequence[3];
    expect(saturnMaha?.lord).toBe("saturn");
    expect(saturnMaha?.start_date).toBe("2025-03-02T19:53:39.108936Z");
    expect(saturnMaha?.end_date).toBe("2044-03-02T13:53:39.108936Z");
    expect(saturnMaha?.antar_sequence?.map((a) => a.lord)).toEqual([
      "saturn",
      "mercury",
      "ketu",
      "venus",
      "sun",
      "moon",
      "mars",
      "rahu",
      "jupiter",
    ]);
    const venusAntar = saturnMaha?.antar_sequence?.[3];
    expect(venusAntar?.start_date).toBe("2031-12-23T13:44:39.108936Z");
    expect(venusAntar?.end_date).toBe("2035-02-22T04:44:39.108936Z");
  });

  it("passes the CURRENT antar's pratyantar_sequence through (level 'pratyantar')", () => {
    expect(referenceChart.dashas.current_antar?.lord).toBe("rahu");
    expect(ctx?.pratyantar_sequence).toHaveLength(9);
    for (const pd of ctx?.pratyantar_sequence ?? []) {
      expect(pd.level).toBe("pratyantar");
    }
    const saturnPd = ctx?.pratyantar_sequence?.[2];
    expect(saturnPd?.lord).toBe("saturn");
    expect(saturnPd?.start_date).toBe("2023-06-13T14:22:27.108936Z");
    expect(saturnPd?.end_date).toBe("2023-10-30T09:27:15.108936Z");
  });

  it("tolerates an older bundle without the tree (keys stay absent, nothing fabricated)", () => {
    const { pratyantar_sequence: _pd, ...dashasRest } = referenceChart.dashas;
    const legacy = {
      ...referenceChart,
      dashas: {
        ...dashasRest,
        maha_dasha_sequence: referenceChart.dashas.maha_dasha_sequence.map(
          ({ antar_sequence: _antars, ...row }) => row,
        ),
      },
    } as unknown as SiderealChart;
    const legacyCtx = toDashaCtx(legacy, new Date("2026-06-11T00:00:00Z"));
    expect(legacyCtx?.full_sequence).toHaveLength(9);
    for (const maha of legacyCtx?.full_sequence ?? []) {
      expect(maha).not.toHaveProperty("antar_sequence");
    }
    expect(legacyCtx).not.toHaveProperty("pratyantar_sequence");
  });

  it("folds an engine-emitted null pratyantar_sequence to an absent key", () => {
    const chart = {
      ...referenceChart,
      dashas: {
        ...referenceChart.dashas,
        current_antar: null,
        current_pratyantar: null,
        pratyantar_sequence: null,
      },
    } as unknown as SiderealChart;
    const nullCtx = toDashaCtx(chart, new Date("2026-06-11T00:00:00Z"));
    expect(nullCtx).not.toHaveProperty("pratyantar_sequence");
  });
});

describe("siderealChartToChartData — the chart's snapshot rides along", () => {
  it("keeps the engine's snapshot on the rendered chart, unchanged", () => {
    const data = siderealChartToChartData(delhiChart, DELHI_BIRTH, REF);

    expect(data.astronomical_calculations.snapshot).toEqual(delhiChart.snapshot);
    expect(data.astronomical_calculations.snapshot?.engine_version).toBe("0.1.0");
  });

  it("records the engine version that COMPUTED the chart as software_version", () => {
    const stamped = { ...delhiChart, snapshot: { ...delhiChart.snapshot!, engine_version: "0.0.9" } };

    const data = siderealChartToChartData(stamped, DELHI_BIRTH, REF);

    expect(data.astronomical_calculations.software_version).toBe("0.0.9");
  });

  it("still adapts a chart stored before snapshots existed, and says it has none", () => {
    const { snapshot: _none, ...legacy } = delhiChart;

    const data = siderealChartToChartData(legacy, DELHI_BIRTH, REF);

    expect("snapshot" in data.astronomical_calculations).toBe(false);
    expect(data.astronomical_calculations.software_version).toBe("almamesh-browser-engine");
  });
});

describe("toBirthInput daylight-saving edges (never silently picked)", () => {
  const LA = { latitude: 34.0522, longitude: -118.2437, timezone: "America/Los_Angeles" };

  it("refuses a spring-forward time that never existed instead of shifting it an hour", () => {
    expect(() => toBirthInput({ ...LA, date: "2024-03-10", time: "02:30" }, REF)).toThrow(
      /did not exist/,
    );
  });

  it("refuses a fall-back time that happened twice when no occurrence was chosen", () => {
    expect(() => toBirthInput({ ...LA, date: "2024-11-03", time: "01:30" }, REF)).toThrow(
      /happened twice/,
    );
  });

  it("uses the occurrence the user chose", () => {
    const later = toBirthInput({ ...LA, date: "2024-11-03", time: "01:30", dstFold: "later" }, REF);
    expect(later.datetimeUtc).toBe("2024-11-03T09:30:00.000Z");
    const earlier = toBirthInput(
      { ...LA, date: "2024-11-03", time: "01:30", dstFold: "earlier" },
      REF,
    );
    expect(earlier.datetimeUtc).toBe("2024-11-03T08:30:00.000Z");
  });

  it("gives the two occurrences different chart ids so switching them regenerates", () => {
    const base: BirthMeta = { ...DELHI_BIRTH, ...LA, date: "2024-11-03", time: "01:30" };
    expect(chartId({ ...base, dstFold: "earlier" })).not.toBe(chartId({ ...base, dstFold: "later" }));
    // An unambiguous birth's id is unchanged by this feature: existing stored
    // ids stay stable (literal pinned from main before the change).
    expect(chartId(DELHI_BIRTH)).toBe("0a651c89");
    expect(chartId({ ...DELHI_BIRTH, dstFold: "later" })).toBe("0a651c89");
    // An unreadable clock never makes the id throw (ids are computed for drafts).
    expect(() => chartId({ ...DELHI_BIRTH, time: "", dstFold: "later" })).not.toThrow();
  });
});
