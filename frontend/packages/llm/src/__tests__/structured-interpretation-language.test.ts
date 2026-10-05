import { describe, expect, it, vi } from "vitest";

import type { SiderealChart } from "@almamesh/browser/types";

import golden from "../../../../../backend/tests/fixtures/chart_golden_de421.json";
import { ProviderConfig } from "../config";
import {
  streamStructuredInterpretation,
  type InterpretationEvent,
  type InterpretationSectionKey,
} from "../structured-interpretation";

const goldenCharts = golden as Record<string, SiderealChart>;
const [firstKey] = Object.keys(goldenCharts);
const realChart: SiderealChart = goldenCharts[firstKey];

const LOCAL_CFG: ProviderConfig = {
  engine: "openai-http",
  model: "llama3.1",
  privacyMode: "local_only",
  baseUrl: "http://localhost:11434/v1",
};

const NOW = new Date("2030-01-01T00:00:00.000Z");

const SECTIONS: InterpretationSectionKey[] = [
  "core",
  "yoga",
  "guidance1",
  "guidance2",
  "remedial",
  "upcoming_periods",
  "current_sky",
];

function markerFor(body: string): InterpretationSectionKey {
  for (const key of SECTIONS) {
    if (body.includes(`SECTION:${key}`)) {
      return key;
    }
  }
  throw new Error(`no section marker in request body: ${body.slice(0, 200)}`);
}

const MINIMAL_SECTION_JSON: Record<InterpretationSectionKey, unknown> = {
  core: { summary: "ok", strengths: [], challenges: [], life_themes: [] },
  yoga: { integrated_yoga_narrative: { layman: "ok", technical: "ok" } },
  guidance1: {
    health_guidance: { layman: "ok", technical: "ok" },
    education_guidance: { layman: "ok", technical: "ok" },
    career_guidance: { layman: "ok", technical: "ok" },
    relationship_guidance: { layman: "ok", technical: "ok" },
  },
  guidance2: {
    finances_guidance: { layman: "ok", technical: "ok" },
    spiritual_guidance: { layman: "ok", technical: "ok" },
    life_evolution_guidance: { layman: "ok", technical: "ok" },
  },
  remedial: { remedial_measures: { layman: "ok", technical: "ok" } },
  upcoming_periods: {
    upcoming_periods: [{ title: "ok", layman: "ok", technical: "ok" }],
  },
  current_sky: {
    current_sky: [{ title: "ok", layman: "ok", technical: "ok" }],
  },
};

/** Capture every request body (system prompts) sent to the endpoint. */
function makeCapturingFetch(): { fetchImpl: typeof fetch; bodies: string[] } {
  const bodies: string[] = [];
  const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
    bodies.push(init.body as string);
    const section = markerFor(init.body as string);
    const body = JSON.stringify({
      choices: [{ message: { content: JSON.stringify(MINIMAL_SECTION_JSON[section]) } }],
    });
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, bodies };
}

async function collect(gen: AsyncGenerator<InterpretationEvent>): Promise<InterpretationEvent[]> {
  const out: InterpretationEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

/** Pull the system-role message content out of each captured chat-completion body. */
function systemPrompts(bodies: string[]): string[] {
  return bodies.map((b) => {
    const messages = JSON.parse(b).messages as { role: string; content: string }[];
    const system = messages.find((m) => m.role === "system");
    return system?.content ?? "";
  });
}

describe("streamStructuredInterpretation — language awareness", () => {
  it("injects a Spanish instruction into every section's system prompt for es", async () => {
    const { fetchImpl, bodies } = makeCapturingFetch();
    await collect(
      streamStructuredInterpretation({
        chart: realChart,
        config: LOCAL_CFG,
        asOf: { basis: "chart", instant: NOW },
        language: "es",
        fetchImpl,
      }),
    );
    const systems = systemPrompts(bodies);
    expect(systems).toHaveLength(7);
    for (const system of systems) {
      expect(system).toMatch(/Spanish/);
      expect(system).toMatch(/Español/);
      expect(system).toMatch(/entire response in Spanish/i);
    }
  });

  it("injects a Portuguese instruction into every section's system prompt for pt", async () => {
    const { fetchImpl, bodies } = makeCapturingFetch();
    await collect(
      streamStructuredInterpretation({
        chart: realChart,
        config: LOCAL_CFG,
        asOf: { basis: "chart", instant: NOW },
        language: "pt",
        fetchImpl,
      }),
    );
    for (const system of systemPrompts(bodies)) {
      expect(system).toMatch(/Portuguese/);
      expect(system).toMatch(/Português/);
      expect(system).toMatch(/entire response in Portuguese/i);
    }
  });

  it("is English-only when no language is given (default, back-compatible)", async () => {
    const { fetchImpl, bodies } = makeCapturingFetch();
    await collect(
      streamStructuredInterpretation({
        chart: realChart,
        config: LOCAL_CFG,
        asOf: { basis: "chart", instant: NOW },
        fetchImpl,
      }),
    );
    for (const system of systemPrompts(bodies)) {
      expect(system).not.toMatch(/Spanish|Español|Portuguese|Português/);
    }
  });
});
