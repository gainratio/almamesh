import { describe, expect, it } from "vitest";

import type { SiderealChart } from "@almamesh/browser/types";

import golden from "../../../../../backend/tests/fixtures/chart_golden_de421.json";
import { sanitizeChartForLlm } from "../sanitize";
import {
  DOMAINS_CTX_FIXTURE,
  STRENGTH_CTX_FIXTURE,
  TRANSIT_CTX_FIXTURE,
  VARGA_CTX_FULL_FIXTURE,
} from "./predictive-fixture";

// A canonical engine SiderealChart from the committed golden fixture (the exact
// shape the Pyodide worker emits). Picking the first entry keeps the test stable
// regardless of which UTC instants the golden file contains.
const goldenCharts = golden as Record<string, SiderealChart>;
const [firstKey] = Object.keys(goldenCharts);
const realChart: SiderealChart = goldenCharts[firstKey];

// A reference "now" between a maha period's start and end so we can assert the
// "current (...)" relativization branch, independent of wall-clock time.
const NOW = new Date("2030-01-01T00:00:00.000Z");

// Recursively collect every string value in an object tree (for leak scanning).
function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) collectStrings(v, out);
  }
}

function allStrings(value: unknown): string[] {
  const out: string[] = [];
  collectStrings(value, out);
  return out;
}

// ISO-8601 absolute timestamp (the birth-identifying leak vector): a 4-digit
// year followed by -MM-DDThh. Relativized output ("age 40", "+16 years",
// "current (...)") must never contain this.
const ABSOLUTE_ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

