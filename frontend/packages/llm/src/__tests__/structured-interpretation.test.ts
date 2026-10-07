import { describe, expect, it, vi } from "vitest";

import type { SiderealChart } from "@almamesh/browser/types";

import golden from "../../../../../backend/tests/fixtures/chart_golden_de421.json";
import { LlmRequestError } from "../client";
import { ProviderConfig } from "../config";
import {
  streamStructuredInterpretation,
  type InterpretationEvent,
  type InterpretationSectionKey,
} from "../structured-interpretation";
import {
  DOMAINS_CTX_FIXTURE,
  STRENGTH_CTX_FIXTURE,
  TRANSIT_CTX_FIXTURE,
  VARGA_CTX_FULL_FIXTURE,
} from "./predictive-fixture";

// A canonical engine SiderealChart from the committed golden fixture (the exact
// shape the Pyodide worker emits).
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

// Canned JSON for each section, keyed by a marker the user message carries.
// The structured builder embeds a "SECTION:<key>" marker in each prompt so a
// stub fetch can vary its reply by section.
const SECTION_JSON: Record<InterpretationSectionKey, unknown> = {
  core: {
    summary: {
      layman: "A grounded, plain-spoken essence.",
      technical: "Saturn in the 10th anchors a disciplined identity.",
    },
    strengths: [
      { title: "Deep Focus", layman: "You concentrate well.", technical: "Saturn in 10th." },
    ],
    challenges: [
      { title: "Over-caution", layman: "You hesitate.", technical: "Saturn aspect." },
    ],
    life_themes: [
      { title: "Builder", layman: "You build slowly.", technical: "Earthy emphasis." },
    ],
  },
  yoga: {
    integrated_yoga_narrative: {
      layman: "Your life is a long arc of patient mastery.",
      technical: "Multiple raja yogas activate in the Saturn dasha.",
    },
  },
  guidance1: {
    health_guidance: { layman: "Rest well.", technical: "1st lord weak." },
    education_guidance: { layman: "Learn by doing.", technical: "Mercury in 3rd." },
    career_guidance: { layman: "Persist in your craft.", technical: "10th lord exalted." },
    relationship_guidance: { layman: "Choose depth.", technical: "Venus in 7th." },
  },
  guidance2: {
    finances_guidance: { layman: "Save steadily.", technical: "2nd lord steady." },
    spiritual_guidance: { layman: "Seek quiet.", technical: "Ketu in 12th." },
    life_evolution_guidance: { layman: "Grow through patience.", technical: "8th lord chain." },
  },
  remedial: {
    remedial_measures: { layman: "Morning meditation grounds you.", technical: "Strengthen Saturn." },
  },
  upcoming_periods: {
    upcoming_periods: [
      {
        title: "Sun antardasha — 2027-01 to 2028-01",
        layman: "A year where your work turns visible.",
        technical: "The Sun period activates the houses the Sun rules.",
      },
    ],
  },
  current_sky: {
    current_sky: [
      {
        title: "The Saturn Mahadasha, Mercury Antardasha",
        layman: "You're in a steady, building chapter right now.",
        technical: "Saturn maha (2017-02 to 2036-02), Mercury antar active.",
      },
    ],
  },
};

function markerFor(body: string): InterpretationSectionKey {
  for (const key of Object.keys(SECTION_JSON) as InterpretationSectionKey[]) {
    if (body.includes(`SECTION:${key}`)) {
      return key;
    }
  }
  throw new Error(`no section marker in request body: ${body.slice(0, 200)}`);
}

// A non-streaming JSON stub: returns one OpenAI chat-completion shaped object
// whose message.content is the canned JSON string for the requested section.
function jsonResponse(content: string, init: ResponseInit = { status: 200 }): Response {
  const body = JSON.stringify({ choices: [{ message: { content } }] });
  return new Response(body, { headers: { "Content-Type": "application/json" }, ...init });
}

interface StubOptions {
  /** Sections that should fail with a 500 (degrade-gracefully path). */
  readonly fail?: ReadonlySet<InterpretationSectionKey>;
  /** Wrap a section's JSON in a ```json fence to exercise fence-tolerance. */
  readonly fence?: ReadonlySet<InterpretationSectionKey>;
}

