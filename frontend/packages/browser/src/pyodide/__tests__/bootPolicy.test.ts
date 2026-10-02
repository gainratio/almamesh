import { describe, expect, it } from "vitest";

import { decideBootPolicy, readBootSignals } from "../bootPolicy";
import type { BootSignals, NavigatorSignals } from "../bootPolicy";

const DESKTOP_CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";
const WINDOWS_CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";
const ANDROID_CHROME =
  "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.8010.12 Mobile Safari/537.36";
const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1";
const IPAD_DESKTOP_MODE =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Safari/605.1.15";
const FIREFOX_DESKTOP =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:128.0) Gecko/20100101 Firefox/128.0";

const desktop: BootSignals = {
  userAgent: DESKTOP_CHROME,
  platform: "MacIntel",
  maxTouchPoints: 0,
  deviceMemory: 8,
  hardwareConcurrency: 12,
  effectiveType: "4g",
  saveData: false,
};

describe("decideBootPolicy (decision table)", () => {
  it("desktop Chrome with >=4 GB and >=4 cores on 4g overlaps", () => {
    expect(decideBootPolicy(desktop)).toEqual({
      mode: "overlap",
      reason: expect.stringMatching(/8 GB.*12 cores/),
    });
  });

  it("low-end Windows (4 GB, 2 cores) is sequential: the two Workers would contend", () => {
    const decision = decideBootPolicy({
      ...desktop,
      userAgent: WINDOWS_CHROME,
      platform: "Win32",
      deviceMemory: 4,
      hardwareConcurrency: 2,
    });
    expect(decision.mode).toBe("sequential");
    expect(decision.reason).toMatch(/2 cores/);
  });

  it("budget Android (2 GB) is sequential: no second wasm heap during the sync", () => {
    const decision = decideBootPolicy({
      ...desktop,
      userAgent: ANDROID_CHROME,
      platform: "Linux armv8l",
      maxTouchPoints: 5,
      deviceMemory: 2,
      hardwareConcurrency: 8,
    });
    expect(decision.mode).toBe("sequential");
    expect(decision.reason).toMatch(/2 GB/);
  });

  it("iPhone Safari is sequential: memory-bound tab, no deviceMemory signal", () => {
    const decision = decideBootPolicy({
      userAgent: IPHONE_SAFARI,
      platform: "iPhone",
      maxTouchPoints: 5,
      hardwareConcurrency: 6,
    });
    expect(decision.mode).toBe("sequential");
    expect(decision.reason).toMatch(/iOS/);
  });

  it("iPadOS in desktop mode (Macintosh UA + touch) is still iOS", () => {
    const decision = decideBootPolicy({
      userAgent: IPAD_DESKTOP_MODE,
      platform: "MacIntel",
      maxTouchPoints: 5,
      hardwareConcurrency: 8,
    });
    expect(decision.mode).toBe("sequential");
    expect(decision.reason).toMatch(/iOS/);
  });

  it("a browser without deviceMemory (Firefox, desktop Safari) is sequential", () => {
    const decision = decideBootPolicy({
      userAgent: FIREFOX_DESKTOP,
      platform: "MacIntel",
      maxTouchPoints: 0,
      hardwareConcurrency: 8,
    });
    expect(decision.mode).toBe("sequential");
    expect(decision.reason).toMatch(/no deviceMemory/);
  });

  it("missing hardwareConcurrency is sequential even with plenty of memory", () => {
    const decision = decideBootPolicy({ ...desktop, hardwareConcurrency: undefined });
    expect(decision.mode).toBe("sequential");
    expect(decision.reason).toMatch(/cores/);
  });

  it("Save-Data is sequential whatever the hardware", () => {
    const decision = decideBootPolicy({ ...desktop, saveData: true });
    expect(decision.mode).toBe("sequential");
    expect(decision.reason).toMatch(/save-data/i);
  });

  it("a 3g (or slower) link is sequential: the sync is network-bound, overlap only lengthens the peak", () => {
    for (const effectiveType of ["slow-2g", "2g", "3g"]) {
      const decision = decideBootPolicy({ ...desktop, effectiveType });
      expect(decision.mode, effectiveType).toBe("sequential");
      expect(decision.reason).toMatch(/network/);
    }
  });

  it("an unknown effectiveType (no Network Information API) does not block overlap", () => {
    expect(decideBootPolicy({ ...desktop, effectiveType: undefined }).mode).toBe("overlap");
  });

  it("defaults to sequential when nothing is known", () => {
    expect(decideBootPolicy({ userAgent: "" }).mode).toBe("sequential");
  });
});

describe("readBootSignals", () => {
  it("reads the navigator fields the policy needs, including the Network Information API", () => {
    const nav: NavigatorSignals = {
      userAgent: ANDROID_CHROME,
      platform: "Linux armv8l",
      maxTouchPoints: 5,
      deviceMemory: 2,
      hardwareConcurrency: 8,
      connection: { saveData: true, effectiveType: "3g" },
    };
    expect(readBootSignals(nav)).toEqual({
      userAgent: ANDROID_CHROME,
      platform: "Linux armv8l",
      maxTouchPoints: 5,
      deviceMemory: 2,
      hardwareConcurrency: 8,
      saveData: true,
      effectiveType: "3g",
    });
  });

  it("tolerates a navigator without the optional fields (WebKit, Firefox)", () => {
    expect(readBootSignals({ userAgent: IPHONE_SAFARI })).toEqual({
      userAgent: IPHONE_SAFARI,
      platform: undefined,
      maxTouchPoints: undefined,
      deviceMemory: undefined,
      hardwareConcurrency: undefined,
      saveData: undefined,
      effectiveType: undefined,
    });
  });
});
