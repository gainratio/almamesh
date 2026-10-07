import { describe, expect, it, vi } from "vitest";

import type { SiderealChart } from "@almamesh/browser/types";

import chartGolden from "../../../../../backend/tests/fixtures/chart_golden_de421.json";
import meshGolden from "../../../../../backend/tests/fixtures/mesh_golden_de421.json";
import type { ProviderConfig } from "../config";
import { streamChartChat } from "../index";
import { buildChatMessages } from "../prompt";
import { sanitizeMeshEdgeForLlm, type SanitizedMeshEdge } from "../mesh-sanitize";
import type { MeshEdgeContext, MeshRelationship } from "../mesh-types";
import type { SanitizedChart } from "../sanitize";

// The same minimal real-shape SanitizedChart the existing prompt tests use.
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
  },
  houses: {},
  yogas: [],
};

const edges = Object.values(meshGolden as unknown as Record<string, MeshEdgeContext>);

function sanitizedEdgeFor(relationship: MeshRelationship): SanitizedMeshEdge {
  const edge = edges.find((e) => e.relationship === relationship);
  if (!edge) {
    throw new Error(`mesh golden carries no ${relationship} edge`);
  }
  return sanitizeMeshEdgeForLlm(edge);
}

const SPOUSE_EDGE = sanitizedEdgeFor("spouse");

describe("buildChatMessages — mesh edge grounding (present)", () => {
  const msgs = buildChatMessages(
    CHART,
    "How do my chart and my spouse's interact?",
    "layman",
    [],
    [],
    undefined,
    "en",
    SPOUSE_EDGE,
  );
  const systemTurn = msgs[0].content ?? "";
  const userTurn = msgs[msgs.length - 1].content ?? "";

  it("injects the delimited mesh facts block into the latest user turn", () => {
    expect(userTurn).toContain("ENGINE RELATIONSHIP CONTEXT");
    expect(userTurn).toContain("- varna: 0/1 — groom Virgo (vaishya) x bride Leo (kshatriya)");
    expect(userTurn).toContain('Total: 21.5/36 — band "average" (classical convention)');
  });

  it("speaks of the other person by role, never by name", () => {
    expect(userTurn).toContain("your spouse");
  });

  it("adds the relationship-context exception and anti-scam fence to the system prompt", () => {
    expect(systemTurn).toContain("RELATIONSHIP CONTEXT EXCEPTION");
    expect(systemTurn).toContain("ANTI-SCAM RELATIONSHIP FENCE");
    expect(systemTurn).toMatch(/NEVER advise marrying, leaving/);
  });

  it("keeps the single-chart facts block alongside the mesh block", () => {
    expect(userTurn).toMatch(/capricorn/i);
    expect(userTurn).toMatch(/exalted/i);
  });
});

describe("buildChatMessages — mesh edge grounding (absent)", () => {
  it("is byte-identical with no edge vs an explicitly-undefined edge", () => {
    const without = buildChatMessages(CHART, "How is my year ahead?");
    const withUndefined = buildChatMessages(
      CHART,
      "How is my year ahead?",
      "layman",
      [],
      [],
      undefined,
      "en",
      undefined,
    );
    expect(JSON.stringify(withUndefined)).toBe(JSON.stringify(without));
  });

  it("carries no mesh markers, exception, or fence without an edge", () => {
    const msgs = buildChatMessages(CHART, "How is my year ahead?");
    const joined = msgs.map((m) => m.content ?? "").join("\n");
    expect(joined).not.toContain("ENGINE RELATIONSHIP CONTEXT");
    expect(joined).not.toContain("RELATIONSHIP CONTEXT EXCEPTION");
    expect(joined).not.toContain("ANTI-SCAM RELATIONSHIP FENCE");
  });
});

// --- streamChartChat: the convenience entry point takes the RAW engine edge
// and sanitizes it internally, so the pair privacy boundary cannot be skipped.

const goldenCharts = chartGolden as Record<string, SiderealChart>;
const [firstChartKey] = Object.keys(goldenCharts);
const realChart: SiderealChart = goldenCharts[firstChartKey];

const RAW_SPOUSE = ((): MeshEdgeContext => {
  const edge = edges.find((e) => e.relationship === "spouse");
  if (!edge) {
    throw new Error("mesh golden carries no spouse edge");
  }
  return edge;
})();

const LOCAL_CFG: ProviderConfig = {
  engine: "openai-http",
  model: "llama3.1",
  privacyMode: "local_only",
  baseUrl: "http://localhost:11434/v1",
};

const NOW = new Date("2030-01-01T00:00:00.000Z");

function sseAnswer(...tokens: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const t of tokens) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`),
        );
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

async function collect(gen: AsyncGenerator<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const token of gen) out.push(token);
  return out;
}

describe("streamChartChat — raw mesh edge threading", () => {
  it("sanitizes the raw edge and puts the mesh block + fence on the wire", async () => {
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(init.body as string);
      return sseAnswer("ok");
    });

    const tokens = await collect(
      streamChartChat({
        chart: realChart,
        question: "How do my chart and my spouse's interact?",
        config: LOCAL_CFG,
        meshEdge: RAW_SPOUSE,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        asOf: { basis: "chart", instant: NOW },
      }),
    );

    expect(tokens.join("")).toBe("ok");
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain("ENGINE RELATIONSHIP CONTEXT");
    expect(bodies[0]).toContain("varna: 0/1");
    expect(bodies[0]).toContain("ANTI-SCAM RELATIONSHIP FENCE");
    // The RAW edge carries absolute ISO datetimes; none may cross the wire.
    expect(bodies[0]).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });

  it("keeps the wire prompt mesh-free when no edge is passed", async () => {
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(init.body as string);
      return sseAnswer("ok");
    });

    await collect(
      streamChartChat({
        chart: realChart,
        question: "How is my year ahead?",
        config: LOCAL_CFG,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        asOf: { basis: "chart", instant: NOW },
      }),
    );

    expect(bodies[0]).not.toContain("ENGINE RELATIONSHIP CONTEXT");
    expect(bodies[0]).not.toContain("ANTI-SCAM RELATIONSHIP FENCE");
  });
});