describe("sanitizeChartForLlm — privacy boundary", () => {
  it("never emits an absolute ISO date anywhere in the output", () => {
    const sanitized = sanitizeChartForLlm(realChart, { basis: "chart", instant: NOW });
    const leaks = allStrings(sanitized).filter((s) => ABSOLUTE_ISO.test(s));
    expect(leaks).toEqual([]);
  });

  it("strips chart_id and generated_at / timestamp identifier fields", () => {
    // Simulate an over-broad input that carries correlatable identifiers; the
    // sanitizer must drop them even though SiderealChart does not declare them.
    const withIdentifiers = {
      ...realChart,
      chart_id: "abc123",
      generated_at: "2024-01-01T00:00:00Z",
      calculation_timestamp: "2024-01-01T00:00:00Z",
    } as unknown as SiderealChart;

    const sanitized = sanitizeChartForLlm(withIdentifiers, { basis: "chart", instant: NOW }) as Record<string, unknown>;
    expect(sanitized).not.toHaveProperty("chart_id");
    expect(sanitized).not.toHaveProperty("generated_at");
    expect(sanitized).not.toHaveProperty("calculation_timestamp");

    const serialized = JSON.stringify(sanitized);
    expect(serialized).not.toContain("abc123");
  });

  it("removes start_date / end_date from every dasha period", () => {
    const sanitized = sanitizeChartForLlm(realChart, { basis: "chart", instant: NOW });
    const dashas = sanitized.dashas;
    expect(dashas).toBeDefined();

    for (const period of dashas?.maha_dasha_sequence ?? []) {
      expect(period).not.toHaveProperty("start_date");
      expect(period).not.toHaveProperty("end_date");
    }
    for (const key of ["current_maha", "current_antar", "current_pratyantar"] as const) {
      const period = dashas?.[key];
      if (period) {
        expect(period).not.toHaveProperty("start_date");
        expect(period).not.toHaveProperty("end_date");
      }
    }
  });

  it("relativizes a maha period spanning NOW to a current-status string", () => {
    const chart = {
      ...realChart,
      dashas: {
        current_maha: null,
        current_antar: null,
        current_pratyantar: null,
        maha_dasha_sequence: [
          {
            lord: "jupiter",
            start_date: "2023-04-23T00:00:00Z",
            end_date: "2039-04-23T00:00:00Z",
            duration_years: 16,
          },
        ],
      },
    } as unknown as SiderealChart;

    const sanitized = sanitizeChartForLlm(chart, { basis: "chart", instant: NOW });
    const period = sanitized.dashas?.maha_dasha_sequence?.[0];
    expect(period?.status).toMatch(/current \(\d+ years remaining\)/);
    expect(period?.lord).toBe("jupiter");
  });

  it("relativizes a future maha period to a 'starts in N years' status", () => {
    const chart = {
      ...realChart,
      dashas: {
        current_maha: null,
        current_antar: null,
        current_pratyantar: null,
        maha_dasha_sequence: [
          {
            lord: "saturn",
            start_date: "2040-01-01T00:00:00Z",
            end_date: "2059-01-01T00:00:00Z",
            duration_years: 19,
          },
        ],
      },
    } as unknown as SiderealChart;

    const sanitized = sanitizeChartForLlm(chart, { basis: "chart", instant: NOW });
    const period = sanitized.dashas?.maha_dasha_sequence?.[0];
    expect(period?.status).toMatch(/future \(starts in \d+ years\)/);
  });

  it("marks an already-elapsed maha period as past", () => {
    const chart = {
      ...realChart,
      dashas: {
        current_maha: null,
        current_antar: null,
        current_pratyantar: null,
        maha_dasha_sequence: [
          {
            lord: "ketu",
            start_date: "2000-01-01T00:00:00Z",
            end_date: "2007-01-01T00:00:00Z",
            duration_years: 7,
          },
        ],
      },
    } as unknown as SiderealChart;

    const sanitized = sanitizeChartForLlm(chart, { basis: "chart", instant: NOW });
    expect(sanitized.dashas?.maha_dasha_sequence?.[0]?.status).toBe("past");
  });

  it("converts a current period to months_remaining (no absolute end_date)", () => {
    const chart = {
      ...realChart,
      dashas: {
        current_maha: {
          lord: "jupiter",
          start_date: "2029-01-01T00:00:00Z",
          end_date: "2030-07-01T00:00:00Z",
          duration_years: 16,
        },
        current_antar: null,
        current_pratyantar: null,
        maha_dasha_sequence: [],
      },
    } as unknown as SiderealChart;

    const sanitized = sanitizeChartForLlm(chart, { basis: "chart", instant: NOW });
    const current = sanitized.dashas?.current_maha;
    expect(current?.months_remaining).toBeGreaterThan(0);
    expect(current).not.toHaveProperty("end_date");
  });

  it("preserves the astrological content the interpreter needs", () => {
    const sanitized = sanitizeChartForLlm(realChart, { basis: "chart", instant: NOW });

    // Planets: names, signs, houses survive.
    const planets = Object.values(sanitized.planets);
    expect(planets.length).toBeGreaterThan(0);
    for (const planet of planets) {
      expect(typeof planet.sign).toBe("string");
      expect(typeof planet.house).toBe("number");
    }

    // Lagna sign + ayanamsa preserved.
    expect(typeof sanitized.lagna.sign).toBe("string");
    expect(typeof sanitized.ayanamsa_value).toBe("number");

    // Dasha lords preserved (relative timing, identity intact).
    for (const period of sanitized.dashas?.maha_dasha_sequence ?? []) {
      expect(typeof period.lord).toBe("string");
    }
  });

  it("passes the engine-declared dasha-year convention through (no silent convention)", () => {
    // The golden fixture declares its convention; it must survive sanitization.
    expect(realChart.dashas.convention).toBeDefined();
    const sanitized = sanitizeChartForLlm(realChart, { basis: "chart", instant: NOW });
    expect(sanitized.dashas?.convention).toBe(realChart.dashas.convention);
  });

  it("omits the convention key when an older engine bundle does not declare one", () => {
    const { convention: _convention, ...withoutConvention } = realChart.dashas;
    const chart = { ...realChart, dashas: withoutConvention } as unknown as SiderealChart;
    const sanitized = sanitizeChartForLlm(chart, { basis: "chart", instant: NOW });
    expect(sanitized.dashas).not.toHaveProperty("convention");
  });

  it("passes the D9 navamsa through (signs only — nothing to relativize)", () => {
    expect(realChart.navamsa).not.toBeNull();
    const sanitized = sanitizeChartForLlm(realChart, { basis: "chart", instant: NOW });
    expect(sanitized.navamsa).toEqual(realChart.navamsa);
  });

  it("omits the navamsa key when the engine emits none", () => {
    const chart = { ...realChart, navamsa: null } as unknown as SiderealChart;
    const sanitized = sanitizeChartForLlm(chart, { basis: "chart", instant: NOW });
    expect(sanitized).not.toHaveProperty("navamsa");
  });

  it("is pure — it does not mutate the input chart", () => {
    const chart = {
      ...realChart,
      dashas: {
        current_maha: {
          lord: "jupiter",
          start_date: "2029-01-01T00:00:00Z",
          end_date: "2030-07-01T00:00:00Z",
          duration_years: 16,
        },
        current_antar: null,
        current_pratyantar: null,
        maha_dasha_sequence: [
          {
            lord: "jupiter",
            start_date: "2023-04-23T00:00:00Z",
            end_date: "2039-04-23T00:00:00Z",
            duration_years: 16,
          },
        ],
      },
    } as unknown as SiderealChart;
    const before = JSON.stringify(chart);

    sanitizeChartForLlm(chart, { basis: "chart", instant: NOW });

    expect(JSON.stringify(chart)).toBe(before);
  });
});

