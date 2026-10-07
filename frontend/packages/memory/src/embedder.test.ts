import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createWorkerEmbedder,
  type EmbedWorkerRequest,
  type EmbedWorkerResponse,
} from "./embedder";

/** A stand-in for the model Worker: answers each request with one 1-dim vector per text. */
class FakeWorker {
  terminated = false;
  readonly requests: EmbedWorkerRequest[] = [];
  #listener: ((event: MessageEvent<EmbedWorkerResponse>) => void) | undefined;
  #errorListener: (() => void) | undefined;

  addEventListener(type: "message" | "error", listener: (event: MessageEvent<EmbedWorkerResponse>) => void): void {
    if (type === "error") this.#errorListener = listener as () => void;
    else this.#listener = listener;
  }

  /** The worker died (e.g. out of memory while loading the model). */
  crash(): void {
    this.#errorListener?.();
  }

  postMessage(request: EmbedWorkerRequest): void {
    this.requests.push(request);
  }

  /** Answer the oldest unanswered request. */
  answer(): void {
    const request = this.requests.shift();
    if (request === undefined) throw new Error("no request to answer");
    const response: EmbedWorkerResponse = { id: request.id, ok: true, vectors: request.texts.map(() => [1]) };
    this.#listener?.({ data: response } as MessageEvent<EmbedWorkerResponse>);
  }

  terminate(): void {
    this.terminated = true;
  }
}

function harness(idleReleaseMs: number) {
  const spawned: FakeWorker[] = [];
  const released = vi.fn();
  const embedder = createWorkerEmbedder({
    idleReleaseMs,
    onRelease: released,
    spawn: () => {
      const worker = new FakeWorker();
      spawned.push(worker);
      return worker as unknown as Worker;
    },
  });
  return { embedder, spawned, released };
}

describe("createWorkerEmbedder idle release", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not spawn the model worker before the first embed", () => {
    const { spawned } = harness(60_000);
    expect(spawned).toHaveLength(0);
  });

  it("terminates the model worker after the idle window and respawns on the next embed", async () => {
    const { embedder, spawned, released } = harness(60_000);
    const first = embedder.embed(["career"]);
    spawned[0]?.answer();
    await expect(first).resolves.toHaveLength(1);

    vi.advanceTimersByTime(59_999);
    expect(spawned[0]?.terminated).toBe(false);
    vi.advanceTimersByTime(1);
    expect(spawned[0]?.terminated).toBe(true);
    expect(released).toHaveBeenCalledTimes(1);

    const second = embedder.embed(["health"]);
    expect(spawned).toHaveLength(2);
    spawned[1]?.answer();
    await expect(second).resolves.toHaveLength(1);
  });

  it("never terminates while an embed is in flight", async () => {
    const { embedder, spawned } = harness(1_000);
    const slow = embedder.embed(["slow"]);
    vi.advanceTimersByTime(10_000);
    expect(spawned[0]?.terminated).toBe(false);
    spawned[0]?.answer();
    await expect(slow).resolves.toHaveLength(1);
    vi.advanceTimersByTime(1_000);
    expect(spawned[0]?.terminated).toBe(true);
  });

  it("a new embed inside the idle window keeps the same worker warm", async () => {
    const { embedder, spawned } = harness(1_000);
    const first = embedder.embed(["a"]);
    spawned[0]?.answer();
    await first;
    vi.advanceTimersByTime(900);
    const second = embedder.embed(["b"]);
    spawned[0]?.answer();
    await second;
    vi.advanceTimersByTime(900);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.terminated).toBe(false);
    vi.advanceTimersByTime(100);
    expect(spawned[0]?.terminated).toBe(true);
  });

  it("keeps the worker for the session when idleReleaseMs is Infinity", async () => {
    const { embedder, spawned } = harness(Number.POSITIVE_INFINITY);
    const first = embedder.embed(["a"]);
    spawned[0]?.answer();
    await first;
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(spawned[0]?.terminated).toBe(false);
  });

  it("rejects every in-flight embed and drops the worker when it dies, then respawns", async () => {
    const { embedder, spawned, released } = harness(60_000);
    const first = embedder.embed(["a"]);
    const second = embedder.embed(["b"]);
    spawned[0]?.crash();
    await expect(first).rejects.toThrow(/embedder worker failed/);
    await expect(second).rejects.toThrow(/embedder worker failed/);
    expect(spawned[0]?.terminated).toBe(true);
    expect(released).toHaveBeenCalledTimes(1);
    const third = embedder.embed(["c"]);
    expect(spawned).toHaveLength(2);
    spawned[1]?.answer();
    await expect(third).resolves.toHaveLength(1);
  });
});
