// The browser runtime that turns a synced signed bundle into a live, in-tab
// chart engine — the on-device replacement for the FastAPI backend.
//
// Two Workers, off the UI thread:
//   - the sync Worker (edge-proc EngineClient) owns OPFS + the ported sync_index;
//     it pulls the signed, content-addressed bundle, verifies it ed25519+sha256
//     fail-closed, and materializes the wheel + ephemeris;
//   - the Pyodide Worker (ChartEngineClient) boots the unchanged almamesh engine
//     over those bytes and computes charts in-thread.
//
// bootstrap() drives both with a progress callback and is idempotent: the engine
// is booted once and cached. After the first run everything needed lives in
// OPFS, so reloads are offline-capable.
//
// Whether the Pyodide Worker may warm up WHILE the sync Worker runs is decided
// once per boot by ./bootPolicy.ts (default: sequential — low-end hardware is
// the primary target; overlap only on a Chromium deviceMemory/cores reading).

import type { SyncProgress, SyncResult } from "@gainratio/browser";

import { spawnAlmaSyncEngine } from "../edgeprocClient";
import { decideBootPolicy, readBootSignals } from "./bootPolicy";
import type { BootDecision } from "./bootPolicy";
import type { SiderealChart } from "./chart";
import { ChartEngineClient } from "./chartEngineClient";
import { memoizeChartEngine } from "./engineMemo";
import type { MeshEdgeContext } from "./mesh";
import type { PredictiveContexts } from "./predictive";
import type {
  BirthInput,
  BootConfig,
  BootProgress,
  MeshEdgeInput,
  PredictiveCallOptions,
  PredictiveInput,
  PyodideAsset,
} from "./protocol";
import type { RectificationInput, RectificationResultRaw } from "./rectification";
import { EngineBootCancelledError, trackPageTeardown } from "./teardown";
import type { PageLifecycle } from "./teardown";

/** A bootstrap stage, surfaced to the UI for a real progress story. The
 * `syncing` and `booting-engine` stages are re-reported with `progress` as
 * bytes arrive (rate-limited by the Workers), so a consumer can draw a bar
 * and an idle budget can tell "slow" from "stuck". */
export type BootStage =
  | { readonly kind: "syncing"; readonly progress?: SyncProgress }
  | { readonly kind: "synced"; readonly result: SyncResult }
  | { readonly kind: "reassembling" }
  | { readonly kind: "booting-engine"; readonly progress?: BootProgress }
  | { readonly kind: "ready" };

/** Progress sink; called as bootstrap advances through its stages. */
export type OnStage = (stage: BootStage) => void;

/** Where the bundle is synced from, the pinned key, and the synced asset paths. */
export interface RuntimeConfig {
  readonly bundleBaseUrl: string; // origin serving /latest, /manifest/*, /chunk/*
  readonly pubkeyUrl: string; // pinned ed25519 key, served same-origin as the app
  readonly expectedBundleId: string; // signed publisher identity expected by this app
  readonly expectedChannel: string; // signed release channel expected by this app
  readonly pyodideIndexUrl: string; // self-hosted Pyodide dist (same-origin app asset)
  // Wheel paths within the bundle, in install order (leaf-first; almamesh last).
  readonly wheelPaths: readonly string[];
  // Skyfield data paths within the bundle (de421.bsp + finals2000A.all).
  readonly skyfieldDataPaths: readonly string[];
}

/** The sync-Worker surface bootstrap needs: pull the bundle, read its files. */
export interface EnginePort {
  sync(
    baseUrl: string,
    pubkeyUrl: string,
    expectedBundleId: string,
    expectedChannel: string,
    onProgress?: (progress: SyncProgress) => void,
  ): Promise<SyncResult>;
  readFile(path: string): Promise<Uint8Array>;
  /** Stop the sync Worker and release its OPFS/wasm resources. */
  terminate?(): void;
}

