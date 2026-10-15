// Northstar, PR #366: the readings had the reflection rule only in their prompts (structured
// interpretation) or nowhere at all (mesh). Every generator of user-facing prose now runs the
// same check as chat: a section whose text fails it is asked once more with the issues named, and
// a value that still fails is withheld in the reading's language. Live previews show only text the
// check has passed.
import { describe, expect, it, vi } from "vitest";

import type { SiderealChart } from "@almamesh/browser/types";

import golden from "../../../../../backend/tests/fixtures/chart_golden_de421.json";
import meshGolden from "../../../../../backend/tests/fixtures/mesh_golden_de421.json";
import type { ProviderConfig } from "../config";
import { streamCurrentTimeline, type CurrentTimelineEvent } from "../index";
import { streamMeshReading, type MeshReadingEvent, type MeshReadingSectionKey } from "../mesh-reading";
import type { MeshEdgeContext } from "../mesh-types";
import { READING_WITHHELD, REFLECTION_RULE } from "../reflection";

const chart = (golden as Record<string, SiderealChart>)[Object.keys(golden)[0]];
const config: ProviderConfig = {
  engine: "openai-http",
  model: "z-ai/glm-5.3-flash",
  privacyMode: "local_only",
  baseUrl: "http://localhost:11434/v1",
};

const FORETELLS = "You will get married in 2027.";
const CLEAN = "A season that highlights partnership and shared plans.";
const road = (layman: string) => JSON.stringify({ upcoming_periods: [{ title: "Jupiter period", layman, technical: "Jupiter MD." }] });
const SKY = JSON.stringify({ current_sky: [{ title: "Now", layman: "Work asks for patience.", technical: "Saturn" }] });

interface Body {
  readonly messages: readonly { readonly role: string; readonly content: string }[];
}

function sse(chunk: Record<string, unknown> | "[DONE]"): string {
  return `data: ${chunk === "[DONE]" ? chunk : JSON.stringify(chunk)}\n\n`;
}

function streamOf(text: string, every = 9): Response {
  const events = [];
  for (let at = 0; at < text.length; at += every) events.push(sse({ choices: [{ index: 0, delta: { content: text.slice(at, at + every) } }] }));
  return new Response(events.join("") + sse("[DONE]"), { headers: { "Content-Type": "text/event-stream" } });
}

const jsonOf = (content: string): Response => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content } }] }));

/** A provider whose road-ahead answers come in order (the last one repeats); the sky is clean. */
function timelineFetch(roadAnswers: readonly string[], streaming = false) {
  const roadBodies: Body[] = [];
  const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Body;
    const reply = (content: string) => (streaming ? streamOf(content) : jsonOf(content));
    if (!String(init.body).includes("SECTION:upcoming_periods")) return reply(SKY);
    const answer = roadAnswers[Math.min(roadBodies.length, roadAnswers.length - 1)] ?? "";
    roadBodies.push(body);
    return reply(answer);
  }) as unknown as typeof fetch;
  return { fetchImpl, roadBodies };
}

async function timeline(events: AsyncGenerator<CurrentTimelineEvent>) {
  const out: CurrentTimelineEvent[] = [];
  for await (const event of events) out.push(event);
  const complete = out.find((event) => event.type === "complete");
  if (complete?.type !== "complete") throw new Error("missing completion");
  return complete.timeline;
}

