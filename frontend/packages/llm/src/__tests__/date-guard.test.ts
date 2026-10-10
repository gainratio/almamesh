import { describe, expect, it } from "vitest";

import { monthsIn, validateTimelineDates } from "../date-guard";
import type { PromptLanguage } from "../language";
import { computeQuarters, quarterTitle } from "../quarters";

const ALLOWED = new Set(["2027-03", "2027-06"]);

describe("validateTimelineDates", () => {
  it("removes a month the engine did not supply", () => {
    const { section, removals } = validateTimelineDates(
      { layman: "Things open up. A new door appears in 2031-01. Keep going.", technical: "Jupiter." },
      ALLOWED,
    );
    expect(section.layman).toBe("Things open up. Keep going.");
    expect(removals).toBe(1);
  });

  it("keeps a month the engine supplied", () => {
    const input = { layman: "Momentum builds around 2027-03.", technical: "Sun antar from 2027-06." };
    expect(validateTimelineDates(input, ALLOWED)).toEqual({ section: input, removals: 0 });
  });

  it("removes day-precision dates", () => {
    // 2027-03 IS allowed: only the day rule can remove this sentence.
    const { section, removals } = validateTimelineDates(
      { layman: "Mark 2027-03-14 in your calendar. Rest well.", technical: "" },
      ALLOWED,
    );
    expect(section.layman).toBe("Rest well.");
    expect(removals).toBe(1);
  });

  it.each([
    ["en", "A shift comes in March 2028. Stay steady."],
    ["es", "Un cambio llega en marzo de 2028. Mantente firme."],
    ["pt", "Uma mudança chega em março de 2028. Mantenha-se firme."],
  ])("removes a %s month name with a year the engine did not supply", (_lang, text) => {
    const { section, removals } = validateTimelineDates({ layman: text, technical: "" }, ALLOWED);
    expect(section.layman).not.toMatch(/2028/);
    expect(section.layman.length).toBeGreaterThan(0);
    expect(removals).toBe(1);
  });

  it("keeps a month name that matches a supplied month", () => {
    const input = { layman: "Plans firm up in March 2027 and again in junio de 2027.", technical: "" };
    expect(validateTimelineDates(input, ALLOWED).removals).toBe(0);
  });

  it("guards the technical voice on its own", () => {
    const { section, removals } = validateTimelineDates(
      { layman: "A good season for steady work.", technical: "Saturn ingress 2029-11. Mars antar from 2027-06." },
      ALLOWED,
    );
    expect(section.layman).toBe("A good season for steady work.");
    expect(section.technical).toBe("Mars antar from 2027-06.");
    expect(removals).toBe(1);
  });

  it("counts every removal across nested arrays and fields", () => {
    const { section, removals } = validateTimelineDates(
      {
        quarters: [
          { key: "Q1", layman: "Fine in 2027-03. Bad in 2030-01.", technical: "On 2027-03-02 exact." },
          { key: "Q2", layman: "Quiet.", technical: "Also 2030-02. And 2030-03." },
        ],
      },
      ALLOWED,
    );
    expect(removals).toBe(4);
    expect(section.quarters[0]).toEqual({ key: "Q1", layman: "Fine in 2027-03.", technical: "" });
    expect(section.quarters[1].technical).toBe("");
  });

  it("does not mutate its input", () => {
    const input = { layman: "Gone in 2031-01." };
    validateTimelineDates(input, ALLOWED);
    expect(input.layman).toBe("Gone in 2031-01.");
  });
});

