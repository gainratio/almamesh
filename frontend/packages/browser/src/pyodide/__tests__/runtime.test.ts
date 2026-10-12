import { describe, expect, it, vi } from "vitest";

import { AlmaMeshRuntime } from "../runtime";
import type { ChartEngine, ChartEnginePort, EnginePort, RuntimeConfig } from "../runtime";
import type { SiderealChart } from "../chart";
import type { MeshEdgeContext } from "../mesh";
import type { PredictiveContexts } from "../predictive";
import type {
  BirthInput,
  BootConfig,
  BootProgress,
  MeshEdgeInput,
  MoonWindow,
  MoonWindowInput,
  PredictiveInput,
} from "../protocol";
import type { RectificationInput, RectificationResultRaw } from "../rectification";
import type { SyncProgress, SyncResult } from "@gainratio/browser";
import type { BootStage, IdleScheduler } from "../runtime";
import { EngineBootCancelledError } from "../teardown";
import { errorFromWorker } from "../bootFault";
import { ChartEngineClient } from "../chartEngineClient";
import type { ChartWorkerRequest, ChartWorkerResponse, WorkerLike } from "../protocol";

const CONFIG: RuntimeConfig = {
  bundleBaseUrl: "https://cdn.test/almamesh",
  pubkeyUrl: "https://app.test/public.key",
  expectedBundleId: "almamesh-constructs",
  expectedChannel: "stable",
  pyodideIndexUrl: "https://app.test/pyodide/",
  wheelPaths: [
    "wheels/jplephem-2.23-py3-none-any.whl",
    "wheels/almamesh-0.1.0-py3-none-any.whl",
  ],
  skyfieldDataPaths: ["data/de421.bsp", "data/finals2000A.all"],
};

const BIRTH: BirthInput = {
  datetimeUtc: "1990-01-15T12:00:00+00:00",
  latitude: 28.6139,
  longitude: 77.209,
  referenceDate: "2025-01-01T00:00:00+00:00",
};

const SYNC_RESULT: SyncResult = {
  version: "2026.05",
  manifestHash: "abc",
  chunksFetched: 3,
  chunksReused: 1,
  bytesFetched: 1024,
};

const SYNC_PROGRESS: SyncProgress = {
  phase: "chunks",
  fetchedChunks: 1,
  totalChunks: 3,
  bytesFetched: 512,
  bytesTotal: 3_000,
  bytesDone: 1_000,
};

const BOOT_PROGRESS: BootProgress = { stage: "pyodide", bytesReceived: 4_096, bytesTotal: null };

class FakeSyncEngine implements EnginePort {
  public readonly syncCalls: Array<readonly [string, string, string, string]> = [];
  public readonly readPaths: string[] = [];
  public terminated = false;

  public constructor(private readonly files: Readonly<Record<string, Uint8Array>>) {}

  public async sync(
    baseUrl: string,
    pubkeyUrl: string,
    expectedBundleId: string,
    expectedChannel: string,
    onProgress?: (progress: SyncProgress) => void,
  ): Promise<SyncResult> {
    this.syncCalls.push([baseUrl, pubkeyUrl, expectedBundleId, expectedChannel]);
    onProgress?.(SYNC_PROGRESS);
    return SYNC_RESULT;
  }

  public async readFile(path: string): Promise<Uint8Array> {
    this.readPaths.push(path);
    const bytes = this.files[path];
    if (bytes === undefined) {
      throw new Error(`missing ${path}`);
    }
    return bytes;
  }

  public terminate(): void {
    this.terminated = true;
  }
}

class FakeChartEngine implements ChartEnginePort {
  public bootConfig: BootConfig | undefined;
  public bootCount = 0;
  public chartCalls = 0;
  public predictiveCalls = 0;
  public readonly prewarmUrls: string[] = [];
  public terminated = false;

  public prewarm(pyodideIndexUrl: string): void {
    this.prewarmUrls.push(pyodideIndexUrl);
  }

  public async boot(
    config: BootConfig,
    onProgress?: (progress: BootProgress) => void,
  ): Promise<void> {
    this.bootConfig = config;
    this.bootCount += 1;
    onProgress?.(BOOT_PROGRESS);
  }

  public async generateChart(birth: BirthInput): Promise<SiderealChart> {
    this.chartCalls += 1;
    return { ayanamsa_value: birth.latitude } as unknown as SiderealChart;
  }

  public async computePredictive(input: PredictiveInput): Promise<PredictiveContexts> {
    this.predictiveCalls += 1;
    return {
      transit_context: { instant: input.referenceInstant },
    } as unknown as PredictiveContexts;
  }

  public async computeMoonWindow(input: MoonWindowInput): Promise<MoonWindow> {
    const mark = { sign: "taurus", nakshatra: "Rohini", tithi: 3, paksha: "shukla" } as const;
    void input;
    return { at_place: { at_start: mark, at_end: mark }, event: null };
  }

  public async computeMeshEdge(input: MeshEdgeInput): Promise<MeshEdgeContext> {
    return {
      relationship: input.relationship,
      role_a: input.roleA,
      role_b: input.roleB,
      synchrony: { window_start: input.windowStart, window_end: input.windowEnd },
    } as unknown as MeshEdgeContext;
  }

  public async computeRectification(input: RectificationInput): Promise<RectificationResultRaw> {
    return {
      mode: input.mode,
      candidates: [],
      margin: 0,
      band: "leans",
      discriminating_event_count: 0,
      recorded_time_sign: null,
      honesty_note_key: "rectify.honesty.leans",
    } as RectificationResultRaw;
  }

  public terminate(): void {
    this.terminated = true;
  }
}

const jplephemBytes = new Uint8Array([10, 11]);
const almameshBytes = new Uint8Array([20, 21]);
const de421Bytes = new Uint8Array([30, 31]);
const finalsBytes = new Uint8Array([40, 41]);

const FILES: Readonly<Record<string, Uint8Array>> = {
  [CONFIG.wheelPaths[0]]: jplephemBytes,
  [CONFIG.wheelPaths[1]]: almameshBytes,
  [CONFIG.skyfieldDataPaths[0]]: de421Bytes,
  [CONFIG.skyfieldDataPaths[1]]: finalsBytes,
};

const makeRuntime = () => {
  const sync = new FakeSyncEngine(FILES);
  const chart = new FakeChartEngine();
  const runtime = new AlmaMeshRuntime({
    spawnSyncEngine: () => sync,
    spawnChartEngine: () => chart,
  });
  return { runtime, sync, chart };
};

/** An idle scheduler that grants the slot at once (the pre-idle behaviour). */
const runIdleNow: IdleScheduler = (task) => {
  task();
  return () => {};
};

