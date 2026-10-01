// Main-thread client over the Pyodide chart Worker. The worker owns the heavy
// WASM Python runtime; the main thread only sends typed requests and awaits
// replies. One in-flight map keyed by request id correlates responses to
// promises (mirrors the edge-proc EngineClient).

import type { SiderealChart } from "./chart";
import type { MeshEdgeContext } from "./mesh";
import type { PredictiveContexts } from "./predictive";
import type {
  BirthInput,
  BootConfig,
  ChartWorkerRequest,
  ChartWorkerResponse,
  MeshEdgeInput,
  PredictiveInput,
  WorkerLike,
} from "./protocol";
import type { RectificationInput, RectificationResultRaw } from "./rectification";

interface Pending {
  readonly kind: ChartWorkerRequest["kind"];
  readonly resolve: (response: ChartWorkerResponse) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** Maximum time a normal chart-worker request may remain unresolved. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/** Predictive contexts can occupy the serial Pyodide worker for several minutes. */
export const DEFAULT_PREDICTIVE_REQUEST_TIMEOUT_MS = 180_000;

/** Whole-day rectification sweeps can occupy the same worker for several minutes. */
export const DEFAULT_RECTIFICATION_REQUEST_TIMEOUT_MS = 180_000;

export interface ChartEngineClientOptions {
  readonly requestTimeoutMs?: number;
  readonly predictiveRequestTimeoutMs?: number;
  readonly rectificationRequestTimeoutMs?: number;
}

export class ChartEngineClient {
  readonly #worker: WorkerLike;
  readonly #pending = new Map<number, Pending>();
  readonly #timeoutMs: number;
  readonly #predictiveTimeoutMs: number;
  readonly #rectificationTimeoutMs: number;
  #nextId = 0;
  #closed: Error | null = null;
  #longPending = 0;

