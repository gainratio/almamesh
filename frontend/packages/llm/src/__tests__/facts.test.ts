import { describe, expect, it } from "vitest";

import { buildChartFactsBlock } from "../facts";
import type { SanitizedChart, SanitizedPredictive } from "../sanitize";

// A hand-built SanitizedChart fixture carrying ONLY the astrological fields the
// sanitizer emits, plus a smuggled identifier so we can prove the facts block
// never echoes it. Mars is exalted in Capricorn (10th); Moon is in own sign.
const CHART: SanitizedChart = {
  as_of: { date: "2026-01-01", basis: "chart" },
  ayanamsa_value: 24.1,
  lagna: {
    longitude: 12.3,
    sign: "aries",
    sign_degrees: 12.3,
    sign_lord: "mars",
    nakshatra: "ashwini",
    nakshatra_pada: 2,
    nakshatra_lord: "ketu",
  },
  planets: {
    mars: {
      name: "mars",
      longitude: 280.5,
      latitude: 0,
      distance: 1,
      speed: 0.5,
      is_retrograde: false,
      sign: "capricorn",
      sign_degrees: 10.5,
      sign_lord: "saturn",
      nakshatra: "shravana",
      nakshatra_pada: 1,
      nakshatra_lord: "moon",
      house: 10,
      dignity: "exalted",
      is_combust: false,
      combustion_separation_deg: null,
      houses_ruled: [],
      is_yogakaraka: false,
    },
    saturn: {
      name: "saturn",
      longitude: 100.2,
      latitude: 0,
      distance: 1,
      speed: -0.1,
      is_retrograde: true,
      sign: "cancer",
      sign_degrees: 10.2,
      sign_lord: "moon",
      nakshatra: "pushya",
      nakshatra_pada: 2,
      nakshatra_lord: "saturn",
      house: 4,
      dignity: "debilitated",
      is_combust: false,
      combustion_separation_deg: null,
      houses_ruled: [],
      is_yogakaraka: false,
    },
  },
  houses: {},
  yogas: [
    {
      name: "Gaja Kesari Yoga",
      display_name: "Gaja Kesari Yoga (Jupiter in the 1st from the Moon)",
      category: "auspicious",
      description: "Jupiter angular to the Moon.",
      effects: "Wisdom and prosperity.",
      grade: "moderate",
      strength_factors: [
        {
          factor_type: "dignity",
          planet: "jupiter",
          value: "exalted",
          basis: "Sign dignity per the BPHS exaltation/own-sign doctrine",
        },
      ],
      planets_involved: ["jupiter", "moon"],
      houses_involved: [1, 4],
      planetary_signature: "jupiter_moon_h1_h4",
      formation_rules: [
        {
          rule: "chandra.gaja_kesari",
          description: "Jupiter in the 1st from the Moon",
          source: "BPHS, Chandra-yoga adhyaya",
          planets: ["jupiter", "moon"],
          houses: [1],
        },
      ],
    },
  ],
  dashas: {
    maha_dasha_sequence: [],
    current_maha: { lord: "sun", duration_years: 6, months_remaining: 48 },
    current_antar: { lord: "mercury", duration_years: 6, months_remaining: 9 },
    current_pratyantar: null,
  },
};

