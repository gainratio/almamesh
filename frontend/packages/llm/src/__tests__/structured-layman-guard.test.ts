import { describe, expect, it, vi } from "vitest";

import type { SiderealChart } from "@almamesh/browser/types";
import type { Persona } from "@almamesh/shared-types";

import golden from "../../../../../backend/tests/fixtures/chart_golden_de421.json";
import type { ProviderConfig } from "../config";
import { streamNatalInterpretation, type NatalInterpretationEvent } from "../index";
import { LAYMAN_JARGON, LAYMAN_JARGON_TERMS } from "../layman-jargon";
import { sanitizeChartForLlm } from "../sanitize";
import { buildSectionMessages } from "../structured-interpretation";

// Regression: nightly E2E run 37071983548 failed "layman ("For You") must
// contain NO jargon — found: yoga". The model (deepseek/deepseek-v4-pro) put
// banned terms in layman fields the prompt told it to keep plain. The guard
// must hold at the point the reading is ACCEPTED, whatever the model writes.

const chart = (golden as Record<string, SiderealChart>)[Object.keys(golden)[0]];
const config: ProviderConfig = {
  engine: "openai-http",
  model: "test-model",
  privacyMode: "local_only",
  baseUrl: "http://localhost:11434/v1",
};

const TECHNICAL = "Leo lagna; Sun in the 12th house, conjunct a combust Mercury.";
const persona = (layman: string) => ({ layman, technical: TECHNICAL });

// Leaky layman text, shaped on the real nightly excerpts.
const SECTIONS: Record<string, unknown> = {
  core: {
    summary: persona("You are warm. Your Leo ascendant makes you shine."),
    strengths: [{ title: "Quiet charisma", ...persona("People trust you. Your house of friends is full.") }],
    challenges: [],
    life_themes: [],
  },
  yoga: { integrated_yoga_narrative: persona("A royal yoga lifts you. You grow steadily.") },
  guidance1: {
    health_guidance: persona("Rest matters. Gentle movement—walking, yoga, swimming—feels like medicine."),
    education_guidance: persona("You learn by doing. A racing mind is a sign to step back."),
    career_guidance: persona("You lead calmly."),
    relationship_guidance: persona("You love deeply."),
  },
  guidance2: {
    finances_guidance: persona("Integrity pays. Ancient texts call it a stainless professional yoga."),
    spiritual_guidance: persona("Silence feeds you."),
    life_evolution_guidance: persona("You keep growing."),
  },
  remedial: { remedial_measures: persona("Journal each morning. Yoga postures like tree pose ground you.") },
};

function sectionKey(init: RequestInit): string {
  const match = /SECTION:(\w+)/.exec(String(init.body));
  if (!match) throw new Error("request carries no SECTION marker");
  return match[1];
}

const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
  const content = JSON.stringify(SECTIONS[sectionKey(init)]);
  return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content } }] }));
}) as unknown as typeof fetch;

async function acceptedReading() {
  const events: NatalInterpretationEvent[] = [];
  for await (const event of streamNatalInterpretation({ chart, config, fetchImpl })) events.push(event);
  const complete = events.find((e) => e.type === "complete");
  if (complete?.type !== "complete") throw new Error("missing completion");
  return complete.interpretation;
}

function personasOf(reading: Awaited<ReturnType<typeof acceptedReading>>): Persona[] {
  const guidance = [
    reading.health_guidance, reading.education_guidance, reading.career_guidance,
    reading.relationship_guidance, reading.finances_guidance, reading.spiritual_guidance,
    reading.life_evolution_guidance, reading.remedial_measures,
  ];
  return [
    reading.summary, reading.integrated_yoga_narrative,
    ...reading.strengths, ...reading.challenges, ...reading.life_themes,
    ...guidance.filter((p): p is Persona => p !== null),
  ];
}

describe("layman voice guard at acceptance", () => {
  it("accepts NO banned term in any layman field of the natal reading", async () => {
    const reading = await acceptedReading();
    const leaks = personasOf(reading)
      .map((p) => p.layman)
      .filter((text) => LAYMAN_JARGON.test(text));
    expect(leaks).toEqual([]);
  });

  it("keeps the plain sentences of a repaired field", async () => {
    const reading = await acceptedReading();
    expect(reading.summary.layman).toBe("You are warm.");
    expect(reading.health_guidance?.layman).toBe("Rest matters.");
  });

  it("leaves the technical voice untouched", async () => {
    const reading = await acceptedReading();
    expect(reading.summary.technical).toBe(TECHNICAL);
    expect(reading.remedial_measures?.technical).toBe(TECHNICAL);
  });
});

// The guard is the backstop; the prompt should not invite the leak. The
// nightly's remedies said "Yoga postures like tree pose" because the remedial
// task itself asked for "yoga postures by ENGLISH name" in the layman voice.
describe("layman prompt agrees with the guard", () => {
  const sanitized = sanitizeChartForLlm(chart, new Date("2026-10-02T00:00:00Z"));

  it.each([false, true])("names every banned term as a layman rule (lite=%s)", (lite) => {
    const [system] = buildSectionMessages("core", sanitized, "layman", lite, "en");
    expect(system.content).toContain(LAYMAN_JARGON_TERMS.join(", "));
  });

  it.each([false, true])("never asks the layman remedies for yoga (lite=%s)", (lite) => {
    const [, user] = buildSectionMessages("remedial", sanitized, "layman", lite, "en");
    expect(user.content).not.toMatch(/yoga postures/i);
  });
});
