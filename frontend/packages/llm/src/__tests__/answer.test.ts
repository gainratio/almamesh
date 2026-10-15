// The typed chat answer: one zod schema the model fills through the `answer`
// tool, checked against this turn's readings (every rejection is the fix the
// model should make), and rendered as plain markdown in the reader's voice.
import { describe, expect, it } from "vitest";

import type { ProviderConfig } from "../config";
import {
  answerSchema,
  answerLanguage,
  chatAnswerSpec,
  datedEventLabel,
  moonTagLabel,
  renderAnswer,
  renderPartialAnswer,
  type AnswerGrounding,
  type ChatAnswer,
  type PeriodAnswer,
} from "../answer";
import { runToolTurn, z, type ToolCallEvent } from "../toolLoop";
import { collect, fakeEndpoint } from "./toolLoopFake";

type Reading = AnswerGrounding["readings"][number];

const SEPTEMBER: Reading = {
  period: { start: "2019-09-01", end: "2019-09-30", label: "September 2019" },
  place: { label: "Vadodara, India" },
  maha: ["jupiter"],
  antar: ["saturn"],
  rules: { jupiter: [2, 11], saturn: [1, 12], mercury: [5, 8], rahu: [] },
  tags: ["sade_sati_phase_1", "jupiter_from_moon_11"],
  windows: [{ date: "2019-09-25", what: "Mars enters Virgo" }],
  themes: { career: { direction: "supportive", confidence: "high" }, obstacles: { direction: "challenging", confidence: "medium" } },
  pratyantar: [],
};

const grounded = (...readings: Reading[]) => (): AnswerGrounding => ({ readings });

const ANSWER: PeriodAnswer = {
  kind: "period",
  period: "September 2019",
  place: "Vadodara, India",
  opening: "September asks for patience at work and care with money, but friends are on your side.",
  dashas: {
    maha: { lord: "jupiter", rules: [2, 11], note: "Income and friendships are the long story of these years." },
    antar: { lord: "saturn", rules: [1, 12], note: "It slows things down and asks you to carry more yourself." },
    pratyantar: null,
  },
  moon: [
    { tag: "sade_sati_phase_1", meaning: "Saturn has begun its long pass over your Moon, so moods can feel heavier." },
    { tag: "jupiter_from_moon_11", meaning: "Friends and networks are generous this month." },
  ],
  themes: [
    { area: "career", direction: "supportive", confidence: "high", text: "A senior person speaks up for your work.", obstacle: null },
    {
      area: "obstacles",
      direction: "challenging",
      confidence: "medium",
      text: "Expect friction with rules or paperwork, and watch for losses and expenses you did not plan.",
      obstacle: "Saturn, which rules your 12th house of losses, runs your current sub-chapter.",
    },
  ],
  windows: [{ date: "2019-09-25", what: "Mars stirs things up; avoid signing or arguing that day." }],
  advice: "Keep a small cash buffer this month and sleep on big decisions.",
};

/** The wire form a strict model sends: every key present, the other kind's keys null. */
const wire = (answer: ChatAnswer): Record<string, unknown> =>
  answer.kind === "period" ? { markdown: null, ...answer } : { period: null, place: null, opening: null, dashas: null, moon: null, themes: null, windows: null, advice: null, ...answer };

function messages(value: unknown, grounding: () => AnswerGrounding = grounded(SEPTEMBER)): string[] {
  const parsed = answerSchema(grounding).safeParse(value);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
}

const withAnswer = (patch: Partial<PeriodAnswer>): Record<string, unknown> => wire({ ...ANSWER, ...patch });