/** The Pyodide-Worker surface bootstrap needs: boot the engine, compute charts. */
export interface ChartEnginePort {
  /**
   * Start the Pyodide runtime + its stdlib packages from the self-hosted index
   * while the bundle is still syncing; `boot` then reuses it. Needs no bundle
   * bytes. Optional so a port without it simply boots cold.
   */
  prewarm?(pyodideIndexUrl: string): void;
  boot(config: BootConfig, onProgress?: (progress: BootProgress) => void): Promise<void>;
  generateChart(birth: BirthInput): Promise<SiderealChart>;
  computePredictive(input: PredictiveInput): Promise<PredictiveContexts>;
  computeMeshEdge(input: MeshEdgeInput): Promise<MeshEdgeContext>;
  computeRectification(input: RectificationInput): Promise<RectificationResultRaw>;
  /** Stop the chart Worker and release Pyodide resources. */
  terminate?(): void;
}

/**
 * Provenance recorded in every signed bundle (`almamesh_meta.json`). This is the
 * wire shape produced by the `almamesh-bundle` publisher (backend
 * `edge/bundle.py` `BundleMeta`) — surfaced to the UI for the per-report
 * "calculated locally" footer (trust through transparency).
 */
export interface BundleMeta {
  readonly bundle_id: string;
  readonly version: string;
  readonly engine_version: string;
  readonly ephemeris_file: string;
  readonly ayanamsa: string;
  readonly constructs: readonly string[];
}

/** The ready engine returned by bootstrap. */
export interface ChartEngine {
  generateChart(birth: BirthInput): Promise<SiderealChart>;
  /**
   * The LAZY predictive payload at an EXPLICIT reference instant. Heavy
   * (~35s under Pyodide) — never part of the natal chart path. `options`
   * only chooses how the engine memo retains the result (./engineMemo.ts).
   */
  computePredictive(input: PredictiveInput, options?: PredictiveCallOptions): Promise<PredictiveContexts>;
  /**
   * The relational MESH edge between two birth inputs, computed on-device
   * (both natal contexts recomputed internally; explicit instants only).
   */
  computeMeshEdge(input: MeshEdgeInput): Promise<MeshEdgeContext>;
  /**
   * Birth-time rectification: score user life events against adjacent-sign
   * candidates and rank them with an honest confidence band.
   */
  computeRectification(input: RectificationInput): Promise<RectificationResultRaw>;
  /** Bundle provenance read from the synced `almamesh_meta.json`, if present. */
  meta(): BundleMeta | null;
}

/**
 * Grants `task` an idle slot of the UI thread and returns a cancel. The
 * overlap-mode warm-up goes through this: it is Worker work, but on few cores
 * it competes with the sync Worker and the UI thread while the user is typing
 * the onboarding form, so it waits until the page has nothing more urgent.
 */
export type IdleScheduler = (task: () => void) => () => void;

/** The warm-up never waits longer than this for an idle slot. */
const PREWARM_IDLE_TIMEOUT_MS = 1_500;

/** The seams bootstrap depends on; defaulted to the real Workers, faked in tests. */
export interface RuntimeDeps {
  readonly spawnSyncEngine: () => EnginePort;
  readonly spawnChartEngine: () => ChartEnginePort;
  /** Sequential or overlapped Worker start-up; defaults to the navigator-driven policy. */
  readonly decideBootMode?: () => BootDecision;
  /** Where the one boot-policy line per boot goes; defaults to console.info. */
  readonly log?: (line: string) => void;
  /** When the overlap-mode warm-up may start; defaults to `requestIdleCallback`. */
  readonly scheduleIdle?: IdleScheduler;
  /** True once the page is unloading; no Worker is spawned then. Defaults to `pagehide`. */
  readonly isPageTearingDown?: () => boolean;
}

const defaultDecideBootMode = (): BootDecision => decideBootPolicy(readBootSignals(navigator));
const defaultLog = (line: string): void => console.info(line);
const defaultScheduleIdle: IdleScheduler = (task) => {
  if (typeof requestIdleCallback === "function") {
    const id = requestIdleCallback(() => task(), { timeout: PREWARM_IDLE_TIMEOUT_MS });
    return () => cancelIdleCallback(id);
  }
  const id = setTimeout(task, 0);
  return () => clearTimeout(id);
};