describe("validateTimelineDates: short month forms", () => {
  // The short forms quarterTitle prints, matched case-insensitively with an
  // optional trailing period. 2027-09 and 2027-12 are NOT in ALLOWED.
  it.each([
    ["en", "Sept 2027", "A turn in Sept 2027. Stay steady."],
    ["en", "Sep. 2027", "A turn in Sep. 2027. Stay steady."],
    ["en", "Dec 2027", "Rest in Dec 2027. Stay steady."],
    ["es", "sept 2027", "Un giro en sept 2027. Mantente firme."],
    ["es", "dic 2027", "Descanso en dic 2027. Mantente firme."],
    ["es", "dic. de 2027", "Descanso en dic. de 2027. Mantente firme."],
    ["pt", "dez. 2027", "Descanso em dez. 2027. Mantenha-se firme."],
    ["pt", "set 2027", "Uma virada em set 2027. Mantenha-se firme."],
    ["pt", "DEZ de 2027", "Descanso em DEZ de 2027. Mantenha-se firme."],
  ])("removes %s short form %s the engine did not supply", (_lang, _form, text) => {
    const { section, removals } = validateTimelineDates({ layman: text }, ALLOWED);
    expect(section.layman).not.toMatch(/2027/);
    expect(section.layman.length).toBeGreaterThan(0);
    expect(removals).toBe(1);
  });

  it.each([
    ["en", "Plans firm up in Mar 2027 and again in Jun. 2027."],
    ["es", "Los planes se afirman en mar. de 2027 y otra vez en jun 2027."],
    ["pt", "Os planos se firmam em mar. 2027 e de novo em jun. de 2027."],
    ["pt", "Os planos se firmam em março de 2027 e em junho de 2027."],
  ])("keeps a %s short form the engine supplied", (_lang, text) => {
    const input = { layman: text };
    expect(validateTimelineDates(input, ALLOWED)).toEqual({ section: input, removals: 0 });
  });

  it("reads each language's short forms as the right month", () => {
    const allowed = new Set([
      "2027-01", "2027-02", "2027-04", "2027-05", "2027-08", "2027-09", "2027-10", "2027-12",
    ]);
    const input = {
      es: "En ene 2027, feb 2027, abr 2027, may 2027, ago 2027, sep 2027, oct 2027 y dic 2027.",
      pt: "Em jan. 2027, fev. 2027, abr. 2027, mai. 2027, ago. 2027, set. 2027, out. 2027 e dez. 2027.",
      en: "In Jan 2027, Feb 2027, Apr 2027, May 2027, Aug 2027, Sept 2027, Oct 2027 and Dec 2027.",
    };
    expect(validateTimelineDates(input, allowed).removals).toBe(0);
    // Without those months every sentence goes: the forms really were read as dates.
    expect(validateTimelineDates(input, ALLOWED).removals).toBe(3);
  });

  it("keeps ordinary words that look like short months when no year follows", () => {
    const input = {
      layman: "Mar is a word. Set your intention. May you rest. Out of the woods by 2027-03.",
      technical: "Jan and Dec stay quiet. Sept is a prefix.",
    };
    expect(validateTimelineDates(input, ALLOWED)).toEqual({ section: input, removals: 0 });
  });

  it.each([
    ["en", "Feb-Apr 2027"],
    ["es", "feb-abr 2027"],
    ["pt", "fev.-abr. 2027"],
    ["pt", "fev. – abr. de 2027"],
  ])("checks both ends of a %s month range %s", (_lang, range) => {
    const input = { layman: `Focus on ${range}. Rest.` };
    // Only the end month supplied: the range's start is an invented month.
    const endOnly = validateTimelineDates(input, new Set(["2027-04"]));
    expect(endOnly).toEqual({ section: { layman: "Rest." }, removals: 1 });
    const both = new Set(["2027-02", "2027-04"]);
    expect(validateTimelineDates(input, both)).toEqual({ section: input, removals: 0 });
  });

  it.each<PromptLanguage>(["en", "es", "pt"])(
    "guards the %s quarter titles quarterTitle prints",
    (language) => {
      for (const quarter of computeQuarters("2026-11")) {
        const title = quarterTitle(quarter, language);
        const input = { layman: `Focus on ${title}. Rest.` };
        const supplied = new Set(quarter.months);
        expect(validateTimelineDates(input, supplied)).toEqual({ section: input, removals: 0 });
        const { section, removals } = validateTimelineDates(input, new Set<string>());
        expect({ title, text: section.layman, removals }).toEqual({ title, text: "Rest.", removals: 1 });
      }
    },
  );
});

