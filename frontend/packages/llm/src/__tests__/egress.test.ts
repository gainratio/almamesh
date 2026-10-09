import { describe, expect, it, vi } from "vitest";

import type { SiderealChart } from "@almamesh/browser/types";

import golden from "../../../../../backend/tests/fixtures/chart_golden_de421.json";
import { streamChartInterpretation } from "../index";
import type { ProviderConfig } from "../config";
import { buildChatMessages } from "../prompt";
import { periodAnalysisInstant, sanitizeChartForLlm } from "../sanitize";
import { BIRTH_2000_DASHAS } from "./birth-2000-fixture";

// End-to-end egress proof: a REAL engine chart routed through the public
// `streamChartInterpretation` entry point must produce a request body that
// contains none of the birth-identifying leak vectors. This is the phase's
// highest-value guarantee — it exercises sanitize -> prompt -> client together.

const goldenCharts = golden as Record<string, SiderealChart>;
const [firstKey] = Object.keys(goldenCharts);
const realChart: SiderealChart = goldenCharts[firstKey];

const LOCAL_CFG: ProviderConfig = {
  engine: "openai-http",
  model: "llama3.1",
  privacyMode: "local_only",
  baseUrl: "http://localhost:11434/v1",
};

async function drain(gen: AsyncGenerator<string>): Promise<void> {
  for await (const _ of gen) {
    // consume
  }
}

describe("egress — only sanitized, identifier-free data leaves the device", () => {
  it("never puts chart_id, timestamps, or absolute ISO dates in the request", async () => {
    let body = "";
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      body = init.body as string;
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'),
          );
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    });

    await drain(
      streamChartInterpretation({
        chart: realChart,
        config: LOCAL_CFG,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        asOf: { basis: "chart", instant: new Date("2030-01-01T00:00:00.000Z") },
      }),
    );

    expect(body).not.toMatch(/chart_id/);
    expect(body).not.toMatch(/generated_at/);
    expect(body).not.toMatch(/calculation_timestamp/);
    // No absolute ISO calendar timestamps (birth-derived dasha dates relativized).
    expect(body).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);

    // Sanity: the astrology DID survive into the prompt (it is not empty).
    expect(body).toMatch(/Vedic Astrolog/i);
    expect(body).toMatch(/planets/);
  });
});

describe("egress — a period early in life never reveals the birth month", () => {
  it("keeps 2000-03 out of the prompt for a 2000-03-15 birth asked about June 2000", () => {
    const chart = { ...realChart, dashas: BIRTH_2000_DASHAS };
    const sanitized = sanitizeChartForLlm(chart, periodAnalysisInstant("2000-06-01", "2000-06-30"));
    const prompt = JSON.stringify(buildChatMessages(sanitized, "What was June 2000 like?"));
    expect(prompt).not.toContain("2000-03");
  });

  // Real engine output: this native is in their first (birth) maha. Its start is
  // the birth instant and must read "birth", never 2019-11. Under a period basis
  // the facts block omits the current rows (they describe today), so the
  // positive control is the sanitized chart itself, not the rendered line.
  it("keeps 2019-11 out of the chat prompt for the real 2019-11-09 native asked about June 2020", () => {
    const native = goldenCharts["2019-11-09T17:45:00+00:00"]!;
    const sanitized = sanitizeChartForLlm(native, periodAnalysisInstant("2020-06-01", "2020-06-30"));
    const prompt = JSON.stringify(buildChatMessages(sanitized, "What was June 2020 like?"));
    expect(sanitized.dashas?.current_maha?.start_month).toBe("birth");
    expect(prompt).not.toContain("Mahadasha: mercury");
    expect(prompt).not.toContain("2019-11");
  });
});
