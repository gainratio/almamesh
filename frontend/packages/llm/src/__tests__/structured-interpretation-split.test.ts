import { describe, expect, it, vi } from "vitest";

import type { SiderealChart } from "@almamesh/browser/types";

import golden from "../../../../../backend/tests/fixtures/chart_golden_de421.json";
import type { ProviderConfig } from "../config";
import { TRANSIT_CTX_FIXTURE } from "./predictive-fixture";
import {
  CURRENT_TIMELINE_SECTIONS,
  NATAL_SECTIONS,
  streamCurrentTimeline,
  streamNatalInterpretation,
  type CurrentTimelineEvent,
  type InterpretationSectionKey,
  type NatalInterpretation,
  type NatalInterpretationEvent,
} from "../index";

const charts = golden as Record<string, SiderealChart>;
const chart = charts[Object.keys(charts)[0]];
const config: ProviderConfig = {
  engine: "openai-http",
  model: "llama3.1",
  privacyMode: "local_only",
  baseUrl: "http://localhost:11434/v1",
};

const payloads: Record<InterpretationSectionKey, unknown> = {
  core: { summary: "Natal summary", strengths: [], challenges: [], life_themes: [] },
  yoga: { integrated_yoga_narrative: { layman: "Yoga", technical: "Yoga" } },
  guidance1: {},
  guidance2: {},
  remedial: { remedial_measures: { layman: "Rest", technical: "Rest" } },
  upcoming_periods: {
    upcoming_periods: [{ title: "Next", layman: "Soon", technical: "Sun antar" }],
  },
  current_sky: {
    current_sky: [{ title: "Now", layman: "Active", technical: "Saturn maha" }],
  },
};

function sectionFrom(body: string): InterpretationSectionKey {
  const section = Object.keys(payloads).find((key) => body.includes(`SECTION:${key}`));
  if (section === undefined) throw new Error("missing section marker");
  return section as InterpretationSectionKey;
}

function response(section: InterpretationSectionKey): Response {
  const body = JSON.stringify({ choices: [{ message: { content: JSON.stringify(payloads[section]) } }] });
  return new Response(body, { headers: { "Content-Type": "application/json" } });
}

function immediateFetch(seen: InterpretationSectionKey[]): typeof fetch {
  return vi.fn(async (_url: string, init: RequestInit) => {
    const section = sectionFrom(String(init.body));
    seen.push(section);
    return response(section);
  }) as unknown as typeof fetch;
}