function makeStubFetch(opts: StubOptions = {}): typeof fetch {
  return vi.fn(async (_url: string, init: RequestInit) => {
    const section = markerFor(init.body as string);
    if (opts.fail?.has(section)) {
      return jsonResponse("", { status: 500, statusText: "Server Error" });
    }
    let content = JSON.stringify(SECTION_JSON[section]);
    if (opts.fence?.has(section)) {
      content = "```json\n" + content + "\n```";
    }
    return jsonResponse(content);
  }) as unknown as typeof fetch;
}

async function collect(
  gen: AsyncGenerator<InterpretationEvent>,
): Promise<InterpretationEvent[]> {
  const out: InterpretationEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

const ALL_SECTIONS: InterpretationSectionKey[] = [
  "core",
  "yoga",
  "guidance1",
  "guidance2",
  "remedial",
  "upcoming_periods",
  "current_sky",
];

describe("streamStructuredInterpretation — happy path", () => {
  it("emits section_start + section_complete for all 6 sections, then complete", async () => {
    const events = await collect(
      streamStructuredInterpretation({
        chart: realChart,
        config: LOCAL_CFG,
        asOf: { basis: "chart", instant: NOW },
        fetchImpl: makeStubFetch(),
      }),
    );

    for (const key of ALL_SECTIONS) {
      expect(events).toContainEqual({ type: "section_start", section: key });
      expect(events).toContainEqual({ type: "section_complete", section: key });
    }
    const complete = events.filter((e) => e.type === "complete");
    expect(complete).toHaveLength(1);
    expect(events.filter((e) => e.type === "error")).toHaveLength(0);
  });

  it("merges the 6 section results into one VedicInterpretation", async () => {
    const events = await collect(
      streamStructuredInterpretation({
        chart: realChart,
        config: LOCAL_CFG,
        asOf: { basis: "chart", instant: NOW },
        fetchImpl: makeStubFetch(),
      }),
    );
    const complete = events.find((e) => e.type === "complete");
    if (complete?.type !== "complete") throw new Error("no complete event");
    const interp = complete.interpretation;

    expect(interp.summary).toEqual({
      layman: "A grounded, plain-spoken essence.",
      technical: "Saturn in the 10th anchors a disciplined identity.",
    });
    expect(interp.strengths).toHaveLength(1);
    expect(interp.strengths[0]?.title).toBe("Deep Focus");
    expect(interp.challenges[0]?.layman).toBe("You hesitate.");
    expect(interp.life_themes[0]?.title).toBe("Builder");

    expect(interp.integrated_yoga_narrative?.layman).toMatch(/patient mastery/);
    expect(interp.integrated_yoga_narrative?.technical).toMatch(/raja yogas/);

    expect(interp.career_guidance?.layman).toBe("Persist in your craft.");
    expect(interp.career_guidance?.technical).toBe("10th lord exalted.");
    expect(interp.health_guidance?.technical).toBe("1st lord weak.");
    expect(interp.finances_guidance?.layman).toBe("Save steadily.");
    expect(interp.spiritual_guidance?.technical).toBe("Ketu in 12th.");
    expect(interp.life_evolution_guidance?.layman).toBe("Grow through patience.");
    expect(interp.remedial_measures?.layman).toMatch(/meditation/);

    expect(interp.upcoming_periods).toHaveLength(1);
    expect(interp.upcoming_periods?.[0]?.title).toBe("Sun antardasha — 2027-01 to 2028-01");
    expect(interp.upcoming_periods?.[0]?.layman).toMatch(/visible/);

    expect(interp.current_sky).toHaveLength(1);
    expect(interp.current_sky?.[0]?.title).toBe("The Saturn Mahadasha, Mercury Antardasha");
    expect(interp.current_sky?.[0]?.layman).toMatch(/building chapter/);
  });

  it("tolerates ```json-fenced section payloads", async () => {
    const events = await collect(
      streamStructuredInterpretation({
        chart: realChart,
        config: LOCAL_CFG,
        asOf: { basis: "chart", instant: NOW },
        fetchImpl: makeStubFetch({ fence: new Set(["core", "yoga"]) }),
      }),
    );
    const complete = events.find((e) => e.type === "complete");
    if (complete?.type !== "complete") throw new Error("no complete event");
    expect(complete.interpretation.summary).toEqual({
      layman: "A grounded, plain-spoken essence.",
      technical: "Saturn in the 10th anchors a disciplined identity.",
    });
    expect(complete.interpretation.integrated_yoga_narrative?.layman).toMatch(
      /patient mastery/,
    );
  });
});

describe("streamStructuredInterpretation — degrade gracefully", () => {
  it("emits an error for a failing section but still completes", async () => {
    const events = await collect(
      streamStructuredInterpretation({
        chart: realChart,
        config: LOCAL_CFG,
        asOf: { basis: "chart", instant: NOW },
        fetchImpl: makeStubFetch({ fail: new Set(["yoga"]) }),
      }),
    );

    // The failing section produces an error event tagged to that section.
    const errors = events.filter((e) => e.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ type: "error", section: "yoga" });

    // The other six sections still completed.
    for (const key of [
      "core",
      "guidance1",
      "guidance2",
      "remedial",
      "upcoming_periods",
      "current_sky",
    ] as const) {
      expect(events).toContainEqual({ type: "section_complete", section: key });
    }

    // The whole interpretation still finishes.
    const complete = events.find((e) => e.type === "complete");
    if (complete?.type !== "complete") throw new Error("no complete event");
    // The good sections are populated...
    expect(complete.interpretation.summary).toEqual({
      layman: "A grounded, plain-spoken essence.",
      technical: "Saturn in the 10th anchors a disciplined identity.",
    });
    // ...and the failed section stays empty (safe default), not a thrown error.
    expect(complete.interpretation.integrated_yoga_narrative?.layman ?? "").toBe("");
  });

  it("fails LOUDLY (throws, no silent empty complete) when EVERY section fails", async () => {
    // Total failure must surface — an empty `complete` event renders as a blank
    // dashboard with no error and no retry. Partial failure still degrades
    // gracefully (test above); zero usable sections must not.
    const gen = streamStructuredInterpretation({
      chart: realChart,
      config: LOCAL_CFG,
      asOf: { basis: "chart", instant: NOW },
      fetchImpl: makeStubFetch({ fail: new Set(ALL_SECTIONS) }),
    });

    const seen: InterpretationEvent[] = [];
    await expect(
      (async () => {
        for await (const ev of gen) seen.push(ev);
      })(),
    ).rejects.toThrow(/all .*sections? failed/i);

    // It surfaced per-section errors before throwing, and never emitted a
    // (misleading) `complete` event.
    expect(seen.filter((e) => e.type === "error")).toHaveLength(7);
    expect(seen.filter((e) => e.type === "complete")).toHaveLength(0);
  });

  it("rethrows a typed LlmRequestError carrying the representative HTTP status (402) when every section fails", async () => {
    // The reading aggregation must PRESERVE the upstream HTTP status so the UI
    // can classify a total failure structurally (402 -> billing copy) instead of
    // parsing prose. A plain Error dropped the status, which is why an out-of-
    // credits reading showed the generic "check your model/endpoint" dead-end.
    const fetch402 = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: "Insufficient credits", code: 402 } }), {
          status: 402,
          statusText: "Payment Required",
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;

    const gen = streamStructuredInterpretation({
      chart: realChart,
      config: LOCAL_CFG,
      asOf: { basis: "chart", instant: NOW },
      fetchImpl: fetch402,
    });

    const thrown = await collect(gen).then(
      () => {
        throw new Error("expected streamStructuredInterpretation to throw");
      },
      (e: unknown) => e,
    );
    expect(thrown).toBeInstanceOf(LlmRequestError);
    expect((thrown as LlmRequestError).status).toBe(402);
    expect((thrown as Error).message).toMatch(/all .*sections? failed/i);
  });
});

