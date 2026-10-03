import { beforeEach, describe, expect, it, vi } from "vitest";

import { ChartEngineClient } from "../chartEngineClient";
import type { SiderealChart } from "../chart";
import type { MeshEdgeContext } from "../mesh";
import type { PredictiveContexts } from "../predictive";
import type {
  BootConfig,
  BootProgress,
  BirthInput,
  ChartWorkerRequest,
  ChartWorkerResponse,
  MeshEdgeInput,
  PredictiveInput,
  RectificationInput,
  RectificationResultRaw,
  WorkerLike,
} from "../protocol";

const BIRTH: BirthInput = {
  datetimeUtc: "1990-01-15T12:00:00+00:00",
  latitude: 28.6139,
  longitude: 77.209,
  referenceDate: "2020-06-01T00:00:00+00:00",
};

const PYODIDE_INDEX_URL = "https://example.test/pyodide/";

// A fresh config per boot: `boot` TRANSFERS the asset buffers, which detaches
// them on this side, so a config cannot be booted twice (as in a real Worker).
const bootConfig = (): BootConfig => ({
  pyodideIndexUrl: PYODIDE_INDEX_URL,
  wheels: [{ filename: "almamesh-0.1.0-py3-none-any.whl", bytes: new Uint8Array([1, 2, 3]) }],
  skyfieldData: [{ filename: "de421.bsp", bytes: new Uint8Array([4, 5, 6]) }],
});

const STUB_CHART = { ayanamsa_value: 23.7 } as unknown as SiderealChart;

const PREDICTIVE_INPUT: PredictiveInput = {
  datetimeUtc: "1990-01-15T12:00:00+00:00",
  latitude: 28.6139,
  longitude: 77.209,
  referenceInstant: "2026-06-09T12:00:00+00:00",
};

const STUB_PREDICTIVE = {
  transit_context: { instant: "2026-06-09T12:00:00+00:00" },
} as unknown as PredictiveContexts;

const RECTIFICATION_INPUT: RectificationInput = {
  datetimeUtc: "1988-08-08T01:14:00+00:00",
  latitude: 12.9716,
  longitude: 77.5946,
  utcOffsetMinutes: 330,
  events: [{ date: "2015-02-14", category: "marriage" }],
  mode: "window",
  spanMinutes: 120,
  referenceDate: "2025-01-01T00:00:00+00:00",
};

const STUB_RECTIFICATION = {
  mode: "window",
  candidates: [],
  margin: 0,
  band: "near_tie",
  discriminating_event_count: 0,
  recorded_time_sign: null,
  honesty_note_key: "rectify.honesty.near_tie",
} as unknown as RectificationResultRaw;

const MESH_INPUT: MeshEdgeInput = {
  a: { datetimeUtc: "1990-01-15T12:00:00+00:00", latitude: 28.6139, longitude: 77.209 },
  b: { datetimeUtc: "1985-07-23T04:30:00+00:00", latitude: 19.076, longitude: 72.8777 },
  relationship: "spouse",
  roleA: "bride",
  roleB: "groom",
  windowStart: "2025-01-01T00:00:00+00:00",
  windowEnd: "2027-01-01T00:00:00+00:00",
  referenceInstant: "2025-01-01T00:00:00+00:00",
};

const STUB_MESH_EDGE = {
  relationship: "spouse",
  role_a: "bride",
  role_b: "groom",
} as unknown as MeshEdgeContext;

/**
 * A scripted worker double: each posted request is answered by `reply`, async,
 * so the client's id-correlation and promise plumbing are exercised for real.
 */
class FakeChartWorker implements WorkerLike {
	public readonly posted: ChartWorkerRequest[] = [];
	/** The transfer list of each post ([] when none): what the real Worker would detach. */
	public readonly transfers: (readonly Transferable[])[] = [];
	public terminated = false;
	#listener: ((event: MessageEvent<ChartWorkerResponse>) => void) | undefined;
	#errorListener: ((event: { message?: string }) => void) | undefined;
	#messageErrorListener: (() => void) | undefined;

  public constructor(
    private readonly reply: (req: ChartWorkerRequest) => ChartWorkerResponse | null,
  ) {}