const pageLifecycle: PageLifecycle | null =
  typeof window === "undefined" ? null : trackPageTeardown(window);
const defaultIsPageTearingDown = (): boolean => pageLifecycle?.isTearingDown() ?? false;

const defaultDeps: RuntimeDeps = {
  spawnSyncEngine: spawnAlmaSyncEngine,
  spawnChartEngine: () => ChartEngineClient.spawn(),
  decideBootMode: defaultDecideBootMode,
  log: defaultLog,
  scheduleIdle: defaultScheduleIdle,
  isPageTearingDown: defaultIsPageTearingDown,
};

/** Build the production runtime deps (real sync Worker + real Pyodide Worker). */
export function defaultRuntimeDeps(): RuntimeDeps {
  return defaultDeps;
}

const META_PATH = "almamesh_meta.json";

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

async function loadAsset(engine: EnginePort, path: string): Promise<PyodideAsset> {
  return { filename: basename(path), bytes: await engine.readFile(path) };
}

/**
 * Read the synced bundle provenance. Best-effort: a missing/unreadable meta file
 * must NOT fail bootstrap — the footer just shows nothing — so this returns null
 * on any error rather than throwing.
 */
async function readMeta(engine: EnginePort): Promise<BundleMeta | null> {
  try {
    const bytes = await engine.readFile(META_PATH);
    return JSON.parse(new TextDecoder().decode(bytes)) as BundleMeta;
  } catch {
    return null;
  }
}

export class AlmaMeshRuntime {
  readonly #deps: RuntimeDeps;
  #enginePromise: Promise<ChartEngine> | null = null;
  #ready: ChartEngine | null = null;
  #syncEngine: EnginePort | null = null;
  #chartEngine: ChartEnginePort | null = null;
  #generation = 0;

  public constructor(deps: RuntimeDeps = defaultDeps) {
    this.#deps = deps;
  }

  /** The ready engine, or null before the first successful bootstrap. */
  public engine(): ChartEngine | null {
    return this.#ready;
  }

  /** Stop all Workers, invalidate an in-flight build, and clear the ready engine. */
  public dispose(): void {
    this.#generation += 1;
    this.#enginePromise = null;
    this.#ready = null;
    this.#syncEngine?.terminate?.();
    this.#chartEngine?.terminate?.();
    this.#syncEngine = null;
    this.#chartEngine = null;
  }

