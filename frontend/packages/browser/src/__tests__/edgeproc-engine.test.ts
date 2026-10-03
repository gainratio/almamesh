import { describe, expect, it } from "vitest";

import {
  classifyEngineError,
  EngineClient,
  MemoryCacheStore,
  syncIndex,
} from "@gainratio/browser";

// Proves the pinned standalone browser Lego resolves through its supported root
// API. Worker construction stays consumer-owned so Vite emits one Worker asset.
describe("@gainratio/browser dependency", () => {
  it("exposes the injected-worker client and the sync state machine", () => {
    expect(typeof EngineClient).toBe("function");
    expect("spawn" in EngineClient).toBe(false);
    expect(typeof syncIndex).toBe("function");
  });

  it("runs the in-memory content-addressed store: a fresh store has no active version", async () => {
    const store = new MemoryCacheStore();

    expect(await store.readActive()).toBeNull();
  });

  it("preserves lock contention as its own stable worker error code", () => {
    expect(classifyEngineError(new Error("timed out acquiring OPFS mutation lock"))).toEqual({
      code: "lock",
      message: "timed out acquiring OPFS mutation lock",
    });
  });
});