describe("streamStructuredInterpretation — dual-voice summary", () => {
  it("parses a dual-mode { layman, technical } summary object", async () => {
    const events = await collect(
      streamStructuredInterpretation({
        chart: realChart,
        config: LOCAL_CFG,
        asOf: { basis: "chart", instant: NOW },
        fetchImpl: makeStubFetch(),
      }),
    );
    const complete = events.find((e) => e.type === "complete");
    if (complete?.type !== "complete") throw new Error("no complete event");
    expect(complete.interpretation.summary).toEqual({
      layman: "A grounded, plain-spoken essence.",
      technical: "Saturn in the 10th anchors a disciplined identity.",
    });
  });

  it("degrades a BARE-STRING summary to both voices (LITE / local models)", async () => {
    // A small local model may emit `summary: "..."` instead of an object. The
    // parser must tolerate that so the summary never blanks — both voices get
    // the same text.
    const bareStringCoreFetch = vi.fn(async (_url: string, init: RequestInit) => {
      const section = markerFor(init.body as string);
      const payload =
        section === "core"
          ? { ...(SECTION_JSON.core as object), summary: "A single plain sentence." }
          : SECTION_JSON[section];
      return jsonResponse(JSON.stringify(payload));
    }) as unknown as typeof fetch;

    const events = await collect(
      streamStructuredInterpretation({
        chart: realChart,
        config: LOCAL_CFG,
        asOf: { basis: "chart", instant: NOW },
        fetchImpl: bareStringCoreFetch,
      }),
    );
    const complete = events.find((e) => e.type === "complete");
    if (complete?.type !== "complete") throw new Error("no complete event");
    expect(complete.interpretation.summary).toEqual({
      layman: "A single plain sentence.",
      technical: "A single plain sentence.",
    });
  });
});