describe("answerSchema: shape", () => {
  it("accepts a full period answer grounded in the turn's reading", () => {
    expect(messages(wire(ANSWER))).toEqual([]);
  });

  it("accepts a general answer when no period was read", () => {
    expect(messages(wire({ kind: "general", markdown: "Venus is your chart ruler." }), grounded())).toEqual([]);
  });

  it("sends an object at the root with every key required (OpenAI strict rejects a root oneOf)", () => {
    const schema = z.toJSONSchema(answerSchema(grounded()), { target: "draft-7", unrepresentable: "any" }) as {
      type?: string;
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(schema.type).toBe("object");
    expect([...schema.required].sort()).toEqual(Object.keys(schema.properties).sort());
    expect(schema.required).toEqual(["kind", "markdown", "period", "place", "opening", "dashas", "moon", "themes", "windows", "advice"]);
  });

  it("rejects a date that is not YYYY-MM-DD", () => {
    expect(messages(withAnswer({ windows: [{ date: "25 Sep 2019", what: "x" }] }))).toEqual(["date must be YYYY-MM-DD"]);
  });
});

describe("answerSchema: grounding refinements say the fix", () => {
  it("a period was read this turn, so a general answer is refused", () => {
    expect(messages(wire({ kind: "general", markdown: "Hello" }))).toEqual([
      'You read a period this turn: answer with kind "period" and its facts.',
    ]);
  });

  it("a general answer needs its markdown", () => {
    expect(messages({ ...wire({ kind: "general", markdown: "" }), markdown: null }, grounded())).toEqual(['kind "general" needs markdown: the answer as plain prose.']);
  });

  it("a period answer with nothing read is refused", () => {
    expect(messages(wire(ANSWER), grounded())).toEqual([
      'Read the period with read_period before answering with kind "period", or answer with kind "general".',
    ]);
  });

  it("a period answer must fill its fields, and each missing key says what goes in it", () => {
    expect(messages({ ...wire(ANSWER), opening: null, themes: null })).toEqual([
      'opening is required when kind is "period": two or three plain sentences that answer the question',
      'themes is required when kind is "period": give at least one theme with its confidence, e.g. career: supportive, high confidence; obstacles: challenging, medium confidence; the reading has an obstacles theme: give one theme an obstacle that says what blocks and why',
    ]);
  });

  it("a first answer missing moon and windows gets ONE rejection naming the allowed tags and dated windows", () => {
    expect(messages({ ...wire(ANSWER), moon: null, windows: null })).toEqual([
      'moon is required when kind is "period": name at least one Moon tag: sade_sati_phase_1, jupiter_from_moon_11',
      'windows is required when kind is "period": give at least one dated window from the reading, e.g. 2019-09-25: Mars enters Virgo',
    ]);
  });

  it("a missing key with nothing to cite says to send an empty list", () => {
    expect(messages({ ...wire(ANSWER), moon: null, windows: null }, grounded({ ...SEPTEMBER, tags: [], windows: [] }))).toEqual([
      'moon is required when kind is "period": the reading has no Moon tags, so send []',
      'windows is required when kind is "period": the reading has no dated days, so send []',
    ]);
  });

  it("a missing dashas key names the lords and their houses; a missing period names the reading's label", () => {
    expect(messages({ ...wire(ANSWER), dashas: null, period: null })).toEqual([
      'period is required when kind is "period": the period as a person says it, e.g. "September 2019"',
      'dashas is required when kind is "period": maha lord one of: jupiter (rules 2, 11); antar lord one of: saturn (rules 1, 12)',
    ]);
  });

  it("a missing key does not stop the other checks: every issue comes back in the same round", () => {
    const themes = ANSWER.themes.map((theme) => ({ ...theme, obstacle: null }));
    expect(messages({ ...wire({ ...ANSWER, themes }), moon: null, place: "Shanghai" })).toEqual([
      'moon is required when kind is "period": name at least one Moon tag: sade_sati_phase_1, jupiter_from_moon_11',
      "name the place as the reading does: Vadodara, India",
      "the reading has an obstacles theme: give one theme an obstacle that says what blocks and why",
    ]);
  });

  it("the wire schema says which keys a period answer must fill, and what goes in each", () => {
    const schema = z.toJSONSchema(answerSchema(grounded()), { target: "draft-7", unrepresentable: "any" }) as { properties: Record<string, { description?: string }> };
    for (const key of ["period", "opening", "dashas", "moon", "themes", "windows"]) {
      expect(schema.properties[key]?.description, key).toMatch(/^kind "period": required\b/);
    }
    // Task 10e: the three keys a model most often left empty point at the reading's cite.
    expect(schema.properties.dashas?.description).toBe('kind "period": required, copy lords and houses from the reading\'s cite');
    expect(schema.properties.moon?.description).toBe('kind "period": required, copy from the reading\'s cite.moon; [] if none');
    expect(schema.properties.windows?.description).toBe('kind "period": required, copy from the reading\'s cite.windows; [] if none');
  });

  it("the answer tool's description tells the model to copy the facts from each reading's cite", async () => {
    const EN = { voice: "layman", language: "en" } as const;
    const spec = chatAnswerSpec(grounded(), EN);
    expect(spec.description).toBe(
      "Submit the final answer to the user. Call it once, last, after the readings you need. " +
        "Copy the facts from each reading's cite. If the arguments are rejected, fix the named fields and call it again.",
    );
    const { fetchImpl, requests } = fakeEndpoint([{ calls: [{ id: "a1", name: "answer", args: JSON.stringify(wire(ANSWER)) }] }]);
    const config: ProviderConfig = { engine: "openai-http", model: "deepseek/deepseek-chat", privacyMode: "cloud_premium", baseUrl: "https://openrouter.ai/api/v1", apiKey: "k" };
    await collect(runToolTurn({ config, messages: [{ role: "user", content: "How is September 2019?" }], tools: [], answer: chatAnswerSpec(grounded(SEPTEMBER), EN), readFirst: false, now: new Date("2026-10-14T00:00:00Z"), fetchImpl }));
    const tools = (requests[0]?.body.tools ?? []) as { function: { name: string; description: string } }[];
    expect(tools.find((tool) => tool.function.name === "answer")?.function.description).toBe(spec.description);
  });

  it("the maha lord must come from the reading", () => {
    const dashas = { ...ANSWER.dashas, maha: { ...ANSWER.dashas.maha, lord: "venus" as const, rules: [4, 9] } };
    expect(messages(withAnswer({ dashas }), grounded({ ...SEPTEMBER, rules: { ...SEPTEMBER.rules, venus: [4, 9] } }))).toEqual([
      "maha lord must be one of: jupiter (from the reading)",
    ]);
  });

  it("the antar lord must come from the reading", () => {
    const dashas = { ...ANSWER.dashas, antar: { ...ANSWER.dashas.antar, lord: "mercury" as const, rules: [5, 8] } };
    expect(messages(withAnswer({ dashas }))).toEqual(["antar lord must be one of: saturn (from the reading)"]);
  });

  it("lords match whatever case the reading uses", () => {
    expect(messages(wire(ANSWER), grounded({ ...SEPTEMBER, maha: ["Jupiter"], antar: ["Saturn"], rules: { Jupiter: [2, 11], Saturn: [1, 12] } }))).toEqual([]);
  });

  it("a reading with no maha or antar lords does not block every answer", () => {
    expect(messages(wire(ANSWER), grounded({ ...SEPTEMBER, maha: [], antar: [] }))).toEqual([]);
  });

  it("a lordship must match the chart", () => {
    const dashas = { ...ANSWER.dashas, antar: { ...ANSWER.dashas.antar, rules: [3, 4] } };
    expect(messages(withAnswer({ dashas }))).toEqual(["saturn rules houses 1, 12 in this chart"]);
  });

  it("a lordship in any order is the same lordship", () => {
    const dashas = { ...ANSWER.dashas, antar: { ...ANSWER.dashas.antar, rules: [12, 1] } };
    expect(messages(withAnswer({ dashas }))).toEqual([]);
  });

  it("the pratyantar's lordship is checked too, and a node rules no houses", () => {
    const dashas = { ...ANSWER.dashas, pratyantar: { lord: "rahu" as const, rules: [6], note: "" } };
    expect(messages(withAnswer({ dashas }))).toEqual(["rahu rules no houses in this chart"]);
  });

  it("a graha the reading gives no lordship for is not second-guessed", () => {
    const dashas = { ...ANSWER.dashas, pratyantar: { lord: "venus" as const, rules: [4, 9], note: "" } };
    expect(messages(withAnswer({ dashas }))).toEqual([]);
  });

  it("a Moon tag must come from the reading", () => {
    expect(messages(withAnswer({ moon: [{ tag: "ashtama_shani", meaning: "x" }] }))).toEqual([
      "moon tags must come from the reading: sade_sati_phase_1, jupiter_from_moon_11",
    ]);
  });

  it("the Moon section may not be empty while the reading has tags", () => {
    expect(messages(withAnswer({ moon: [] }))).toEqual(["name at least one Moon tag: sade_sati_phase_1, jupiter_from_moon_11"]);
  });

  it("Moon tags match whatever case either side uses", () => {
    expect(messages(wire(ANSWER), grounded({ ...SEPTEMBER, tags: ["Sade_Sati_Phase_1", "JUPITER_FROM_MOON_11"] }))).toEqual([]);
    expect(messages(withAnswer({ moon: [{ tag: "SADE_SATI_PHASE_1", meaning: "x" }] }))).toEqual([]);
  });

  it("a reading without tags leaves the Moon section empty", () => {
    expect(messages(wire(ANSWER), grounded({ ...SEPTEMBER, tags: [] }))).toEqual(["the reading has no Moon tags: leave moon empty"]);
  });

  // CONTRACT TIGHTENED (final review, Important 2): a window date used to pass when it merely fell
  // inside the period read; an invented "2026-11-05: Venus enters Libra" was accepted. Now it must
  // be a day the reading gives (the cite's windows are a subset, so copying the cite passes).
  it("window dates must be days the reading gives, not merely inside the period", () => {
    const outside = { ...SEPTEMBER, period: { start: "2019-06-01", end: "2019-12-31", label: "late 2019" } };
    const fix = "each window date must be a day the reading gives, e.g. 2019-09-25: Mars enters Virgo";
    expect(messages(withAnswer({ windows: [{ date: "2020-01-02", what: "x" }] }), grounded(outside))).toEqual([fix]);
    expect(messages(withAnswer({ windows: [{ date: "2019-09-10", what: "Venus enters Libra" }] }))).toEqual([fix]);
    expect(messages(withAnswer({ windows: [{ date: "2019-09-25", what: "A day to watch." }] }))).toEqual([]);
  });

  it("a reading with no dated days takes no window at all", () => {
    expect(messages(withAnswer({ windows: [{ date: "2019-09-10", what: "x" }] }), grounded({ ...SEPTEMBER, windows: [] }))).toEqual([
      "the reading has no dated days, so send []",
    ]);
  });

  it("a theme of a domain the reading has carries the reading's direction and confidence", () => {
    const [career, obstacles] = ANSWER.themes as [PeriodAnswer["themes"][number], PeriodAnswer["themes"][number]];
    const fix = "the reading gives career as supportive, high confidence: copy both";
    expect(messages(withAnswer({ themes: [{ ...career, confidence: "medium" }, obstacles] }))).toEqual([fix]);
    expect(messages(withAnswer({ themes: [{ ...career, direction: "mixed" }, obstacles] }))).toEqual([fix]);
    expect(messages(withAnswer({ themes: [{ ...career, area: "Career and money", confidence: "low" }, obstacles] }))).toEqual([fix]);
    // An area that names no domain of the reading is the model's own: not checked.
    expect(messages(withAnswer({ themes: [{ ...career, area: "Love", confidence: "low" }, obstacles] }))).toEqual([]);
  });

  it("two readings (a comparison) accept a domain's facts from either", () => {
    const may: Reading = { ...SEPTEMBER, period: { start: "2019-05-01", end: "2019-05-31", label: "May 2019" }, themes: { career: { direction: "mixed", confidence: "low" } } };
    const [career, obstacles] = ANSWER.themes as [PeriodAnswer["themes"][number], PeriodAnswer["themes"][number]];
    expect(messages(withAnswer({ themes: [{ ...career, direction: "mixed", confidence: "low" }, obstacles] }), grounded(SEPTEMBER, may))).toEqual([]);
  });

  it("a given pratyantar lord must be one of the reading's pratyantar lords", () => {
    const reading = { ...SEPTEMBER, pratyantar: ["mercury"] };
    const venus = { ...ANSWER.dashas, pratyantar: { lord: "venus" as const, rules: [4, 9], note: "" } };
    expect(messages(withAnswer({ dashas: venus }), grounded(reading))).toEqual(["pratyantar lord must be one of: mercury (from the reading)"]);
    const mercury = { ...ANSWER.dashas, pratyantar: { lord: "mercury" as const, rules: [5, 8], note: "" } };
    expect(messages(withAnswer({ dashas: mercury }), grounded(reading))).toEqual([]);
    expect(messages(withAnswer({ dashas: { ...ANSWER.dashas, pratyantar: null } }), grounded(reading))).toEqual([]);
  });

  it("windows may not be empty while the reading has some", () => {
    expect(messages(withAnswer({ windows: [] }))).toEqual(["give at least one dated window from the reading, e.g. 2019-09-25: Mars enters Virgo"]);
  });

  it("the window suggestion lists only dates inside the period read", () => {
    const reading = { ...SEPTEMBER, windows: [{ date: "2019-08-30", what: "a" }, { date: "2019-09-25", what: "Mars enters Virgo" }, { date: "2019-10-02", what: "b" }] };
    expect(messages(withAnswer({ windows: [] }), grounded(reading))).toEqual(["give at least one dated window from the reading, e.g. 2019-09-25: Mars enters Virgo"]);
  });

  it("a date from a segment event or a dasha change is a dated window too, named by what happens", () => {
    const november: Reading = {
      ...SEPTEMBER,
      period: { start: "2026-11-01", end: "2026-11-30", label: "November 2026" },
      windows: [{ date: "2026-11-12", what: "Mars enters Leo" }, { date: "2026-11-20", what: "pratyantar Mars begins" }],
    };
    expect(messages(withAnswer({ windows: [] }), grounded(november))).toEqual([
      "give at least one dated window from the reading, e.g. 2026-11-12: Mars enters Leo; 2026-11-20: pratyantar Mars begins",
    ]);
  });

  it("a reading whose windows all fall outside its period does not demand one", () => {
    expect(messages(withAnswer({ windows: [] }), grounded({ ...SEPTEMBER, windows: [{ date: "2019-10-02", what: "x" }] }))).toEqual([]);
  });

  it("the place matches without accents on either side", () => {
    const at = (label: string) => grounded({ ...SEPTEMBER, place: { label } });
    expect(messages(withAnswer({ place: "Sao Paulo" }), at("São Paulo, Brazil"))).toEqual([]);
    expect(messages(withAnswer({ place: "Zurich, Switzerland" }), at("Zürich, Switzerland"))).toEqual([]);
    expect(messages(withAnswer({ place: "bogota" }), at("Bogotá, Colombia"))).toEqual([]);
    expect(messages(withAnswer({ place: "Bogotá" }), at("Bogota, Colombia"))).toEqual([]);
    expect(messages(withAnswer({ place: "Medellín" }), at("Bogotá, Colombia"))).toEqual(["name the place as the reading does: Bogotá, Colombia"]);
  });

  it("the place is named as the reading names it (the city is enough, any case)", () => {
    expect(messages(withAnswer({ place: "Shanghai" }))).toEqual(["name the place as the reading does: Vadodara, India"]);
    expect(messages(withAnswer({ place: "vadodara" }))).toEqual([]);
  });

  it("a null or blank place means the reading's place and passes", () => {
    expect(messages(withAnswer({ place: null }))).toEqual([]);
    expect(messages(withAnswer({ place: "" }))).toEqual([]);
    expect(messages(withAnswer({ place: "  " }))).toEqual([]);
  });

  it("a place that names no reading's place says every reading's label", () => {
    const may: Reading = { ...SEPTEMBER, period: { start: "2019-05-01", end: "2019-05-31", label: "May 2019" }, place: { label: "Singapore" } };
    expect(messages(withAnswer({ place: "Shanghai" }), grounded(SEPTEMBER, may))).toEqual(["name the place as the reading does: Vadodara, India or Singapore"]);
    expect(messages(withAnswer({ place: "singapore" }), grounded(SEPTEMBER, may))).toEqual([]);
  });

  it("the wire schema tells the model that null means the reading's place", () => {
    const schema = z.toJSONSchema(answerSchema(grounded()), { target: "draft-7", unrepresentable: "any" }) as { properties: { place: { description?: string } } };
    expect(schema.properties.place.description).toBe("the place as the reading names it, or null for the reading's own place");
  });

  // CONTRACT REVERSAL (Task 10d): this test used to assert that a reading without a place label
  // accepted ANY place ("home" passed). In today threads the label is empty, so gpt-sol's guess
  // "America/Los_Angeles timezone" was accepted and rendered as the heading's place. Now, when
  // every reading this turn has no place, a named place is refused; null or blank still passes.
  it("a reading without a place label refuses a named place: the answer's place must be null", () => {
    const nowhere = grounded({ ...SEPTEMBER, place: { label: "" } });
    expect(messages(withAnswer({ place: "home" }), nowhere)).toEqual(["This reading has no place; set place to null."]);
    expect(messages(withAnswer({ place: "America/Los_Angeles timezone" }), nowhere)).toEqual(["This reading has no place; set place to null."]);
    expect(messages(withAnswer({ place: null }), nowhere)).toEqual([]);
    expect(messages(withAnswer({ place: " " }), nowhere)).toEqual([]);
  });

  it("one labelled reading among unlabelled ones still names the place by its label", () => {
    const may: Reading = { ...SEPTEMBER, period: { start: "2019-05-01", end: "2019-05-31", label: "May 2019" }, place: { label: "" } };
    expect(messages(withAnswer({ place: "Vadodara" }), grounded(SEPTEMBER, may))).toEqual([]);
  });

  it("at least one theme", () => {
    expect(messages(withAnswer({ themes: [] }))).toEqual([
      "give at least one theme with its confidence, e.g. career: supportive, high confidence; obstacles: challenging, medium confidence",
    ]);
    expect(messages(withAnswer({ themes: [] }), grounded({ ...SEPTEMBER, themes: {} }))).toEqual(["give at least one theme with its confidence"]);
  });

  it("an obstacles theme in the reading needs a theme that names its obstacle", () => {
    const themes = ANSWER.themes.map((theme) => ({ ...theme, obstacle: null }));
    expect(messages(withAnswer({ themes }))).toEqual([
      "the reading has an obstacles theme: give one theme an obstacle that says what blocks and why",
    ]);
    expect(messages(withAnswer({ themes }), grounded({ ...SEPTEMBER, themes: { career: SEPTEMBER.themes.career! } }))).toEqual([]);
  });

  it("two readings (a comparison) allow the facts of either", () => {
    const may: Reading = { ...SEPTEMBER, period: { start: "2019-05-01", end: "2019-05-31", label: "May 2019" }, antar: ["mercury"], windows: [{ date: "2019-05-10", what: "x" }] };
    const dashas = { ...ANSWER.dashas, antar: { ...ANSWER.dashas.antar, lord: "mercury" as const, rules: [5, 8] } };
    expect(messages(withAnswer({ dashas, windows: [{ date: "2019-05-10", what: "x" }] }), grounded(SEPTEMBER, may))).toEqual([]);
    expect(messages(withAnswer({ windows: [{ date: "2019-07-04", what: "x" }] }), grounded(SEPTEMBER, may))).toEqual([
      "each window date must be a day the reading gives, e.g. 2019-05-10: x; 2019-09-25: Mars enters Virgo",
    ]);
  });
});

describe("answerSchema: a period that crosses a dasha change names every running lord", () => {
  const CROSSING: Reading = { ...SEPTEMBER, antar: ["saturn", "venus"], rules: { ...SEPTEMBER.rules, venus: [4, 9] } };
  const FIX = "This period crosses a dasha change: also name Venus in the dasha note.";

  it("a single-lord reading is unaffected", () => {
    expect(messages(wire(ANSWER))).toEqual([]);
  });

  it("a two-antar reading whose answer never names the second lord says the fix", () => {
    expect(messages(wire(ANSWER), grounded(CROSSING))).toEqual([FIX]);
  });

  it("naming the second lord in the dasha note passes (any case, whole word)", () => {
    const dashas = { ...ANSWER.dashas, antar: { ...ANSWER.dashas.antar, note: "Saturn slows things, then VENUS eases them." } };
    expect(messages(withAnswer({ dashas }), grounded(CROSSING))).toEqual([]);
  });

  it("naming it in the opening passes", () => {
    expect(messages(withAnswer({ opening: "Venus takes over the sub-chapter mid-month." }), grounded(CROSSING))).toEqual([]);
  });

  it("a substring of another word does not count", () => {
    expect(messages(withAnswer({ opening: "Venusian charm abounds." }), grounded(CROSSING))).toEqual([FIX]);
  });

  it("two maha lords in one reading are both required", () => {
    const other: Reading = { ...SEPTEMBER, maha: ["jupiter", "mars"] };
    expect(messages(wire(ANSWER), grounded(other))).toEqual(["This period crosses a dasha change: also name Mars in the dasha note."]);
  });

  describe("in Spanish and Portuguese the lord may be named in the answer's language", () => {
    const MERCURY: Reading = { ...SEPTEMBER, antar: ["saturn", "mercury"] };
    const VENUS: Reading = CROSSING;
    const inLanguage = (language: "en" | "es" | "pt", opening: string, reading: Reading): string[] => {
      const parsed = answerSchema(grounded(reading), language).safeParse(withAnswer({ opening }));
      return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
    };

    it("es: Mercurio and Marte count, any case", () => {
      expect(inLanguage("es", "Mercurio toma el relevo a mitad de mes.", MERCURY)).toEqual([]);
      expect(inLanguage("es", "MERCURIO toma el relevo.", MERCURY)).toEqual([]);
      const mars: Reading = { ...SEPTEMBER, maha: ["jupiter", "mars"] };
      expect(inLanguage("es", "Júpiter cede el paso a Marte.", mars)).toEqual([]);
    });

    it("pt: Mercúrio and Vênus count, with or without accents", () => {
      expect(inLanguage("pt", "Mercúrio assume no meio do mês.", MERCURY)).toEqual([]);
      expect(inLanguage("pt", "Mercurio assume no meio do mês.", MERCURY)).toEqual([]);
      expect(inLanguage("pt", "Vênus suaviza o fim do mês.", VENUS)).toEqual([]);
      expect(inLanguage("pt", "Venus suaviza o fim do mês.", VENUS)).toEqual([]);
    });

    it("the English name still counts in es and pt prose", () => {
      expect(inLanguage("es", "Mercury toma el relevo.", MERCURY)).toEqual([]);
    });

    it("the fix names the lord in the answer's language", () => {
      expect(inLanguage("es", "Un mes lento.", MERCURY)).toEqual(["This period crosses a dasha change: also name Mercurio in the dasha note."]);
      expect(inLanguage("pt", "Um mês lento.", MERCURY)).toEqual(["This period crosses a dasha change: also name Mercúrio in the dasha note."]);
      expect(inLanguage("pt", "Um mês lento.", VENUS)).toEqual(["This period crosses a dasha change: also name Vênus in the dasha note."]);
      expect(inLanguage("en", "A slow month.", MERCURY)).toEqual(["This period crosses a dasha change: also name Mercury in the dasha note."]);
    });

    it("another language's name does not count (Mercurio is not English)", () => {
      expect(inLanguage("en", "Mercurio takes over.", MERCURY)).toEqual(["This period crosses a dasha change: also name Mercury in the dasha note."]);
    });

    it("the answer spec checks in its own language", () => {
      const spec = chatAnswerSpec(grounded(MERCURY), { voice: "layman", language: "pt" });
      expect(spec.schema.safeParse(withAnswer({ opening: "Mercúrio assume." })).success).toBe(true);
    });
  });

  it("the rendered answer names both lords", () => {
    const dashas = { ...ANSWER.dashas, antar: { ...ANSWER.dashas.antar, note: "Saturn slows things, then Venus eases them." } };
    const answer = { ...ANSWER, dashas };
    expect(messages(wire(answer), grounded(CROSSING))).toEqual([]);
    expect(renderAnswer(answer, { voice: "layman", language: "en" })).toMatch(/saturn[\s\S]*venus/i);
  });
});

describe("moonTagLabel", () => {
  it("names the tags as a person says them", () => {
    expect(moonTagLabel("sade_sati_phase_1", "en")).toBe("Sade Sati, first phase");
    expect(moonTagLabel("sade_sati_phase_3", "en")).toBe("Sade Sati, third phase");
    expect(moonTagLabel("jupiter_from_moon_11", "en")).toBe("Jupiter 11th from your Moon");
    expect(moonTagLabel("jupiter_from_moon_2", "en")).toBe("Jupiter 2nd from your Moon");
    expect(moonTagLabel("kantaka_shani", "en")).toBe("Kantaka Shani");
    expect(moonTagLabel("ashtama_shani", "en")).toBe("Ashtama Shani");
  });

  it("in Spanish and Portuguese", () => {
    expect(moonTagLabel("sade_sati_phase_2", "es")).toBe("Sade Sati, segunda fase");
    expect(moonTagLabel("jupiter_from_moon_11", "es")).toBe("Júpiter en la casa 11 desde tu Luna");
    expect(moonTagLabel("sade_sati_phase_1", "pt")).toBe("Sade Sati, primeira fase");
    expect(moonTagLabel("jupiter_from_moon_11", "pt")).toBe("Júpiter na casa 11 a partir da sua Lua");
  });

  it("an unknown tag reads as words", () => {
    expect(moonTagLabel("double_transit", "en")).toBe("Double Transit");
  });

  it("an unknown tag in Spanish or Portuguese uses the labels it has, not English words", () => {
    expect(moonTagLabel("saturn_return_phase_2", "en")).toBe("Saturn Return Phase 2");
    expect(moonTagLabel("saturn_return_phase_2", "es")).toBe("Saturno Return Fase 2");
    expect(moonTagLabel("venus_from_moon_x", "pt")).toBe("Vênus From Lua X");
  });
});

const LAYMAN_EN = `**September 2019 in Vadodara, India**

September asks for patience at work and care with money, but friends are on your side.

**Your chapters**
- **Jupiter** is your main chapter (maha dasha). Jupiter rules your 2nd and 11th houses. Income and friendships are the long story of these years.
- **Saturn** is the sub-chapter inside it (antar dasha). Saturn rules your 1st and 12th houses. It slows things down and asks you to carry more yourself.

**The Moon's sky**
- **Sade Sati, first phase**: Saturn has begun its long pass over your Moon, so moods can feel heavier.
- **Jupiter 11th from your Moon**: Friends and networks are generous this month.

**What it means**
- **Career** (supportive, most indicators agree): A senior person speaks up for your work.
- **Obstacles** (challenging, some indicators agree): Expect friction with rules or paperwork, and watch for losses and expenses you did not plan. Saturn, which rules your 12th house of losses, runs your current sub-chapter.

**Dates to watch**
- **25 Sep 2019**: Mars stirs things up; avoid signing or arguing that day.

Keep a small cash buffer this month and sleep on big decisions.`;

describe("renderAnswer", () => {
  it("layman, English: plain sections, the chapters explained", () => {
    expect(renderAnswer(ANSWER, { voice: "layman", language: "en" })).toBe(LAYMAN_EN);
  });

  it("expert, English: dasha and gochara terms, lordships as numbers", () => {
    expect(renderAnswer(ANSWER, { voice: "expert", language: "en" })).toBe(`**September 2019 in Vadodara, India**

September asks for patience at work and care with money, but friends are on your side.

**Dashas**
- **Mahadasha Jupiter** (lord of 2, 11): Income and friendships are the long story of these years.
- **Antardasha Saturn** (lord of 1, 12): It slows things down and asks you to carry more yourself.

**Gochara from the Moon**
- **Sade Sati, first phase**: Saturn has begun its long pass over your Moon, so moods can feel heavier.
- **Jupiter 11th from your Moon**: Friends and networks are generous this month.

**Themes**
- **Career** (supportive, most indicators agree): A senior person speaks up for your work.
- **Obstacles** (challenging, some indicators agree): Expect friction with rules or paperwork, and watch for losses and expenses you did not plan. Saturn, which rules your 12th house of losses, runs your current sub-chapter.

**Windows**
- **25 Sep 2019**: Mars stirs things up; avoid signing or arguing that day.

Keep a small cash buffer this month and sleep on big decisions.`);
  });

  const SPANISH: PeriodAnswer = {
    ...ANSWER,
    period: "Septiembre de 2019",
    opening: "Septiembre pide paciencia.",
    dashas: { maha: { ...ANSWER.dashas.maha, note: "Ingresos." }, antar: { ...ANSWER.dashas.antar, note: "Calma." }, pratyantar: { lord: "mercury", rules: [5], note: "" } },
    moon: [{ tag: "sade_sati_phase_1", meaning: "Ánimo pesado." }],
    themes: [{ area: "carrera", direction: "supportive", confidence: "high", text: "Reconocimiento.", obstacle: null }],
    windows: [{ date: "2019-09-25", what: "Evita discutir." }],
    advice: null,
  };

  it("layman, Spanish: its own labels, months and lordship grammar", () => {
    expect(renderAnswer(SPANISH, { voice: "layman", language: "es" })).toBe(`**Septiembre de 2019 en Vadodara, India**

Septiembre pide paciencia.

**Tus capítulos**
- **Júpiter** es tu capítulo principal (maha dasha). Júpiter rige tus casas 2 y 11. Ingresos.
- **Saturno** es el subcapítulo dentro de él (antar dasha). Saturno rige tus casas 1 y 12. Calma.
- **Mercurio** es el capítulo corto dentro de ese (pratyantar dasha). Mercurio rige tu casa 5.

**El cielo de la Luna**
- **Sade Sati, primera fase**: Ánimo pesado.

**Qué significa**
- **Carrera** (favorable, coinciden casi todos los indicadores): Reconocimiento.

**Fechas clave**
- **25 sept 2019**: Evita discutir.`);
  });

  it("expert, Spanish", () => {
    const text = renderAnswer(SPANISH, { voice: "expert", language: "es" });
    expect(text).toContain("**Dashas**\n- **Mahadasha Júpiter** (señor de 2, 11): Ingresos.");
    expect(text).toContain("- **Pratyantardasha Mercurio** (señor de 5)\n");
    expect(text).toContain("**Gochara desde la Luna**");
    expect(text).toContain("**Temas**");
    expect(text).toContain("**Ventanas**\n- **25 sept 2019**: Evita discutir.");
  });

  it("layman and expert, Portuguese", () => {
    const layman = renderAnswer({ ...SPANISH, period: "Setembro de 2019" }, { voice: "layman", language: "pt" });
    expect(layman).toContain("**Setembro de 2019 em Vadodara, India**");
    expect(layman).toContain("- **Júpiter** é seu capítulo principal (maha dasha). Júpiter rege suas casas 2 e 11. Ingresos.");
    expect(layman).toContain("- **Saturno** é o subcapítulo dentro dele (antar dasha). Saturno rege suas casas 1 e 12. Calma.");
    expect(layman).toContain("Mercúrio rege sua casa 5.");
    expect(layman).toContain("**O céu da Lua**\n- **Sade Sati, primeira fase**");
    expect(layman).toContain("**O que significa**\n- **Carrera** (favorável, quase todos os indicadores concordam)");
    expect(layman).toContain("**Datas para observar**\n- **25 set 2019**");
    const expert = renderAnswer(SPANISH, { voice: "expert", language: "pt" });
    expect(expert).toContain("- **Antardasha Saturno** (senhor de 1, 12): Calma.");
    expect(expert).toContain("**Gochara a partir da Lua**");
    expect(expert).toContain("**Janelas**");
  });

  it("a blank place leaves the heading as just the period", () => {
    expect(renderAnswer({ ...ANSWER, place: " " }, { voice: "layman", language: "en" }).startsWith("**September 2019**\n\n")).toBe(true);
    expect(renderPartialAnswer({ kind: "period", period: "Mayo de 2019", place: "", opening: "x" }, { voice: "layman", language: "es" })).toBe("**Mayo de 2019**");
  });

  it("the answer spec renders a null or blank place as the reading's place", () => {
    const spec = chatAnswerSpec(grounded(SEPTEMBER), { voice: "layman", language: "en" });
    expect(spec.render({ ...ANSWER, place: null }, true).startsWith("**September 2019 in Vadodara, India**\n\n")).toBe(true);
    expect(spec.render({ ...ANSWER, place: " " }, true).startsWith("**September 2019 in Vadodara, India**\n\n")).toBe(true);
    expect(spec.render({ ...ANSWER, place: "Vadodara" }, true).startsWith("**September 2019 in Vadodara**\n\n")).toBe(true);
  });

  it("with several readings, a null place is the place of the reading whose period the answer names, else the first", () => {
    const may: Reading = { ...SEPTEMBER, period: { start: "2019-05-01", end: "2019-05-31", label: "May 2019" }, place: { label: "Singapore" } };
    const spec = chatAnswerSpec(grounded(SEPTEMBER, may), { voice: "layman", language: "en" });
    expect(spec.render({ ...ANSWER, period: "may 2019", place: null }, true).startsWith("**may 2019 in Singapore**")).toBe(true);
    expect(spec.render({ ...ANSWER, period: "Spring 2019", place: null }, true).startsWith("**Spring 2019 in Vadodara, India**")).toBe(true);
  });

  it("a general answer is its markdown", () => {
    expect(renderAnswer({ kind: "general", markdown: "  Venus rules your chart.\n" }, { voice: "layman", language: "en" })).toBe("Venus rules your chart.");
  });

  it("leaves out empty sections and a node's missing lordship", () => {
    const bare: PeriodAnswer = {
      ...ANSWER,
      dashas: { ...ANSWER.dashas, maha: { lord: "rahu", rules: [], note: "Ambition runs high." } },
      moon: [],
      windows: [],
      advice: null,
    };
    const layman = renderAnswer(bare, { voice: "layman", language: "en" });
    expect(layman).toContain("- **Rahu** is your main chapter (maha dasha). Ambition runs high.\n");
    expect(layman).not.toContain("The Moon's sky");
    expect(layman).not.toContain("Dates to watch");
    expect(layman.endsWith("you did not plan. Saturn, which rules your 12th house of losses, runs your current sub-chapter.")).toBe(true);
    expect(renderAnswer(bare, { voice: "expert", language: "en" })).toContain("- **Mahadasha Rahu**: Ambition runs high.\n");
  });
});

describe("renderPartialAnswer: snapshots only grow", () => {
  const EN = { voice: "layman", language: "en" } as const;

  it("renders nothing until the kind and the heading are complete", () => {
    expect(renderPartialAnswer({}, EN)).toBe("");
    expect(renderPartialAnswer({ kind: "period", period: "Septem" }, EN)).toBe("");
    expect(renderPartialAnswer({ kind: "period", period: "September 2019", place: "Vado" }, EN)).toBe("");
    expect(renderPartialAnswer({ kind: "period", period: "September 2019", place: "Vadodara, India", opening: "Sep" }, EN)).toBe(
      "**September 2019 in Vadodara, India**",
    );
  });

  it("streams a general answer's markdown as it grows", () => {
    expect(renderPartialAnswer({ kind: "general", markdown: "Venus rul" }, EN)).toBe("Venus rul");
  });

  it("adds a list's items once each is followed by the next", () => {
    const { windows: _w, advice: _a, ...head } = ANSWER;
    const themes = [ANSWER.themes[0], { area: "obst" }];
    const text = renderPartialAnswer({ ...head, themes } as never, EN);
    expect(text.endsWith("**What it means**\n- **Career** (supportive, most indicators agree): A senior person speaks up for your work.")).toBe(true);
  });

  it("every snapshot the tool loop yields while the answer streams is a prefix of the next, ending at the full render", async () => {
    const json = JSON.stringify(wire(ANSWER));
    const pieces = json.match(/.{1,7}/gs) ?? [];
    const { fetchImpl } = fakeEndpoint([{ calls: [{ id: "a1", name: "answer", args: pieces }] }]);
    const config: ProviderConfig = { engine: "openai-http", model: "deepseek/deepseek-chat", privacyMode: "cloud_premium", baseUrl: "https://openrouter.ai/api/v1", apiKey: "k" };
    const { snapshots } = await collect(
      runToolTurn({
        config,
        messages: [{ role: "user", content: "How is September 2019?" }],
        tools: [],
        answer: chatAnswerSpec(grounded(SEPTEMBER), EN),
        readFirst: false,
        now: new Date("2026-10-14T00:00:00Z"),
        fetchImpl,
      }),
    );
    expect(snapshots.length).toBeGreaterThan(8);
    for (let i = 1; i < snapshots.length; i += 1) expect(snapshots[i]?.startsWith(snapshots[i - 1] ?? "\u0000")).toBe(true);
    expect(snapshots.at(-1)).toBe(LAYMAN_EN);
  });

  it("a null place streams prefix-stable through the tool loop, ending at the reading's place", async () => {
    const json = JSON.stringify(wire({ ...ANSWER, place: null }));
    const pieces = json.match(/.{1,5}/gs) ?? [];
    const { fetchImpl } = fakeEndpoint([{ calls: [{ id: "a1", name: "answer", args: pieces }] }]);
    const config: ProviderConfig = { engine: "openai-http", model: "deepseek/deepseek-chat", privacyMode: "cloud_premium", baseUrl: "https://openrouter.ai/api/v1", apiKey: "k" };
    const { snapshots } = await collect(
      runToolTurn({
        config,
        messages: [{ role: "user", content: "How is this month?" }],
        tools: [],
        answer: chatAnswerSpec(grounded(SEPTEMBER), EN),
        readFirst: false,
        now: new Date("2026-10-14T00:00:00Z"),
        fetchImpl,
      }),
    );
    expect(snapshots.length).toBeGreaterThan(8);
    for (let i = 1; i < snapshots.length; i += 1) expect(snapshots[i]?.startsWith(snapshots[i - 1] ?? "\u0000")).toBe(true);
    expect(snapshots.at(-1)).toBe(LAYMAN_EN);
  });

  it("keys streamed in an unusual order still only grow the text", () => {
    const order = ["kind", "advice", "period", "place", "opening", "dashas", "moon", "themes", "windows", "markdown"] as const;
    const full = wire(ANSWER);
    const snapshots: string[] = [];
    const partial: Record<string, unknown> = {};
    for (const key of order) {
      partial[key] = full[key];
      snapshots.push(renderPartialAnswer({ ...partial } as never, EN));
    }
    for (let i = 1; i < snapshots.length; i += 1) expect(snapshots[i]?.startsWith(snapshots[i - 1] ?? "\u0000")).toBe(true);
    expect(LAYMAN_EN.startsWith(snapshots.at(-1) ?? "\u0000")).toBe(true);
  });
});

describe("answerSchema: a model that sends \"null\" or omits nullable keys (production schema, through the tool loop)", () => {
  const CONFIG: ProviderConfig = { engine: "openai-http", model: "deepseek/deepseek-v4-pro", privacyMode: "cloud_premium", baseUrl: "https://openrouter.ai/api/v1", apiKey: "k" };

  const EN = { voice: "layman", language: "en" } as const;

  async function answerEvents(...sent: Record<string, unknown>[]): Promise<ToolCallEvent[]> {
    const turns = sent.map((body, i) => ({ calls: [{ id: `a${i}`, name: "answer", args: JSON.stringify(body) }] }));
    const toolCalls: ToolCallEvent[] = [];
    const ep = fakeEndpoint(turns);
    await collect(
      runToolTurn({
        config: CONFIG,
        messages: [{ role: "user", content: "How is September 2019?" }],
        tools: [],
        answer: chatAnswerSpec(grounded(SEPTEMBER), EN),
        readFirst: false,
        now: new Date("2026-10-14T00:00:00Z"),
        fetchImpl: ep.fetchImpl,
        onToolCall: (e) => toolCalls.push(e),
      }),
    );
    return toolCalls;
  }

  it('accepts "null" in dashas.pratyantar and advice, and an omitted themes[].obstacle and place, on the first try', async () => {
    const sent = wire(ANSWER) as { dashas: Record<string, unknown>; themes: Record<string, unknown>[] } & Record<string, unknown>;
    const [career, obstacles] = sent.themes;
    const { obstacle: _obstacle, ...omitted } = career ?? {};
    const themes = [omitted, obstacles, { ...career, obstacle: "Null" }];
    const events = await answerEvents({ ...sent, dashas: { ...sent.dashas, pratyantar: "null" }, themes, advice: " NULL ", place: "null" });
    expect(events.map((e) => [e.toolName, e.status, e.validFirstTry])).toEqual([["answer", "complete", true]]);
  });

  it('accepts "" for nullable keys at any depth (pratyantar, obstacle, advice, place) on the first try', async () => {
    const sent = wire(ANSWER) as { dashas: Record<string, unknown>; themes: Record<string, unknown>[] } & Record<string, unknown>;
    const themes = sent.themes.map((theme, i) => (i === 0 ? { ...theme, obstacle: "" } : theme));
    const events = await answerEvents({ ...sent, dashas: { ...sent.dashas, pratyantar: "" }, themes, advice: "  ", place: "" });
    expect(events.map((e) => [e.toolName, e.status, e.validFirstTry])).toEqual([["answer", "complete", true]]);
  });

  it("accepts a fully omitted advice key", async () => {
    const { advice: _advice, ...sent } = wire(ANSWER);
    const events = await answerEvents(sent);
    expect(events.map((e) => [e.status, e.validFirstTry])).toEqual([["complete", true]]);
  });

  // CONTRACT REVERSED (Task 10f): this was "fixed in ONE retry". The spec now fills moon and
  // windows from the reading before validation, so the same answer passes on the first try.
  // The rejection text it asserted is still asserted on the schema itself (answerSchema tests).
  it("a first answer that leaves moon and windows null passes on the first try: both are filled from the reading", async () => {
    const events = await answerEvents({ ...wire(ANSWER), moon: null, windows: null });
    expect(events.map((e) => [e.status, e.validFirstTry, e.filled])).toEqual([["complete", true, ["moon", "windows"]]]);
  });

  it("a nested wrong value still retries", async () => {
    const sent = wire(ANSWER) as { themes: Record<string, unknown>[] } & Record<string, unknown>;
    const wrong = { ...sent, themes: [{ ...sent.themes[0], direction: "great" }] };
    const events = await answerEvents(wrong, wire(ANSWER));
    expect(events.map((e) => e.status)).toEqual(["retried", "complete"]);
    expect(events[0]?.validFirstTry).toBe(false);
  });
});

describe("chatAnswerSpec.prepare: moon and windows come from the reading when the model leaves them out", () => {
  const CONFIG: ProviderConfig = { engine: "openai-http", model: "deepseek/deepseek-v4-pro", privacyMode: "cloud_premium", baseUrl: "https://openrouter.ai/api/v1", apiKey: "k" };
  const EN = { voice: "layman", language: "en" } as const;
  const OCTOBER: Reading = {
    period: { start: "2026-10-01", end: "2026-10-31", label: "October 2026" },
    place: { label: "" },
    maha: ["jupiter"],
    antar: ["saturn"],
    rules: { jupiter: [2, 11], saturn: [1, 12] },
    tags: ["jupiter_from_moon_7"],
    windows: [
      { date: "2026-09-28", what: "Venus enters Virgo" },
      { date: "2026-10-04", what: "pratyantar Mars begins" },
      { date: "2026-10-12", what: "Mars enters Leo" },
      { date: "2026-10-19", what: "Saturn stations direct" },
      { date: "2026-10-27", what: "Sun enters Libra" },
    ],
    themes: { career: { direction: "supportive", confidence: "high" } },
    pratyantar: [],
  };
  /** What deepseek sends: moon null, windows [], the interpretation filled in. */
  const DEEPSEEK = {
    ...wire({ ...ANSWER, period: "October 2026", place: null, themes: [ANSWER.themes[0] as PeriodAnswer["themes"][number]] }),
    moon: null,
    windows: [],
  };

  async function turn(reading: Reading, language: "en" | "es", ...sent: Record<string, unknown>[]) {
    const ep = fakeEndpoint(sent.map((body, i) => ({ calls: [{ id: `a${i}`, name: "answer", args: JSON.stringify(body) }] })));
    const events: ToolCallEvent[] = [];
    const { snapshots, result } = await collect(
      runToolTurn({
        config: CONFIG,
        messages: [{ role: "user", content: "How is this month?" }],
        tools: [],
        answer: chatAnswerSpec(grounded(reading), { voice: "layman", language }),
        readFirst: false,
        now: new Date("2026-10-14T00:00:00Z"),
        fetchImpl: ep.fetchImpl,
        onToolCall: (e) => events.push(e),
      }),
    );
    return { events, snapshots, answer: (result as { answer: PeriodAnswer }).answer };
  }

  it("deepseek's moon null and windows [] pass on the first try, rendered with the reading's tag and dated windows", async () => {
    const { events, snapshots, answer } = await turn(OCTOBER, "en", DEEPSEEK);
    expect(events.map((e) => [e.status, e.validFirstTry, e.filled])).toEqual([["complete", true, ["moon", "windows"]]]);
    expect(answer.moon).toEqual([{ tag: "jupiter_from_moon_7", meaning: "Jupiter 7th from your Moon" }]);
    // Up to 3, inside the period only, in the reading's order (earliest first).
    expect(answer.windows).toEqual([
      { date: "2026-10-04", what: "pratyantar Mars begins" },
      { date: "2026-10-12", what: "Mars enters Leo" },
      { date: "2026-10-19", what: "Saturn stations direct" },
    ]);
    const final = snapshots.at(-1) ?? "";
    expect(final).toContain("**The Moon's sky**\n- **Jupiter 7th from your Moon**\n");
    expect(final).toContain("**Dates to watch**\n- **4 Oct 2026**: pratyantar Mars begins\n- **12 Oct 2026**: Mars enters Leo\n- **19 Oct 2026**: Saturn stations direct");
  });

  it("the streamed text before the final snapshot lacks the filled sections; the final one has them", async () => {
    const { snapshots } = await turn(OCTOBER, "en", DEEPSEEK);
    expect(snapshots.slice(0, -1).some((s) => s.includes("Dates to watch"))).toBe(false);
    expect(snapshots.at(-1)).toContain("Dates to watch");
  });

  it("a filled Moon line reads as the tag in the answer's language", async () => {
    const { answer, snapshots } = await turn(OCTOBER, "es", DEEPSEEK);
    expect(answer.moon).toEqual([{ tag: "jupiter_from_moon_7", meaning: "Júpiter en la casa 7 desde tu Luna" }]);
    expect(snapshots.at(-1)).toContain("- **Júpiter en la casa 7 desde tu Luna**\n");
  });

  it("what the model gave is never overwritten", async () => {
    const moon = [{ tag: "jupiter_from_moon_7", meaning: "A partner or ally steps forward." }];
    const { events, answer } = await turn(OCTOBER, "en", { ...DEEPSEEK, moon });
    expect(events.map((e) => [e.status, e.filled])).toEqual([["complete", ["windows"]]]);
    expect(answer.moon).toEqual(moon);
  });

  it("a wrong Moon tag the model gave still retries", async () => {
    const wrong = { ...DEEPSEEK, moon: [{ tag: "saturn_from_moon_4", meaning: "Home feels heavy." }] };
    const { events } = await turn(OCTOBER, "en", wrong, DEEPSEEK);
    expect(events.map((e) => e.status)).toEqual(["retried", "complete"]);
    expect(String(events[0]?.result)).toContain("moon tags must come from the reading: jupiter_from_moon_7");
  });

  it("themes and dashas sent as JSON strings (deepseek) parse before validation: valid on the first try", async () => {
    const sent = { ...DEEPSEEK, themes: JSON.stringify(DEEPSEEK.themes), dashas: JSON.stringify(DEEPSEEK.dashas) };
    const { events, answer } = await turn(OCTOBER, "en", sent);
    expect(events.map((e) => [e.status, e.validFirstTry])).toEqual([["complete", true]]);
    expect(answer.themes).toEqual(DEEPSEEK.themes);
    expect(answer.dashas).toEqual(DEEPSEEK.dashas);
  });

  it("a string that is not JSON of the expected type still retries", async () => {
    for (const themes of ["career is good", JSON.stringify({ area: "career" }), "[1, 2"]) {
      const { events } = await turn(OCTOBER, "en", { ...DEEPSEEK, themes }, DEEPSEEK);
      expect(events.map((e) => e.status)).toEqual(["retried", "complete"]);
    }
    const { events } = await turn(OCTOBER, "en", { ...DEEPSEEK, dashas: JSON.stringify([DEEPSEEK.dashas]) }, DEEPSEEK);
    expect(events.map((e) => e.status)).toEqual(["retried", "complete"]);
  });

  it("an out-of-period window the model gave still retries", async () => {
    const wrong = { ...DEEPSEEK, windows: [{ date: "2026-11-12", what: "Mars enters Leo" }] };
    const { events } = await turn(OCTOBER, "en", wrong, DEEPSEEK);
    expect(events.map((e) => e.status)).toEqual(["retried", "complete"]);
    expect(String(events[0]?.result)).toContain("each window date must be a day the reading gives, e.g. 2026-10-04: pratyantar Mars begins");
  });

  it("the interpretation is not filled: a missing dashas or themes still retries", async () => {
    const { events } = await turn(OCTOBER, "en", { ...DEEPSEEK, dashas: null, themes: [] }, DEEPSEEK);
    expect(events.map((e) => e.status)).toEqual(["retried", "complete"]);
    const reason = String(events[0]?.result);
    expect(reason).toContain("dashas is required");
    expect(reason).toContain("give at least one theme");
  });

  it("a reading with no tags and no dated days: a null moon or windows becomes [] (nothing to cite)", async () => {
    const bare: Reading = { ...OCTOBER, tags: [], windows: [] };
    const { events, answer } = await turn(bare, "en", { ...DEEPSEEK, windows: null });
    expect(events.map((e) => [e.status, e.validFirstTry, e.filled])).toEqual([["complete", true, ["moon", "windows"]]]);
    expect([answer.moon, answer.windows]).toEqual([[], []]);
  });

  it("kind general is untouched", () => {
    const general = wire({ kind: "general", markdown: "Venus rules your 4th house." });
    expect(chatAnswerSpec(grounded(OCTOBER), EN).prepare?.(general)).toBe(general);
    expect(chatAnswerSpec(grounded(), EN).prepare?.({ ...general, kind: "period" })).toEqual({ ...general, kind: "period" });
  });
});

describe("datedEventLabel: what happens on a dated day, in the answer's language", () => {
  it.each([
    ["en", "Mars enters Leo", "Saturn stations direct", "Jupiter stations retrograde", "maha Jupiter begins", "pratyantar Mars begins", "antar dasha junction (sandhi)"],
    ["es", "Marte entra en Leo", "Saturno pasa a directo", "Júpiter pasa a retrógrado", "comienza el maha dasha de Júpiter", "comienza el pratyantar dasha de Marte", "transición del antar dasha (sandhi)"],
    ["pt", "Marte entra em Leão", "Saturno fica direto", "Júpiter fica retrógrado", "começa o maha dasha de Júpiter", "começa o pratyantar dasha de Marte", "transição do antar dasha (sandhi)"],
  ] as const)("%s", (language, ingress, direct, retrograde, maha, pratyantar, sandhi) => {
    expect(datedEventLabel({ kind: "ingress", graha: "mars", sign: "leo" }, language)).toBe(ingress);
    expect(datedEventLabel({ kind: "station", graha: "saturn", motion: "direct" }, language)).toBe(direct);
    expect(datedEventLabel({ kind: "station", graha: "jupiter", motion: "retrograde" }, language)).toBe(retrograde);
    expect(datedEventLabel({ kind: "dasha", level: "maha", lord: "jupiter" }, language)).toBe(maha);
    expect(datedEventLabel({ kind: "dasha", level: "pratyantar", lord: "mars" }, language)).toBe(pratyantar);
    expect(datedEventLabel({ kind: "sandhi", level: "antar" }, language)).toBe(sandhi);
  });

  it("every sign has a name in each language", () => {
    const signs = ["aries", "taurus", "gemini", "cancer", "leo", "virgo", "libra", "scorpio", "sagittarius", "capricorn", "aquarius", "pisces"];
    for (const language of ["en", "es", "pt"] as const) {
      const names = signs.map((sign) => datedEventLabel({ kind: "ingress", graha: "sun", sign }, language).split(" ").at(-1) ?? "");
      expect(names.every((name) => /^\p{Lu}/u.test(name))).toBe(true);
      expect(new Set(names).size).toBe(12);
    }
    expect(datedEventLabel({ kind: "ingress", graha: "sun", sign: "cancer" }, "es")).toBe("Sol entra en Cáncer");
    expect(datedEventLabel({ kind: "ingress", graha: "venus", sign: "pisces" }, "pt")).toBe("Vênus entra em Peixes");
  });

  it("an engine descriptor it cannot phrase stays as written", () => {
    expect(datedEventLabel({ kind: "other", text: "career.dasha.boundary" }, "es")).toBe("career.dasha.boundary");
  });
});

describe("answerLanguage: the chat language as the answer speaks it", () => {
  it.each([["en", "en"], ["es", "es"], ["es-MX", "es"], ["pt-BR", "pt"], ["fr", "en"]] as const)("%s -> %s", (tag, expected) => {
    expect(answerLanguage(tag)).toBe(expected);
  });
});
