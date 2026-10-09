import { describe, expect, it } from "vitest";

import { AlmaMeshRuntime } from "../runtime";
import type { ChartEnginePort, EnginePort, RuntimeConfig } from "../runtime";
import type { SiderealChart } from "../chart";
import type { MeshEdgeContext } from "../mesh";
import type { PredictiveContexts } from "../predictive";
import type {
  BirthInput,
  BootConfig,
  BootProgress,
  MeshEdgeInput,
  PredictiveInput,
} from "../protocol";
import type { RectificationInput, RectificationResultRaw } from "../rectification";
import type { SyncProgress, SyncResult } from "@gainratio/browser";
import type { BootStage, IdleScheduler } from "../runtime";
import { EngineBootCancelledError } from "../teardown";

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
});
