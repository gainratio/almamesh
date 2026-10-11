import { describe, expect, it, vi } from "vitest";

import type { ProviderConfig } from "../config";
import {
  buildReportMessages,
  REPORT_PROMPT_SET,
  REPORT_SECTIONS,
  streamNatalInterpretation,
  streamReportTimeline,
} from "../index";
import { REPORT_AS_OF, REPORT_RAW_CHART } from "./report-fixture";

const CONFIG: ProviderConfig = {
  engine: "openai-http", model: "deepseek/deepseek-v4.1-flash", privacyMode: "cloud_premium",
  baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk-or-test",
};

describe("buildReportMessages", () => {
  it("returns one message array per report section", () => {
    const messages = buildReportMessages({ chart: REPORT_RAW_CHART, asOf: REPORT_AS_OF }, { mode: "layman", language: "en", lite: false });
    expect(Object.keys(messages).sort()).toEqual([...REPORT_SECTIONS].sort());
  });

  it("builds exactly the messages the generators send, so the estimate prices what is sent", async () => {
    const sent = new Map<string, unknown>();
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messages: unknown };
      sent.set(/SECTION:([a-z0-9_]+)/.exec(String(init.body))?.[1] ?? "", body.messages);
      return new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }));
    }) as unknown as typeof fetch;
    const common = { chart: REPORT_RAW_CHART, asOf: REPORT_AS_OF, config: CONFIG, fetchImpl, language: "es" as const };
    try { for await (const _ of streamNatalInterpretation({ ...common, promptSet: REPORT_PROMPT_SET })) { /* drain */ } } catch { /* empty stub replies */ }
    try { for await (const _ of streamReportTimeline(common)) { /* drain */ } } catch { /* empty stub replies */ }

    const built = buildReportMessages({ chart: REPORT_RAW_CHART, asOf: REPORT_AS_OF }, { mode: "layman", language: "es", lite: false });
    for (const section of REPORT_SECTIONS) expect(sent.get(section)).toEqual(built[section]);
  });

  it("never puts dashas or predictive data in a natal message", () => {
    const messages = buildReportMessages({ chart: REPORT_RAW_CHART, asOf: REPORT_AS_OF }, { mode: "layman", language: "en", lite: true });
    for (const section of ["core", "yoga", "guidance1", "guidance2", "remedial"] as const) {
      const user = messages[section][1].content;
      expect(user).not.toContain('"maha_dasha_sequence"');
      expect(user).not.toContain("ENGINE");
    }
  });
});