describe("buildChartFactsBlock", () => {
  it("emits each planet's sign + house from the engine facts", () => {
    const block = buildChartFactsBlock(CHART);
    expect(block).toMatch(/mars/i);
    expect(block).toMatch(/capricorn/i);
    expect(block).toContain("10"); // Mars house
    expect(block).toMatch(/saturn/i);
    expect(block).toMatch(/cancer/i);
  });

  it("marks dignity (exalted) and retrograde where the engine flags them", () => {
    const block = buildChartFactsBlock(CHART);
    expect(block).toMatch(/exalted/i); // Mars dignity
    expect(block).toMatch(/debilitated/i); // Saturn dignity
    expect(block).toMatch(/retrograde/i); // Saturn is retrograde
  });

  it("includes the current maha + antar dasha lords", () => {
    const block = buildChartFactsBlock(CHART);
    expect(block).toMatch(/sun/i); // maha lord
    expect(block).toMatch(/mercury/i); // antar lord
  });

  it("emits each yoga honestly: display name, [grade], planets, formation basis", () => {
    const block = buildChartFactsBlock(CHART);
    expect(block).toContain("Gaja Kesari Yoga (Jupiter in the 1st from the Moon)");
    expect(block).toContain("[moderate]");
    expect(block).toMatch(/planets: jupiter, moon/);
    // The first formation rule's description is the engine's own basis line.
    expect(block).toContain("basis: Jupiter in the 1st from the Moon");
  });

  it("never emits a numeric/undefined yoga strength (the field no longer exists)", () => {
    const block = buildChartFactsBlock(CHART);
    expect(block).not.toContain("undefined");
    expect(block).not.toMatch(/strength 0?\.\d/);
    expect(block).not.toMatch(/\d+\s*%/);
  });

  it("is compact: NOT a raw chart JSON dump", () => {
    const block = buildChartFactsBlock(CHART);
    // Raw JSON would carry these structural keys; the facts block must not.
    // NOTE (Spec 062, LLM delta 4): nakshatra/pada/degrees now DO appear — but
    // as prose ("pada 1"), never as the raw JSON keys asserted absent here.
    expect(block).not.toContain("ayanamsa_value");
    expect(block).not.toContain("nakshatra_pada");
    expect(block).not.toContain("sign_degrees");
    expect(block).not.toContain("longitude");
  });

  it("never echoes a smuggled identifier field", () => {
    const chartWithId = {
      ...CHART,
      chart_id: "secret-correlatable-id-abc123",
    } as unknown as SanitizedChart;
    const block = buildChartFactsBlock(chartWithId);
    expect(block).not.toContain("chart_id");
    expect(block).not.toContain("secret-correlatable-id-abc123");
  });

  it("tolerates a chart with no dasha data (no throw)", () => {
    const noDasha = { ...CHART, dashas: undefined } as SanitizedChart;
    const block = buildChartFactsBlock(noDasha);
    expect(block).toMatch(/mars/i); // still emits planet facts
  });
});

// Spec 062 (LLM delta 4): the old planetLine DROPPED degree-within-sign and
// nakshatra/pada/lord, so chat could not answer "what degree is my Mars?" or
// ground a nakshatra question. This suite locks the DELIBERATE reversal: the
// engine's own sign_degrees + nakshatra fields now ride the planet line as
// prose. Still zero astrology math and nothing identifying — every value is an
// emitted engine field.
describe("buildChartFactsBlock — degrees + nakshatra depth (Spec 062 delta 4)", () => {
  it("emits each planet's engine degree-within-sign on its line", () => {
    const block = buildChartFactsBlock(CHART);
    expect(block).toContain("- mars: capricorn 10.50° (10th house), exalted");
    expect(block).toContain("- saturn: cancer 10.20° (4th house), debilitated, retrograde");
  });

  it("emits each planet's nakshatra, pada, and nakshatra lord as prose", () => {
    const block = buildChartFactsBlock(CHART);
    expect(block).toContain("nakshatra shravana pada 1 (lord moon)");
    expect(block).toContain("nakshatra pushya pada 2 (lord saturn)");
  });

  it("degrades gracefully when a legacy payload lacks nakshatra/degrees fields", () => {
    const legacyMars = { ...CHART.planets.mars } as Record<string, unknown>;
    delete legacyMars.nakshatra;
    delete legacyMars.sign_degrees;
    const legacy: SanitizedChart = {
      as_of: { date: "2026-01-01", basis: "chart" },
      ...CHART,
      planets: { mars: legacyMars as unknown as SanitizedChart["planets"][string] },
    };
    const block = buildChartFactsBlock(legacy);
    expect(block).toContain("- mars: capricorn (10th house), exalted");
    expect(block).not.toContain("undefined");
  });
});

describe("buildChartFactsBlock — dasha convention (no silent convention)", () => {
  it("states the engine-declared dasha-year convention when present", () => {
    const withConvention: SanitizedChart = {
      as_of: { date: "2026-01-01", basis: "chart" },
      ...CHART,
      dashas: { ...CHART.dashas!, convention: "julian_365_25" },
    };
    const block = buildChartFactsBlock(withConvention);
    expect(block).toMatch(/dasha-year convention/i);
    expect(block).toContain("julian_365_25");
  });

  it("emits no convention line when the engine declares none (graceful absence)", () => {
    const block = buildChartFactsBlock(CHART);
    expect(block).not.toMatch(/convention/i);
  });
});