// A chart carrying ALL FOUR optional predictive contexts (the engine emits them
// as additive top-level keys; older bundles omit them entirely).
const predictiveChart = {
  ...realChart,
  transit_context: TRANSIT_CTX_FIXTURE,
  strength_context: STRENGTH_CTX_FIXTURE,
  varga_context_full: VARGA_CTX_FULL_FIXTURE,
  domains_context: DOMAINS_CTX_FIXTURE,
} as unknown as SiderealChart;

// Any day-or-finer absolute date (YYYY-MM-DD…). Month precision (YYYY-MM) is the
// allowed granularity — it matches the existing months_remaining contract.
const DAY_PRECISION = /\d{4}-\d{2}-\d{2}/;

describe("sanitizeChartForLlm — predictive contexts (transits/strength/vargas/domains)", () => {
  it("omits the predictive key entirely when no context is present (graceful absence)", () => {
    const sanitized = sanitizeChartForLlm(realChart, { basis: "chart", instant: NOW });
    expect(sanitized).not.toHaveProperty("predictive");
  });

  it("reduces every predictive date to month precision (no day-level or ISO dates)", () => {
    const sanitized = sanitizeChartForLlm(predictiveChart, { basis: "chart", instant: NOW });
    const leaks = allStrings(sanitized.predictive).filter((s) => DAY_PRECISION.test(s));
    expect(leaks).toEqual([]);
    expect(allStrings(sanitized).filter((s) => ABSOLUTE_ISO.test(s))).toEqual([]);
  });

  it("compacts the transit context: sade sati, fusion, gochara, hits, timeline", () => {
    const transits = sanitizeChartForLlm(predictiveChart, { basis: "chart", instant: NOW }).predictive?.transits;
    expect(transits?.sade_sati).toMatchObject({
      is_active: true,
      current_phase: "peak",
      natal_moon_sign: "aquarius",
      until_month: "2033-04",
    });
    expect(transits?.fusion).toMatchObject({
      maha_lord: "saturn",
      antar_lord: "mercury",
      maha_lord_transit_house_from_moon: 8,
      maha_lord_transit_house_from_lagna: 12,
      severity: "challenging",
    });
    expect(transits?.gochara).toContainEqual({
      graha: "saturn",
      sign: "pisces",
      house_from_lagna: 12,
      house_from_moon: 8,
      is_retrograde: true,
    });
    expect(transits?.slow_hits).toContainEqual({
      graha: "jupiter",
      kind: "return",
      natal_point: "jupiter",
      month: "2030-05",
      severity: "supportive",
    });
    expect(transits?.timeline).toContainEqual({
      month: "2030-03",
      kind: "sign_ingress",
      graha: "saturn",
      from_sign: "aquarius",
      to_sign: "pisces",
      severity: "challenging",
      descriptor: "Saturn enters Pisces",
    });
  });

  it("compacts strength to SAV total + per-planet shadbala figures", () => {
    const strength = sanitizeChartForLlm(predictiveChart, { basis: "chart", instant: NOW }).predictive?.strength;
    expect(strength?.sav_total).toBe(337);
    expect(strength?.shadbala).toContainEqual({
      planet: "saturn",
      total_rupas: 5.21,
      required_rupas: 5,
      meets_minimum: true,
    });
  });

  it("keeps only the engine's varga SUMMARIES (vargottama/shadvarga/vimshopaka)", () => {
    const vargas = sanitizeChartForLlm(predictiveChart, { basis: "chart", instant: NOW }).predictive?.vargas;
    expect(vargas?.vargottama).toContainEqual({ point: "moon", sign: "taurus" });
    expect(vargas?.shadvarga_own_sign?.[0]).toMatchObject({
      graha: "jupiter",
      own_sign_count: 3,
    });
    expect(vargas?.vimshopaka).toContainEqual({
      graha: "jupiter",
      score: 16.5,
      approximated: false,
    });
  });

  it("compacts each life-domain forecast (band, key graha, emphasis, month windows)", () => {
    const domains = sanitizeChartForLlm(predictiveChart, { basis: "chart", instant: NOW }).predictive?.domains;
    const career = domains?.find((d) => d.domain === "career");
    expect(career).toMatchObject({
      band: "strong",
      key_graha: "saturn",
      key_graha_rupas: 5.21,
      key_graha_meets_minimum: true,
      sav_bindus: 28,
      active_dasha_significator: true,
      under_sade_sati: true,
      transit_severity: "neutral",
    });
    expect(career?.windows).toContainEqual({
      month: "2030-03",
      source: "transit",
      kind: "sign_ingress",
      trigger: "saturn",
      severity: "supportive",
      descriptor: "Career window opens as Saturn changes sign",
    });
  });

  it("drops the bulky raw context fields (sunrise, bindus tables, full charts)", () => {
    const serialized = JSON.stringify(sanitizeChartForLlm(predictiveChart, { basis: "chart", instant: NOW }).predictive);
    expect(serialized).not.toContain("sunrise_utc_iso");
    expect(serialized).not.toContain("bhinna");
    expect(serialized).not.toContain("transit_ayanamsa");
    expect(serialized).not.toContain("net_weight");
    expect(serialized).not.toContain("window_start");
  });

  it("is pure with predictive contexts — it does not mutate the input chart", () => {
    const before = JSON.stringify(predictiveChart);
    sanitizeChartForLlm(predictiveChart, { basis: "chart", instant: NOW });
    expect(JSON.stringify(predictiveChart)).toBe(before);
  });
});