describe("streamStructuredInterpretation — privacy fail-closed", () => {
  it("throws a clean PrivacyViolationError up front for a cloud endpoint under local_only", async () => {
    // The real-world OpenRouter trap: a cloud baseUrl with privacyMode left at
    // the default `local_only`. This must fail fast with ONE clear message —
    // not five swallowed per-section errors that complete empty.
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const gen = streamStructuredInterpretation({
      chart: realChart,
      config: {
        engine: "openai-http",
        model: "anthropic/claude-3.5-sonnet",
        privacyMode: "local_only",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "sk-test",
      },
      asOf: { basis: "chart", instant: NOW },
      fetchImpl,
    });

    await expect(collect(gen)).rejects.toThrow(/local_only/i);
    // Fail-fast: it never even reached out to the network.
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("streamStructuredInterpretation — abort", () => {
  it("honors an already-aborted signal (no completion, no fetch)", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    const gen = streamStructuredInterpretation({
      chart: realChart,
      config: LOCAL_CFG,
      asOf: { basis: "chart", instant: NOW },
      signal: controller.signal,
      fetchImpl,
    });

    await expect(collect(gen)).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("streamStructuredInterpretation — egress", () => {
  it("only sends sanitized chart data (no identifiers) to the endpoint", async () => {
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(init.body as string);
      const section = markerFor(init.body as string);
      return jsonResponse(JSON.stringify(SECTION_JSON[section]));
    }) as unknown as typeof fetch;

    await collect(
      streamStructuredInterpretation({
        chart: realChart,
        config: LOCAL_CFG,
        asOf: { basis: "chart", instant: NOW },
        fetchImpl,
      }),
    );

    expect(bodies).toHaveLength(7);
    for (const body of bodies) {
      expect(body).not.toMatch(/chart_id|generated_at|calculation_timestamp/);
      expect(body).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
      // Requests JSON object responses.
      expect(JSON.parse(body).response_format).toEqual({ type: "json_object" });
      // The golden chart carries no predictive contexts — the prompt must stay
      // byte-free of the actual embedded predictive block (graceful absence).
      // (The current_sky section's OWN task prose legitimately names the block
      // — it must tell the model to return [] when it is absent — so this
      // checks the delimited block's unique marker, not the bare phrase.)
      expect(body).not.toContain("(deterministic engine output)");
    }
  });
});

describe("streamStructuredInterpretation — engine predictive context", () => {
  const predictiveChart = {
    ...realChart,
    transit_context: TRANSIT_CTX_FIXTURE,
    strength_context: STRENGTH_CTX_FIXTURE,
    varga_context_full: VARGA_CTX_FULL_FIXTURE,
    domains_context: DOMAINS_CTX_FIXTURE,
  } as unknown as SiderealChart;

  async function captureBodies(chart: SiderealChart): Promise<string[]> {
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(init.body as string);
      const section = markerFor(init.body as string);
      return jsonResponse(JSON.stringify(SECTION_JSON[section]));
    }) as unknown as typeof fetch;
    await collect(
      streamStructuredInterpretation({ chart, config: LOCAL_CFG, now: NOW, fetchImpl }),
    );
    return bodies;
  }

  it("injects the delimited predictive block only into timeline section prompts", async () => {
    const bodies = await captureBodies(predictiveChart);
    expect(bodies).toHaveLength(7);
    const timelineBodies = bodies.filter(
      (body) => body.includes("SECTION:upcoming_periods") || body.includes("SECTION:current_sky"),
    );
    const natalBodies = bodies.filter((body) => !timelineBodies.includes(body));
    expect(timelineBodies).toHaveLength(2);
    expect(natalBodies).toHaveLength(5);
    for (const body of timelineBodies) {
      expect(body).toContain("ENGINE PREDICTIVE CONTEXT");
      // Sade Sati + a month-precision window + a strength figure all reach the LLM.
      expect(body).toMatch(/sade sati/i);
      expect(body).toContain("2030-03");
      expect(body).toContain("337");
      // Still no day-level or ISO dates anywhere in the outbound request.
      expect(body).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    }
    for (const body of natalBodies) {
      expect(body).not.toContain("ENGINE PREDICTIVE CONTEXT");
      expect(body).not.toContain('"dashas"');
      expect(body).not.toContain("months_remaining");
      expect(body).not.toContain("start_month");
    }
  });

  it("adds the predictive timing exception to the system prompt ONLY when present", async () => {
    const withCtx = await captureBodies(predictiveChart);
    const withoutCtx = await captureBodies(realChart);

    const systemOf = (body: string): string => {
      const messages = JSON.parse(body).messages as { role: string; content: string }[];
      return messages.find((m) => m.role === "system")?.content ?? "";
    };

    // Stable natal sections keep the natal-only fence even when a compatibility
    // caller supplies predictive context; only timeline sections require it.
    const natalWithCtx = withCtx.find((body) => body.includes("SECTION:core"));
    const timelineWithCtx = withCtx.find((body) => body.includes("SECTION:current_sky"));
    expect(systemOf(natalWithCtx!)).toMatch(/STABLE NATAL ONLY/);
    expect(systemOf(natalWithCtx!)).not.toMatch(/ENGINE PREDICTIVE CONTEXT — USE IT/);
    expect(systemOf(timelineWithCtx!)).toMatch(
      /ENGINE PREDICTIVE CONTEXT — USE IT \(REQUIRED\)/,
    );
    // Without predictive: the stable-natal fence is present instead, and
    // the required directive is absent.
    expect(systemOf(withoutCtx[0]!)).not.toMatch(/ENGINE PREDICTIVE CONTEXT — USE IT/);
    expect(systemOf(withoutCtx[0]!)).toMatch(/STABLE NATAL ONLY/);
  });

  it("does not duplicate the contexts as raw JSON in the chart payload", async () => {
    const bodies = await captureBodies(predictiveChart);
    for (const body of bodies) {
      // The compact text block carries the facts; the raw keys must not ride along.
      expect(body).not.toContain("transit_context");
      expect(body).not.toContain("strength_context");
      expect(body).not.toContain("varga_context_full");
      expect(body).not.toContain("domains_context");
      expect(body).not.toContain("sunrise_utc_iso");
    }
  });
});

describe("streamStructuredInterpretation — output discipline (full + lite prompts)", () => {
  // A legitimate cloud config (cloud_premium + cloud URL) selects the FULL prompt;
  // LOCAL_CFG (localhost) selects the LITE prompt via isLocalEndpoint.
  const CLOUD_CFG: ProviderConfig = {
    engine: "openai-http",
    model: "deepseek/deepseek-v4-pro",
    privacyMode: "cloud_premium",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "sk-test",
  };

  // Literal phrases from the output-discipline + derived-fact rules: finished
  // prose only (no self-corrections / meta-commentary / chain-of-thought /
  // parenthetical self-questioning), and no lordship/rulership/date/yoga/
  // period the engine never stated. The engine now emits the dated dasha tree,
  // so the old blanket next-antar ban is a facts-fenced clause: upcoming
  // periods only as listed (lords + dated windows verbatim).
  const DISCIPLINE_PHRASES = [
    "OUTPUT DISCIPLINE (ABSOLUTE)",
    "self-corrections",
    "meta-commentary",
    "chain-of-thought",
    "NEVER pose a question to yourself",
    "NEVER state a house lordship, sign rulership, dasha",
    "OMIT the claim entirely",
    "may be narrated ONLY as stated in the provided facts",
    "a period, a lord, or a window the facts do not state",
    "single authoritative dignity",
    "kendra = houses 1/4/7/10",
  ] as const;

  async function systemPromptFor(config: ProviderConfig): Promise<string> {
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(init.body as string);
      const section = markerFor(init.body as string);
      return jsonResponse(JSON.stringify(SECTION_JSON[section]));
    }) as unknown as typeof fetch;
    await collect(
      streamStructuredInterpretation({ chart: realChart, config, now: NOW, fetchImpl }),
    );
    const messages = JSON.parse(bodies[0]!).messages as { role: string; content: string }[];
    return messages.find((m) => m.role === "system")?.content ?? "";
  }

  it("pins the discipline rules in the FULL (cloud) system prompt", async () => {
    const system = await systemPromptFor(CLOUD_CFG);
    expect(system).toContain("grand master"); // proves the FULL prompt was selected
    for (const phrase of DISCIPLINE_PHRASES) {
      expect(system).toContain(phrase);
    }
  });

  it("pins the discipline rules in the LITE (local) system prompt", async () => {
    const system = await systemPromptFor(LOCAL_CFG);
    expect(system).not.toContain("grand master"); // proves the LITE prompt was selected
    for (const phrase of DISCIPLINE_PHRASES) {
      expect(system).toContain(phrase);
    }
  });
});

describe("streamStructuredInterpretation — The Road Ahead (upcoming_periods prompts)", () => {
  const CLOUD_CFG: ProviderConfig = {
    engine: "openai-http",
    model: "deepseek/deepseek-v4-pro",
    privacyMode: "cloud_premium",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "sk-test",
  };

  async function bodiesFor(config: ProviderConfig): Promise<string[]> {
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(init.body as string);
      const section = markerFor(init.body as string);
      return jsonResponse(JSON.stringify(SECTION_JSON[section]));
    }) as unknown as typeof fetch;
    await collect(
      streamStructuredInterpretation({ chart: realChart, config, now: NOW, fetchImpl }),
    );
    return bodies;
  }

  it("sends a sixth, Road-Ahead section prompt fenced to engine-listed periods (FULL)", async () => {
    const bodies = await bodiesFor(CLOUD_CFG);
    const upcoming = bodies.find((b) => b.includes("SECTION:upcoming_periods"));
    expect(upcoming).toBeDefined();
    expect(upcoming).toContain("The Road Ahead");
    expect(upcoming).toContain("antar_sequence");
    expect(upcoming).toMatch(/never invent/i);
  });

  it("sends the Road-Ahead section in the LITE prompt too (same fences)", async () => {
    const bodies = await bodiesFor(LOCAL_CFG);
    const upcoming = bodies.find((b) => b.includes("SECTION:upcoming_periods"));
    expect(upcoming).toBeDefined();
    expect(upcoming).toContain("The Road Ahead");
    expect(upcoming).toContain("antar_sequence");
    expect(upcoming).toMatch(/never invent/i);
  });

  it("keeps life evolution timeless and assigns dated windows to Road Ahead", async () => {
    for (const config of [CLOUD_CFG, LOCAL_CFG]) {
      const bodies = await bodiesFor(config);
      const guidance2 = bodies.find((b) => b.includes("SECTION:guidance2"));
      const upcoming = bodies.find((b) => b.includes("SECTION:upcoming_periods"));
      expect(guidance2).toBeDefined();
      expect(upcoming).toBeDefined();
      expect(guidance2).not.toMatch(/dated month windows/);
      expect(guidance2).not.toContain('"dashas"');
      expect(upcoming).toMatch(/dated windows|month precision/i);
    }
  });
});