const NAVAMSA: SanitizedChart["navamsa"] = {
  name: "D9",
  lagna_sign: "scorpio",
  lagna_sign_lord: "mars",
  planets: {
    mars: { name: "mars", sign: "capricorn", sign_lord: "saturn" },
    venus: { name: "venus", sign: "pisces", sign_lord: "jupiter" },
  },
};

describe("buildChartFactsBlock — D9 navamsa", () => {
  it("emits the D9 lagna and each graha's navamsa sign when present", () => {
    const block = buildChartFactsBlock({ ...CHART, navamsa: NAVAMSA });
    expect(block).toMatch(/D9 Navamsa/);
    expect(block).toMatch(/scorpio/i); // D9 lagna
    expect(block).toMatch(/venus.*pisces/i); // a navamsa placement
  });

  it("emits no navamsa block when the chart carries none (graceful absence)", () => {
    const block = buildChartFactsBlock(CHART);
    expect(block).not.toMatch(/navamsa/i);
  });
});

const PREDICTIVE: SanitizedPredictive = {
  transits: {
    gochara: [
      {
        graha: "saturn",
        sign: "pisces",
        house_from_lagna: 12,
        house_from_moon: 8,
        is_retrograde: true,
      },
    ],
    sade_sati: {
      is_active: true,
      current_phase: "peak",
      natal_moon_sign: "aquarius",
      until_month: "2033-04",
    },
    fusion: {
      maha_lord: "saturn",
      antar_lord: "mercury",
      maha_lord_transit_house_from_moon: 8,
      maha_lord_transit_house_from_lagna: 12,
      reinforcing: ["jupiter"],
      afflicting: ["mars"],
      severity: "challenging",
    },
    slow_hits: [
      {
        graha: "jupiter",
        kind: "return",
        natal_point: "jupiter",
        month: "2030-05",
        severity: "supportive",
      },
    ],
    timeline: [
      {
        month: "2030-03",
        kind: "sign_ingress",
        graha: "saturn",
        from_sign: "aquarius",
        to_sign: "pisces",
        severity: "challenging",
        descriptor: "Saturn enters Pisces",
      },
    ],
  },
  strength: {
    sav_total: 337,
    shadbala: [
      { planet: "saturn", total_rupas: 5.21, required_rupas: 5, meets_minimum: true },
    ],
  },
  vargas: {
    vargottama: [{ point: "moon", sign: "taurus" }],
    shadvarga_own_sign: [
      { graha: "jupiter", own_sign_count: 3, charts_in_own_sign: ["D1", "D9", "D12"] },
    ],
    vimshopaka: [{ graha: "jupiter", score: 16.5, approximated: false }],
  },
  domains: [
    {
      domain: "career",
      band: "strong",
      key_graha: "saturn",
      key_graha_rupas: 5.21,
      key_graha_meets_minimum: true,
      sav_bindus: 28,
      strength_note: "Saturn meets its Shadbala minimum.",
      active_dasha_significator: true,
      dasha_levels: ["maha"],
      matched_dasha_lords: ["saturn"],
      under_sade_sati: true,
      transit_severity: "neutral",
      windows: [
        {
          month: "2030-03",
          source: "transit",
          kind: "sign_ingress",
          trigger: "saturn",
          severity: "supportive",
          descriptor: "Career window opens as Saturn changes sign",
        },
      ],
    },
  ],
};