  public constructor(worker: WorkerLike, options: ChartEngineClientOptions = {}) {
    this.#worker = worker;
    this.#timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#predictiveTimeoutMs =
      options.predictiveRequestTimeoutMs ?? DEFAULT_PREDICTIVE_REQUEST_TIMEOUT_MS;
    this.#rectificationTimeoutMs =
      options.rectificationRequestTimeoutMs ?? DEFAULT_RECTIFICATION_REQUEST_TIMEOUT_MS;
    this.#worker.addEventListener("message", (event) => {
      this.#onMessage(event.data);
    });
    this.#worker.addEventListener("error", (event) => {
      this.#close(new Error(`chart worker failed: ${event.message ?? "unknown error"}`));
    });
    this.#worker.addEventListener("messageerror", () => {
      this.#close(new Error("chart worker failed: messageerror"));
    });
  }

  /** Spawn the bundled Pyodide chart Worker (module worker). */
  public static spawn(): ChartEngineClient {
    const worker = new Worker(new URL("./chartWorker.ts", import.meta.url), {
      type: "module",
    });
    return new ChartEngineClient(worker as unknown as WorkerLike);
  }

  /**
   * Start loading Pyodide + its stdlib packages from `pyodideIndexUrl` before
   * the bundle bytes exist; `boot` then reuses the warm runtime.
   *
   * ONE-WAY on purpose: no pending entry and no timeout. The warm-up overlaps
   * the bundle download, so on a slow link it can legitimately outlast the
   * request budget — and a timed-out request closes the Worker. `boot` stays
   * the single bounded request and awaits (and reports) the same warm-up.
   */
  public prewarm(pyodideIndexUrl: string): void {
    if (this.#closed !== null) {
      return;
    }
    this.#worker.postMessage({ kind: "prewarm", id: this.#allocId(), pyodideIndexUrl });
  }

  /** Boot Pyodide and load the AlmaMesh engine + ephemeris from `config`. */
  public async boot(config: BootConfig): Promise<void> {
    const response = await this.#send({ kind: "boot", id: this.#allocId(), config });
    if (!response.ok) {
      throw new Error(response.error);
    }
  }

  /** Compute a sidereal chart on-device. Requires a prior successful `boot`. */
  public async generateChart(birth: BirthInput): Promise<SiderealChart> {
    const response = await this.#send({ kind: "generateChart", id: this.#allocId(), birth });
    if (response.ok && response.kind === "generateChart") {
      return response.chart;
    }
    throw new Error(response.ok ? "unexpected response kind" : response.error);
  }

  /**
   * Compute the LAZY predictive payload (transits + vargas + strength + life
   * domains) on-device at the EXPLICIT `input.referenceInstant`. Requires a
   * prior successful `boot`. Heavy: ~35s under Pyodide — call lazily, never on
   * the natal chart path.
   */
  public async computePredictive(input: PredictiveInput): Promise<PredictiveContexts> {
    const response = await this.#send({ kind: "computePredictive", id: this.#allocId(), input });
    if (response.ok && response.kind === "computePredictive") {
      return response.predictive;
    }
    throw new Error(response.ok ? "unexpected response kind" : response.error);
  }

  /**
   * Compute the relational MESH edge between two birth inputs on-device.
   * Both natal contexts are recomputed inside the worker (fast — no chart
   * crosses the boundary); every instant (`referenceInstant`, the synchrony
   * window) is EXPLICIT. Requires a prior successful `boot`.
   */
  public async computeMeshEdge(input: MeshEdgeInput): Promise<MeshEdgeContext> {
    const response = await this.#send({ kind: "computeMeshEdge", id: this.#allocId(), input });
    if (response.ok && response.kind === "computeMeshEdge") {
      return response.meshEdge;
    }
    throw new Error(response.ok ? "unexpected response kind" : response.error);
  }

  /**
   * Compute birth-time rectification on-device by scoring the user-supplied
   * life events against Ascendant-sign candidates. Requires a prior successful
   * `boot`. Lighter than predictive (~5s under Pyodide).
   */
  public async computeRectification(input: RectificationInput): Promise<RectificationResultRaw> {
    const response = await this.#send({ kind: "computeRectification", id: this.#allocId(), input });
    if (response.ok && response.kind === "computeRectification") {
      return response.rectification;
    }
    throw new Error(response.ok ? "unexpected response kind" : response.error);
  }

  public terminate(): void {
    this.#close(new Error("chart worker terminated"));
  }

  #allocId(): number {
    this.#nextId += 1;
    return this.#nextId;
  }

  #send(request: ChartWorkerRequest): Promise<ChartWorkerResponse> {
    if (this.#closed !== null) {
      return Promise.reject(this.#closed);
    }
    return new Promise<ChartWorkerResponse>((resolve, reject) => {
      const longRequest =
        request.kind === "computePredictive" || request.kind === "computeRectification";
      const timeoutMs =
        request.kind === "computePredictive"
          ? this.#predictiveTimeoutMs
          : request.kind === "computeRectification"
            ? this.#rectificationTimeoutMs
            : this.#longPending > 0
              ? Math.max(this.#predictiveTimeoutMs, this.#rectificationTimeoutMs)
              : this.#timeoutMs;
      if (longRequest) {
        this.#longPending += 1;
      }
      const timer = setTimeout(() => {
        this.#close(
          new Error(
            `chart worker request ${request.id} (${request.kind}) timed out after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
      this.#pending.set(request.id, { kind: request.kind, resolve, reject, timer });
      try {
        this.#worker.postMessage(request);
      } catch (error) {
        this.#pending.delete(request.id);
        if (longRequest) {
          this.#longPending -= 1;
        }
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  #onMessage(response: ChartWorkerResponse): void {
    const pending = this.#pending.get(response.id);
    if (pending === undefined) {
      return;
    }
    this.#pending.delete(response.id);
    if (pending.kind === "computePredictive" || pending.kind === "computeRectification") {
      this.#longPending -= 1;
    }
    clearTimeout(pending.timer);
    pending.resolve(response);
  }

  #close(error: Error): void {
    if (this.#closed !== null) {
      return;
    }
    this.#closed = error;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    this.#longPending = 0;
    this.#worker.terminate();
  }
}
