import { describe, expect, it, vi } from "vitest";

import type { SiderealChart } from "@almamesh/browser/types";

import golden from "../../../../../backend/tests/fixtures/chart_golden_de421.json";
import type { ProviderConfig } from "../config";
import { streamCurrentTimeline, type CurrentTimelineEvent } from "../index";

// Regression: "Some timeline sections could not be generated: The road ahead".
// The road-ahead call is the longest single completion in the app (minutes,
// 15-29k tokens on z-ai/glm-5.3-flash). Upstream providers drop a share of
// those mid-generation; one transient failure used to sink the section for
// good. A section now gets one retry on a transient failure, and a final
// failure carries its HTTP status so the UI can show a specific code.

const chart = (golden as Record<string, SiderealChart>)[Object.keys(golden)[0]];
const config: ProviderConfig = {
  engine: "openai-http",
  model: "z-ai/glm-5.3-flash",
  privacyMode: "local_only",
  baseUrl: "http://localhost:11434/v1",
};

const ok = {
  upcoming_periods: { upcoming_periods: [{ title: "Next", layman: "Soon", technical: "Sun antar" }] },
  current_sky: { current_sky: [{ title: "Now", layman: "Active", technical: "Saturn maha" }] },
} as const;
type Key = keyof typeof ok;

function sectionOf(init: RequestInit): Key {
  return String(init.body).includes("SECTION:upcoming_periods") ? "upcoming_periods" : "current_sky";
}

function okResponse(section: Key): Response {
  return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(ok[section]) } }] }));
}

const inBandError = (): Response =>
  new Response(JSON.stringify({ choices: [{ finish_reason: "error", message: { content: "" } }] }));

/** Fetch whose road-ahead call answers with `failures` in order, then succeeds. */
function roadAheadFetch(failures: ReadonlyArray<() => Response | Promise<Response>>) {
  let roadCalls = 0;
  const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
    const section = sectionOf(init);
    if (section !== "upcoming_periods") return okResponse(section);
    const failure = failures[roadCalls];
    roadCalls += 1;
    return failure ? failure() : okResponse(section);
  }) as unknown as typeof fetch;
  return { fetchImpl, roadCalls: () => roadCalls };
}

async function collect(events: AsyncGenerator<CurrentTimelineEvent>): Promise<CurrentTimelineEvent[]> {
  const out: CurrentTimelineEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe("timeline section retry on transient provider failure", () => {
  it("retries the road ahead once after an in-band provider error and completes it", async () => {
    const { fetchImpl, roadCalls } = roadAheadFetch([inBandError]);
    const events = await collect(streamCurrentTimeline({ chart, config, fetchImpl }));

    expect(roadCalls()).toBe(2);
    expect(events.some((e) => e.type === "error")).toBe(false);
    const complete = events.find((e) => e.type === "complete");
    if (complete?.type !== "complete") throw new Error("missing completion");
    expect(complete.timeline.upcoming_periods[0]?.title).toBe("Next");
  });

  it.each([
    ["HTTP 503", () => new Response("unavailable", { status: 503 })],
    ["HTTP 429", () => new Response("slow down", { status: 429 })],
    ["a dropped connection", () => Promise.reject(new TypeError("Failed to fetch"))],
  ])("retries after %s", async (_label, failure) => {
    const { fetchImpl, roadCalls } = roadAheadFetch([failure]);
    const events = await collect(streamCurrentTimeline({ chart, config, fetchImpl }));
    expect(roadCalls()).toBe(2);
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("does not retry a non-transient failure such as a rejected key", async () => {
    const { fetchImpl, roadCalls } = roadAheadFetch([() => new Response("bad key", { status: 401 })]);
    const events = await collect(streamCurrentTimeline({ chart, config, fetchImpl }));
    expect(roadCalls()).toBe(1);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "error", section: "upcoming_periods", status: 401 }),
    );
  });

  it("reports the final status when the retry also fails", async () => {
    const { fetchImpl, roadCalls } = roadAheadFetch([inBandError, inBandError]);
    const events = await collect(streamCurrentTimeline({ chart, config, fetchImpl }));
    expect(roadCalls()).toBe(2);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "error", section: "upcoming_periods", status: 502 }),
    );
  });

  it("does not retry after the caller aborts", async () => {
    const controller = new AbortController();
    const { fetchImpl, roadCalls } = roadAheadFetch([
      () => {
        controller.abort();
        return Promise.reject(new TypeError("Failed to fetch"));
      },
    ]);
    await expect(
      collect(streamCurrentTimeline({ chart, config, fetchImpl, signal: controller.signal })),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(roadCalls()).toBe(1);
  });
});
