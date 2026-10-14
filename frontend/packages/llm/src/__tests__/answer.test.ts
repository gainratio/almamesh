// The typed chat answer: one zod schema the model fills through the `answer`
// tool, checked against this turn's readings (every rejection is the fix the
// model should make), and rendered as plain markdown in the reader's voice.
import { describe, expect, it } from "vitest";

import type { ProviderConfig } from "../config";
import {
  answerSchema,
  chatAnswerSpec,
  moonTagLabel,
  renderAnswer,
  renderPartialAnswer,
  type AnswerGrounding,
  type ChatAnswer,
  type PeriodAnswer,
} from "../answer";
import { runToolTurn, z } from "../toolLoop";
import { collect, fakeEndpoint } from "./toolLoopFake";

type Reading = AnswerGrounding["readings"][number];

const SEPTEMBER: Reading = {
  period: { start: "2019-09-01", end: "2019-09-30", label: "September 2019" },
  place: { label: "Vadodara, India" },
  maha: ["jupiter"],
  antar: ["saturn"],
  rules: { jupiter: [2, 11], saturn: [1, 12], mercury: [5, 8], rahu: [] },
  tags: ["sade_sati_phase_1", "jupiter_from_moon_11"],
  windows: ["2019-09-25"],
  domains: ["career", "obstacles"],
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

  it("a period answer must fill its fields", () => {
    expect(messages({ ...wire(ANSWER), opening: null, themes: null })).toEqual([
      'opening is required when kind is "period"',
      'themes is required when kind is "period"',
    ]);
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

  it("a reading without tags leaves the Moon section empty", () => {
    expect(messages(wire(ANSWER), grounded({ ...SEPTEMBER, tags: [] }))).toEqual(["the reading has no Moon tags: leave moon empty"]);
  });

  it("window dates must fall inside a period read this turn", () => {
    const outside = { ...SEPTEMBER, period: { start: "2019-06-01", end: "2019-12-31", label: "late 2019" } };
    expect(messages(withAnswer({ windows: [{ date: "2020-01-02", what: "x" }] }), grounded(outside))).toEqual([
      "dates must fall inside 2019-06-01..2019-12-31",
    ]);
  });

  it("windows may not be empty while the reading has some", () => {
    expect(messages(withAnswer({ windows: [] }))).toEqual(["give at least one dated window from the reading: 2019-09-25"]);
  });

  it("the place is named as the reading names it (the city is enough, any case)", () => {
    expect(messages(withAnswer({ place: "Shanghai" }))).toEqual(["name the place as the reading does: Vadodara, India"]);
    expect(messages(withAnswer({ place: "vadodara" }))).toEqual([]);
  });

  it("a reading without a place label does not constrain the place", () => {
    expect(messages(withAnswer({ place: "home" }), grounded({ ...SEPTEMBER, place: { label: "" } }))).toEqual([]);
  });

  it("at least one theme", () => {
    expect(messages(withAnswer({ themes: [] }))).toEqual(["give at least one theme with its confidence"]);
  });

  it("an obstacles theme in the reading needs a theme that names its obstacle", () => {
    const themes = ANSWER.themes.map((theme) => ({ ...theme, obstacle: null }));
    expect(messages(withAnswer({ themes }))).toEqual([
      "the reading has an obstacles theme: give one theme an obstacle that says what blocks and why",
    ]);
    expect(messages(withAnswer({ themes }), grounded({ ...SEPTEMBER, domains: ["career"] }))).toEqual([]);
  });

  it("two readings (a comparison) allow the facts of either", () => {
    const may: Reading = { ...SEPTEMBER, period: { start: "2019-05-01", end: "2019-05-31", label: "May 2019" }, antar: ["mercury"], windows: ["2019-05-10"] };
    const dashas = { ...ANSWER.dashas, antar: { ...ANSWER.dashas.antar, lord: "mercury" as const, rules: [5, 8] } };
    expect(messages(withAnswer({ dashas, windows: [{ date: "2019-05-10", what: "x" }] }), grounded(SEPTEMBER, may))).toEqual([]);
    expect(messages(withAnswer({ windows: [{ date: "2019-07-04", what: "x" }] }), grounded(SEPTEMBER, may))).toEqual([
      "dates must fall inside 2019-09-01..2019-09-30, 2019-05-01..2019-05-31",
    ]);
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
- **Career** (supportive, high confidence): A senior person speaks up for your work.
- **Obstacles** (challenging, medium confidence): Expect friction with rules or paperwork, and watch for losses and expenses you did not plan. Saturn, which rules your 12th house of losses, runs your current sub-chapter.

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
- **Career** (supportive, high confidence): A senior person speaks up for your work.
- **Obstacles** (challenging, medium confidence): Expect friction with rules or paperwork, and watch for losses and expenses you did not plan. Saturn, which rules your 12th house of losses, runs your current sub-chapter.

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
- **Carrera** (favorable, confianza alta): Reconocimiento.

**Fechas a vigilar**
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
    expect(layman).toContain("**O que significa**\n- **Carrera** (favorável, confiança alta)");
    expect(layman).toContain("**Datas para observar**\n- **25 set 2019**");
    const expert = renderAnswer(SPANISH, { voice: "expert", language: "pt" });
    expect(expert).toContain("- **Antardasha Saturno** (senhor de 1, 12): Calma.");
    expect(expert).toContain("**Gochara a partir da Lua**");
    expect(expert).toContain("**Janelas**");
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
    expect(text.endsWith("**What it means**\n- **Career** (supportive, high confidence): A senior person speaks up for your work.")).toBe(true);
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