// Review round 1. Each removal case names a month that IS allowed (2027-03 or
// 2027-06), so only the day-precision / numeric rule can remove the sentence.
describe("validateTimelineDates: day precision and numeric shapes", () => {
  const removesFirst = (sentence: string, allowed: ReadonlySet<string> = ALLOWED): void => {
    const { section, removals } = validateTimelineDates({ layman: `${sentence} Rest.` }, allowed);
    expect({ sentence, text: section.layman, removals }).toEqual({ sentence, text: "Rest.", removals: 1 });
  };
  const keeps = (sentence: string, allowed: ReadonlySet<string> = ALLOWED): void => {
    const input = { layman: `${sentence} Rest.` };
    expect({ sentence, result: validateTimelineDates(input, allowed) }).toEqual({
      sentence,
      result: { section: input, removals: 0 },
    });
  };

  it("removes an ISO timestamp (C1)", () => {
    removesFirst("On 2027-03-14T00:00 act.");
  });

  it.each([
    "On March 14, 2027 act.",
    "On Mar. 14, 2027 act.",
    "On March 14th 2027 act.",
    "On jun 3, 2027 act.",
  ])("removes month-day-year %s (C2)", (sentence) => {
    removesFirst(sentence);
  });

  it("reads a comma between month and year (C2)", () => {
    removesFirst("In March, 2028 act.");
    keeps("In March, 2027 act.");
  });

  it.each([
    ["en", "On 14 March 2027 act."],
    ["en", "On the 14th of March 2027 act."],
    ["en", "On 14 March act."],
    ["es", "El 14 de marzo de 2027 actúa."],
    ["es", "El 3 de junio actúa."],
    ["pt", "Em 14 de março de 2027 aja."],
    ["pt", "Em 1º de junho de 2027 aja."],
    ["pt", "Em 3 de jun. de 2027 aja."],
  ])("removes %s day-before-month %s (I1)", (_lang, sentence) => {
    removesFirst(sentence);
  });

  it("keeps a short word after a count with no year (I1 false positive)", () => {
    keeps("The top 5 may change.");
    keeps("Give it 3 set tries.");
  });

  it("reads Spanish 'del' before the year (I2)", () => {
    removesFirst("En marzo del 2028 actúa.");
    keeps("En marzo del 2027 actúa.");
    removesFirst("En mar. del 2028 actúa.");
  });

  it.each([
    "Act by 2027/03.",
    "Act by 03/2027.",
    "Act by 3/2027.",
    "Act by 2027.03 now.",
    "Act on 3/14/2027.",
    "Act on 14.03.2027 now.",
  ])("removes numeric date %s (I3)", (sentence) => {
    removesFirst(sentence);
  });

  it("reads 'of' and '/' between month and year (I3)", () => {
    removesFirst("Act in março/2028.");
    keeps("Act in março/2027.");
    removesFirst("Act in March of 2028.");
    keeps("Act in March of 2027.");
  });

  it("checks the start month of a slash range (I3)", () => {
    removesFirst("Act in Feb/Mar 2027.", new Set(["2027-03"]));
    keeps("Act in Feb/Mar 2027.", new Set(["2027-02", "2027-03"]));
  });

  it("keeps ordinary prose numbers", () => {
    keeps("Sleep 3.5 hours more. Add 1/2 cup. Score 10/10 and 2.25 points.");
  });
});