  public postMessage(message: ChartWorkerRequest, transfer?: readonly Transferable[]): void {
    // structuredClone with a transfer list detaches the caller's buffers exactly
    // as a real Worker.postMessage does, so the tests see the real property.
    this.posted.push(transfer ? structuredClone(message, { transfer: [...transfer] }) : message);
    this.transfers.push(transfer ?? []);
    const response = this.reply(message);
    if (response !== null) {
      queueMicrotask(() => {
        this.#listener?.(new MessageEvent("message", { data: response }));
      });
    }
  }

	public addEventListener(
		type: "message" | "error" | "messageerror",
		listener:
			| ((event: MessageEvent<ChartWorkerResponse>) => void)
			| ((event: { message?: string }) => void)
			| (() => void),
	): void {
		if (type === "message") {
			this.#listener = listener as (event: MessageEvent<ChartWorkerResponse>) => void;
		} else if (type === "error") {
			this.#errorListener = listener as (event: { message?: string }) => void;
		} else {
			this.#messageErrorListener = listener as () => void;
		}
  }

	public terminate(): void {
		this.terminated = true;
	}

	public emitError(message: string): void {
		this.#errorListener?.({ message });
	}

	public emitMessageError(): void {
		this.#messageErrorListener?.();
	}

	public respond(response: ChartWorkerResponse): void {
		this.#listener?.(new MessageEvent("message", { data: response }));
	}
}

