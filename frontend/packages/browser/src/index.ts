// @almamesh/browser — the in-browser, local-first AlmaMesh engine.
//
// AlmaMesh runs entirely on-device: a signed edge-proc bundle (ephemeris +
// rules + the almamesh wheel + Pyodide/numpy/skyfield wheels) is synced into
// OPFS, then the chart is computed in a Web Worker by the UNCHANGED Python
// engine under Pyodide. No backend, no account.
//
// The signed-bundle sync + OPFS + Worker tier comes from the independently
// versioned @edgeproc/browser package; this package owns only AlmaMesh's thin
// cache/exit-gate adapter and Pyodide chart compute.

// --- the reused sync foundation (edge-proc browser tier) ---
export {
  EngineClient,
  materializeFile,
  MemoryCacheStore,
  OpfsCacheStore,
  syncIndex,
  WorkerCrashError,
  WorkerTimeoutError,
} from "@edgeproc/browser";
export type {
  CacheStore,
  FetchBytes,
  IndexManifest,
  SyncProgress,
  SyncResult,
  Verify,
  VersionPointer,
} from "@edgeproc/browser";

// --- explicit user reset only: wipe the synced bundle cache + rollback floor ---
export { clearAlmaBundleCache } from "./edgeprocClient";

// --- the runtime: sync the bundle -> boot Pyodide -> on-device chart engine ---
export { AlmaMeshRuntime, defaultRuntimeDeps } from "./pyodide/runtime";
export type {
  BootStage,
  BundleMeta,
  ChartEngine,
  EnginePort,
  ChartEnginePort,
  OnStage,
  RuntimeConfig,
  RuntimeDeps,
} from "./pyodide/runtime";

// --- domain-strength receipts (tamper-evidence layer, see ./pyodide/strengthReceipt) ---
export {
  signDomainStrength,
  verifyDomainStrength,
  verifyDomainStrengthClaim,
} from "./pyodide/strengthReceipt";
export type { DomainStrengthAssayResult } from "./pyodide/strengthAssay";

// --- the Pyodide chart engine (compute layer) ---
export { ChartEngineClient } from "./pyodide/chartEngineClient";
export type {
  HouseCusp,
  LagnaData,
  PlanetPosition,
  DashaPeriod,
  MahaDashaPeriod,
  SiderealChart,
  VimshottariDasha,
  YogaData,
  YogaFormationRule,
  YogaGrade,
  YogaStrengthFactor,
} from "./pyodide/chart";
export type {
  BirthInput,
  BootConfig,
  BootProgress,
  BootProgressStage,
  MeshBirthInput,
  MeshEdgeInput,
  PredictiveInput,
  PyodideAsset,
} from "./pyodide/protocol";
export type { PredictiveContexts } from "./pyodide/predictive";
export type { MeshEdgeContext } from "./pyodide/mesh";
export type {
  EventEvidenceRaw,
  RectificationCandidateRaw,
  RectificationInput,
  RectificationResultRaw,
} from "./pyodide/rectification";