/** An idle scheduler the test drives by hand. */
class FakeIdleScheduler {
  public readonly pending: Array<() => void> = [];
  public requested = 0;
  public cancelled = 0;

  public readonly schedule: IdleScheduler = (task) => {
    this.requested += 1;
    this.pending.push(task);
    return () => {
      this.cancelled += 1;
      const index = this.pending.indexOf(task);
      if (index >= 0) this.pending.splice(index, 1);
    };
  };

  public runPending(): void {
    for (const task of this.pending.splice(0)) task();
  }
}

describe("AlmaMeshRuntime.bootstrap", () => {
  // Both Workers report progress (bundle bytes, Pyodide bytes); bootstrap must
  // surface it as stages, because the provider's idle budgets and the
  // onboarding progress bar are fed from `onStage` and nothing else.
  it("re-reports the syncing and booting-engine stages with each Worker's progress", async () => {
    const { runtime } = makeRuntime();
    const stages: BootStage[] = [];

    await runtime.bootstrap(CONFIG, (stage) => stages.push(stage));

    expect(stages).toEqual([
      { kind: "syncing" },
      { kind: "syncing", progress: SYNC_PROGRESS },
      { kind: "synced", result: SYNC_RESULT },
      { kind: "reassembling" },
      { kind: "booting-engine" },
      { kind: "booting-engine", progress: BOOT_PROGRESS },
      { kind: "ready" },
    ]);
  });

  it("syncs the signed bundle with the configured origin + pinned key", async () => {
    const { runtime, sync } = makeRuntime();

    await runtime.bootstrap(CONFIG);

    expect(sync.syncCalls).toEqual([
      [
        CONFIG.bundleBaseUrl,
        CONFIG.pubkeyUrl,
        CONFIG.expectedBundleId,
        CONFIG.expectedChannel,
      ],
    ]);
  });

  it("reads the wheels + skyfield data from the synced bundle (order preserved) and boots with them", async () => {
    const { runtime, chart } = makeRuntime();

    await runtime.bootstrap(CONFIG);

    expect(chart.bootConfig).toEqual({
      pyodideIndexUrl: CONFIG.pyodideIndexUrl,
      wheels: [
        { filename: "jplephem-2.23-py3-none-any.whl", bytes: jplephemBytes },
        { filename: "almamesh-0.1.0-py3-none-any.whl", bytes: almameshBytes },
      ],
      skyfieldData: [
        { filename: "de421.bsp", bytes: de421Bytes },
        { filename: "finals2000A.all", bytes: finalsBytes },
      ],
    });
  });

  it("emits progress stages in order", async () => {
    const { runtime } = makeRuntime();
    const stages: string[] = [];

    await runtime.bootstrap(CONFIG, (stage) => {
      // A stage is re-reported with progress; the ORDER of kinds is the contract.
      if (stages.at(-1) !== stage.kind) stages.push(stage.kind);
    });

    expect(stages).toEqual(["syncing", "synced", "reassembling", "booting-engine", "ready"]);
  });

  it("returns a chart engine that computes charts on-device", async () => {
    const { runtime } = makeRuntime();

    const engine = await runtime.bootstrap(CONFIG);
    const chart = await engine.generateChart(BIRTH);

    expect(chart.ayanamsa_value).toBe(BIRTH.latitude);
  });

  it("returns an engine that computes the lazy predictive payload on-device", async () => {
    const { runtime } = makeRuntime();

    const engine = await runtime.bootstrap(CONFIG);
    const predictive = await engine.computePredictive({
      ...BIRTH,
      referenceInstant: "2026-06-09T12:00:00+00:00",
      utcOffsetMinutes: 330,
    });

    expect(predictive.transit_context.instant).toBe("2026-06-09T12:00:00+00:00");
  });

  it("returns an engine that computes the relational mesh edge on-device", async () => {
    const { runtime } = makeRuntime();

    const engine = await runtime.bootstrap(CONFIG);
    const meshEdge = await engine.computeMeshEdge({
      a: { datetimeUtc: BIRTH.datetimeUtc, latitude: BIRTH.latitude, longitude: BIRTH.longitude },
      b: { datetimeUtc: "1985-07-23T04:30:00+00:00", latitude: 19.076, longitude: 72.8777 },
      relationship: "spouse",
      roleA: "bride",
      roleB: "groom",
      windowStart: "2025-01-01T00:00:00+00:00",
      windowEnd: "2027-01-01T00:00:00+00:00",
      referenceInstant: "2025-01-01T00:00:00+00:00",
    });

    expect(meshEdge.relationship).toBe("spouse");
    expect(meshEdge.synchrony.window_start).toBe("2025-01-01T00:00:00+00:00");
  });

  it("surfaces the synced bundle provenance via engine.meta()", async () => {
    const meta = {
      bundle_id: "almamesh-constructs",
      version: "dev",
      engine_version: "0.1.0",
      ephemeris_file: "de421.bsp",
      ayanamsa: "lahiri",
      constructs: ["lahiri_ayanamsa.txt"],
    };
    const sync = new FakeSyncEngine({
      ...FILES,
      "almamesh_meta.json": new TextEncoder().encode(JSON.stringify(meta)),
    });
    const runtime = new AlmaMeshRuntime({
      spawnSyncEngine: () => sync,
      spawnChartEngine: () => new FakeChartEngine(),
    });

    const engine = await runtime.bootstrap(CONFIG);

    expect(engine.meta()).toEqual(meta);
  });

  it("meta() is null (not a bootstrap failure) when the bundle has no meta file", async () => {
    const { runtime } = makeRuntime(); // FILES has no almamesh_meta.json

    const engine = await runtime.bootstrap(CONFIG);

    expect(engine.meta()).toBeNull();
  });

  it("is idempotent: a second bootstrap reuses the engine without re-syncing", async () => {
    const { runtime, sync, chart } = makeRuntime();

    await runtime.bootstrap(CONFIG);
    await runtime.bootstrap(CONFIG);

    expect(sync.syncCalls).toHaveLength(1);
    expect(chart.bootCount).toBe(1);
  });

  it("clears its memo on failure so bootstrap can be retried", async () => {
    const chart = new FakeChartEngine();
    const failing = new FakeSyncEngine({}); // no files -> readFile throws
    const ok = new FakeSyncEngine(FILES);
    const engines = [failing, ok];
    const runtime = new AlmaMeshRuntime({
      spawnSyncEngine: () => engines.shift() ?? ok,
      spawnChartEngine: () => chart,
    });

    await expect(runtime.bootstrap(CONFIG)).rejects.toThrow();
    await expect(runtime.bootstrap(CONFIG)).resolves.toBeDefined();
  });

  it("terminates both workers when chart boot fails", async () => {
    const sync = new FakeSyncEngine(FILES);
    const chart = new FakeChartEngine();
    chart.boot = async () => {
      throw new Error("pyodide failed");
    };
    const runtime = new AlmaMeshRuntime({
      spawnSyncEngine: () => sync,
      spawnChartEngine: () => chart,
    });

    await expect(runtime.bootstrap(CONFIG)).rejects.toThrow("pyodide failed");
    expect(sync.terminated).toBe(true);
    expect(chart.terminated).toBe(true);
  });

  it("dispose releases workers and clears the ready engine", async () => {
    const { runtime, sync, chart } = makeRuntime();

    await runtime.bootstrap(CONFIG);
    await runtime.dispose();

    expect(runtime.engine()).toBeNull();
    expect(sync.terminated).toBe(true);
    expect(chart.terminated).toBe(true);
  });

  it("does not publish a late engine after dispose supersedes an in-flight boot", async () => {
    let releaseSync!: () => void;
    const sync = new FakeSyncEngine(FILES);
    const originalSync = sync.sync.bind(sync);
    sync.sync = async (...args) => {
      await new Promise<void>((resolve) => {
        releaseSync = resolve;
      });
      return originalSync(...args);
    };
    const chart = new FakeChartEngine();
    const runtime = new AlmaMeshRuntime({
      spawnSyncEngine: () => sync,
      spawnChartEngine: () => chart,
    });

    const pending = runtime.bootstrap(CONFIG);
    await runtime.dispose();
    releaseSync();

    await expect(pending).rejects.toThrow(/superseded|terminated/);
    expect(runtime.engine()).toBeNull();
    expect(chart.bootCount).toBe(0);
  });

  it("overlap mode starts warming Pyodide before the bundle sync settles", async () => {
    let releaseSync!: () => void;
    const sync = new FakeSyncEngine(FILES);
    const originalSync = sync.sync.bind(sync);
    sync.sync = async (...args) => {
      await new Promise<void>((resolve) => {
        releaseSync = resolve;
      });
      return originalSync(...args);
    };
    const chart = new FakeChartEngine();
    const runtime = new AlmaMeshRuntime({
      spawnSyncEngine: () => sync,
      spawnChartEngine: () => chart,
      decideBootMode: () => ({ mode: "overlap", reason: "test" }),
      scheduleIdle: runIdleNow,
    });

    const pending = runtime.bootstrap(CONFIG);
    await Promise.resolve();
    expect(chart.prewarmUrls).toEqual([CONFIG.pyodideIndexUrl]);
    expect(chart.bootCount).toBe(0);

    releaseSync();
    await pending;
    expect(chart.bootCount).toBe(1);
  });

  // The warm-up is Worker work, but on few cores it competes with the sync
  // Worker AND the UI thread while the user is typing the onboarding form.
  // Low-end hardware is the primary target, so the warm-up waits for an idle
  // slot instead of starting the instant the boot does.
  it("overlap mode waits for an idle slot before warming Pyodide", async () => {
    let releaseSync!: () => void;
    const sync = new FakeSyncEngine(FILES);
    const originalSync = sync.sync.bind(sync);
    sync.sync = async (...args) => {
      await new Promise<void>((resolve) => {
        releaseSync = resolve;
      });
      return originalSync(...args);
    };
    const chart = new FakeChartEngine();
    const idle = new FakeIdleScheduler();
    const runtime = new AlmaMeshRuntime({
      spawnSyncEngine: () => sync,
      spawnChartEngine: () => chart,
      decideBootMode: () => ({ mode: "overlap", reason: "test" }),
      scheduleIdle: idle.schedule,
    });

    const pending = runtime.bootstrap(CONFIG);
    await Promise.resolve();
    expect(idle.pending).toHaveLength(1);
    expect(chart.prewarmUrls).toEqual([]);

    idle.runPending();
    expect(chart.prewarmUrls).toEqual([CONFIG.pyodideIndexUrl]);

    releaseSync();
    await pending;
    expect(chart.bootCount).toBe(1);
  });

  it("cancels a warm-up whose idle slot never came before the sync settled; boot proceeds cold", async () => {
    const sync = new FakeSyncEngine(FILES);
    const chart = new FakeChartEngine();
    const idle = new FakeIdleScheduler();
    const runtime = new AlmaMeshRuntime({
      spawnSyncEngine: () => sync,
      spawnChartEngine: () => chart,
      decideBootMode: () => ({ mode: "overlap", reason: "test" }),
      scheduleIdle: idle.schedule,
    });

    await runtime.bootstrap(CONFIG);
    expect(idle.cancelled).toBe(1);
    expect(chart.prewarmUrls).toEqual([]);
    expect(chart.bootCount).toBe(1);
    // A slot arriving after cancellation must not touch the booted Worker.
    idle.runPending();
    expect(chart.prewarmUrls).toEqual([]);
  });

  it("sequential mode never asks for an idle slot", async () => {
    const sync = new FakeSyncEngine(FILES);
    const idle = new FakeIdleScheduler();
    const runtime = new AlmaMeshRuntime({
      spawnSyncEngine: () => sync,
      spawnChartEngine: () => new FakeChartEngine(),
      decideBootMode: () => ({ mode: "sequential", reason: "test" }),
      scheduleIdle: idle.schedule,
    });
    await runtime.bootstrap(CONFIG);
    expect(idle.requested).toBe(0);
  });

  it("terminates the warming chart worker when the bundle sync fails", async () => {
    const sync = new FakeSyncEngine(FILES);
    sync.sync = async () => {
      throw new Error("signature verification failed");
    };
    const chart = new FakeChartEngine();
    const runtime = new AlmaMeshRuntime({
      spawnSyncEngine: () => sync,
      spawnChartEngine: () => chart,
      decideBootMode: () => ({ mode: "overlap", reason: "test" }),
    });

    await expect(runtime.bootstrap(CONFIG)).rejects.toThrow("signature verification failed");
    expect(chart.terminated).toBe(true);
    expect(sync.terminated).toBe(true);
  });

  it("surfaces a failed warm-up through boot", async () => {
    const chart = new FakeChartEngine();
    chart.boot = async () => {
      throw new Error("pyodide fetch failed");
    };
    const runtime = new AlmaMeshRuntime({
      spawnSyncEngine: () => new FakeSyncEngine(FILES),
      spawnChartEngine: () => chart,
    });

    await expect(runtime.bootstrap(CONFIG)).rejects.toThrow("pyodide fetch failed");
  });

  it("sequential mode never prewarms and spawns the chart Worker only after the sync Worker is gone", async () => {
    const sync = new FakeSyncEngine(FILES);
    const chart = new FakeChartEngine();
    let syncTerminatedAtSpawn: boolean | null = null;
    const runtime = new AlmaMeshRuntime({
      spawnSyncEngine: () => sync,
      spawnChartEngine: () => {
        syncTerminatedAtSpawn = sync.terminated;
        return chart;
      },
      decideBootMode: () => ({ mode: "sequential", reason: "test" }),
    });

    await runtime.bootstrap(CONFIG);

    expect(chart.prewarmUrls).toEqual([]);
    expect(syncTerminatedAtSpawn).toBe(true);
    expect(chart.bootCount).toBe(1);
  });

  it("overlap mode still releases the sync Worker before `boot` is sent", async () => {
    const sync = new FakeSyncEngine(FILES);
    const chart = new FakeChartEngine();
    let syncTerminatedAtBoot = false;
    const originalBoot = chart.boot.bind(chart);
    chart.boot = async (config) => {
      syncTerminatedAtBoot = sync.terminated;
      return originalBoot(config);
    };
    const runtime = new AlmaMeshRuntime({
      spawnSyncEngine: () => sync,
      spawnChartEngine: () => chart,
      decideBootMode: () => ({ mode: "overlap", reason: "test" }),
    });

    await runtime.bootstrap(CONFIG);

    expect(syncTerminatedAtBoot).toBe(true);
  });

  it("logs the boot policy decision once per boot", async () => {
    const lines: string[] = [];
    const runtime = new AlmaMeshRuntime({
      spawnSyncEngine: () => new FakeSyncEngine(FILES),
      spawnChartEngine: () => new FakeChartEngine(),
      decideBootMode: () => ({ mode: "sequential", reason: "2 GB < 4 GB" }),
      log: (line) => lines.push(line),
    });

    await runtime.bootstrap(CONFIG);
    await runtime.bootstrap(CONFIG);

    expect(lines).toEqual(["[almamesh] engine boot policy: sequential (2 GB < 4 GB)"]);
  });

  it("without an injected decision the real policy runs over navigator (no deviceMemory here → sequential)", async () => {
    const chart = new FakeChartEngine();
    const lines: string[] = [];
    const runtime = new AlmaMeshRuntime({
      spawnSyncEngine: () => new FakeSyncEngine(FILES),
      spawnChartEngine: () => chart,
      log: (line) => lines.push(line),
    });

    await runtime.bootstrap(CONFIG);

    expect(chart.prewarmUrls).toEqual([]);
    expect(lines[0]).toMatch(/^\[almamesh\] engine boot policy: sequential \(no deviceMemory/);
  });

  it("computes an identical chart or predictive input once per booted engine", async () => {
    const { runtime, chart } = makeRuntime();
    const engine = await runtime.bootstrap(CONFIG);
    const predictive: PredictiveInput = {
      datetimeUtc: BIRTH.datetimeUtc,
      latitude: BIRTH.latitude,
      longitude: BIRTH.longitude,
      referenceInstant: "2025-01-01T00:00:00+00:00",
      utcOffsetMinutes: 330,
    };

    const first = await engine.generateChart(BIRTH);
    const second = await engine.generateChart({ ...BIRTH });
    await engine.computePredictive(predictive);
    await engine.computePredictive({ ...predictive });

    expect(chart.chartCalls).toBe(1);
    expect(chart.predictiveCalls).toBe(1);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("recomputes after a re-boot onto a different bundle manifest", async () => {
    const chart = new FakeChartEngine();
    const syncA = new FakeSyncEngine(FILES);
    const syncB = new FakeSyncEngine(FILES);
    syncB.sync = async () => ({ ...SYNC_RESULT, manifestHash: "def" });
    const syncs = [syncA, syncB];
    const runtime = new AlmaMeshRuntime({
      spawnSyncEngine: () => syncs.shift() ?? syncB,
      spawnChartEngine: () => chart,
    });

    await (await runtime.bootstrap(CONFIG)).generateChart(BIRTH);
    runtime.dispose();
    await (await runtime.bootstrap(CONFIG)).generateChart(BIRTH);

    expect(chart.chartCalls).toBe(2);
  });

  describe("page teardown (WebKit refuses a Worker constructed after pagehide)", () => {
    it("a bootstrap that starts while the page is tearing down spawns no Worker and rejects as cancelled", async () => {
      let spawned = 0;
      const runtime = new AlmaMeshRuntime({
        spawnSyncEngine: () => {
          spawned += 1;
          return new FakeSyncEngine(FILES);
        },
        spawnChartEngine: () => {
          spawned += 1;
          return new FakeChartEngine();
        },
        isPageTearingDown: () => true,
      });

      await expect(runtime.bootstrap(CONFIG)).rejects.toBeInstanceOf(EngineBootCancelledError);
      expect(spawned).toBe(0);
    });

    it("a sync that settles after pagehide does not spawn the chart Worker", async () => {
      let tearingDown = false;
      const sync = new FakeSyncEngine(FILES);
      const originalSync = sync.sync.bind(sync);
      sync.sync = async (...args) => {
        const result = await originalSync(...args);
        tearingDown = true;
        return result;
      };
      let chartSpawned = false;
      const runtime = new AlmaMeshRuntime({
        spawnSyncEngine: () => sync,
        spawnChartEngine: () => {
          chartSpawned = true;
          return new FakeChartEngine();
        },
        decideBootMode: () => ({ mode: "sequential", reason: "test" }),
        isPageTearingDown: () => tearingDown,
      });

      await expect(runtime.bootstrap(CONFIG)).rejects.toBeInstanceOf(EngineBootCancelledError);
      expect(chartSpawned).toBe(false);
      expect(sync.terminated).toBe(true);
    });

    it("does not prewarm or boot an overlap Worker after pagehide during sync", async () => {
      let tearingDown = false;
      let releaseSync!: () => void;
      const sync = new FakeSyncEngine(FILES);
      const originalSync = sync.sync.bind(sync);
      sync.sync = async (...args) => {
        await new Promise<void>((resolve) => { releaseSync = resolve; });
        return originalSync(...args);
      };
      const chart = new FakeChartEngine();
      const idle = new FakeIdleScheduler();
      const stages: BootStage[] = [];
      const runtime = new AlmaMeshRuntime({
        spawnSyncEngine: () => sync,
        spawnChartEngine: () => chart,
        decideBootMode: () => ({ mode: "overlap", reason: "test" }),
        scheduleIdle: idle.schedule,
        isPageTearingDown: () => tearingDown,
      });

      const outcome = runtime.bootstrap(CONFIG, (stage) => stages.push(stage))
        .then(() => null, (error: unknown) => error);
      tearingDown = true;
      try { idle.runPending(); }
      finally { releaseSync(); }
      const error = await outcome;

      expect(chart.prewarmUrls).toEqual([]);
      expect(chart.bootCount).toBe(0);
      expect(error).toBeInstanceOf(EngineBootCancelledError);
      expect(runtime.engine()).toBeNull();
      expect(stages.some((stage) => stage.kind === "ready")).toBe(false);
      expect(sync.terminated).toBe(true);
      expect(chart.terminated).toBe(true);
    });

    it("does not boot an overlap Worker after pagehide during asset reads", async () => {
      let tearingDown = false;
      let releaseAssets!: () => void;
      let reportReadStarted!: () => void;
      const assets = new Promise<void>((resolve) => { releaseAssets = resolve; });
      const readStarted = new Promise<void>((resolve) => { reportReadStarted = resolve; });
      const sync = new FakeSyncEngine(FILES);
      const originalRead = sync.readFile.bind(sync);
      sync.readFile = async (path) => {
        reportReadStarted();
        await assets;
        return originalRead(path);
      };
      const chart = new FakeChartEngine();
      const idle = new FakeIdleScheduler();
      const stages: BootStage[] = [];
      const runtime = new AlmaMeshRuntime({
        spawnSyncEngine: () => sync,
        spawnChartEngine: () => chart,
        decideBootMode: () => ({ mode: "overlap", reason: "test" }),
        scheduleIdle: idle.schedule,
        isPageTearingDown: () => tearingDown,
      });

      const outcome = runtime.bootstrap(CONFIG, (stage) => stages.push(stage))
        .then(() => null, (error: unknown) => error);
      await readStarted;
      tearingDown = true;
      releaseAssets();
      const error = await outcome;

      expect(chart.bootCount).toBe(0);
      expect(error).toBeInstanceOf(EngineBootCancelledError);
      expect(runtime.engine()).toBeNull();
      expect(stages.some((stage) => stage.kind === "ready")).toBe(false);
      expect(idle.cancelled).toBe(1);
      expect(chart.prewarmUrls).toEqual([]);
      expect(sync.terminated).toBe(true);
      expect(chart.terminated).toBe(true);
    });

    it("does not publish readiness when an overlap boot completes after pagehide", async () => {
      let tearingDown = false;
      let releaseBoot!: () => void;
      let reportBootStarted!: () => void;
      const boot = new Promise<void>((resolve) => { releaseBoot = resolve; });
      const bootStarted = new Promise<void>((resolve) => { reportBootStarted = resolve; });
      const sync = new FakeSyncEngine(FILES);
      const chart = new FakeChartEngine();
      const originalBoot = chart.boot.bind(chart);
      chart.boot = async (...args) => {
        await originalBoot(...args);
        reportBootStarted();
        await boot;
      };
      const stages: BootStage[] = [];
      const runtime = new AlmaMeshRuntime({
        spawnSyncEngine: () => sync,
        spawnChartEngine: () => chart,
        decideBootMode: () => ({ mode: "overlap", reason: "test" }),
        scheduleIdle: new FakeIdleScheduler().schedule,
        isPageTearingDown: () => tearingDown,
      });

      const outcome = runtime.bootstrap(CONFIG, (stage) => stages.push(stage))
        .then(() => null, (error: unknown) => error);
      await bootStarted;
      tearingDown = true;
      releaseBoot();
      const error = await outcome;

      expect(chart.bootCount).toBe(1);
      expect(error).toBeInstanceOf(EngineBootCancelledError);
      expect(runtime.engine()).toBeNull();
      expect(stages.some((stage) => stage.kind === "ready")).toBe(false);
      expect(sync.terminated).toBe(true);
      expect(chart.terminated).toBe(true);
    });

    it("allows an explicit fresh bootstrap after cancellation without automatically retrying", async () => {
      let tearingDown = false;
      const abandonedSync = new FakeSyncEngine(FILES);
      abandonedSync.sync = async () => {
        tearingDown = true;
        return SYNC_RESULT;
      };
      const abandonedChart = new FakeChartEngine();
      const freshSync = new FakeSyncEngine(FILES);
      const freshChart = new FakeChartEngine();
      const syncs = [abandonedSync, freshSync];
      const charts = [abandonedChart, freshChart];
      const spawnSyncEngine = vi.fn(() => syncs.shift() ?? freshSync);
      const spawnChartEngine = vi.fn(() => charts.shift() ?? freshChart);
      const runtime = new AlmaMeshRuntime({
        spawnSyncEngine,
        spawnChartEngine,
        decideBootMode: () => ({ mode: "overlap", reason: "test" }),
        scheduleIdle: new FakeIdleScheduler().schedule,
        isPageTearingDown: () => tearingDown,
      });

      await expect(runtime.bootstrap(CONFIG)).rejects.toBeInstanceOf(EngineBootCancelledError);
      expect(spawnSyncEngine).toHaveBeenCalledTimes(1);
      expect(spawnChartEngine).toHaveBeenCalledTimes(1);
      expect(abandonedSync.terminated).toBe(true);
      expect(abandonedChart.terminated).toBe(true);
      expect(runtime.engine()).toBeNull();

      tearingDown = false;
      const engine = await runtime.bootstrap(CONFIG);
      await engine.generateChart(BIRTH);
      expect(runtime.engine()).toBe(engine);
      expect(spawnSyncEngine).toHaveBeenCalledTimes(2);
      expect(spawnChartEngine).toHaveBeenCalledTimes(2);
      expect(freshChart.bootCount).toBe(1);
      expect(freshChart.chartCalls).toBe(1);
      expect(freshChart.terminated).toBe(false);
    });

    it("keeps the current pagehide/pageshow boolean semantics across a held overlap sync", async () => {
      let tearingDown = false;
      let releaseSync!: () => void;
      const sync = new FakeSyncEngine(FILES);
      const originalSync = sync.sync.bind(sync);
      sync.sync = async (...args) => {
        await new Promise<void>((resolve) => { releaseSync = resolve; });
        return originalSync(...args);
      };
      const chart = new FakeChartEngine();
      const idle = new FakeIdleScheduler();
      const runtime = new AlmaMeshRuntime({
        spawnSyncEngine: () => sync,
        spawnChartEngine: () => chart,
        decideBootMode: () => ({ mode: "overlap", reason: "test" }),
        scheduleIdle: idle.schedule,
        isPageTearingDown: () => tearingDown,
      });

      const pending = runtime.bootstrap(CONFIG);
      tearingDown = true;
      try { idle.runPending(); }
      finally {
        tearingDown = false;
        releaseSync();
      }
      const engine = await pending;

      expect(chart.prewarmUrls).toEqual([]);
      expect(chart.bootCount).toBe(1);
      expect(runtime.engine()).toBe(engine);
      expect(chart.terminated).toBe(false);
    });

    it("a live page boots normally", async () => {
      const chart = new FakeChartEngine();
      const runtime = new AlmaMeshRuntime({
        spawnSyncEngine: () => new FakeSyncEngine(FILES),
        spawnChartEngine: () => chart,
        isPageTearingDown: () => false,
      });

      await runtime.bootstrap(CONFIG);
      expect(chart.bootCount).toBe(1);
    });
  });

  describe("one automatic retry after a WebAssembly fault during boot", () => {
    /** A Pyodide Worker whose boot traps the way WebKit's cold wasm compile did. */
    class FaultingChartEngine extends FakeChartEngine {
      public override async boot(config: BootConfig): Promise<void> {
        this.bootConfig = config;
        this.bootCount += 1;
        throw errorFromWorker("Out of bounds memory access", "RuntimeError");
      }
    }

    const harness = (chartEngines: FakeChartEngine[]) => {
      const spawnedCharts: FakeChartEngine[] = [];
      const spawnedSyncs: FakeSyncEngine[] = [];
      const lines: string[] = [];
      const runtime = new AlmaMeshRuntime({
        spawnSyncEngine: () => {
          const sync = new FakeSyncEngine(FILES);
          spawnedSyncs.push(sync);
          return sync;
        },
        spawnChartEngine: () => {
          const next = chartEngines.shift();
          if (next === undefined) throw new Error("no chart engine left to spawn");
          spawnedCharts.push(next);
          return next;
        },
        decideBootMode: () => ({ mode: "sequential", reason: "test" }),
        log: (line) => lines.push(line),
      });
      return { runtime, spawnedCharts, spawnedSyncs, lines };
    };

    it("terminates the faulted Worker and boots a fresh one that succeeds", async () => {
      const faulted = new FaultingChartEngine();
      const fresh = new FakeChartEngine();
      const { runtime, spawnedCharts, lines } = harness([faulted, fresh]);

      const engine = await runtime.bootstrap(CONFIG);

      expect(spawnedCharts).toEqual([faulted, fresh]);
      expect(faulted.terminated).toBe(true);
      expect(fresh.terminated).toBe(false);
      expect(fresh.bootCount).toBe(1);
      expect(runtime.engine()).toBe(engine);
      await engine.generateChart(BIRTH);
      expect(fresh.chartCalls).toBe(1);
      expect(lines).toContain("[almamesh] engine.boot_retry error=RuntimeError");
    });

    it("retries once only: a second fault rejects so the recovery card shows", async () => {
      const first = new FaultingChartEngine();
      const second = new FaultingChartEngine();
      const { runtime, spawnedCharts, spawnedSyncs, lines } = harness([first, second]);

      await expect(runtime.bootstrap(CONFIG)).rejects.toMatchObject({
        name: "RuntimeError",
        message: "Out of bounds memory access",
      });

      expect(spawnedCharts).toEqual([first, second]);
      // No leak: every Worker either boot attempt spawned is terminated.
      expect(spawnedCharts.every((chart) => chart.terminated)).toBe(true);
      expect(spawnedSyncs.every((sync) => sync.terminated)).toBe(true);
      expect(runtime.engine()).toBeNull();
      expect(lines.filter((line) => line.includes("engine.boot_retry"))).toHaveLength(1);
    });

    it("does not retry a failure that is not a wasm fault", async () => {
      const broken = new FakeChartEngine();
      broken.boot = async () => {
        throw new Error("bundle signature verification failed");
      };
      const { runtime, spawnedCharts, lines } = harness([broken, new FakeChartEngine()]);

      await expect(runtime.bootstrap(CONFIG)).rejects.toThrow("bundle signature verification failed");

      expect(spawnedCharts).toEqual([broken]);
      expect(broken.terminated).toBe(true);
      expect(lines.some((line) => line.includes("engine.boot_retry"))).toBe(false);
    });

    it("keeps the sequential policy on the retry: the fresh Worker starts only after its sync Worker is gone", async () => {
      const faulted = new FaultingChartEngine();
      const fresh = new FakeChartEngine();
      const { runtime, spawnedSyncs, spawnedCharts } = harness([faulted, fresh]);
      const syncAliveAtSpawn: boolean[] = [];
      fresh.boot = async (config) => {
        syncAliveAtSpawn.push(spawnedSyncs.some((sync) => !sync.terminated));
        fresh.bootConfig = config;
        fresh.bootCount += 1;
      };

      await runtime.bootstrap(CONFIG);

      expect(spawnedSyncs).toHaveLength(2);
      expect(syncAliveAtSpawn).toEqual([false]);
      expect(fresh.prewarmUrls).toEqual([]);
      expect(spawnedCharts).toHaveLength(2);
    });

    it("does not retry a boot that dispose() superseded", async () => {
      const faulted = new FaultingChartEngine();
      const fresh = new FakeChartEngine();
      const { runtime, spawnedCharts } = harness([faulted, fresh]);
      faulted.boot = async () => {
        runtime.dispose();
        throw errorFromWorker("Out of bounds memory access", "RuntimeError");
      };

      await expect(runtime.bootstrap(CONFIG)).rejects.toMatchObject({ name: "RuntimeError" });

      expect(spawnedCharts).toEqual([faulted]);
    });
  });
});

describe("AlmaMeshRuntime terminal client failures", () => {
  const predictive: PredictiveInput = {
    ...BIRTH,
    referenceInstant: "2026-06-09T12:00:00+00:00",
    utcOffsetMinutes: 330,
  };

  /** The actual client/Worker protocol, with only the Worker I/O replaced. */
  function harness() {
    let message: (event: MessageEvent<ChartWorkerResponse>) => void = () => {};
    let error: (event: { message?: string }) => void = () => {};
    let messageerror: () => void = () => {};
    let mode: "ok" | "silent" | "python" = "ok";
    let closeAfterReply = false;
    const posted: ChartWorkerRequest[] = [];
    const worker: WorkerLike = {
      postMessage(request) {
        posted.push(request);
        const response: ChartWorkerResponse | null = request.kind === "boot"
          ? { ok: true, kind: "boot", id: request.id }
          : mode === "python" ? { ok: false, id: request.id, error: "Traceback ...\nRuntimeError: unreachable\n" }
            : mode === "silent" ? null
              : { ok: true, kind: "computePredictive", id: request.id, predictive: {} as PredictiveContexts };
        if (response) queueMicrotask(() => {
          message(new MessageEvent("message", { data: response }));
          if (closeAfterReply) error({ message: "Worker exited just after reply" });
        });
      },
      addEventListener(type: "message" | "error" | "messageerror", listener:
        ((event: MessageEvent<ChartWorkerResponse>) => void) | ((event: { message?: string }) => void) | (() => void)) {
        if (type === "message") message = listener as typeof message;
        else if (type === "error") error = listener as typeof error;
        else messageerror = listener as typeof messageerror;
      },
      terminate: vi.fn(),
    };
    const client = new ChartEngineClient(worker, { predictiveRequestTimeoutMs: 5 });
    const fresh = new FakeChartEngine();
    let spawns = 0;
    const runtime = new AlmaMeshRuntime({
      spawnSyncEngine: () => new FakeSyncEngine(FILES),
      spawnChartEngine: () => ++spawns === 1 ? client : fresh,
      decideBootMode: () => ({ mode: "sequential", reason: "test" }),
      log: () => {},
    });
    return { runtime, client, fresh, posted, worker,
      mode(value: typeof mode) { mode = value; },
      fail(type: "error" | "messageerror") {
        if (type === "error") error({ message: "Worker process exited" });
        else messageerror();
      },
      closeAfterReply() { closeAfterReply = true; },
      spawns: () => spawns,
    };
  }

  it.each(["error", "messageerror", "timeout"] as const)("invalidates a terminal %s from the real client and explicitly boots a replacement", async (failure) => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const notifications = vi.fn();
      h.runtime.subscribeFailures(notifications);
      const engine = await h.runtime.bootstrap(CONFIG);
      h.mode("silent");
      const first = engine.computePredictive(predictive).catch((error: unknown) => error);
      const second = engine.computePredictive({ ...predictive, referenceInstant: "2027-01-01T00:00:00Z" })
        .catch((error: unknown) => error);
      if (failure === "timeout") vi.advanceTimersByTime(6);
      else h.fail(failure);
      const [error, concurrent] = await Promise.all([first, second]);

      expect(h.runtime.engine()).toBeNull();
      expect(concurrent).toBe(error);
      expect(error).toBe(h.client.closedError());
      expect((error as Error).name).toBe("Error"); // No Wasm marker/message heuristic.
      expect(notifications).toHaveBeenCalledExactlyOnceWith(error);
      expect(h.worker.terminate).toHaveBeenCalledTimes(1);
      expect(h.spawns()).toBe(1);
      const posts = h.posted.length;
      await expect(engine.computePredictive(predictive)).rejects.toThrow("superseded");
      expect(h.posted).toHaveLength(posts);
      const replacement = await h.runtime.bootstrap(CONFIG);
      expect(h.spawns()).toBe(2);
      expect(replacement).not.toBe(engine);
      await expect(replacement.computePredictive(predictive)).resolves.toBeDefined();
      expect(h.fresh.terminated).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["error", "messageerror"] as const)("detects an idle client %s before a populated memo can return a stale result", async (failure) => {
    const h = harness();
    const engine = await h.runtime.bootstrap(CONFIG);
    await engine.computePredictive(predictive);
    const posts = h.posted.length;
    const notifications = vi.fn();
    h.runtime.subscribeFailures(notifications);
    h.fail(failure);

    await expect(engine.computePredictive(predictive)).rejects.toThrow("chart worker failed");
    expect(h.runtime.engine()).toBeNull();
    expect(h.posted).toHaveLength(posts);
    expect(notifications).toHaveBeenCalledExactlyOnceWith(h.client.closedError());
  });

  it("checks client closure again after a successful reply but before delivering the result", async () => {
    const h = harness();
    const engine = await h.runtime.bootstrap(CONFIG);
    const notifications = vi.fn();
    h.runtime.subscribeFailures(notifications);
    h.closeAfterReply();

    await expect(engine.computePredictive(predictive)).rejects.toThrow("Worker exited just after reply");
    expect(h.runtime.engine()).toBeNull();
    expect(notifications).toHaveBeenCalledExactlyOnceWith(h.client.closedError());
  });

  it("keeps an ordinary Python protocol failure local and permits a later computation", async () => {
    const h = harness();
    const engine = await h.runtime.bootstrap(CONFIG);
    const notifications = vi.fn();
    h.runtime.subscribeFailures(notifications);
    h.mode("python");

    await expect(engine.computePredictive(predictive)).rejects.toThrow("RuntimeError: unreachable");
    expect(h.client.closedError()).toBeNull();
    expect(h.runtime.engine()).toBe(engine);
    expect(h.worker.terminate).not.toHaveBeenCalled();
    expect(notifications).not.toHaveBeenCalled();
    h.mode("ok");
    await expect(engine.computePredictive(predictive)).resolves.toBeDefined();
    expect(h.spawns()).toBe(1);
  });
});

describe("AlmaMeshRuntime post-ready failures", () => {
  const predictive: PredictiveInput = {
    ...BIRTH,
    referenceInstant: "2026-06-09T12:00:00+00:00",
    utcOffsetMinutes: 330,
  };
  const moon: MoonWindowInput = {
    placeStartUtc: "2026-06-09T00:00:00Z",
    placeEndUtc: "2026-06-10T00:00:00Z",
  };
  const mesh: MeshEdgeInput = {
    a: BIRTH,
    b: BIRTH,
    relationship: "spouse",
    roleA: "bride",
    roleB: "groom",
    windowStart: "2026-01-01T00:00:00Z",
    windowEnd: "2027-01-01T00:00:00Z",
    referenceInstant: "2026-06-09T12:00:00Z",
  };
  const rectification: RectificationInput = {
    ...BIRTH,
    utcOffsetMinutes: 330,
    events: [{ date: "2017-09-01", category: "relocation" }],
    mode: "window",
  };
  const calls: ReadonlyArray<{
    method: "generateChart" | "computePredictive" | "computeMoonWindow" | "computeMeshEdge" | "computeRectification";
    run(engine: ChartEngine): Promise<unknown>;
  }> = [
    { method: "generateChart", run: (engine) => engine.generateChart(BIRTH) },
    { method: "computePredictive", run: (engine) => engine.computePredictive(predictive, { retention: "period" }) },
    { method: "computeMoonWindow", run: (engine) => engine.computeMoonWindow(moon) },
    { method: "computeMeshEdge", run: (engine) => engine.computeMeshEdge(mesh) },
    { method: "computeRectification", run: (engine) => engine.computeRectification(rectification) },
  ];

  function harness(charts = [new FakeChartEngine(), new FakeChartEngine()]) {
    const spawned: FakeChartEngine[] = [];
    const syncs: FakeSyncEngine[] = [];
    const runtime = new AlmaMeshRuntime({
      spawnSyncEngine: () => {
        const sync = new FakeSyncEngine(FILES);
        syncs.push(sync);
        return sync;
      },
      spawnChartEngine: () => {
        const chart = charts.shift();
        if (!chart) throw new Error("unexpected chart Worker spawn");
        spawned.push(chart);
        return chart;
      },
      decideBootMode: () => ({ mode: "sequential", reason: "test" }),
      log: () => {},
    });
    return { runtime, spawned, syncs };
  }

  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  }

  it.each(calls)("invalidates a fatal $method failure and boots a fresh instance only when explicitly requested", async ({ method, run }) => {
    const { runtime, spawned, syncs } = harness();
    const engine = await runtime.bootstrap(CONFIG);
    const fault = errorFromWorker("Out of bounds memory access", "RuntimeError");
    vi.spyOn(spawned[0], method).mockRejectedValueOnce(fault);
    const terminate = vi.spyOn(spawned[0], "terminate");

    await expect(run(engine)).rejects.toBe(fault);

    expect(runtime.engine()).toBeNull();
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(spawned).toHaveLength(1); // A failed calculation is never replayed.
    const fresh = await runtime.bootstrap(CONFIG);
    expect(fresh).not.toBe(engine);
    expect(spawned).toHaveLength(2);
    expect(syncs).toHaveLength(2);
    expect(syncs.every((sync) => sync.terminated)).toBe(true);
    expect(spawned[1].terminated).toBe(false);
    await expect(run(fresh)).resolves.toBeDefined();
  });

  it.each(calls)("rejects a disposed engine's $method before accessing even a populated memo", async ({ method, run }) => {
    const { runtime, spawned } = harness();
    const old = await runtime.bootstrap(CONFIG);
    const compute = vi.spyOn(spawned[0], method);
    await run(old); // Chart and predictive calls now have settled memo entries.
    runtime.dispose();
    const fresh = await runtime.bootstrap(CONFIG);

    await expect(run(old)).rejects.toThrow("superseded");
    expect(compute).toHaveBeenCalledTimes(1);
    expect(runtime.engine()).toBe(fresh);
    expect(spawned[1].terminated).toBe(false);
  });

  it.each([
    new Error("invalid birth coordinates"),
    new Error("Traceback ...\nRuntimeError: unreachable\n"),
    new Error("network unreachable"),
    new Error("unreachable"),
    "invalid input",
  ])("does not reset or notify for an ordinary compute error: %s", async (error) => {
    const { runtime, spawned } = harness();
    const failure = vi.fn();
    runtime.subscribeFailures(failure);
    const engine = await runtime.bootstrap(CONFIG);
    vi.spyOn(spawned[0], "computePredictive").mockRejectedValueOnce(error);

    await expect(engine.computePredictive(predictive)).rejects.toBe(error);
    expect(await runtime.bootstrap(CONFIG)).toBe(engine);
    await expect(engine.computePredictive(predictive)).resolves.toBeDefined();
    expect(runtime.engine()).toBe(engine);
    expect(spawned).toHaveLength(1);
    expect(spawned[0].terminated).toBe(false);
    expect(failure).not.toHaveBeenCalled();
  });

  it("notifies once after invalidation and fences a concurrent old failure from the replacement instance", async () => {
    const { runtime, spawned } = harness();
    const engine = await runtime.bootstrap(CONFIG);
    const first = deferred<PredictiveContexts>();
    const second = deferred<MeshEdgeContext>();
    vi.spyOn(spawned[0], "computePredictive").mockReturnValue(first.promise);
    vi.spyOn(spawned[0], "computeMeshEdge").mockReturnValue(second.promise);
    const notifications: Error[] = [];
    runtime.subscribeFailures((error) => {
      expect(runtime.engine()).toBeNull();
      expect(spawned[0].terminated).toBe(true);
      notifications.push(error);
    });
    const firstResult = engine.computePredictive(predictive).catch((error: unknown) => error);
    const secondResult = engine.computeMeshEdge(mesh).catch((error: unknown) => error);
    const fault = errorFromWorker("memory access out of bounds");
    first.reject(fault);
    expect(await firstResult).toBe(fault);
    expect(notifications).toEqual([fault]);

    const fresh = await runtime.bootstrap(CONFIG);
    const lateFault = errorFromWorker("unreachable", "RuntimeError");
    second.reject(lateFault);
    expect(await secondResult).toBe(lateFault);
    expect(notifications).toEqual([fault]);
    expect(runtime.engine()).toBe(fresh);
    expect(spawned[1].terminated).toBe(false);
    await expect(fresh.computePredictive(predictive)).resolves.toBeDefined();
  });

  it.each(["success", "fatal failure"])("fences a late %s after explicit disposal and replacement", async (outcome) => {
    const { runtime, spawned } = harness();
    const old = await runtime.bootstrap(CONFIG);
    const pending = deferred<PredictiveContexts>();
    vi.spyOn(spawned[0], "computePredictive").mockReturnValue(pending.promise);
    const failure = vi.fn();
    runtime.subscribeFailures(failure);
    const result = old.computePredictive(predictive).catch((error: unknown) => error);
    runtime.dispose();
    const fresh = await runtime.bootstrap(CONFIG);

    if (outcome === "success") {
      pending.resolve({} as PredictiveContexts);
      expect(await result).toEqual(expect.objectContaining({ message: expect.stringContaining("superseded") }));
    } else {
      const fault = errorFromWorker("Out of bounds memory access", "RuntimeError");
      pending.reject(fault);
      expect(await result).toBe(fault);
    }
    expect(runtime.engine()).toBe(fresh);
    expect(spawned[1].terminated).toBe(false);
    expect(failure).not.toHaveBeenCalled();
  });

  it("supports unsubscribe and keeps listener exceptions from replacing the fatal error or other notifications", async () => {
    const { runtime, spawned } = harness();
    const unsubscribed = vi.fn();
    const unsubscribe = runtime.subscribeFailures(unsubscribed);
    unsubscribe();
    runtime.subscribeFailures(() => { throw new Error("observer failed"); });
    const listener = vi.fn();
    runtime.subscribeFailures(listener);
    const engine = await runtime.bootstrap(CONFIG);
    const fault = errorFromWorker("unreachable", "RuntimeError");
    vi.spyOn(spawned[0], "computePredictive").mockRejectedValueOnce(fault);

    await expect(engine.computePredictive(predictive)).rejects.toBe(fault);
    expect(unsubscribed).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledExactlyOnceWith(fault);
    expect(runtime.engine()).toBeNull();
  });

  it("does not report the existing automatic boot retry as a post-ready failure", async () => {
    const faulted = new FakeChartEngine();
    vi.spyOn(faulted, "boot").mockRejectedValue(errorFromWorker("Out of bounds memory access", "RuntimeError"));
    const { runtime, spawned } = harness([faulted, new FakeChartEngine()]);
    const failure = vi.fn();
    runtime.subscribeFailures(failure);

    const engine = await runtime.bootstrap(CONFIG);
    expect(runtime.engine()).toBe(engine);
    expect(spawned).toHaveLength(2);
    expect(failure).not.toHaveBeenCalled();
  });
});
