import { describe, expect, it } from "vitest";

import {
  LIFE_OUTLOOK_GROUPS,
  parseCurrentPeriod,
  parseLifeOutlook,
  parseYearAhead,
  ReportParseError,
} from "../report-sections";

const KEYS = ["Q1", "Q2", "Q3", "Q4"] as const;
const p = (text: string) => ({ layman: text, technical: text });

describe("parseYearAhead", () => {
  it("keeps the sent quarters and the optional focus", () => {
    const parsed = parseYearAhead(
      { headline: p("A building year."), quarters: KEYS.map((key) => ({ key, ...p(`${key} prose.`) })), focus: p("Focus.") },
      KEYS,
    );
    expect(parsed.quarters.map((q) => q.key)).toEqual(KEYS);
    expect(parsed.focus).toEqual(p("Focus."));
  });

  it("omits focus when the model sent none (lite)", () => {
    expect(parseYearAhead({ headline: p("h"), quarters: [] }, KEYS)).not.toHaveProperty("focus");
  });

  it("rejects a quarter key it did not send", () => {
    expect(() => parseYearAhead({ headline: p("h"), quarters: [{ key: "Q5", ...p("x") }] }, KEYS)).toThrow(ReportParseError);
    expect(() => parseYearAhead({ headline: p("h"), quarters: [{ key: "2027-01", ...p("x") }] }, KEYS)).toThrow(/not sent/);
  });

  it("rejects a repeated quarter key", () => {
    expect(() => parseYearAhead({ headline: p("h"), quarters: [{ key: "Q1", ...p("a") }, { key: "Q1", ...p("b") }] }, KEYS)).toThrow(ReportParseError);
  });

  it("maps empty and missing keys to the sent quarter at the same position", () => {
    const rows = [{ key: "", ...p("a") }, { ...p("b") }, { key: "", ...p("c") }, { key: "", ...p("d") }];
    const parsed = parseYearAhead({ headline: p("h"), quarters: rows }, KEYS);
    expect(parsed.quarters.map((q) => [q.key, q.technical])).toEqual([
      ["Q1", "a"],
      ["Q2", "b"],
      ["Q3", "c"],
      ["Q4", "d"],
    ]);
  });

  it("fills one empty key among valid keys with its positional quarter", () => {
    const rows = [{ key: "Q1", ...p("a") }, { key: "Q2", ...p("b") }, { key: "", ...p("c") }, { key: "Q4", ...p("d") }];
    const parsed = parseYearAhead({ headline: p("h"), quarters: rows }, KEYS);
    expect(parsed.quarters.map((q) => q.key)).toEqual(KEYS);
    expect(parsed.quarters[2].technical).toBe("c");
  });

  it("rejects an empty key whose positional quarter is already taken", () => {
    const rows = [{ key: "Q2", ...p("a") }, { key: "", ...p("b") }];
    expect(() => parseYearAhead({ headline: p("h"), quarters: rows }, KEYS)).toThrow(ReportParseError);
  });

  it("rejects a reply with more quarter entries than quarters sent", () => {
    const rows = ["Q1", "Q2", "Q3", "Q4", ""].map((key) => ({ key, ...p(key) }));
    expect(() => parseYearAhead({ headline: p("h"), quarters: rows }, KEYS)).toThrow(ReportParseError);
  });

  it("strips jargon from the layman voice of a quarter", () => {
    const parsed = parseYearAhead({ headline: p("h"), quarters: [{ key: "Q1", layman: "Saturn moves. Rest.", technical: "Saturn." }] }, KEYS);
    expect(parsed.quarters[0].layman).toBe("Rest.");
  });
});

describe("parseLifeOutlook", () => {
  it("keeps the group's domains with their one-liners", () => {
    const parsed = parseLifeOutlook(
      { domains: [{ domain: "career", outlook: p("Good."), lean_into: "Ask for more.", watch_for: "Overwork." }] },
      LIFE_OUTLOOK_GROUPS.life_outlook_1,
    );
    expect(parsed).toEqual([{ domain: "career", outlook: p("Good."), lean_into: "Ask for more.", watch_for: "Overwork." }]);
  });

  it("rejects an unknown domain", () => {
    expect(() => parseLifeOutlook({ domains: [{ domain: "luck", outlook: p("x") }] }, LIFE_OUTLOOK_GROUPS.life_outlook_1)).toThrow(ReportParseError);
  });

  it("rejects a real domain that belongs to the other call", () => {
    expect(() => parseLifeOutlook({ domains: [{ domain: "health", outlook: p("x") }] }, LIFE_OUTLOOK_GROUPS.life_outlook_1)).toThrow(/not in this section/);
  });

  it("rejects a repeated domain", () => {
    const twice = { domains: [{ domain: "career", outlook: p("A.") }, { domain: "career", outlook: p("B.") }] };
    expect(() => parseLifeOutlook(twice, LIFE_OUTLOOK_GROUPS.life_outlook_1)).toThrow(/repeated/);
  });

  it("drops empty one-liners instead of storing blanks (lite)", () => {
    expect(parseLifeOutlook({ domains: [{ domain: "health", outlook: "Rest." }] }, LIFE_OUTLOOK_GROUPS.life_outlook_2)).toEqual([
      { domain: "health", outlook: { layman: "Rest.", technical: "Rest." } },
    ]);
  });
});

describe("parseCurrentPeriod", () => {
  it("parses all four parts; lite has no activates", () => {
    expect(parseCurrentPeriod({ maha: p("m"), antar: p("a"), next_change: p("n") })).toEqual({
      maha: p("m"), antar: p("a"), activates: [], next_change: p("n"),
    });
  });
});
