import { describe, expect, it } from "vitest";

import { createJsonProseExtractor, createWordCounter, PROSE_PREVIEW_CHARS } from "../json-prose";

// The timeline sections stream JSON. The reader should see the PROSE as it is
// written, never braces, keys, or escape sequences — and a low-end device must
// not keep re-scanning or re-copying the whole growing document per token.

function feed(text: string, every: number): ReturnType<typeof createJsonProseExtractor> {
  const extractor = createJsonProseExtractor();
  for (let at = 0; at < text.length; at += every) extractor.push(text.slice(at, at + every));
  return extractor;
}

const DOC = JSON.stringify({
  upcoming_periods: [
    { title: "Jupiter period", layman: "A season of growth.", technical: "Jupiter MD, Venus AD." },
  ],
});

describe("createJsonProseExtractor", () => {
  it("shows only string values, never keys or JSON punctuation", () => {
    const prose = feed(DOC, 1000).preview();
    expect(prose).toBe("Jupiter period\nA season of growth.\nJupiter MD, Venus AD.");
  });

  it("gives the same prose however the deltas are split", () => {
    for (const every of [1, 2, 3, 7, 13]) {
      expect(feed(DOC, every).preview()).toBe(feed(DOC, 1000).preview());
    }
  });

  it("renders a partial string value as soon as its characters arrive", () => {
    const extractor = createJsonProseExtractor();
    extractor.push('{"upcoming_periods":[{"title":"Satu');
    expect(extractor.preview()).toBe("Satu");
    expect(extractor.words()).toBe(1);
  });

  it("decodes escapes, including \\u sequences split across deltas", () => {
    const extractor = createJsonProseExtractor();
    for (const part of ['{"a":"Say \\"hi\\"\\nnow ', "\\u00", "e9", 'tude"}']) extractor.push(part);
    expect(extractor.preview()).toBe('Say "hi"\nnow étude');
  });

  it("counts words across values without counting keys", () => {
    expect(feed(DOC, 5).words()).toBe(10);
  });

  it("ignores a markdown fence around the JSON", () => {
    expect(feed("```json\n" + DOC + "\n```", 4).preview()).toBe(feed(DOC, 4).preview());
  });

  it("keeps a bounded tail of the prose, not the whole document", () => {
    const long = "word ".repeat(5000);
    const extractor = feed(JSON.stringify({ text: long }), 11);
    expect(extractor.words()).toBe(5000);
    expect(extractor.preview().length).toBeLessThanOrEqual(PROSE_PREVIEW_CHARS);
    expect(PROSE_PREVIEW_CHARS).toBe(480);
    expect(long.endsWith(extractor.preview())).toBe(true);
  });

  it("treats strings inside arrays as values", () => {
    expect(feed('{"k":["one two","three"]}', 3).preview()).toBe("one two\nthree");
  });
});

describe("createWordCounter", () => {
  it("counts words across arbitrary delta splits without keeping the text", () => {
    const counter = createWordCounter();
    for (const part of ["Let me th", "ink about ", "the da", "sha.\nOk"]) counter.push(part);
    expect(counter.words()).toBe(7);
  });
});