async function collect<Event>(events: AsyncGenerator<Event>): Promise<Event[]> {
  const collected: Event[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

const invalidTimelineItems: readonly [string, unknown][] = [
  ["null item", null],
  ["non-object item", "A future chapter"],
  ["missing fields", {}],
  ["missing title", { layman: "A season of growth.", technical: "Sun antar." }],
  ["blank title", { title: " \n", layman: "A season of growth.", technical: "Sun antar." }],
  ["missing layman voice", { title: "Next", technical: "Sun antar." }],
  ["blank layman voice", { title: "Next", layman: " \n", technical: "Sun antar." }],
  ["missing technical voice", { title: "Next", layman: "A season of growth." }],
  ["blank technical voice", { title: "Next", layman: "A season of growth.", technical: " \n" }],
  ["non-string voice", { title: "Next", layman: 42, technical: "Sun antar." }],
  ["layman voice removed by jargon guard", { title: "Next", layman: "Saturn rules this house.", technical: "Sun antar." }],
];

async function timelineWithResponse(
  section: "upcoming_periods" | "current_sky",
  payload: unknown,
  input: SiderealChart = { ...chart, transit_context: TRANSIT_CTX_FIXTURE },
): Promise<{ events: CurrentTimelineEvent[]; seen: InterpretationSectionKey[] }> {
  const seen: InterpretationSectionKey[] = [];
  const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
    const requested = sectionFrom(String(init.body));
    seen.push(requested);
    if (requested !== section) return response(requested);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }), {
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { events: await collect(streamCurrentTimeline({ chart: input, config, fetchImpl })), seen };
}

describe.each(["upcoming_periods", "current_sky"] as const)("%s required output", (section) => {
  const invalidResponses: readonly [string, unknown][] = [
    ["missing section key", {}],
    ["null section", { [section]: null }],
    ["non-array section", { [section]: "A future chapter" }],
    ...invalidTimelineItems.map(([label, item]): [string, unknown] => [label, { [section]: [item] }]),
    ["one malformed item among valid items", { [section]: [
      { title: "Next", layman: "A season of growth.", technical: "Sun antar." },
      { title: "Later", technical: "Moon antar." },
    ] }],
  ];

  it.each(invalidResponses)("reports %s as a section failure instead of a successful hidden section", async (_label, payload) => {
    const { events, seen } = await timelineWithResponse(section, payload);
    expect(events).toContainEqual(expect.objectContaining({ type: "error", section }));
    expect(events).not.toContainEqual({ type: "section_complete", section });
    const complete = events.find((event) => event.type === "complete");
    if (complete?.type !== "complete") throw new Error("missing surviving timeline section");
    expect(complete.timeline[section]).toEqual([]);
    const other = section === "upcoming_periods" ? "current_sky" : "upcoming_periods";
    expect(complete.timeline[other]).toHaveLength(1);
    expect(seen).toHaveLength(2);
  });

  it("rejects an empty array when the engine supplied facts for the requested section", async () => {
    const { events } = await timelineWithResponse(section, { [section]: [] });
    expect(events).toContainEqual(expect.objectContaining({ type: "error", section }));
    expect(events).not.toContainEqual({ type: "section_complete", section });
  });
});

describe("timeline sections with no eligible engine facts", () => {
  it("accepts an empty current-sky section when the predictive context is absent", async () => {
    const { events } = await timelineWithResponse("current_sky", { current_sky: [] }, chart);
    expect(events).toContainEqual({ type: "section_complete", section: "current_sky" });
    expect(events).not.toContainEqual(expect.objectContaining({ type: "error", section: "current_sky" }));
  });

  it("accepts an empty upcoming-periods section when timing data is absent", async () => {
    const { dashas: _dashas, ...withoutTiming } = chart;
    const { events } = await timelineWithResponse("upcoming_periods", { upcoming_periods: [] }, withoutTiming);
    expect(events).toContainEqual({ type: "section_complete", section: "upcoming_periods" });
    expect(events).not.toContainEqual(expect.objectContaining({ type: "error", section: "upcoming_periods" }));
  });

  it("accepts an empty upcoming-periods section at the final engine maha and antar", async () => {
    if (!chart.dashas?.current_maha) throw new Error("fixture needs a current maha");
    const rows = chart.dashas.maha_dasha_sequence;
    const currentIndex = rows.findIndex((row) => row.lord === chart.dashas?.current_maha?.lord);
    const current = rows[currentIndex];
    const lastAntar = current.antar_sequence?.at(-1);
    if (!lastAntar) throw new Error("fixture needs a dated antar tree");
    const finalWindowChart: SiderealChart = {
      ...chart,
      dashas: {
        ...chart.dashas,
        maha_dasha_sequence: rows.slice(0, currentIndex + 1),
        current_antar: lastAntar,
        current_pratyantar: null,
        pratyantar_sequence: null,
      },
    };
    const { events } = await timelineWithResponse("upcoming_periods", { upcoming_periods: [] }, finalWindowChart);
    expect(events).toContainEqual({ type: "section_complete", section: "upcoming_periods" });
    expect(events).not.toContainEqual(expect.objectContaining({ type: "error", section: "upcoming_periods" }));
  });
});

describe("legacy upcoming windows without a dated antar tree", () => {
  it.each([
    ["omitted", undefined],
    ["empty", []],
  ] as const)("rejects empty upcoming output when the current antar tree is %s and future maha rows exist", async (_label, antarSequence) => {
    const dashas = chart.dashas;
    if (!dashas?.current_maha) throw new Error("fixture needs a current maha");
    const currentLord = dashas.current_maha.lord;
    const legacyChart: SiderealChart = {
      ...chart,
      dashas: {
        ...dashas,
        maha_dasha_sequence: dashas.maha_dasha_sequence.map((row) => ({
          ...row,
          antar_sequence: row.lord === currentLord ? antarSequence : undefined,
        })),
      },
    };
    const { events } = await timelineWithResponse("upcoming_periods", { upcoming_periods: [] }, legacyChart);
    expect(events).toContainEqual(expect.objectContaining({ type: "error", section: "upcoming_periods" }));
    expect(events).not.toContainEqual({ type: "section_complete", section: "upcoming_periods" });
  });
});

describe("explicit structured interpretation generators", () => {
  it("runs only the five natal sections and returns no timeline fields", async () => {
    const seen: InterpretationSectionKey[] = [];
    const requestBodies: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = String(init.body);
      requestBodies.push(body);
      const section = sectionFrom(body);
      seen.push(section);
      return response(section);
    }) as unknown as typeof fetch;
    const events = await collect<NatalInterpretationEvent>(
      streamNatalInterpretation({ chart, config, fetchImpl }),
    );

    expect(NATAL_SECTIONS).toEqual(["core", "yoga", "guidance1", "guidance2", "remedial"]);
    expect(seen).toEqual(expect.arrayContaining([...NATAL_SECTIONS]));
    expect(seen).toHaveLength(NATAL_SECTIONS.length);
    const complete = events.find((event) => event.type === "complete");
    expect(complete?.type).toBe("complete");
    if (complete?.type !== "complete") throw new Error("missing natal completion");
    expect(complete.interpretation).not.toHaveProperty("upcoming_periods");
    expect(complete.interpretation).not.toHaveProperty("current_sky");
    expect(complete.interpretation).not.toHaveProperty("current_period_guidance");
    for (const body of requestBodies) {
      expect(body).not.toContain('"dashas"');
      expect(body).not.toMatch(/CURRENT chapter|NEXT period\b|months_remaining|start_month/i);
    }
  });

  it("runs only the two timeline sections and returns narrow timeline content", async () => {
    const seen: InterpretationSectionKey[] = [];
    const events = await collect<CurrentTimelineEvent>(
      streamCurrentTimeline({ chart, config, fetchImpl: immediateFetch(seen) }),
    );

    expect(CURRENT_TIMELINE_SECTIONS).toEqual(["upcoming_periods", "current_sky"]);
    expect(seen).toEqual(expect.arrayContaining([...CURRENT_TIMELINE_SECTIONS]));
    expect(seen).toHaveLength(CURRENT_TIMELINE_SECTIONS.length);
    const complete = events.find((event) => event.type === "complete");
    expect(complete?.type).toBe("complete");
    if (complete?.type !== "complete") throw new Error("missing timeline completion");
    expect(Object.keys(complete.timeline).sort()).toEqual(["current_sky", "upcoming_periods"]);
    expect(complete.timeline.upcoming_periods[0]?.title).toBe("Next");
    expect(complete.timeline.current_sky[0]?.title).toBe("Now");
  });

  it("emits completion progress as each timeline request settles", async () => {
    let releaseUpcoming: (() => void) | undefined;
    const upcomingBlocked = new Promise<void>((resolve) => {
      releaseUpcoming = resolve;
    });
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const section = sectionFrom(String(init.body));
      if (section === "upcoming_periods") await upcomingBlocked;
      return response(section);
    }) as unknown as typeof fetch;
    const events = streamCurrentTimeline({ chart, config, fetchImpl });

    await expect(events.next()).resolves.toMatchObject({ value: { type: "section_start", section: "upcoming_periods" } });
    await expect(events.next()).resolves.toMatchObject({ value: { type: "section_start", section: "current_sky" } });
    await expect(events.next()).resolves.toMatchObject({ value: { type: "section_complete", section: "current_sky" } });
    releaseUpcoming?.();
    await expect(events.next()).resolves.toMatchObject({ value: { type: "section_complete", section: "upcoming_periods" } });
    await expect(events.next()).resolves.toMatchObject({ value: { type: "complete" } });
  });

  it("reports one timeline error and completes with the successful section", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const section = sectionFrom(String(init.body));
      if (section === "upcoming_periods") {
        return new Response("unavailable", { status: 503 });
      }
      return response(section);
    }) as unknown as typeof fetch;

    const events = await collect<CurrentTimelineEvent>(
      streamCurrentTimeline({ chart, config, fetchImpl }),
    );

    expect(events).toContainEqual(
      expect.objectContaining({ type: "error", section: "upcoming_periods" }),
    );
    const complete = events.find((event) => event.type === "complete");
    if (complete?.type !== "complete") throw new Error("missing timeline completion");
    expect(complete.timeline.upcoming_periods).toEqual([]);
    expect(complete.timeline.current_sky[0]?.title).toBe("Now");
  });

  it.each([streamNatalInterpretation, streamCurrentTimeline])(
    "honors an already-aborted signal without egress",
    async (stream) => {
      const controller = new AbortController();
      controller.abort();
      const fetchImpl = vi.fn() as unknown as typeof fetch;

      await expect(
        collect(stream({ chart, config, signal: controller.signal, fetchImpl }) as AsyncGenerator<unknown>),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );
});