describe("structured interpretation sections", () => {
  it("ask once more, naming the issue, and keep the reworded text", async () => {
    const { fetchImpl, roadBodies } = timelineFetch([road(FORETELLS), road(CLEAN)]);
    const result = await timeline(streamCurrentTimeline({ chart, config, fetchImpl }));
    expect(roadBodies).toHaveLength(2);
    const retry = roadBodies[1]?.messages ?? [];
    expect(retry.at(-2)).toEqual({ role: "assistant", content: road(FORETELLS) });
    expect(retry.at(-1)?.content).toContain('"You will get"');
    expect(result.upcoming_periods[0]?.layman).toBe(CLEAN);
  });

  it("withhold a value that still fails, keeping the clean ones", async () => {
    const { fetchImpl, roadBodies } = timelineFetch([road(FORETELLS)]);
    const result = await timeline(streamCurrentTimeline({ chart, config, fetchImpl }));
    expect(roadBodies).toHaveLength(2);
    expect(result.upcoming_periods[0]).toMatchObject({ title: "Jupiter period", layman: READING_WITHHELD.en, technical: "Jupiter MD." });
  });

  it("withhold in the reading's language", async () => {
    const { fetchImpl } = timelineFetch([road(FORETELLS)]);
    const result = await timeline(streamCurrentTimeline({ chart, config, fetchImpl, language: "pt" }));
    expect(result.upcoming_periods[0]?.layman).toBe(READING_WITHHELD.pt);
  });

  it("make one request when the text passes", async () => {
    const { fetchImpl, roadBodies } = timelineFetch([road(CLEAN)]);
    await timeline(streamCurrentTimeline({ chart, config, fetchImpl }));
    expect(roadBodies).toHaveLength(1);
  });

  it("never preview a sentence the check fails", async () => {
    const { fetchImpl } = timelineFetch([road(`${CLEAN} ${FORETELLS} Work asks for patience.`), road(CLEAN)], true);
    const previews: string[] = [];
    await timeline(streamCurrentTimeline({ chart, config, fetchImpl, onSectionProgress: (_section, progress) => previews.push(progress.preview) }));
    expect(previews.some((preview) => preview.includes("shared plans"))).toBe(true);
    expect(previews.filter((preview) => preview.includes("married") || preview.includes("You will"))).toEqual([]);
  });
});

const SPOUSE = Object.values(meshGolden as unknown as Record<string, MeshEdgeContext>).find((edge) => edge.relationship === "spouse");
const MESH_CLEAN = { title: "Shared Seasons", layman: "The shared Venus chapter highlights the 7th house.", technical: "Venus antardasha for both." };

function meshFetch(timing: readonly unknown[]) {
  const bodies: Body[] = [];
  let timingCalls = 0;
  const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Body;
    bodies.push(body);
    const section = (["connection", "timing_together", "care"] as MeshReadingSectionKey[]).find((key) => String(init.body).includes(`SECTION:${key}`));
    if (section !== "timing_together") return jsonOf(JSON.stringify(MESH_CLEAN));
    const answer = timing[Math.min(timingCalls, timing.length - 1)];
    timingCalls += 1;
    return jsonOf(JSON.stringify(answer));
  }) as unknown as typeof fetch;
  return { fetchImpl, bodies, timingCalls: () => timingCalls };
}

async function meshReading(events: AsyncGenerator<MeshReadingEvent>) {
  for await (const event of events) if (event.type === "complete") return event.reading;
  throw new Error("missing completion");
}

describe("the mesh reading", () => {
  if (!SPOUSE) throw new Error("mesh golden carries no spouse edge");

  it("carries the reflection rule in its system prompt", async () => {
    const { fetchImpl, bodies } = meshFetch([MESH_CLEAN]);
    await meshReading(streamMeshReading({ edge: SPOUSE, config, fetchImpl }));
    for (const body of bodies) expect(body.messages.find((message) => message.role === "system")?.content).toContain(REFLECTION_RULE);
  });

  it("asks once more, then withholds a value that still foretells", async () => {
    const { fetchImpl, timingCalls } = meshFetch([{ ...MESH_CLEAN, layman: "Expect a wedding in 2027." }]);
    const reading = await meshReading(streamMeshReading({ edge: SPOUSE, config, fetchImpl, language: "es" }));
    expect(timingCalls()).toBe(2);
    expect(reading.timing_together).toEqual({ ...MESH_CLEAN, layman: READING_WITHHELD.es });
    expect(reading.connection).toEqual(MESH_CLEAN);
  });

  it("keeps a reworded retry", async () => {
    const { fetchImpl, timingCalls } = meshFetch([{ ...MESH_CLEAN, layman: "Vas a casarte en 2027." }, MESH_CLEAN]);
    const reading = await meshReading(streamMeshReading({ edge: SPOUSE, config, fetchImpl }));
    expect(timingCalls()).toBe(2);
    expect(reading.timing_together).toEqual(MESH_CLEAN);
  });
});
