import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { ChartSnapshot, SiderealChart } from "../chart";
import { ChartSnapshotError, computeSnapshotId, verifyChartSnapshot } from "../chartSnapshot";
import type { BirthInput } from "../../types";

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = resolve(HERE, "../../../../../../backend/tests/fixtures/chart_golden_de421.json");
const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as Record<string, SiderealChart>;

const DELHI = "1990-01-15T12:00:00+00:00";
const chart = golden[DELHI]!;
const stamp = chart.snapshot!;

// The browser mints instants with toISOString(): same instant, different spelling.
const BIRTH: BirthInput = {
  datetimeUtc: "1990-01-15T12:00:00.000Z",
  latitude: 28.6139,
  longitude: 77.209,
  referenceDate: "2025-01-01T00:00:00.000Z",
};

function withSnapshot(snapshot: unknown): SiderealChart {
  return { ...chart, snapshot } as SiderealChart;
}

function fieldsOf(snapshot: ChartSnapshot): Omit<ChartSnapshot, "snapshot_id"> {
  const { snapshot_id: _id, ...fields } = snapshot;
  return fields;
}

describe("computeSnapshotId", () => {
  it("reproduces the engine's id for every golden chart (one canonical form, two languages)", async () => {
    for (const [key, entry] of Object.entries(golden)) {
      const expected = entry.snapshot!.snapshot_id;
      await expect(computeSnapshotId(fieldsOf(entry.snapshot!)), key).resolves.toBe(expected);
    }
  });

  it("is independent of key order", async () => {
    const reversed = Object.fromEntries(Object.entries(fieldsOf(stamp)).reverse());

    await expect(computeSnapshotId(reversed as unknown as typeof stamp)).resolves.toBe(stamp.snapshot_id);
  });
});

describe("verifyChartSnapshot (the worker boundary)", () => {
  it("accepts a stamped chart that answers this exact request", async () => {
    await expect(verifyChartSnapshot(chart, BIRTH)).resolves.toEqual(stamp);
  });

  it("refuses a chart with no snapshot", async () => {
    await expect(verifyChartSnapshot(withSnapshot(undefined), BIRTH)).rejects.toThrow(
      ChartSnapshotError,
    );
  });

  it("refuses a stamp whose fields do not hash to its id", async () => {
    const forged = withSnapshot({ ...stamp, engine_version: "9.9.9" });

    await expect(verifyChartSnapshot(forged, BIRTH)).rejects.toThrow(/does not match/);
  });

  it("refuses a chart computed for another birth instant", async () => {
    const other = { ...BIRTH, datetimeUtc: "1990-01-15T12:01:00.000Z" };

    await expect(verifyChartSnapshot(chart, other)).rejects.toThrow(/birth_utc/);
  });

  it("refuses a chart computed as of another analysis instant", async () => {
    const other = { ...BIRTH, referenceDate: "2030-01-01T00:00:00.000Z" };

    await expect(verifyChartSnapshot(chart, other)).rejects.toThrow(/reference_date/);
  });

  it.each([
    ["an unknown field", { ...stamp, extra: "x" }],
    ["a missing field", fieldsOf(stamp)],
    ["a non-string field", { ...stamp, engine_version: 1 }],
    ["an id that is not a SHA-256 hex digest", { ...stamp, snapshot_id: "abc" }],
  ])("refuses a malformed stamp: %s", async (_label, snapshot) => {
    await expect(verifyChartSnapshot(withSnapshot(snapshot), BIRTH)).rejects.toThrow(
      ChartSnapshotError,
    );
  });

  it("refuses an unknown schema even when its id is self-consistent", async () => {
    const fields = { ...fieldsOf(stamp), snapshot_schema: "2" };
    const future = { ...fields, snapshot_id: await computeSnapshotId(fields) };

    await expect(verifyChartSnapshot(withSnapshot(future), BIRTH)).rejects.toThrow(/schema/);
  });

  it("refuses an extra field even when the id was re-hashed to cover it", async () => {
    const fields = { ...fieldsOf(stamp), smuggled: "x" } as unknown as typeof stamp;
    const padded = { ...fields, snapshot_id: await computeSnapshotId(fields) };

    await expect(verifyChartSnapshot(withSnapshot(padded), BIRTH)).rejects.toThrow(
      /unexpected fields/,
    );
  });
});
