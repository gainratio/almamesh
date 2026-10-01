import { describe, expect, it, vi } from "vitest";

import type { SiderealChart } from "@almamesh/browser/types";

import golden from "../../../../../backend/tests/fixtures/chart_golden_de421.json";
import type { ProviderConfig } from "../config";
import {
  streamCurrentTimeline,
  type CurrentTimelineEvent,
  type SectionProgressSnapshot,
} from "../index";

// "The road ahead" took 3-14 minutes on z-ai/glm-5.3-flash with nothing on
// screen. With a progress listener the timeline sections stream: the caller
// sees the prose as it is written, and the final JSON is still validated (an
// invalid final document is the #192 provider-failure code + one retry).

const chart = (golden as Record<string, SiderealChart>)[Object.keys(golden)[0]];
const config: ProviderConfig = {
  engine: "openai-http",
  model: "z-ai/glm-5.3-flash",
  privacyMode: "local_only",
  baseUrl: "http://localhost:11434/v1",
};

const ROAD = JSON.stringify({
  upcoming_periods: [{ title: "Jupiter period", layman: "A season of growth.", technical: "Jupiter MD." }],
});
const SKY = JSON.stringify({ current_sky: [{ title: "Now", layman: "Active", technical: "Saturn" }] });

function sse(chunk: Record<string, unknown> | "[DONE]"): string {
  return `data: ${chunk === "[DONE]" ? chunk : JSON.stringify(chunk)}\n\n`;
}

function streamOf(text: string, every = 9): Response {
  const events = [];
  for (let at = 0; at < text.length; at += every) {
    events.push(sse({ choices: [{ index: 0, delta: { content: text.slice(at, at + every) } }] }));
  }
  return new Response(events.join("") + sse("[DONE]"), { headers: { "Content-Type": "text/event-stream" } });
}

function isRoad(init: RequestInit): boolean {
  return String(init.body).includes("SECTION:upcoming_periods");
}

function timelineFetch(roadAnswers: ReadonlyArray<() => Response>) {
  const bodies: Array<Record<string, unknown>> = [];
  let roadCalls = 0;
  const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    if (!isRoad(init)) return streamOf(SKY);
    const answer = roadAnswers[Math.min(roadCalls, roadAnswers.length - 1)];
    roadCalls += 1;
    return answer();
  }) as unknown as typeof fetch;
  return { fetchImpl, bodies, roadCalls: () => roadCalls };
}

async function collect(events: AsyncGenerator<CurrentTimelineEvent>): Promise<CurrentTimelineEvent[]> {
  const out: CurrentTimelineEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

type Seen = Array<{ section: string } & SectionProgressSnapshot>;

describe("streamed timeline sections", () => {
  it("requests stream:true for both timeline sections when progress is wanted", async () => {
    const { fetchImpl, bodies } = timelineFetch([() => streamOf(ROAD)]);
    await collect(streamCurrentTimeline({ chart, config, fetchImpl, onSectionProgress: () => undefined }));
    expect(bodies).toHaveLength(2);
    for (const body of bodies) expect(body).toMatchObject({ stream: true, response_format: { type: "json_object" } });
  });

  it("reports the growing prose and word count of the road ahead before it completes", async () => {
    const { fetchImpl } = timelineFetch([() => streamOf(ROAD)]);
    const seen: Seen = [];
    const events = await collect(
      streamCurrentTimeline({
        chart,
        config,
        fetchImpl,
        onSectionProgress: (section, progress) => seen.push({ section, ...progress }),
      }),
    );
    const road = seen.filter((p) => p.section === "upcoming_periods");
    expect(road.length).toBeGreaterThan(3);
    expect(road.map((p) => p.words)).toEqual([...road.map((p) => p.words)].sort((a, b) => a - b));
    expect(road.at(-1)).toMatchObject({ words: 8, preview: "Jupiter period\nA season of growth.\nJupiter MD." });
    expect(road.some((p) => p.preview.startsWith("Jupi") && p.words < 8)).toBe(true);
    for (const p of road) expect(p.preview).not.toMatch(/[{}"]|upcoming_periods/);
    const complete = events.find((e) => e.type === "complete");
    if (complete?.type !== "complete") throw new Error("missing completion");
    expect(complete.timeline.upcoming_periods[0]?.title).toBe("Jupiter period");
  });

  it("reports reasoning-model thinking as progress before any prose arrives", async () => {
    const thinking = () =>
      new Response(
        sse({ choices: [{ delta: { reasoning: "Weighing the Jupiter dasha" } }] }) +
          sse({ choices: [{ delta: { content: ROAD } }] }) +
          sse("[DONE]"),
      );
    const { fetchImpl } = timelineFetch([thinking]);
    const seen: Seen = [];
    await collect(
      streamCurrentTimeline({
        chart,
        config,
        fetchImpl,
        onSectionProgress: (section, progress) => seen.push({ section, ...progress }),
      }),
    );
    const road = seen.filter((p) => p.section === "upcoming_periods");
    expect(road[0]).toEqual({ section: "upcoming_periods", words: 0, preview: "", thinkingWords: 4 });
    expect(road.at(-1)).toMatchObject({ words: 8, thinkingWords: 4 });
  });

  it("retries once when the stream ends on invalid JSON, then completes", async () => {
    const { fetchImpl, roadCalls } = timelineFetch([() => streamOf(ROAD.slice(0, 40)), () => streamOf(ROAD)]);
    const events = await collect(streamCurrentTimeline({ chart, config, fetchImpl, onSectionProgress: () => undefined }));
    expect(roadCalls()).toBe(2);
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("reports the #192 provider-failure status when the retry also ends on invalid JSON", async () => {
    const { fetchImpl, roadCalls } = timelineFetch([() => streamOf(ROAD.slice(0, 40))]);
    const events = await collect(streamCurrentTimeline({ chart, config, fetchImpl, onSectionProgress: () => undefined }));
    expect(roadCalls()).toBe(2);
    expect(events).toContainEqual(expect.objectContaining({ type: "error", section: "upcoming_periods", status: 502 }));
  });

  it("maps a mid-stream finish_reason error to the same 502 and retries it", async () => {
    const dropped = () =>
      new Response(sse({ choices: [{ delta: { content: '{"upcoming' } }] }) + sse({ choices: [{ delta: {}, finish_reason: "error" }] }));
    const { fetchImpl, roadCalls } = timelineFetch([dropped, dropped]);
    const events = await collect(streamCurrentTimeline({ chart, config, fetchImpl, onSectionProgress: () => undefined }));
    expect(roadCalls()).toBe(2);
    expect(events).toContainEqual(expect.objectContaining({ type: "error", section: "upcoming_periods", status: 502 }));
  });

  it("does not stream without a progress listener (natal path unchanged)", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      const content = isRoad(init) ? ROAD : SKY;
      return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content } }] }));
    }) as unknown as typeof fetch;
    await collect(streamCurrentTimeline({ chart, config, fetchImpl }));
    for (const body of bodies) expect(body.stream).toBe(false);
  });

  it("aborts mid-stream without a retry", async () => {
    const controller = new AbortController();
    const { fetchImpl, roadCalls } = timelineFetch([() => streamOf(ROAD, 3)]);
    await expect(
      collect(
        streamCurrentTimeline({
          chart,
          config,
          fetchImpl,
          signal: controller.signal,
          onSectionProgress: (section) => {
            if (section === "upcoming_periods") controller.abort();
          },
        }),
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(roadCalls()).toBe(1);
  });
});