describe("buildChartFactsBlock — engine predictive context", () => {
  const withPredictive: SanitizedChart = { ...CHART, predictive: PREDICTIVE };

  it("emits a clearly delimited block with narrate-only guard language", () => {
    const block = buildChartFactsBlock(withPredictive);
    expect(block).toContain("ENGINE PREDICTIVE CONTEXT");
    expect(block).toContain("END ENGINE PREDICTIVE CONTEXT");
    expect(block).toMatch(/narrate only what this block states/i);
  });

  it("surfaces sade sati, fusion, and month-precision transit windows", () => {
    const block = buildChartFactsBlock(withPredictive);
    expect(block).toMatch(/sade sati/i);
    expect(block).toMatch(/peak/);
    expect(block).toContain("2033-04");
    expect(block).toContain("2030-03");
    expect(block).toContain("Saturn enters Pisces");
    expect(block).toMatch(/maha lord saturn/i);
  });

  it("surfaces the key strength figures (SAV, shadbala, vargottama, vimshopaka)", () => {
    const block = buildChartFactsBlock(withPredictive);
    expect(block).toContain("337");
    expect(block).toContain("5.21");
    expect(block).toMatch(/vargottama/i);
    expect(block).toMatch(/vimshopaka/i);
    expect(block).toContain("16.5");
  });

  it("surfaces the per-life-domain forecast summary with its windows", () => {
    const block = buildChartFactsBlock(withPredictive);
    expect(block).toMatch(/career/i);
    expect(block).toMatch(/strong/);
    expect(block).toContain("Career window opens as Saturn changes sign");
  });

  it("emits NO predictive block when the chart carries none (graceful absence)", () => {
    const block = buildChartFactsBlock(CHART);
    expect(block).not.toContain("ENGINE PREDICTIVE CONTEXT");
  });
});

// Planets carrying the engine's lordship fields (`houses_ruled`,
// `is_yogakaraka`) — required, typed PlanetPosition fields since the
// yoga-integrity contract landed.
const LORDSHIP_PLANETS: SanitizedChart["planets"] = {
  mars: { ...CHART.planets.mars, houses_ruled: [1, 8] },
  saturn: { ...CHART.planets.saturn, houses_ruled: [10, 11], is_yogakaraka: true },
};

describe("buildChartFactsBlock — engine house lordships (graceful absence)", () => {
  it("emits the compact engine-computed lordship line when planets carry houses_ruled", () => {
    const block = buildChartFactsBlock({ ...CHART, planets: LORDSHIP_PLANETS });
    expect(block).toContain("House lordships (engine-computed):");
    expect(block).toContain("mars rules 1,8");
    expect(block).toContain("saturn rules 10,11 (yogakaraka)");
  });

  it("marks a combust planet on its planet line (engine flag verbatim)", () => {
    const combust: SanitizedChart["planets"] = {
      mars: { ...CHART.planets.mars, is_combust: true },
      saturn: CHART.planets.saturn,
    };
    const block = buildChartFactsBlock({ ...CHART, planets: combust });
    expect(block).toMatch(/mars: .*combust/);
  });

  it("emits NO lordship line when no planet carries houses_ruled (graceful absence)", () => {
    const block = buildChartFactsBlock(CHART);
    expect(block).not.toContain("House lordships");
    expect(block).not.toContain("yogakaraka");
  });

  it("treats an empty houses_ruled array as absent — output byte-identical to today", () => {
    const emptied: SanitizedChart["planets"] = {
      mars: { ...CHART.planets.mars, houses_ruled: [] },
      saturn: { ...CHART.planets.saturn, houses_ruled: [] },
    };
    const block = buildChartFactsBlock({ ...CHART, planets: emptied });
    expect(block).toBe(buildChartFactsBlock(CHART));
  });
});