describe("ChartEngineClient", () => {
  let worker: FakeChartWorker;

  const withReply = (reply: (req: ChartWorkerRequest) => ChartWorkerResponse | null) => {
    worker = new FakeChartWorker(reply);
    return new ChartEngineClient(worker);
  };

  beforeEach(() => {
    worker = new FakeChartWorker(() => null);
  });

  it("boots by forwarding the config and resolving on a boot-ok reply", async () => {
    const client = withReply((req) => ({ ok: true, kind: "boot", id: req.id }));

    await client.boot(bootConfig());

    expect(worker.posted[0]).toMatchObject({ kind: "boot", config: bootConfig() });
  });

  it("boot transfers the asset buffers to the Worker instead of copying them", async () => {
    const wheel = new Uint8Array([1, 2, 3]);
    const ephemeris = new Uint8Array([4, 5, 6]);
    const config: BootConfig = {
      pyodideIndexUrl: PYODIDE_INDEX_URL,
      wheels: [{ filename: "almamesh-0.1.0-py3-none-any.whl", bytes: wheel }],
      skyfieldData: [{ filename: "de421.bsp", bytes: ephemeris }],
    };
    const client = withReply((req) => ({ ok: true, kind: "boot", id: req.id }));

    await client.boot(config);

    expect(worker.transfers[0]).toHaveLength(2);
    expect(worker.transfers[0][0]).toBe(wheel.buffer);
    expect(worker.transfers[0][1]).toBe(ephemeris.buffer);
    // The main-thread copies are gone (detached), the Worker got the bytes.
    expect(wheel.byteLength).toBe(0);
    expect(ephemeris.byteLength).toBe(0);
    expect(worker.posted[0]).toMatchObject({
      kind: "boot",
      config: { wheels: [{ bytes: new Uint8Array([1, 2, 3]) }], skyfieldData: [{ bytes: new Uint8Array([4, 5, 6]) }] },
    });
  });

  it("boot transfers a buffer shared by two assets only once (a duplicate transferable throws)", async () => {
    const shared = new ArrayBuffer(6);
    const config: BootConfig = {
      pyodideIndexUrl: PYODIDE_INDEX_URL,
      wheels: [{ filename: "a.whl", bytes: new Uint8Array(shared, 0, 3) }],
      skyfieldData: [{ filename: "de421.bsp", bytes: new Uint8Array(shared, 3, 3) }],
    };
    const client = withReply((req) => ({ ok: true, kind: "boot", id: req.id }));

    await client.boot(config);

    expect(worker.transfers[0]).toEqual([shared]);
  });

  it("prewarm posts the Pyodide index URL as a one-way message", () => {
    const client = withReply(() => null);

    client.prewarm(PYODIDE_INDEX_URL);

    expect(worker.posted[0]).toMatchObject({
      kind: "prewarm",
      pyodideIndexUrl: PYODIDE_INDEX_URL,
    });
  });

  it("prewarm never arms the request timeout: a slow download must not kill the worker", async () => {
    worker = new FakeChartWorker(() => null);
    const client = new ChartEngineClient(worker, { requestTimeoutMs: 5 });

    client.prewarm(PYODIDE_INDEX_URL);
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(worker.terminated).toBe(false);
    const booting = client.boot(bootConfig());
    worker.respond({ ok: true, kind: "boot", id: (worker.posted[1] as { id: number }).id });
    await expect(booting).resolves.toBeUndefined();
  });

  it("ignores a late prewarm reply or error (boot reports any warm-up failure)", async () => {
    const client = withReply((req) =>
      req.kind === "prewarm"
        ? { ok: false, id: req.id, error: "pyodide fetch failed" }
        : { ok: true, kind: "boot", id: req.id },
    );

    client.prewarm(PYODIDE_INDEX_URL);
    await expect(client.boot(bootConfig())).resolves.toBeUndefined();
  });

  // The boot deadline is an IDLE deadline. Pyodide is ~17 MB; on slow 4G the
  // download alone outlives a 60 s wall clock, so the Worker reports progress
  // (download bytes, then each install stage) and each report re-arms it.
  it("re-arms the boot deadline on each bootProgress message and forwards it", async () => {
    vi.useFakeTimers();
    try {
      worker = new FakeChartWorker(() => null);
      const client = new ChartEngineClient(worker, { requestTimeoutMs: 50 });
      const seen: BootProgress[] = [];
      const pending = client.boot(bootConfig(), (progress) => seen.push(progress));
      let settled = false;
      pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      const id = worker.posted[0]?.id ?? 0;
      for (let tick = 0; tick < 5; tick += 1) {
        await vi.advanceTimersByTimeAsync(40);
        worker.respond({
          ok: true,
          kind: "bootProgress",
          id,
          progress: { stage: "pyodide", bytesReceived: tick * 1_000, bytesTotal: 5_000 },
        });
      }
      // 200 ms: four deadlines' worth, but never 50 ms without progress.
      expect(settled).toBe(false);
      expect(worker.terminated).toBe(false);
      expect(seen).toHaveLength(5);
      expect(seen[4]).toEqual({ stage: "pyodide", bytesReceived: 4_000, bytesTotal: 5_000 });

      worker.respond({ ok: true, kind: "boot", id });
      await expect(pending).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("generates a chart, returning the worker's chart payload", async () => {
    const client = withReply((req) => ({
      ok: true,
      kind: "generateChart",
      id: req.id,
      chart: STUB_CHART,
    }));

    const chart = await client.generateChart(BIRTH);

    expect(chart).toBe(STUB_CHART);
    expect(worker.posted[0]).toMatchObject({ kind: "generateChart", birth: BIRTH });
  });

  it("computes the lazy predictive payload, forwarding the explicit reference instant", async () => {
    const client = withReply((req) => ({
      ok: true,
      kind: "computePredictive",
      id: req.id,
      predictive: STUB_PREDICTIVE,
    }));

    const predictive = await client.computePredictive(PREDICTIVE_INPUT);

    expect(predictive).toBe(STUB_PREDICTIVE);
    expect(worker.posted[0]).toMatchObject({
      kind: "computePredictive",
      input: PREDICTIVE_INPUT,
    });
  });

  it("rejects computePredictive with the worker's error message", async () => {
    const client = withReply((req) => ({ ok: false, id: req.id, error: "engine not booted" }));

    await expect(client.computePredictive(PREDICTIVE_INPUT)).rejects.toThrow("engine not booted");
  });

  it("computes the mesh edge, forwarding both births + relationship/roles + the explicit window", async () => {
    const client = withReply((req) => ({
      ok: true,
      kind: "computeMeshEdge",
      id: req.id,
      meshEdge: STUB_MESH_EDGE,
    }));

    const meshEdge = await client.computeMeshEdge(MESH_INPUT);

    expect(meshEdge).toBe(STUB_MESH_EDGE);
    expect(worker.posted[0]).toMatchObject({
      kind: "computeMeshEdge",
      input: MESH_INPUT,
    });
  });

  it("rejects computeMeshEdge with the worker's error message", async () => {
    const client = withReply((req) => ({
      ok: false,
      id: req.id,
      error: "role_a and role_b must differ (one bride, one groom)",
    }));

    await expect(client.computeMeshEdge(MESH_INPUT)).rejects.toThrow(
      "role_a and role_b must differ",
    );
  });

  it("rejects with the worker's error message", async () => {
    const client = withReply((req) => ({ ok: false, id: req.id, error: "ephemeris missing" }));

    await expect(client.generateChart(BIRTH)).rejects.toThrow("ephemeris missing");
  });

  it("correlates concurrent requests by id even when replies arrive out of order", async () => {
    const client = withReply((req) => {
      if (req.kind !== "generateChart") {
        return { ok: true, kind: "boot", id: req.id };
      }
      // Answer the second request first to prove correlation is by id, not order.
      const chart = { ayanamsa_value: req.id } as unknown as SiderealChart;
      return { ok: true, kind: "generateChart", id: req.id, chart };
    });

    const [first, second] = await Promise.all([
      client.generateChart(BIRTH),
      client.generateChart(BIRTH),
    ]);

    expect(first.ayanamsa_value).not.toBe(second.ayanamsa_value);
  });

	it("terminates the underlying worker", () => {
    const client = withReply(() => null);

    client.terminate();

		expect(worker.terminated).toBe(true);
	});

	it("rejects every pending request when the worker crashes", async () => {
		const client = withReply(() => null);
		const pending = client.generateChart(BIRTH);
		worker.emitError("Pyodide initialization failed");
		await expect(pending).rejects.toThrow(/Pyodide initialization failed/);
	});

	it("rejects pending requests when a worker reply cannot be deserialized", async () => {
		const client = withReply(() => null);
		const pending = client.computePredictive(PREDICTIVE_INPUT);
		worker.emitMessageError();
		await expect(pending).rejects.toThrow(/messageerror/);
	});

	it("bounds a silent request and terminates the worker", async () => {
		const client = new ChartEngineClient(worker, { requestTimeoutMs: 5 });
		const pending = client.generateChart(BIRTH);
		await expect(pending).rejects.toThrow(/timed out/);
		expect(worker.terminated).toBe(true);
	});

	it("does not expire a chart request while a heavy predictive request occupies the worker", async () => {
		vi.useFakeTimers();
		try {
			const client = new ChartEngineClient(worker);
			const predictive = client.computePredictive(PREDICTIVE_INPUT);
			const chart = client.generateChart(BIRTH);
			const [predictiveRequest, chartRequest] = worker.posted;

			vi.advanceTimersByTime(60_001);
			expect(worker.terminated).toBe(false);

			worker.respond({
				ok: true,
				kind: "computePredictive",
				id: predictiveRequest.id,
				predictive: STUB_PREDICTIVE,
			});
			worker.respond({
				ok: true,
				kind: "generateChart",
				id: chartRequest.id,
				chart: STUB_CHART,
			});

			await expect(predictive).resolves.toBe(STUB_PREDICTIVE);
			await expect(chart).resolves.toBe(STUB_CHART);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not expire a chart request while a rectification sweep occupies the worker", async () => {
		vi.useFakeTimers();
		try {
			const client = new ChartEngineClient(worker);
			const rectification = client.computeRectification(RECTIFICATION_INPUT);
			const chart = client.generateChart(BIRTH);
			const [rectificationRequest, chartRequest] = worker.posted;

			vi.advanceTimersByTime(60_001);
			expect(worker.terminated).toBe(false);

			worker.respond({
				ok: true,
				kind: "computeRectification",
				id: rectificationRequest.id,
				rectification: STUB_RECTIFICATION,
			});
			worker.respond({
				ok: true,
				kind: "generateChart",
				id: chartRequest.id,
				chart: STUB_CHART,
			});

			await expect(rectification).resolves.toBe(STUB_RECTIFICATION);
			await expect(chart).resolves.toBe(STUB_CHART);
		} finally {
			vi.useRealTimers();
		}
	});

	it("terminate rejects pending requests instead of leaving them hanging", async () => {
		const client = withReply(() => null);
		const pending = client.boot(bootConfig());
		client.terminate();
		await expect(pending).rejects.toThrow(/terminated/);
	});
});
