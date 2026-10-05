// Main-thread client over the Pyodide chart Worker. The worker owns the heavy
// WASM Python runtime; the main thread only sends typed requests and awaits
// replies. One in-flight map keyed by request id correlates responses to
// promises (mirrors the edge-proc EngineClient).

import { verifyChartSnapshot } from "./chartSnapshot";
import type { SiderealChart } from "./chart";
import type { MeshEdgeContext } from "./mesh";
import type { PredictiveContexts } from "./predictive";
import type {
  BirthInput,
  BootConfig,
  BootProgress,
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
  readonly timeoutMs: number;
  readonly onProgress?: (progress: BootProgress) => void;
  /** Re-armed by boot progress; a boot's deadline is an idle deadline. */
  timer: ReturnType<typeof setTimeout>;
}

/** Maximum time a normal chart-worker request may remain unresolved. For a
 * `boot`, the time it may go WITHOUT PROGRESS: the ~17 MB Pyodide download
 * reports bytes as they arrive, so a slow link does not look like a hang. */
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

/**
 * The distinct ArrayBuffers behind the boot assets (wheels + ~20 MB of
 * ephemeris), each once: transferring moves them into the Worker instead of
 * structured-cloning a second copy, and a duplicate transferable throws.
 * SharedArrayBuffers are not transferable and are left to be cloned.
 */
function bootTransferables(config: BootConfig): readonly ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  for (const asset of [...config.wheels, ...config.skyfieldData]) {
    const buffer = asset.bytes.buffer;
    if (buffer instanceof ArrayBuffer) buffers.add(buffer);
  }
  return [...buffers];
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

  /** Boot Pyodide and load the AlmaMesh engine + ephemeris from `config`.
   * `onProgress` receives the Worker's boot progress (download bytes, then
   * each install stage); every report also re-arms the boot deadline. */
  public async boot(
    config: BootConfig,
    onProgress?: (progress: BootProgress) => void,
  ): Promise<void> {
    const response = await this.#send(
      { kind: "boot", id: this.#allocId(), config },
      onProgress,
      bootTransferables(config),
    );
    if (!response.ok) {
      throw new Error(response.error);
    }
  }

  /**
   * Compute a sidereal chart on-device. Requires a prior successful `boot`.
   * The chart crosses into the app only with a verified snapshot that names
   * this request's birth and analysis instants (`verifyChartSnapshot`).
   */
  public async generateChart(birth: BirthInput): Promise<SiderealChart> {
    const response = await this.#send({ kind: "generateChart", id: this.#allocId(), birth });
    if (response.ok && response.kind === "generateChart") {
      await verifyChartSnapshot(response.chart, birth);
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

  #send(
    request: ChartWorkerRequest,
    onProgress?: (progress: BootProgress) => void,
    transfer?: readonly Transferable[],
  ): Promise<ChartWorkerResponse> {
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
      const pending: Pending = {
        kind: request.kind,
        resolve,
        reject,
        timeoutMs,
        ...(onProgress === undefined ? {} : { onProgress }),
        timer: this.#deadline(request.id, request.kind, timeoutMs),
      };
      this.#pending.set(request.id, pending);
      try {
        if (transfer === undefined) this.#worker.postMessage(request);
        else this.#worker.postMessage(request, transfer);
      } catch (error) {
        this.#pending.delete(request.id);
        if (longRequest) {
          this.#longPending -= 1;
        }
        clearTimeout(pending.timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  #deadline(
    id: number,
    kind: ChartWorkerRequest["kind"],
    timeoutMs: number,
  ): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      this.#close(
        new Error(
          `chart worker request ${id} (${kind}) timed out after ${timeoutMs}ms${
            kind === "boot" ? " without progress" : ""
          }`,
        ),
      );
    }, timeoutMs);
  }

  #onMessage(response: ChartWorkerResponse): void {
    const pending = this.#pending.get(response.id);
    if (pending === undefined) {
      return;
    }
    if (response.ok && response.kind === "bootProgress") {
      if (pending.kind === "boot") {
        clearTimeout(pending.timer);
        pending.timer = this.#deadline(response.id, pending.kind, pending.timeoutMs);
        try {
          pending.onProgress?.(response.progress);
        } catch {
          // Observability must not fail or settle the boot.
        }
      }
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
