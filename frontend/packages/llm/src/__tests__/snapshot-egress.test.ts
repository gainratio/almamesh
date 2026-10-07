/**
 * The chart snapshot never crosses the privacy boundary.
 *
 * Every chart now carries a `snapshot` block (birth_utc, the analysis instant,
 * engine/data hashes, snapshot_id). The sanitizer is an allowlist rebuild, so
 * none of it may reach a provider. The ONLY new prompt content from the
 * one-analysis-instant change is the derived `as_of` calendar date of the
 * chart's analysis instant (never a timestamp, never birth data).
 *
 * This drives the three public entry points with a seeded chart and inspects
 * the exact request bodies that would leave the device.
 */
import { describe, expect, it, vi } from "vitest";

import type { SiderealChart } from "@almamesh/browser/types";
import golden from "../../../../../backend/tests/fixtures/chart_golden_de421.json";
import { streamChartChat, streamChartInterpretation } from "../index";
import { streamNatalInterpretation } from "../structured-interpretation";
import type { ProviderConfig } from "../config";

const BIRTH_KEY = "1988-08-08T01:14:00+00:00";
const stamped = (golden as Record<string, SiderealChart>)[BIRTH_KEY]!;
const stamp = stamped.snapshot!;

// A seeded chart as a careless caller might hand it over: the stamp plus
// identifiers layered on top. None of this may leave the device.
const seeded = {
  ...stamped,
  name: "Asha Seeded",
  location_name: "Bengaluru, Karnataka",
  latitude: 12.9716,
  longitude: 77.5946,
  birth_datetime_utc: BIRTH_KEY,
} as unknown as SiderealChart;

const FORBIDDEN: ReadonlyArray<readonly [string, string]> = [
  // Request bodies are JSON, so a prompt's own JSON key arrives as \"snapshot\":
  ["snapshot key", 'snapshot\\":'],
  ["snapshot_id key", "snapshot_id"],
  ["snapshot_id value", stamp.snapshot_id],
  ["data_hash value", stamp.data_hash],
  ["birth_utc key", "birth_utc"],
  ["birth instant", "1988-08-08T01:14"],
  ["birth date", "1988-08-08"],
  ["analysis timestamp", "2025-01-01T00:00"],
  ["reference_date key", "reference_date"],
  ["engine_version key", "engine_version"],
  ["latitude", "12.9716"],
  ["longitude", "77.5946"],
  ["name", "Asha Seeded"],
  ["place", "Bengaluru"],
];

const CFG: ProviderConfig = {
  engine: "openai-http",
  model: "llama3.1",
  privacyMode: "local_only",
  baseUrl: "http://localhost:11434/v1",
};

function capturingFetch(bodies: string[]): typeof fetch {
  return vi.fn(async (_url: string, init: RequestInit) => {
    bodies.push(init.body as string);
    const data = 'data: {"choices":[{"delta":{"content":"{}"}}]}\n\ndata: [DONE]\n\n';
    return new Response(new TextEncoder().encode(data), { status: 200 });
  }) as unknown as typeof fetch;
}

async function drain(gen: AsyncGenerator<unknown>): Promise<void> {
  try {
    for await (const _ of gen) {
      // consume
    }
  } catch {
    // A stub reply may fail section parsing; only the outbound bodies matter.
  }
}

async function outboundBodies(): Promise<string> {
  const bodies: string[] = [];
  const fetchImpl = capturingFetch(bodies);
  await drain(streamChartInterpretation({ chart: seeded, config: CFG, fetchImpl }));
  await drain(
    streamChartChat({ chart: seeded, question: "What period am I in?", config: CFG, fetchImpl }),
  );
  await drain(streamNatalInterpretation({ chart: seeded, config: CFG, fetchImpl }));
  return bodies.join("\n");
}

describe("snapshot egress — the stamp stays on the device", () => {
  it.each(FORBIDDEN)("no prompt carries the %s", async (_label, needle) => {
    const body = await outboundBodies();

    expect(body.length).toBeGreaterThan(1000);
    expect(body).not.toContain(needle);
  });

  it("carries only the derived as-of calendar date, never a timestamp", async () => {
    const body = await outboundBodies();

    expect(body).toMatch(/as of \d{4}-\d{2}-\d{2}, the chart's analysis date/);
    expect(body).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });
});