async function natalComplete(): Promise<NatalInterpretation | undefined> {
  const fetchImpl = vi.fn(async (_url: string, init: RequestInit) =>
    response(sectionFrom(String(init.body))),
  ) as unknown as typeof fetch;
  const events = await collect<NatalInterpretationEvent>(
    streamNatalInterpretation({ chart, config, fetchImpl }),
  );
  const complete = events.find((e) => e.type === "complete");
  return complete?.type === "complete" ? complete.interpretation : undefined;
}

describe("family_guidance (natal, optional)", () => {
  it("is kept when guidance1 returns it", async () => {
    payloads.guidance1 = {
      family_guidance: { layman: "Home is your anchor.", technical: "4th lord Moon own sign." },
    };
    try {
      const interpretation = await natalComplete();
      expect(interpretation).toBeDefined();
      expect(interpretation?.family_guidance).toEqual({
        layman: "Home is your anchor.",
        technical: "4th lord Moon own sign.",
      });
    } finally {
      payloads.guidance1 = {};
    }
  });

  it("is absent (not null) when the reply has none, so old readings and legacy prompts are unchanged", async () => {
    const interpretation = await natalComplete();
    expect(interpretation).toBeDefined();
    expect("family_guidance" in (interpretation ?? {})).toBe(false);
  });
});