// Final review. ALLOWED holds 2027-03 and 2027-06, so a year of 2027 is an
// allowed year; each removal below can only come from the new rule.
describe("validateTimelineDates: final review shapes", () => {
  const removesFirst = (sentence: string, allowed: ReadonlySet<string> = ALLOWED): void => {
    const { section, removals } = validateTimelineDates({ layman: `${sentence} Rest.` }, allowed);
    expect({ sentence, text: section.layman, removals }).toEqual({ sentence, text: "Rest.", removals: 1 });
  };
  const keeps = (sentence: string, allowed: ReadonlySet<string> = ALLOWED): void => {
    const input = { layman: `${sentence} Rest.` };
    expect({ sentence, result: validateTimelineDates(input, allowed) }).toEqual({
      sentence,
      result: { section: input, removals: 0 },
    });
  };

  it.each([
    ["en", "Act on October 12."],
    ["en", "Things shift on March 14th."],
    ["en", "Act on Oct 12."],
    ["en", "Act on Oct. 12 sharp."],
    ["en", "Watch May 14 closely."],
    ["en", "Act on MARCH 3."],
    ["es", "Actúa en marzo 14."],
    ["es", "Actúa el Dic 3."],
    ["pt", "Aja em março de 14."],
    ["pt", "Aja em Set 3."],
  ])("removes a %s month-then-day with no year: %s (F1)", (_lang, sentence) => {
    removesFirst(sentence);
  });

  it("keeps a lowercase 3-letter word before a count (F1 false positive)", () => {
    keeps("Things may 5 times improve.");
    keeps("We set 3 goals.");
    keeps("March 2027 is the month.");
  });

  it.each([
    ["en", "On 12/14 act."],
    ["en", "Act by 3/14."],
    ["es", "El 14/3 actúa."],
    ["pt", "Em 14/3 aja."],
    ["pt", "A partir de 1/7 aja."],
  ])("removes a %s numeric day/month after a date cue: %s (F1)", (_lang, sentence) => {
    removesFirst(sentence);
  });

  it("keeps numeric fractions and scores with no date cue (F1 false positive)", () => {
    keeps("Add 1/2 cup.");
    keeps("Score 10/10 today.");
    keeps("Give it 3/4 effort.");
    keeps("On 45/60 tries it held.");
  });

  it.each([
    ["en", "In 2031 you rise."],
    ["en", "Q3 2029 brings a turn."],
    ["en", "By early 2031 it settles."],
    ["en", "Around mid-2029 it settles."],
    ["es", "En 2031 te elevas."],
    ["es", "El T3 de 2029 trae un giro."],
    ["pt", "Em 2031 você cresce."],
    ["pt", "No meio de 2029 se acalma."],
  ])("removes a %s bare year the engine did not supply: %s (F2)", (_lang, sentence) => {
    removesFirst(sentence);
  });

  it.each([
    ["en", "In 2027 you rise."],
    ["en", "Q3 2027 brings a turn."],
    ["es", "En 2027 te elevas."],
    ["pt", "Em meados de 2027 se acalma."],
  ])("keeps a %s year of an allowed month: %s (F2)", (_lang, sentence) => {
    keeps(sentence);
  });

  it("keeps a year range whose years are allowed and ordinary 4-digit counts (F2)", () => {
    keeps("Walk 5000 steps.");
    keeps("Spend $2,050 wisely.");
    keeps("From 2027-03 on, rest.");
  });

  it.each([
    ["U+2011", "Act in 2028‑03."],
    ["U+2013", "Act in 2028–03."],
    ["U+2014", "Act in 2028—03."],
    ["single digit", "Act in 2028-3 now."],
  ])("removes a YYYY-MM with a %s separator the engine did not supply (F4)", (_form, sentence) => {
    // 2028 is not an allowed year; allow it so only the month rule can remove.
    removesFirst(sentence, new Set([...ALLOWED, "2028-01"]));
  });

  it.each([
    ["U+2011", "Act in 2027‑03."],
    ["U+2013", "Act in 2027–03."],
    ["single digit", "Act in 2027-3 now."],
  ])("keeps a supplied month written with a %s separator (F4)", (_form, sentence) => {
    keeps(sentence);
  });

  it("removes an ISO day written with non-ASCII dashes (F4)", () => {
    removesFirst("Mark 2027‑03‑14 now.");
  });
});

describe("monthsIn", () => {
  it("collects every YYYY-MM the engine put in a slice", () => {
    const slice = { a: "2027-03", b: [{ month: "2027-06" }], c: "birth", d: 2027 };
    expect([...monthsIn(slice)].sort()).toEqual(["2027-03", "2027-06"]);
  });
});
