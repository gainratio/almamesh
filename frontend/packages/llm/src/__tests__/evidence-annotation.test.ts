// The model-call side of the evidence-backed report.
//
// The contract under test is narrow on purpose: build a request that names every
// citable id, and parse the reply into the RAW payload the web app's validator
// expects — WITHOUT validating it here. Validation lives in exactly one place
// (`lib/evidence/annotations.ts`); a second copy here would be a second place for
// the rule to drift, so these tests assert that a bogus id SURVIVES parsing.

import { describe, expect, it, vi } from "vitest";

import type { SiderealChart } from "@almamesh/browser/types";

import golden from "../../../../../backend/tests/fixtures/chart_golden_de421.json";
import { LlmRequestError } from "../client";
import { PrivacyViolationError, type ProviderConfig } from "../config";
import {
  requestEvidenceAnnotations,
  type EvidenceObservationPrompt,
} from "../evidence-annotation";
import { sanitizeChartForLlm } from "../sanitize";

const NOW = new Date("2030-01-01T00:00:00.000Z");
const CHART = sanitizeChartForLlm(golden as unknown as SiderealChart, { basis: "chart", instant: NOW });

const LOCAL_CONFIG: ProviderConfig = {
  engine: "openai-http",
  model: "llama3.1",
  privacyMode: "local_only",
  baseUrl: "http://localhost:11434/v1",
};

/** A CLOUD endpoint left under the default `local_only` — the fail-closed case. */
const CLOUD_UNDER_LOCAL_ONLY: ProviderConfig = {
  ...LOCAL_CONFIG,
  baseUrl: "https://openrouter.ai/api/v1",
};

const OBSERVATIONS: readonly EvidenceObservationPrompt[] = [
  {
    id: "dignity:venus",
    statement: "Venus sits in its sign of debilitation.",
    evidence: "Venus 12.4° Virgo; dignity=debilitated",
  },
  {
    id: "combustion:venus",
    statement: "Venus is combust.",
    evidence: "Venus 4.2° from the Sun; combustion orb 10°",
  },
  {
    id: "yoga:Gajakesari Yoga",
    statement: "Gajakesari Yoga is formed.",
    evidence: "Jupiter in a kendra from the Moon; grade=moderate",
  },
];

/** Every id the chart can legally cite — the superset the model is fenced to. */
const FACTOR_IDS: readonly string[] = [
  "dignity:venus",
  "combustion:venus",
  "yoga:Gajakesari Yoga",
  "rulership:venus",
  "lagna",
  "dasha:maha:saturn",
];

