import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { devicePolicy } from "../../deviceTier";
import type { SiderealChart } from "../chart";
import { EngineMemo, memoKey, memoizeChartEngine } from "../engineMemo";
import type { PredictiveContexts } from "../predictive";
import type { BirthInput, PredictiveInput } from "../protocol";
import type { ChartEngine } from "../runtime";

const HERE = dirname(fileURLToPath(import.meta.url));
// Real CPython engine output, the same golden the browser byte-parity gate pins.
const GOLDEN = resolve(HERE, "../../../../../../backend/tests/fixtures/chart_golden_de421.json");
const goldenCharts = JSON.parse(readFileSync(GOLDEN, "utf8")) as Record<string, SiderealChart>;
const FIXTURE_KEYS = Object.keys(goldenCharts).slice(0, 4);

const REFERENCE = "2025-01-01T00:00:00+00:00";

function birthFor(datetimeUtc: string): BirthInput {
  return { datetimeUtc, latitude: 12.9716, longitude: 77.5946, referenceDate: REFERENCE };
}

const PREDICTIVE: PredictiveInput = {
  datetimeUtc: "1988-08-08T01:14:00+00:00",
  latitude: 12.9716,
  longitude: 77.5946,
  referenceInstant: REFERENCE,
  utcOffsetMinutes: 330,
};

/** A deterministic engine double: serves the golden chart for its birth instant. */
class CountingEngine implements ChartEngine {
  public chartCalls = 0;
  public predictiveCalls = 0;
  public failNext = false;

  public async generateChart(birth: BirthInput): Promise<SiderealChart> {
    this.chartCalls += 1;
    if (this.failNext) {
      this.failNext = false;
      throw new Error("engine failed");
    }
    // A fresh parse per call, like a real Worker reply (never a shared object).
    return JSON.parse(JSON.stringify(goldenCharts[birth.datetimeUtc])) as SiderealChart;
  }

  public async computePredictive(input: PredictiveInput): Promise<PredictiveContexts> {
    this.predictiveCalls += 1;
    return { transit_context: { instant: input.referenceInstant } } as unknown as PredictiveContexts;
  }

  public async computeMeshEdge(): Promise<never> {
    throw new Error("not used");
  }

  public async computeRectification(): Promise<never> {
    throw new Error("not used");
  }

  public meta(): null {
    return null;
  }
}

const memoized = (engine: ChartEngine, identity = "manifest-a", memo = new EngineMemo()) =>
  memoizeChartEngine(engine, identity, memo);

