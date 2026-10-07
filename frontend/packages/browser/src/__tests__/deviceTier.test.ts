import { describe, expect, it } from "vitest";

import { DEVICE_POLICIES, deviceTier, devicePolicy } from "../deviceTier";

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1";
const DESKTOP_CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";

describe("deviceTier (one tier per tab, decided by @gainratio/browser)", () => {
  it("a 3 GB iPhone is minimal whatever it reports", () => {
    expect(deviceTier({ userAgent: IPHONE, platform: "iPhone", maxTouchPoints: 5, hardwareConcurrency: 6 })).toBe(
      "minimal",
    );
  });

  it("iPadOS desktop mode (Macintosh UA + touch) is minimal", () => {
    expect(deviceTier({ userAgent: "Macintosh", platform: "MacIntel", maxTouchPoints: 5 })).toBe("minimal");
  });

  it("an 8 GB, 12-core desktop is full", () => {
    expect(deviceTier({ userAgent: DESKTOP_CHROME, deviceMemory: 8, hardwareConcurrency: 12 })).toBe("full");
  });

  it("a 4 GB Android and a 2-core laptop are lite", () => {
    expect(deviceTier({ userAgent: DESKTOP_CHROME, deviceMemory: 4, hardwareConcurrency: 8 })).toBe("lite");
    expect(deviceTier({ userAgent: DESKTOP_CHROME, deviceMemory: 8, hardwareConcurrency: 2 })).toBe("lite");
  });

  it("unknown memory (Firefox, desktop Safari) is lite, never full", () => {
    expect(deviceTier({ userAgent: DESKTOP_CHROME, hardwareConcurrency: 16 })).toBe("lite");
  });
});

describe("devicePolicy (pinned literals: what each tier may keep resident)", () => {
  it("minimal (3 GB iPhone): embedder released after 60 s idle, no bloom, dpr 1, no boot overlap", () => {
    expect(devicePolicy("minimal")).toEqual({
      tier: "minimal",
      embedderIdleReleaseMs: 60_000,
      forceFieldEffects: "none",
      forceFieldMaxDpr: 1,
      bootOverlapAllowed: false,
    });
  });

  it("lite (4 GB Android, 2-core laptop): embedder released after 120 s idle, lite bloom, dpr 1.5", () => {
    expect(devicePolicy("lite")).toEqual({
      tier: "lite",
      embedderIdleReleaseMs: 120_000,
      forceFieldEffects: "lite",
      forceFieldMaxDpr: 1.5,
      bootOverlapAllowed: false,
    });
  });

  it("full (>= 8 GB desktop): embedder released after 10 min idle, full bloom, dpr 2, overlap allowed", () => {
    expect(devicePolicy("full")).toEqual({
      tier: "full",
      embedderIdleReleaseMs: 600_000,
      forceFieldEffects: "full",
      forceFieldMaxDpr: 2,
      bootOverlapAllowed: true,
    });
  });

  it("every tier has a policy", () => {
    expect(Object.keys(DEVICE_POLICIES).sort()).toEqual(["full", "lite", "minimal"]);
  });
});
