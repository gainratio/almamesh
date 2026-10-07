/**
 * The embedding boundary. `Embedder` is the only contract the RAG pipeline
 * depends on, so tests inject a deterministic stub and never load the real
 * model. In the browser, {@link createWorkerEmbedder} runs the model OFF the UI
 * thread in {@link ./embedder.worker} and entirely on-device (zero network).
 *
 * NOTE: the heavy `@huggingface/transformers` import lives ONLY in the worker
 * module; this file references the worker by URL, so importing it in Node/tests
 * does not pull in the model runtime.
 */

/** A pluggable text → embedding function. Vectors are L2-normalized Float32. */
export interface Embedder {
  /** Embed each input string; result order matches input order. */
  embed(texts: readonly string[]): Promise<Float32Array[]>;
}

/** Request sent to the embedder worker. */
export interface EmbedWorkerRequest {
  readonly id: number;
  readonly texts: readonly string[];
}

/** Response from the embedder worker. */
export interface EmbedWorkerResponse {
  readonly id: number;
  readonly ok: boolean;
  readonly vectors?: readonly number[][];
  readonly error?: string;
}

interface Pending {
  readonly resolve: (vectors: Float32Array[]) => void;
  readonly reject: (error: Error) => void;
}

/** Lifetime of the model worker. */
export interface WorkerEmbedderOptions {
  /**
   * Terminate the model worker after this many ms with no embed in flight, so
   * its model, onnxruntime wasm heap and compiled code (about +95 MiB heap,
   * more in process memory) go back to the OS; the next embed respawns it.
   * `Infinity` keeps it for the session. Default: Infinity.
   */
  readonly idleReleaseMs?: number;
  /** Called after an idle release (the next embed reloads the model). */
  readonly onRelease?: () => void;
  /** Worker factory; tests inject a fake. */
  readonly spawn?: () => Worker;
}

function spawnModelWorker(): Worker {
  return new Worker(new URL("./embedder.worker.ts", import.meta.url), {
    type: "module",
  });
}

/**
 * Spin up the model worker lazily (on first `embed`) and marshal embed
 * requests/responses across the worker boundary. Vectors cross as plain number
 * arrays and are rehydrated to `Float32Array` on the main thread. With
 * `idleReleaseMs`, the worker is terminated once idle and respawned on demand.
 */
export function createWorkerEmbedder(options: WorkerEmbedderOptions = {}): Embedder {
  const idleReleaseMs = options.idleReleaseMs ?? Number.POSITIVE_INFINITY;
  const spawn = options.spawn ?? spawnModelWorker;
  let worker: Worker | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let nextId = 0;
  const pending = new Map<number, Pending>();

  function release(): void {
    idleTimer = undefined;
    if (worker === undefined || pending.size > 0) {
      return;
    }
    worker.terminate();
    worker = undefined;
    options.onRelease?.();
  }

  function scheduleRelease(): void {
    if (pending.size > 0 || !Number.isFinite(idleReleaseMs)) {
      return;
    }
    idleTimer = setTimeout(release, idleReleaseMs);
  }

  function settle(event: MessageEvent<EmbedWorkerResponse>): void {
    const { id, ok, vectors, error } = event.data;
    const slot = pending.get(id);
    if (slot === undefined) {
      return;
    }
    pending.delete(id);
    if (ok && vectors !== undefined) {
      slot.resolve(vectors.map((v) => new Float32Array(v)));
    } else {
      slot.reject(new Error(error ?? "embedder worker failed"));
    }
    scheduleRelease();
  }

  /**
   * The worker died (e.g. out of memory while reloading the model after an idle
   * release). Reject every in-flight embed instead of leaving it pending forever,
   * and drop the worker so the next embed spawns a fresh one.
   */
  function fail(dead: Worker): void {
    if (worker !== dead) {
      return;
    }
    clearTimeout(idleTimer);
    idleTimer = undefined;
    worker = undefined;
    dead.terminate();
    const failed = [...pending.values()];
    pending.clear();
    for (const slot of failed) {
      slot.reject(new Error("embedder worker failed"));
    }
    options.onRelease?.();
  }

  function ensureWorker(): Worker {
    clearTimeout(idleTimer);
    idleTimer = undefined;
    if (worker === undefined) {
      const spawned = spawn();
      spawned.addEventListener("message", settle);
      spawned.addEventListener("error", () => fail(spawned));
      worker = spawned;
    }
    return worker;
  }

  return {
    embed(texts: readonly string[]): Promise<Float32Array[]> {
      if (texts.length === 0) {
        return Promise.resolve([]);
      }
      const active = ensureWorker();
      const id = nextId;
      nextId += 1;
      return new Promise<Float32Array[]>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        const request: EmbedWorkerRequest = { id, texts };
        active.postMessage(request);
      });
    },
  };
}