describe("memoizeChartEngine — identical input is computed once", () => {
  it("does not invoke the engine again for an identical chart input", async () => {
    const engine = new CountingEngine();
    const cached = memoized(engine);
    const birth = birthFor(FIXTURE_KEYS[0]);

    await cached.generateChart(birth);
    await cached.generateChart({ ...birth });

    expect(engine.chartCalls).toBe(1);
  });

  it("does not invoke the engine again for an identical predictive input", async () => {
    const engine = new CountingEngine();
    const cached = memoized(engine);

    await cached.computePredictive(PREDICTIVE);
    await cached.computePredictive({ ...PREDICTIVE });

    expect(engine.predictiveCalls).toBe(1);
  });

  it("treats key order as irrelevant (canonical input)", async () => {
    const engine = new CountingEngine();
    const cached = memoized(engine);
    const birth = birthFor(FIXTURE_KEYS[0]);
    const reordered: BirthInput = {
      referenceDate: birth.referenceDate,
      longitude: birth.longitude,
      latitude: birth.latitude,
      datetimeUtc: birth.datetimeUtc,
    };

    await cached.generateChart(birth);
    await cached.generateChart(reordered);

    expect(engine.chartCalls).toBe(1);
  });

  it("recomputes when any input moves — including the reference instant", async () => {
    const engine = new CountingEngine();
    const cached = memoized(engine);
    const birth = birthFor(FIXTURE_KEYS[0]);

    await cached.generateChart(birth);
    await cached.generateChart({ ...birth, latitude: 13 });
    await cached.generateChart({ ...birth, referenceDate: "2026-01-01T00:00:00+00:00" });
    await cached.generateChart(birthFor(FIXTURE_KEYS[1]));

    expect(engine.chartCalls).toBe(4);
  });

  it("shares one in-flight compute between concurrent identical calls", async () => {
    const engine = new CountingEngine();
    const cached = memoized(engine);
    const birth = birthFor(FIXTURE_KEYS[0]);

    const [a, b] = await Promise.all([cached.generateChart(birth), cached.generateChart(birth)]);

    expect(engine.chartCalls).toBe(1);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("never caches a failure: the next identical call recomputes", async () => {
    const engine = new CountingEngine();
    const cached = memoized(engine);
    const birth = birthFor(FIXTURE_KEYS[0]);
    engine.failNext = true;

    await expect(cached.generateChart(birth)).rejects.toThrow("engine failed");
    await expect(cached.generateChart(birth)).resolves.toBeDefined();

    expect(engine.chartCalls).toBe(2);
  });

  it("evicts the least recently used entry beyond its capacity", async () => {
    const engine = new CountingEngine();
    const cached = memoized(engine, "manifest-a", new EngineMemo(2));

    await cached.generateChart(birthFor(FIXTURE_KEYS[0]));
    await cached.generateChart(birthFor(FIXTURE_KEYS[1]));
    await cached.generateChart(birthFor(FIXTURE_KEYS[0])); // refresh 0
    await cached.generateChart(birthFor(FIXTURE_KEYS[2])); // evicts 1
    expect(engine.chartCalls).toBe(3);

    await cached.generateChart(birthFor(FIXTURE_KEYS[0])); // still cached
    expect(engine.chartCalls).toBe(3);
    await cached.generateChart(birthFor(FIXTURE_KEYS[1])); // was evicted
    expect(engine.chartCalls).toBe(4);
  });

  it("passes non-memoized calls and meta straight through", async () => {
    const engine = new CountingEngine();
    const cached = memoized(engine);

    expect(cached.meta()).toBeNull();
    await expect(cached.computeMeshEdge({} as never)).rejects.toThrow("not used");
  });
});

describe("memoizeChartEngine — engine identity invalidates", () => {
  it("recomputes when the engine identity (bundle manifest) changes, even on a shared memo", async () => {
    const memo = new EngineMemo();
    const before = new CountingEngine();
    const after = new CountingEngine();
    const birth = birthFor(FIXTURE_KEYS[0]);

    await memoized(before, "manifest-a", memo).generateChart(birth);
    await memoized(after, "manifest-b", memo).generateChart(birth);
    await memoized(after, "manifest-b", memo).generateChart(birth);

    expect(before.chartCalls).toBe(1);
    expect(after.chartCalls).toBe(1);
  });

  it("keys on identity, call kind, and canonical input", () => {
    const birth = birthFor(FIXTURE_KEYS[0]);
    expect(memoKey("a", "generateChart", birth)).not.toBe(memoKey("b", "generateChart", birth));
    expect(memoKey("a", "generateChart", birth)).not.toBe(memoKey("a", "computePredictive", birth));
    expect(memoKey("a", "generateChart", { b: 1, a: [1, { d: 2, c: 3 }] })).toBe(
      memoKey("a", "generateChart", { a: [1, { c: 3, d: 2 }], b: 1 }),
    );
  });
});

describe("memoizeChartEngine — determinism contract: cached == fresh, byte for byte", () => {
  it.each(FIXTURE_KEYS)("golden chart %s: the cached result is byte-identical to an uncached compute", async (key) => {
    const fresh = await new CountingEngine().generateChart(birthFor(key));
    const engine = new CountingEngine();
    const cached = memoized(engine);

    const miss = await cached.generateChart(birthFor(key));
    const hit = await cached.generateChart(birthFor(key));

    expect(engine.chartCalls).toBe(1);
    expect(JSON.stringify(miss)).toBe(JSON.stringify(fresh));
    expect(JSON.stringify(hit)).toBe(JSON.stringify(fresh));
    expect(JSON.stringify(hit)).toBe(JSON.stringify(goldenCharts[key]));
  });

  it("a caller mutating its result cannot poison the cache", async () => {
    const engine = new CountingEngine();
    const cached = memoized(engine);
    const birth = birthFor(FIXTURE_KEYS[0]);

    const first = await cached.generateChart(birth);
    (first as unknown as { lagna: unknown }).lagna = "tampered";
    const second = await cached.generateChart(birth);

    expect(engine.chartCalls).toBe(1);
    expect(JSON.stringify(second)).toBe(JSON.stringify(goldenCharts[FIXTURE_KEYS[0]]));
  });
});

/** The same birth at another reference day: a distinct predictive input. */
const atDay = (day: string): PredictiveInput => ({ ...PREDICTIVE, referenceInstant: `${day}T00:00:00Z` });
const PERIOD = { retention: "period" } as const;
const DAYS = ["2019-01-01", "2019-02-01", "2019-03-01", "2019-04-01", "2019-05-01", "2019-06-01"];

describe("memoizeChartEngine — period computes are bounded by the period capacity", () => {
  it("keeps at most `periodCapacity` period payloads; one more evicts the oldest", async () => {
    const engine = new CountingEngine();
    const cached = memoized(engine, "manifest-a", new EngineMemo(32, 2));

    for (const day of DAYS.slice(0, 3)) await cached.computePredictive(atDay(day), PERIOD);
    await cached.computePredictive(atDay(DAYS[2]), PERIOD); // newest still kept
    expect(engine.predictiveCalls).toBe(3);
    await cached.computePredictive(atDay(DAYS[0]), PERIOD); // oldest was evicted
    expect(engine.predictiveCalls).toBe(4);
  });

  it("a period compute never evicts a default (Life Atlas) entry", async () => {
    const engine = new CountingEngine();
    const cached = memoized(engine, "manifest-a", new EngineMemo(32, 1));

    await cached.computePredictive(PREDICTIVE);
    for (const day of DAYS) await cached.computePredictive(atDay(day), PERIOD);
    await cached.computePredictive(PREDICTIVE);
    expect(engine.predictiveCalls).toBe(1 + DAYS.length);
  });

  it("default entries do not use up the period capacity", async () => {
    const engine = new CountingEngine();
    const cached = memoized(engine, "manifest-a", new EngineMemo(32, 2));

    await cached.computePredictive(PREDICTIVE);
    await cached.computePredictive(atDay(DAYS[0]), PERIOD);
    await cached.computePredictive(atDay(DAYS[1]), PERIOD);
    await cached.computePredictive(atDay(DAYS[0]), PERIOD);
    await cached.computePredictive(atDay(DAYS[1]), PERIOD);
    expect(engine.predictiveCalls).toBe(3);
  });

  it("default computes are not bound by the period capacity", async () => {
    const engine = new CountingEngine();
    const cached = memoized(engine, "manifest-a", new EngineMemo(32, 1));

    for (const day of DAYS) await cached.computePredictive(atDay(day));
    for (const day of DAYS) await cached.computePredictive(atDay(day));
    expect(engine.predictiveCalls).toBe(DAYS.length);
  });

  it("a period ask joins the entry the store's compute already holds (same key shape)", async () => {
    const engine = new CountingEngine();
    const cached = memoized(engine, "manifest-a", new EngineMemo(32, 1));

    await cached.computePredictive(PREDICTIVE);
    await cached.computePredictive(PREDICTIVE, PERIOD);
    expect(engine.predictiveCalls).toBe(1);
  });

  it.each([0, -3, Number.NaN])("a period capacity of %s clamps to 1 (the last period stays cached)", async (size) => {
    const engine = new CountingEngine();
    const cached = memoized(engine, "manifest-a", new EngineMemo(32, size));

    await cached.computePredictive(atDay(DAYS[0]), PERIOD);
    await cached.computePredictive(atDay(DAYS[0]), PERIOD);
    expect(engine.predictiveCalls).toBe(1);
    await cached.computePredictive(atDay(DAYS[1]), PERIOD);
    await cached.computePredictive(atDay(DAYS[0]), PERIOD);
    expect(engine.predictiveCalls).toBe(3);
  });

  it("by default the period capacity is this device tier's periodSkyCacheSize", async () => {
    const size = devicePolicy().periodSkyCacheSize;
    const engine = new CountingEngine();
    const cached = memoizeChartEngine(engine, "manifest-a");

    for (const day of DAYS.slice(0, size + 1)) await cached.computePredictive(atDay(day), PERIOD);
    await cached.computePredictive(atDay(DAYS[size]), PERIOD);
    expect(engine.predictiveCalls).toBe(size + 1);
    await cached.computePredictive(atDay(DAYS[0]), PERIOD);
    expect(engine.predictiveCalls).toBe(size + 2);
  });
});