// The founder fixture's SANITIZED dasha tree (month precision, exactly as
// sanitizeChartForLlm emits it from the regenerated golden): Saturn maha
// 2017-02 → 2036-02, currently in its Venus antar (2023-12 → 2027-01), with
// the Venus antar's 9 pratyantardashas attached.
const FOUNDER_DASHAS: NonNullable<SanitizedChart["dashas"]> = {
  maha_dasha_sequence: [
    { lord: "moon", duration_years: 2.865518, status: "past" },
    { lord: "mars", duration_years: 7, status: "past" },
    { lord: "rahu", duration_years: 18, status: "past" },
    { lord: "jupiter", duration_years: 16, status: "past" },
    {
      lord: "saturn",
      duration_years: 19,
      status: "current (9 years remaining)",
      start_month: "2017-02",
      end_month: "2036-02",
      antar_sequence: [
        { lord: "saturn", duration_years: 19, start_month: "2017-02", end_month: "2020-02" },
        { lord: "mercury", duration_years: 17, start_month: "2020-02", end_month: "2022-10" },
        { lord: "ketu", duration_years: 7, start_month: "2022-10", end_month: "2023-12" },
        { lord: "venus", duration_years: 20, start_month: "2023-12", end_month: "2027-01" },
        { lord: "sun", duration_years: 6, start_month: "2027-01", end_month: "2028-01" },
        { lord: "moon", duration_years: 10, start_month: "2028-01", end_month: "2029-08" },
        { lord: "mars", duration_years: 7, start_month: "2029-08", end_month: "2030-09" },
        { lord: "rahu", duration_years: 18, start_month: "2030-09", end_month: "2033-07" },
        { lord: "jupiter", duration_years: 16, start_month: "2033-07", end_month: "2036-02" },
      ],
    },
    {
      lord: "mercury",
      duration_years: 17,
      status: "future (starts in 9 years)",
      start_month: "2036-02",
      end_month: "2053-02",
    },
    {
      lord: "ketu",
      duration_years: 7,
      status: "future (starts in 26 years)",
      start_month: "2053-02",
      end_month: "2060-02",
    },
  ],
  current_maha: {
    lord: "saturn",
    duration_years: 19,
    months_remaining: 116,
    start_month: "2017-02",
    end_month: "2036-02",
  },
  current_antar: {
    lord: "venus",
    duration_years: 20,
    months_remaining: 7,
    start_month: "2023-12",
    end_month: "2027-01",
  },
  current_pratyantar: {
    lord: "mars",
    duration_years: 7,
    months_remaining: 0,
    start_month: "2024-11",
    end_month: "2025-01",
  },
  pratyantar_sequence: [
    { lord: "venus", duration_years: 20, start_month: "2023-12", end_month: "2024-06" },
    { lord: "sun", duration_years: 6, start_month: "2024-06", end_month: "2024-08" },
    { lord: "moon", duration_years: 10, start_month: "2024-08", end_month: "2024-11" },
    { lord: "mars", duration_years: 7, start_month: "2024-11", end_month: "2025-01" },
    { lord: "rahu", duration_years: 18, start_month: "2025-01", end_month: "2025-07" },
    { lord: "jupiter", duration_years: 16, start_month: "2025-07", end_month: "2025-12" },
    { lord: "saturn", duration_years: 19, start_month: "2025-12", end_month: "2026-06" },
    { lord: "mercury", duration_years: 17, start_month: "2026-06", end_month: "2026-11" },
    { lord: "ketu", duration_years: 7, start_month: "2026-11", end_month: "2027-01" },
  ],
};

const TREE_CHART: SanitizedChart = { ...CHART, dashas: FOUNDER_DASHAS };

const EXPECTED_CURRENT_BLOCK = [
  "Current period (engine-dated):",
  "- Mahadasha: saturn 2017-02 -> 2036-02",
  "- Antardasha: venus 2023-12 -> 2027-01",
  "- Pratyantardasha: mars 2024-11 -> 2025-01",
].join("\n");

const EXPECTED_UPCOMING_BLOCK = [
  "Upcoming periods (engine-dated):",
  "- Remaining antardashas of the saturn mahadasha: sun 2027-01 -> 2028-01; moon 2028-01 -> 2029-08; mars 2029-08 -> 2030-09; rahu 2030-09 -> 2033-07; jupiter 2033-07 -> 2036-02",
  "- Remaining pratyantardashas of the venus antardasha: rahu 2025-01 -> 2025-07; jupiter 2025-07 -> 2025-12; saturn 2025-12 -> 2026-06; mercury 2026-06 -> 2026-11; ketu 2026-11 -> 2027-01",
  "- Next mahadasha: mercury 2036-02 -> 2053-02",
].join("\n");

