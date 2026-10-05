/**
 * The worker boundary check for a chart's snapshot.
 *
 * The engine stamps every chart with a `ChartSnapshot` and a `snapshot_id`
 * (SHA-256 of the canonical JSON of the other fields; see
 * `backend/src/almamesh/snapshot.py`). Before a computed chart enters the app,
 * this module re-derives the id and checks the stamp names the exact birth and
 * analysis instants the caller asked for. A chart that fails is refused, never
 * stored: an unverified identity is worse than none, because readings and chat
 * bind to it.
 */

import type { BirthInput } from "../types";
import type { ChartSnapshot, SiderealChart } from "./chart";

export const CHART_SNAPSHOT_SCHEMA = "1";

const FIELDS = [
  "birth_utc",
  "dasha_year_convention",
  "data_hash",
  "engine_version",
  "ephemeris_file",
  "house_system",
  "node_type",
  "ayanamsa",
  "reference_date",
  "snapshot_schema",
] as const;

type SnapshotFields = Omit<ChartSnapshot, "snapshot_id">;

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** A chart whose snapshot is missing, malformed, forged, or for another request. */
export class ChartSnapshotError extends Error {
  public constructor(message: string) {
    super(`chart snapshot: ${message}`);
    this.name = "ChartSnapshotError";
  }
}

/** Python's `json.dumps(sort_keys=True, separators=(",", ":"))` for string fields. */
function canonicalJson(fields: SnapshotFields): string {
  const sorted = Object.keys(fields)
    .sort()
    .map((key) => [key, fields[key as keyof SnapshotFields]]);
  return JSON.stringify(Object.fromEntries(sorted));
}

/** SHA-256 (lower-case hex) of the canonical form of the snapshot fields. */
export async function computeSnapshotId(fields: SnapshotFields): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(fields));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Exactly the eleven string fields, ASCII only (the id is hashed over ASCII). */
function parseShape(value: unknown): ChartSnapshot {
  if (!isRecord(value)) throw new ChartSnapshotError("missing");
  const expected = [...FIELDS, "snapshot_id"].sort();
  const actual = Object.keys(value).sort();
  if (actual.join(",") !== expected.join(",")) {
    throw new ChartSnapshotError(`unexpected fields [${actual.join(", ")}]`);
  }
  for (const key of actual) {
    const field = value[key];
    if (typeof field !== "string" || !/^[\x20-\x7e]*$/.test(field)) {
      throw new ChartSnapshotError(`field ${key} is not an ASCII string`);
    }
  }
  return value as unknown as ChartSnapshot;
}

/** Same instant, whatever the spelling ("+00:00" vs ".000Z"). */
function requireSameInstant(field: string, stamped: string, requested: string): void {
  const a = Date.parse(stamped);
  if (Number.isNaN(a) || a !== Date.parse(requested)) {
    throw new ChartSnapshotError(`${field} ${stamped} is not the requested ${requested}`);
  }
}

/** Parse a stored or computed snapshot: well-formed, known schema, id matches. */
export async function parseChartSnapshot(value: unknown): Promise<ChartSnapshot> {
  const snapshot = parseShape(value);
  if (snapshot.snapshot_schema !== CHART_SNAPSHOT_SCHEMA) {
    throw new ChartSnapshotError(`unknown schema ${snapshot.snapshot_schema}`);
  }
  if (!SHA256_HEX.test(snapshot.snapshot_id)) {
    throw new ChartSnapshotError("snapshot_id is not a SHA-256 hex digest");
  }
  const { snapshot_id: claimed, ...fields } = snapshot;
  if ((await computeSnapshotId(fields)) !== claimed) {
    throw new ChartSnapshotError("snapshot_id does not match its fields");
  }
  return snapshot;
}

/**
 * The boundary check for a freshly computed chart: a valid snapshot that names
 * the birth instant and the analysis instant this request asked for.
 */
export async function verifyChartSnapshot(
  chart: SiderealChart,
  birth: BirthInput,
): Promise<ChartSnapshot> {
  const snapshot = await parseChartSnapshot(chart.snapshot);
  requireSameInstant("birth_utc", snapshot.birth_utc, birth.datetimeUtc);
  requireSameInstant("reference_date", snapshot.reference_date, birth.referenceDate);
  return snapshot;
}