  /** Sync the bundle, boot Pyodide, and return the in-tab chart engine. Idempotent. */
  public bootstrap(config: RuntimeConfig, onStage: OnStage = () => {}): Promise<ChartEngine> {
    if (this.#enginePromise === null) {
      const generation = this.#generation;
      this.#enginePromise = this.#build(config, onStage, generation).catch(
        (error: unknown) => {
          // A superseded build must not clear state belonging to a newer boot.
          if (this.#generation === generation) {
            this.#generation += 1;
            this.#enginePromise = null;
            this.#ready = null;
            this.#syncEngine = null;
            this.#chartEngine = null;
          }
          throw error;
        },
      );
    }
    return this.#enginePromise;
  }

  async #build(
    config: RuntimeConfig,
    onStage: OnStage,
    generation: number,
  ): Promise<ChartEngine> {
    this.#assertPageAlive();
    const syncEngine = this.#deps.spawnSyncEngine();
    this.#syncEngine = syncEngine;
    let chartEngine: ChartEnginePort | null = null;
    let cancelPrewarm: (() => void) | null = null;
    try {
      this.#assertCurrent(generation);
      const decision = (this.#deps.decideBootMode ?? defaultDecideBootMode)();
      (this.#deps.log ?? defaultLog)(
        `[almamesh] engine boot policy: ${decision.mode} (${decision.reason})`,
      );
      if (decision.mode === "overlap") {
        // Overlap the two independent cold costs: Pyodide's own runtime + stdlib
        // packages need nothing from the bundle, so they load while the bundle
        // syncs and verifies. Only the engine install waits for the synced bytes.
        // A warm-up failure is not lost: `boot` awaits the same warm-up in the
        // Worker and reports it. The price is two wasm heaps alive at once,
        // which is why the policy grants this only on roomy hardware — and even
        // then the warm-up waits for an idle slot, so the first keystrokes of
        // the onboarding form are never competing with it for cores.
        this.#assertPageAlive();
        const warming = this.#deps.spawnChartEngine();
        chartEngine = warming;
        this.#chartEngine = warming;
        cancelPrewarm = (this.#deps.scheduleIdle ?? defaultScheduleIdle)(() => {
          cancelPrewarm = null;
          if (this.#chartEngine === warming) warming.prewarm?.(config.pyodideIndexUrl);
        });
      }

      onStage({ kind: "syncing" });
      const result = await syncEngine.sync(
        config.bundleBaseUrl,
        config.pubkeyUrl,
        config.expectedBundleId,
        config.expectedChannel,
        (progress) => onStage({ kind: "syncing", progress }),
      );
      this.#assertCurrent(generation);
      // The sync settled before an idle slot came: `boot` warms the runtime
      // itself (cold), which is exactly the sequential path.
      cancelPrewarm?.();
      cancelPrewarm = null;
      onStage({ kind: "synced", result });

      onStage({ kind: "reassembling" });
      const [bootConfig, meta] = await Promise.all([
        this.#assembleBootConfig(syncEngine, config),
        readMeta(syncEngine),
      ]);
      this.#assertCurrent(generation);

      // The sync Worker is only needed to materialize the boot assets. Release
      // its OPFS handles and wasm memory as soon as they are in hand — in
      // sequential mode the Pyodide Worker does not even exist until this point.
      syncEngine.terminate?.();
      if (this.#syncEngine === syncEngine) this.#syncEngine = null;

      onStage({ kind: "booting-engine" });
      if (chartEngine === null) this.#assertPageAlive();
      const booted = chartEngine ?? this.#deps.spawnChartEngine();
      chartEngine = booted;
      this.#chartEngine = booted;
      await booted.boot(bootConfig, (progress) => onStage({ kind: "booting-engine", progress }));
      this.#assertCurrent(generation);

      // Identical inputs are computed once per booted engine, keyed on the
      // signed bundle's content-addressed manifest (see ./engineMemo.ts).
      const engine: ChartEngine = memoizeChartEngine(
        {
          generateChart: (birth) => booted.generateChart(birth),
          computePredictive: (input) => booted.computePredictive(input),
          computeMeshEdge: (input) => booted.computeMeshEdge(input),
          computeRectification: (input) => booted.computeRectification(input),
          meta: () => meta,
        },
        result.manifestHash,
      );
      this.#ready = engine;
      onStage({ kind: "ready" });
      return engine;
    } catch (error) {
      cancelPrewarm?.();
      syncEngine.terminate?.();
      chartEngine?.terminate?.();
      if (this.#syncEngine === syncEngine) this.#syncEngine = null;
      if (this.#chartEngine === chartEngine) this.#chartEngine = null;
      throw error;
    }
  }

  /** WebKit refuses (and logs) a Worker constructed after `pagehide`; do not try. */
  #assertPageAlive(): void {
    if ((this.#deps.isPageTearingDown ?? defaultIsPageTearingDown)()) {
      throw new EngineBootCancelledError();
    }
  }

  #assertCurrent(generation: number): void {
    if (this.#generation !== generation) {
      throw new Error("AlmaMesh engine boot superseded");
    }
  }

  async #assembleBootConfig(engine: EnginePort, config: RuntimeConfig): Promise<BootConfig> {
    const [wheels, skyfieldData] = await Promise.all([
      Promise.all(config.wheelPaths.map((path) => loadAsset(engine, path))),
      Promise.all(config.skyfieldDataPaths.map((path) => loadAsset(engine, path))),
    ]);
    return { pyodideIndexUrl: config.pyodideIndexUrl, wheels, skyfieldData };
  }
}
