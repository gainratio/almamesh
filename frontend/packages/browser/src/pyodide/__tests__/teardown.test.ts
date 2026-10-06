import { describe, expect, it } from "vitest";

import {
  EngineBootCancelledError,
  isNetworkLoadFailure,
  observeOrphanedLoadFailures,
  trackPageTeardown,
} from "../teardown";

/** An `unhandledrejection`-shaped event: cancelable, carrying `reason`. */
function rejectionEvent(reason: unknown): Event {
  const event = new Event("unhandledrejection", { cancelable: true });
  Object.defineProperty(event, "reason", { value: reason });
  return event;
}

describe("isNetworkLoadFailure", () => {
  it.each([
    ["WebKit", "Load failed"],
    ["Chromium", "Failed to fetch"],
    ["Firefox", "NetworkError when attempting to fetch resource."],
  ])("classifies the %s fetch network failure as a load failure", (_engine, message) => {
    expect(isNetworkLoadFailure(new TypeError(message))).toBe(true);
  });

  it("does not classify an HTTP failure (Pyodide's own Error for a non-ok response)", () => {
    expect(isNetworkLoadFailure(new Error("Failed to load 'x.whl': request failed."))).toBe(false);
  });

  it("does not classify a plain Error carrying the WebKit text", () => {
    expect(isNetworkLoadFailure(new Error("Load failed"))).toBe(false);
  });

  it("does not classify an unrelated TypeError (a real bug)", () => {
    expect(isNetworkLoadFailure(new TypeError("x is not a function"))).toBe(false);
  });

  it("does not classify a non-error reason", () => {
    expect(isNetworkLoadFailure("Load failed")).toBe(false);
    expect(isNetworkLoadFailure(undefined)).toBe(false);
  });
});

describe("trackPageTeardown", () => {
  it("reports teardown after pagehide and clears it when the page is shown again (bfcache)", () => {
    const target = new EventTarget();
    const page = trackPageTeardown(target);
    expect(page.isTearingDown()).toBe(false);
    target.dispatchEvent(new Event("pagehide"));
    expect(page.isTearingDown()).toBe(true);
    target.dispatchEvent(new Event("pageshow"));
    expect(page.isTearingDown()).toBe(false);
  });
});

describe("observeOrphanedLoadFailures", () => {
  it("marks a network load failure handled while the runtime is not ready", () => {
    const scope = new EventTarget();
    observeOrphanedLoadFailures(scope, () => false);
    const event = rejectionEvent(new TypeError("Load failed"));
    scope.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("leaves a network load failure reported once the runtime is ready", () => {
    const scope = new EventTarget();
    observeOrphanedLoadFailures(scope, () => true);
    const event = rejectionEvent(new TypeError("Load failed"));
    scope.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("leaves any other rejection reported, even while the runtime is starting", () => {
    const scope = new EventTarget();
    observeOrphanedLoadFailures(scope, () => false);
    const event = rejectionEvent(new TypeError("x is not a function"));
    scope.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});

describe("EngineBootCancelledError", () => {
  it("is an Error whose name identifies a cancelled boot", () => {
    const error = new EngineBootCancelledError();
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("EngineBootCancelledError");
  });
});