// Per-planet `houses_ruled` / `is_yogakaraka` / `is_combust` are REQUIRED
// engine fields — pure astrology, nothing identifying — so the allowlist
// rebuild must pass them through verbatim (locks the passthrough contract
// against the real regenerated golden).
describe("sanitizeChartForLlm — per-planet engine lordship fields", () => {
  it("passes houses_ruled / is_yogakaraka / is_combust through verbatim", () => {
    const sanitized = sanitizeChartForLlm(realChart, { basis: "chart", instant: NOW });
    expect(Object.keys(sanitized.planets).length).toBeGreaterThan(0);
    for (const [key, planet] of Object.entries(sanitized.planets)) {
      expect(planet.houses_ruled).toEqual(realChart.planets[key].houses_ruled);
      expect(planet.is_yogakaraka).toBe(realChart.planets[key].is_yogakaraka);
      expect(planet.is_combust).toBe(realChart.planets[key].is_combust);
    }
  });

  it("passes each yoga's qualitative trace (grade + factors + rules) through verbatim", () => {
    const sanitized = sanitizeChartForLlm(realChart, { basis: "chart", instant: NOW });
    expect(sanitized.yogas).toEqual(realChart.yogas);
    for (const yoga of sanitized.yogas) {
      expect(["strong", "moderate", "weak"]).toContain(yoga.grade);
      expect(yoga.strength_factors.length).toBeGreaterThanOrEqual(1);
      expect(yoga.formation_rules.length).toBeGreaterThanOrEqual(1);
    }
  });
});

// The dasha tree (each maha's antar_sequence + the current antar's
// pratyantar_sequence) crosses the boundary at MONTH precision ("YYYY-MM") —
// the same granularity as the predictive contexts — and ONLY for non-past
// periods, so birth-adjacent calendar dates still never leak.
const MONTH_ONLY = /^\d{4}-\d{2}$/;