/** One OpenAI chat-completion shaped reply whose message.content is `content`. */
function jsonResponse(content: string): Response {
  const body = JSON.stringify({ choices: [{ message: { content } }] });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function stubFetch(content: string) {
  return vi.fn(async () => jsonResponse(content));
}

function run(config: ProviderConfig, fetchImpl: ReturnType<typeof stubFetch>) {
  return requestEvidenceAnnotations({
    chart: CHART,
    observations: OBSERVATIONS,
    factorIds: FACTOR_IDS,
    config,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
}

/** The JSON body the stub fetch was called with, as a string. */
function sentBody(fetchImpl: ReturnType<typeof stubFetch>): string {
  const init = fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined;
  return String(init?.body ?? "");
}

const WELL_FORMED = JSON.stringify({
  readings: [
    {
      observation_id: "dignity:venus",
      interpretation: "Warmth here is earned through effort rather than handed over.",
      also_cites: ["rulership:venus"],
    },
    // A citation the chart does NOT contain. Parsing must NOT drop it — the web
    // app's validator is the ONE place that decides, and it must see this row.
    {
      observation_id: "yoga:Invented Yoga",
      interpretation: "A yoga that does not exist in this chart.",
    },
  ],
  general_guidance: ["Rest is not a reward for finishing; it is part of the work."],
});

describe("requestEvidenceAnnotations", () => {
  it("names every observation id and every citable factor id in the request", async () => {
    const fetchImpl = stubFetch('{"readings":[],"general_guidance":[]}');
    await run(LOCAL_CONFIG, fetchImpl);

    const body = sentBody(fetchImpl);
    for (const observation of OBSERVATIONS) {
      expect(body).toContain(observation.id);
      expect(body).toContain(observation.statement);
      expect(body).toContain(observation.evidence);
    }
    for (const factorId of FACTOR_IDS) {
      expect(body).toContain(factorId);
    }
  });

  it("tells the model that ungrounded advice belongs in general_guidance", async () => {
    const fetchImpl = stubFetch('{"readings":[],"general_guidance":[]}');
    await run(LOCAL_CONFIG, fetchImpl);

    const body = sentBody(fetchImpl);
    // The split, the incentive, and the anti-paraphrase rule must all be stated.
    expect(body).toContain("general_guidance");
    expect(body).toContain("readings");
    expect(body).toContain("also_cites");
    expect(body.toLowerCase()).toContain("discarded");
  });

  it("passes a well-formed payload through untouched — a bogus id SURVIVES parsing", async () => {
    const fetchImpl = stubFetch(WELL_FORMED);
    const payload = await run(LOCAL_CONFIG, fetchImpl);

    expect(payload).toEqual(JSON.parse(WELL_FORMED));
    const readings = payload.readings as ReadonlyArray<{ observation_id: string }>;
    expect(readings).toHaveLength(2);
    // The single validation site is the web app's. Filtering here would create a
    // second one, and two copies of a rule always diverge.
    expect(readings[1].observation_id).toBe("yoga:Invented Yoga");
    expect(payload.general_guidance).toEqual([
      "Rest is not a reward for finishing; it is part of the work.",
    ]);
  });

  it("unwraps a ```json fenced completion", async () => {
    const fetchImpl = stubFetch("```json\n" + WELL_FORMED + "\n```");
    const payload = await run(LOCAL_CONFIG, fetchImpl);

    expect(payload).toEqual(JSON.parse(WELL_FORMED));
  });

  it("throws LlmRequestError on a non-JSON completion (never a silent {})", async () => {
    const fetchImpl = stubFetch("Sure! Here is your reading: Venus is debilitated.");

    await expect(run(LOCAL_CONFIG, fetchImpl)).rejects.toBeInstanceOf(LlmRequestError);
  });

  it("throws LlmRequestError when the completion is a JSON array, not an object", async () => {
    const fetchImpl = stubFetch('[{"observation_id":"dignity:venus"}]');

    await expect(run(LOCAL_CONFIG, fetchImpl)).rejects.toBeInstanceOf(LlmRequestError);
  });

  it("throws LlmRequestError on an empty completion", async () => {
    const fetchImpl = stubFetch("   ");

    await expect(run(LOCAL_CONFIG, fetchImpl)).rejects.toBeInstanceOf(LlmRequestError);
  });

  it("refuses a cloud endpoint under local_only BEFORE any fetch happens", async () => {
    const fetchImpl = stubFetch(WELL_FORMED);

    await expect(run(CLOUD_UNDER_LOCAL_ONLY, fetchImpl)).rejects.toBeInstanceOf(
      PrivacyViolationError,
    );
    // The gate is only a gate if nothing left the device.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("retries once when prose breaks the reflection rule and preserves already-clean rows", async () => {
    const firstCompletion = JSON.stringify({
      readings: [
        {
          observation_id: "dignity:venus",
          interpretation: "Warmth here is earned through effort rather than handed over.",
          also_cites: ["rulership:venus"],
        },
        {
          observation_id: "yoga:Gajakesari Yoga",
          interpretation: "You will become famous and experience a windfall in 2027.",
        },
      ],
      general_guidance: ["You will soon get a promotion."],
    });
    // Retry omits the already-clean `dignity:venus` row and rewords only the failing ones.
    const retriedCompletion = JSON.stringify({
      readings: [
        {
          observation_id: "yoga:Gajakesari Yoga",
          interpretation:
            "Jupiter in a kendra from the Moon highlights counsel, stewardship, and steady reputation.",
        },
      ],
      general_guidance: ["Steady preparation matters more than rushing a decision."],
    });
    const fetchImpl = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse(firstCompletion))
      .mockResolvedValueOnce(jsonResponse(retriedCompletion));

    const payload = await requestEvidenceAnnotations({
      chart: CHART,
      observations: OBSERVATIONS,
      factorIds: FACTOR_IDS,
      config: LOCAL_CONFIG,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const secondBody = String((fetchImpl.mock.calls[1] as unknown[] | undefined)?.[1] && ((fetchImpl.mock.calls[1] as unknown[])[1] as RequestInit).body);
    expect(secondBody).toContain("broke the reflection rule");
    expect(payload).toEqual({
      readings: [
        {
          observation_id: "dignity:venus",
          interpretation: "Warmth here is earned through effort rather than handed over.",
          also_cites: ["rulership:venus"],
        },
        {
          observation_id: "yoga:Gajakesari Yoga",
          interpretation:
            "Jupiter in a kendra from the Moon highlights counsel, stewardship, and steady reputation.",
        },
      ],
      general_guidance: ["Steady preparation matters more than rushing a decision."],
    });
  });

  it("falls back cleanly to the first payload when the reflection retry fails or returns non-JSON", async () => {
    const firstCompletion = JSON.stringify({
      readings: [
        {
          observation_id: "dignity:venus",
          interpretation: "You will get married next year.",
        },
      ],
      general_guidance: [],
    });
    const fetchImpl = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse(firstCompletion))
      .mockResolvedValueOnce(jsonResponse("Sorry, I cannot rewrite JSON right now."));

    const payload = await requestEvidenceAnnotations({
      chart: CHART,
      observations: OBSERVATIONS,
      factorIds: FACTOR_IDS,
      config: LOCAL_CONFIG,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(payload).toEqual(JSON.parse(firstCompletion));
  });

  it("preserves sibling also_cites and clean general_guidance when a retry omits fields or returns empty guidance", async () => {
    const firstCompletion = JSON.stringify({
      readings: [
        {
          observation_id: "yoga:Gajakesari Yoga",
          interpretation: "You will become famous in 2027.",
          also_cites: ["dignity:venus"],
        },
        {
          observation_id: "dignity:venus",
          interpretation: "You will win a windfall.",
        },
      ],
      general_guidance: [
        "Rest is part of the work.",
        "You will soon get promoted.",
      ],
    });
    // Retry fixes yoga:Gajakesari Yoga without repeating also_cites, returns a
    // malformed missing-interpretation row for dignity:venus, null garbage, and empty guidance [].
    const retriedCompletion = JSON.stringify({
      readings: [
        null,
        {
          observation_id: "yoga:Gajakesari Yoga",
          interpretation: "Highlights steady counsel and public stewardship.",
        },
        {
          observation_id: "dignity:venus",
        },
      ],
      general_guidance: [],
    });
    const fetchImpl = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse(firstCompletion))
      .mockResolvedValueOnce(jsonResponse(retriedCompletion));

    const payload = await requestEvidenceAnnotations({
      chart: CHART,
      observations: OBSERVATIONS,
      factorIds: FACTOR_IDS,
      config: LOCAL_CONFIG,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(payload).toEqual({
      readings: [
        {
          observation_id: "yoga:Gajakesari Yoga",
          interpretation: "Highlights steady counsel and public stewardship.",
          also_cites: ["dignity:venus"],
        },
        // Malformed retry row lacking string interpretation does NOT overwrite first's row
        // (so validateAnnotations still classifies it accurately as not-reflection).
        {
          observation_id: "dignity:venus",
          interpretation: "You will win a windfall.",
        },
      ],
      // Empty retry guidance [] does NOT wipe out first.general_guidance.
      general_guidance: [
        "Rest is part of the work.",
        "You will soon get promoted.",
      ],
    });
  });

  it("replaces paraphrased general_guidance without duplicating clean bullets and ignores non-reflective extra rows", async () => {
    const firstCompletion = JSON.stringify({
      readings: [
        {
          observation_id: "dignity:venus",
          interpretation: "You will get married in 2027.",
        },
      ],
      general_guidance: [
        "Rest is part of work.",
        "You will soon get promoted.",
      ],
    });
    const retriedCompletion = JSON.stringify({
      readings: [
        {
          observation_id: "dignity:venus",
          interpretation: "Highlights deliberate affection and honest pacing.",
        },
        // Unseen extra row that itself breaks the reflection rule must NOT be appended.
        {
          observation_id: "combustion:venus",
          interpretation: "You will gain fame next month.",
        },
      ],
      general_guidance: [
        "Rest is part of the work.",
        "Steady preparation steadies major transitions.",
      ],
    });
    const fetchImpl = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse(firstCompletion))
      .mockResolvedValueOnce(jsonResponse(retriedCompletion));

    const payload = await requestEvidenceAnnotations({
      chart: CHART,
      observations: OBSERVATIONS,
      factorIds: FACTOR_IDS,
      config: LOCAL_CONFIG,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(payload).toEqual({
      readings: [
        {
          observation_id: "dignity:venus",
          interpretation: "Highlights deliberate affection and honest pacing.",
        },
      ],
      general_guidance: [
        "Rest is part of the work.",
        "Steady preparation steadies major transitions.",
      ],
    });
  });
});