describe("buildChartFactsBlock — engine-dated current + upcoming periods", () => {
  it("emits the dated current-period stack exactly as the engine states it", () => {
    const block = buildChartFactsBlock(TREE_CHART);
    expect(block).toContain(EXPECTED_CURRENT_BLOCK);
  });

  it("emits the upcoming periods: remaining antars, remaining pratyantars, next maha", () => {
    const block = buildChartFactsBlock(TREE_CHART);
    expect(block).toContain(EXPECTED_UPCOMING_BLOCK);
  });

  it("orders the blocks: relative current block, then dated current, then upcoming", () => {
    const block = buildChartFactsBlock(TREE_CHART);
    const relativeIdx = block.indexOf("Current dasha period (as of 2026-01-01, the chart's analysis date):");
    const datedIdx = block.indexOf("Current period (engine-dated):");
    const upcomingIdx = block.indexOf("Upcoming periods (engine-dated):");
    expect(relativeIdx).toBeGreaterThanOrEqual(0);
    expect(datedIdx).toBeGreaterThan(relativeIdx);
    expect(upcomingIdx).toBeGreaterThan(datedIdx);
  });

  it("omits the next-maha line when the current maha is the LAST sequence row", () => {
    const truncated: SanitizedChart = {
      as_of: { date: "2026-01-01", basis: "chart" },
      ...CHART,
      dashas: {
        ...FOUNDER_DASHAS,
        // Saturn (the current maha) is now the final row — no next maha exists.
        maha_dasha_sequence: FOUNDER_DASHAS.maha_dasha_sequence.slice(0, 5),
      },
    };
    const block = buildChartFactsBlock(truncated);
    expect(block).toContain("Upcoming periods (engine-dated):");
    expect(block).not.toContain("Next mahadasha");
  });

  it("omits current and upcoming rows under a period basis, which describe today", () => {
    const block = buildChartFactsBlock({
      ...TREE_CHART,
      as_of: { date: "2026-06-01", basis: "period", period_start: "2026-06-01", period_end: "2026-06-30" },
    });
    expect(block).not.toContain("Remaining antardashas");
    expect(block).not.toContain("Remaining pratyantardashas");
    expect(block).not.toContain("Next mahadasha");
    expect(buildChartFactsBlock(TREE_CHART)).toContain("- Next mahadasha: mercury 2036-02 -> 2053-02");
  });

  it("emits no remaining antar/pratyantar lines without a current antar anchor", () => {
    const noAntar: SanitizedChart = {
      as_of: { date: "2026-01-01", basis: "chart" },
      ...CHART,
      dashas: {
        ...FOUNDER_DASHAS,
        current_antar: null,
        current_pratyantar: null,
        // The engine emits pratyantar_sequence null exactly when current_antar
        // is null; the sanitizer folds that to an absent key.
        pratyantar_sequence: undefined,
      },
    };
    const block = buildChartFactsBlock(noAntar);
    expect(block).not.toContain("Remaining antardashas");
    expect(block).not.toContain("Remaining pratyantardashas");
    expect(block).toContain("- Next mahadasha: mercury 2036-02 -> 2053-02");
  });

  it("graceful absence: a chart without the tree renders byte-identical to today", () => {
    // The exact, full pre-tree output for CHART — pinned verbatim so any
    // accidental reformatting of the legacy path fails loudly.
    // DELIBERATELY UPDATED for Spec 062 (LLM delta 4): the planet lines now
    // carry the engine's degree-within-sign and nakshatra/pada/lord — the old
    // exclusion this test used to lock was reversed on purpose so chat can
    // ground degree- and nakshatra-level questions in engine facts.
    const expected = [
      "Ascendant (Lagna): aries, lord mars",
      "",
      "Planets:",
      "- mars: capricorn 10.50° (10th house), exalted — nakshatra shravana pada 1 (lord moon)",
      "- saturn: cancer 10.20° (4th house), debilitated, retrograde — nakshatra pushya pada 2 (lord saturn)",
      "",
      "Current dasha period (as of 2026-01-01, the chart's analysis date):",
      "- Mahadasha: sun (48 months remaining)",
      "- Antardasha: mercury (9 months remaining)",
      "",
      "Detected yogas:",
      "- Gaja Kesari Yoga (Jupiter in the 1st from the Moon) [moderate] (planets: jupiter, moon) — basis: Jupiter in the 1st from the Moon",
    ].join("\n");
    expect(buildChartFactsBlock(CHART)).toBe(expected);
    expect(buildChartFactsBlock(CHART)).not.toContain("engine-dated");
  });
});