describe("sanitizeChartForLlm — dasha tree (antar + pratyantar sequences)", () => {
  // The golden's first chart carries the full tree; NOW (2030-01-01) falls
  // inside its jupiter maha (2023-04 → 2039-04).
  const sanitized = sanitizeChartForLlm(realChart, { basis: "chart", instant: NOW });
  const rows = sanitized.dashas?.maha_dasha_sequence ?? [];

  it("attaches the month window + the dated antar tree to the CURRENT maha row", () => {
    const current = rows.find((r) => r.status.startsWith("current"));
    expect(current?.lord).toBe("jupiter");
    expect(current?.start_month).toBe("2023-04");
    expect(current?.end_month).toBe("2039-04");
    expect(current?.antar_sequence).toHaveLength(9);
    for (const antar of current?.antar_sequence ?? []) {
      expect(antar.start_month).toMatch(MONTH_ONLY);
      expect(antar.end_month).toMatch(MONTH_ONLY);
      expect(antar).not.toHaveProperty("start_date");
      expect(antar).not.toHaveProperty("end_date");
    }
  });

  it("gives FUTURE maha rows their month window but NOT their antar tree", () => {
    const future = rows.filter((r) => r.status.startsWith("future"));
    expect(future.length).toBeGreaterThan(0);
    for (const row of future) {
      expect(row.start_month).toMatch(MONTH_ONLY);
      expect(row.end_month).toMatch(MONTH_ONLY);
      expect(row).not.toHaveProperty("antar_sequence");
    }
  });

  it("keeps PAST maha rows date-free (birth-adjacent dates never leak)", () => {
    const past = rows.filter((r) => r.status === "past");
    expect(past.length).toBeGreaterThan(0);
    for (const row of past) {
      expect(row).not.toHaveProperty("start_month");
      expect(row).not.toHaveProperty("end_month");
      expect(row).not.toHaveProperty("antar_sequence");
    }
  });

  it("dates the current maha/antar/pratyantar legs at month precision", () => {
    for (const key of ["current_maha", "current_antar", "current_pratyantar"] as const) {
      const leg = sanitized.dashas?.[key];
      if (leg) {
        expect(leg.start_month).toMatch(MONTH_ONLY);
        expect(leg.end_month).toMatch(MONTH_ONLY);
      }
    }
    expect(sanitized.dashas?.current_maha?.start_month).toBe("2023-04");
    expect(sanitized.dashas?.current_maha?.end_month).toBe("2039-04");
  });

  it("reduces the pratyantar_sequence to month-precision dated rows", () => {
    expect(realChart.dashas.pratyantar_sequence).toHaveLength(9);
    const pds = sanitized.dashas?.pratyantar_sequence;
    expect(pds).toHaveLength(9);
    for (const pd of pds ?? []) {
      expect(pd.start_month).toMatch(MONTH_ONLY);
      expect(pd.end_month).toMatch(MONTH_ONLY);
      expect(pd).not.toHaveProperty("start_date");
      expect(pd).not.toHaveProperty("end_date");
    }
  });

  it("emits NO new keys for an older bundle without the tree (output unchanged)", () => {
    const { pratyantar_sequence: _pd, ...dashasRest } = realChart.dashas;
    const legacy = {
      ...realChart,
      dashas: {
        ...dashasRest,
        maha_dasha_sequence: realChart.dashas.maha_dasha_sequence.map(
          ({ antar_sequence: _antars, ...row }) => row,
        ),
      },
    } as unknown as SiderealChart;
    const out = sanitizeChartForLlm(legacy, { basis: "chart", instant: NOW });
    expect(out.dashas).not.toHaveProperty("pratyantar_sequence");
    for (const row of out.dashas?.maha_dasha_sequence ?? []) {
      expect(row).not.toHaveProperty("start_month");
      expect(row).not.toHaveProperty("end_month");
      expect(row).not.toHaveProperty("antar_sequence");
    }
    for (const key of ["current_maha", "current_antar", "current_pratyantar"] as const) {
      const leg = out.dashas?.[key];
      if (leg) {
        expect(leg).not.toHaveProperty("start_month");
        expect(leg).not.toHaveProperty("end_month");
      }
    }
  });

  it("folds an engine-emitted null pratyantar_sequence to an absent key", () => {
    const chart = {
      ...realChart,
      dashas: {
        ...realChart.dashas,
        current_antar: null,
        current_pratyantar: null,
        pratyantar_sequence: null,
      },
    } as unknown as SiderealChart;
    const out = sanitizeChartForLlm(chart, { basis: "chart", instant: NOW });
    expect(out.dashas).not.toHaveProperty("pratyantar_sequence");
  });
});
