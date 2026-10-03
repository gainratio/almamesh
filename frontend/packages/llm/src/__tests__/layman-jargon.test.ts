import { describe, expect, it } from "vitest";

import { findLaymanJargon, LAYMAN_JARGON, LAYMAN_JARGON_TERMS, stripLaymanJargon } from "../layman-jargon";

// The "For You" promise: the layman voice is plain language with NO astrology
// jargon. These terms are the product's contract, shared with the real
// dual-voice e2e gate — pinned literally so the list cannot drift silently.
describe("layman jargon list", () => {
  it("pins the exact banned terms", () => {
    expect([...LAYMAN_JARGON_TERMS]).toEqual([
      "house", "lord", "dasha", "saturn", "jupiter", "rahu", "ketu", "nakshatra", "lagna",
      "exalted", "debilitated", "conjunct", "retrograde", "combust", "ascendant", "sign",
      "degree", "navamsa", "yoga",
    ]);
  });

  it("matches whole words case-insensitively, not substrings", () => {
    expect(LAYMAN_JARGON.test("Yoga postures help")).toBe(true);
    expect(LAYMAN_JARGON.test("a design for the landlord")).toBe(false);
  });

  it("lists every banned term found, lower-cased", () => {
    expect(findLaymanJargon("Walking, yoga, swimming. That's a Sign to rest.")).toEqual(["yoga", "sign"]);
    expect(findLaymanJargon("Plain, warm words.")).toEqual([]);
  });
});

describe("stripLaymanJargon", () => {
  it("returns clean text unchanged", () => {
    const clean = "You are warm.\n\nYou recharge in quiet places.";
    expect(stripLaymanJargon(clean)).toBe(clean);
  });

  // Verbatim shape of the nightly failure (run 37071983548, deepseek-v4-pro):
  // the health guidance carried "yoga" in its plain-English exercise sense.
  it("drops only the sentence that carries a banned term", () => {
    const text =
      "Burnout can sneak up on you. Gentle movement—walking, yoga, swimming—feels like medicine. Rest when you can.";
    expect(stripLaymanJargon(text)).toBe("Burnout can sneak up on you. Rest when you can.");
  });

  it("keeps paragraph breaks around a dropped sentence", () => {
    const text = "First idea.\n\nSupported by a professional yoga. Still true.\n\nLast idea.";
    expect(stripLaymanJargon(text)).toBe("First idea.\n\nStill true.\n\nLast idea.");
  });

  it("leaves no banned term behind, even when every sentence leaks", () => {
    expect(stripLaymanJargon("Your house is strong. Your sign is bright.")).toBe("");
  });
});
