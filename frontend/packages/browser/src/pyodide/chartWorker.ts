// The Pyodide chart Worker: boots Pyodide, installs the UNCHANGED `almamesh`
// Python engine + its ephemeris, and computes sidereal charts entirely
// in-thread. This is a faithful port of the proven Phase-0 spike
// (/tmp/almamesh-spike/run_full_pyodide.mjs) to a browser module Worker — Node
// `readFileSync` is replaced by bytes delivered in the boot message (synced from
// the signed edge-proc bundle by the runtime).
//
// Exercised end-to-end by the P2.6 harness; the main-thread client that drives
// it (ChartEngineClient) is unit-tested separately against a fake worker.

import { generateSeedHex, publicKeyHex } from "@gainratio/avow";
import { loadPyodide, type PyodideInterface } from "pyodide";

import type { SiderealChart } from "./chart";
import { LOAD_PACKAGES } from "./loadPackages";
import { versionedPyodideIndexUrl } from "./pyodideDist";
import {
  assertPackagesLoaded,
  bootCriticalUrls,
  ensureDistCached,
  openDistCache,
} from "./pyodideDistCache";
import type { MeshEdgeContext } from "./mesh";
import type { EnginePredictiveContexts, PredictiveContexts } from "./predictive";
import { composeDomainStrengths } from "./strengthAssay";
import { sealDomainStrengths } from "./strengthReceipt";
import type {
  BirthInput,
  BootConfig,
  BootProgress,
  BootProgressStage,
  ChartWorkerRequest,
  ChartWorkerResponse,
  MeshEdgeInput,
  MoonWindow,
  MoonWindowInput,
  PredictiveInput,
} from "./protocol";
import type { RectificationInput, RectificationResultRaw } from "./rectification";
import { observeOrphanedLoadFailures } from "./teardown";

const SKYFIELD_DATA_DIR = "/home/pyodide/.skyfield-data";


// Defines `_almamesh_generate_chart(birth_json)` once; the engine is the
// unchanged package, called with an explicit reference_date for reproducibility.
//
// Exported so the offline parity/precision integration gates can run the EXACT
// same glue under Pyodide (rather than a drifting copy).
export const PY_BOOTSTRAP = `
import json
from datetime import UTC, datetime
from almamesh.calculations import calculate_sidereal_context
from almamesh.snapshot import compute_stamped_chart

def _almamesh_generate_chart(birth_json):
    # referenceDate is REQUIRED — no silent now(); a KeyError here is a caller
    # bug, surfaced through the worker's error envelope. Birth data ALONE does
    # not determine a chart: the instant picks which Vimshottari maha dasha is
    # "current", so a path that accepted birth data alone was guessing, and the
    # guess was the wall clock — which made the SAME input produce a different
    # chart on a different day. Same rule the predictive and mesh entries below
    # have always enforced.
    birth = json.loads(birth_json)
    dt = datetime.fromisoformat(birth["datetimeUtc"])
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    reference_date = datetime.fromisoformat(birth["referenceDate"])
    # The stamped chart: engine output + its snapshot (engine version, data
    # hash, conventions, both instants, snapshot_id). The TS boundary re-hashes
    # the snapshot and refuses a chart whose stamp does not match the request.
    chart = compute_stamped_chart(
        dt, birth["latitude"], birth["longitude"], reference_date=reference_date
    )
    return json.dumps(chart.model_dump(mode="json"))

def _almamesh_compute_predictive(input_json):
    # The LAZY predictive superset (transits + vargas + strength + domains).
    # referenceInstant is REQUIRED — no silent now(); a KeyError here is a
    # caller bug, surfaced through the worker's error envelope.
    # Imported lazily so booting an OLDER bundled wheel (without the
    # predictive module) still serves natal charts.
    #
    # This returns the engine's four contexts and NOTHING else. Assay composes
    # each headline and Avow seals its complete strength summary in TypeScript
    # after this call returns — the Python side stays crypto-free.
    from almamesh.predictive import civil_offset_from_minutes, compute_predictive_contexts, window_months_from_wire
    data = json.loads(input_json)
    dt = datetime.fromisoformat(data["datetimeUtc"])
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    reference = datetime.fromisoformat(data["referenceInstant"])
    ctx = compute_predictive_contexts(
        dt, data["latitude"], data["longitude"], reference,
        civil_offset=civil_offset_from_minutes(data["utcOffsetMinutes"]),
        window_months=window_months_from_wire(data.get("windowMonths")),
    )
    return json.dumps(ctx.model_dump(mode="json"))

def _almamesh_compute_moon_window(input_json):
    # The Moon at the ends of a place's local window, plus (optionally) one
    # event's Moon and lagna sign. Only the explicit instants and coordinates
    # in the payload are read; no wall clock. Imported lazily so booting an
    # OLDER bundled wheel (without the module) still serves natal charts.
    from almamesh.transits.moon_window import moon_window_from_wire
    data = json.loads(input_json)
    event = data.get("event")
    return json.dumps(moon_window_from_wire({
        "place_start_utc": data.get("placeStartUtc"),
        "place_end_utc": data.get("placeEndUtc"),
        "event": None if event is None else {
            "datetime_utc": event.get("datetimeUtc"),
            "latitude": event.get("latitude"),
            "longitude": event.get("longitude"),
        },
    }).model_dump(mode="json"))

def _almamesh_compute_mesh(input_json):
    # The relational MESH edge between TWO bare birth inputs ("a" and "b").
    # Both natal contexts are recomputed here on-device — no chart crosses the
    # worker boundary. Every instant is REQUIRED and explicit (referenceInstant
    # pins both charts' "current" dasha; windowStart/windowEnd bound the dasha
    # synchrony) — a KeyError is a caller bug, surfaced through the worker's
    # error envelope. Imported lazily so booting an OLDER bundled wheel
    # (without the mesh module) still serves natal charts.
    from almamesh.mesh import compute_mesh_edge
    from almamesh.schemas.mesh import MatchRole, Relationship
    data = json.loads(input_json)
    reference = datetime.fromisoformat(data["referenceInstant"])
    def _natal(birth):
        dt = datetime.fromisoformat(birth["datetimeUtc"])
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=UTC)
        return calculate_sidereal_context(
            dt, birth["latitude"], birth["longitude"], reference_date=reference
        )
    edge = compute_mesh_edge(
        _natal(data["a"]),
        _natal(data["b"]),
        relationship=Relationship(data["relationship"]),
        role_a=MatchRole(data["roleA"]),
        role_b=MatchRole(data["roleB"]),
        window_start=datetime.fromisoformat(data["windowStart"]),
        window_end=datetime.fromisoformat(data["windowEnd"]),
    )
    return json.dumps(edge.model_dump(mode="json"))

def _almamesh_compute_rectification(input_json):
    # Birth-time rectification: score user life events against Ascendant-sign
    # candidates and rank them honestly (band = 'near_tie' | 'leans' | 'consistent').
    # referenceDate is OPTIONAL — omit for live non-deterministic use; pass it
    # for reproducible test fixtures. A KeyError here is a caller bug.
    # Imported lazily so an OLDER bundled wheel (without the rectification module)
    # still serves natal charts.
    from almamesh.rectification import compute_rectification_result
    from almamesh.rectification.models import RectificationEventInput, RectificationMode
    data = json.loads(input_json)
    dt = datetime.fromisoformat(data["datetimeUtc"])
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    raw_ref = data.get("referenceDate")
    reference_date = datetime.fromisoformat(raw_ref) if raw_ref else datetime.now(UTC)
    events = [
        # precision drives the approximate-date engine (exact|month|year|approx);
        # default "exact" keeps older callers (no precision key) byte-stable.
        RectificationEventInput(
            date=e["date"], category=e["category"], precision=e.get("precision", "exact")
        )
        for e in data["events"]
    ]
    # Spec 062: spanMinutes (honest window bound) + anchorConfidence (E5 anchor
    # prior) thread through as snake_case kwargs. Both kwargs are OMITTED when
    # the caller omits the field, so absent inputs stay byte-identical and an
    # older wheel (without the kwargs) still serves span-less calls.
    extra_kwargs = {}
    raw_span = data.get("spanMinutes")
    if raw_span is not None:
        extra_kwargs["span_minutes"] = int(raw_span)
    raw_anchor = data.get("anchorConfidence")
    if raw_anchor is not None:
        from almamesh.rectification.models import AnchorConfidence
        extra_kwargs["anchor_confidence"] = AnchorConfidence(str(raw_anchor))
    result = compute_rectification_result(
        dt_utc=dt,
        latitude=data["latitude"],
        longitude=data["longitude"],
        utc_offset_minutes=data["utcOffsetMinutes"],
        events=events,
        mode=RectificationMode(data["mode"]),
        reference_date=reference_date,
        **extra_kwargs,
    )
    return json.dumps(result.model_dump(mode="json"))
`;

// micropip's install is a Python callable; callKwargs forwards keyword args.
interface PyInstall {
  (requirements: string | readonly string[]): Promise<void>;
  callKwargs(url: string, kwargs: { readonly deps: boolean }): Promise<void>;
}
interface Micropip {
  readonly install: PyInstall;
}
interface PyChartFn {
  (birthJson: string): string;
  destroy(): void;
}
interface PyPredictiveFn {
  (inputJson: string): string;
  destroy(): void;
}
interface PyMoonWindowFn {
  (inputJson: string): string;
  destroy(): void;
}
interface PyMeshFn {
  (inputJson: string): string;
  destroy(): void;
}
interface PyRectificationFn {
  (inputJson: string): string;
  destroy(): void;
}

let enginePyodide: PyodideInterface | undefined;

// The one Pyodide runtime this Worker owns, started by `prewarm` (while the
// bundle is still syncing on the main thread's sync Worker) or else by `boot`.
let runtimePyodide: Promise<PyodideInterface> | undefined;
/** Set once the runtime start has fully succeeded; see observeOrphanedLoadFailures. */
let runtimeReady = false;

/** Boot progress sink: a stage change, or bytes of a Pyodide asset arriving. */
type ReportBoot = (progress: BootProgress) => void;

/** Byte-level progress reports are rate-limited to this interval. */
const BOOT_PROGRESS_INTERVAL_MS = 250;

/**
 * How far the runtime start has got, kept at module level because `prewarm`
 * may start the ~17 MB download before any `boot` request exists. A `boot`
 * that arrives mid-download attaches as the listener and keeps reporting the
 * remaining bytes; without this a prewarmed boot on slow 4G would go silent
 * for the rest of the download and trip the main thread's idle deadline.
 */
const runtimeStart: {
  stage: BootProgressStage;
  bytesReceived: number;
  bytesTotal: number | null;
  listener: ((event: "stage" | "bytes") => void) | undefined;
} = { stage: "pyodide", bytesReceived: 0, bytesTotal: null, listener: undefined };

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * A `fetch` that counts the bytes of every Pyodide asset as they stream in.
 * `loadPyodide` and `loadPackage` fetch ~17 MB through the global `fetch`
 * with no progress hook of their own; on slow 4G that download alone outlives
 * a 60 s wall clock. Teeing the body keeps the main thread's boot deadline
 * honest (slow is not dead) and gives the UI a real number to show. Headers
 * are preserved so `WebAssembly.instantiateStreaming` still sees
 * `application/wasm`.
 */
function countingFetch(
  native: typeof fetch,
  indexUrl: string,
  onBytes: (received: number, total: number | null) => void,
  fetched: Set<string>,
): typeof fetch {
  const prefix = new URL(indexUrl, self.location.href).href;
  let cumulative = 0;
  return async (input, init) => {
    const response = await native(input, init);
    const url = new URL(requestUrl(input), self.location.href).href;
    if (!url.startsWith(prefix)) return response;
    fetched.add(url);
    if (response.body === null) return response;
    const declared = Number(response.headers.get("content-length"));
    const total = Number.isFinite(declared) && declared > 0 ? declared : null;
    const counted = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          cumulative += chunk.byteLength;
          onBytes(cumulative, total);
          controller.enqueue(chunk);
        },
      }),
    );
    return new Response(counted, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

/**
 * Make sure every file this boot used is in the SW's Pyodide cache, so the next
 * boot works offline even when the SW never saw this one (first visit, slow
 * CPU). A file that cannot be cached does not fail the boot — the engine works
 * now — but it is reported, because offline reboot is now not guaranteed.
 */
async function cacheForOffline(
  indexUrl: string,
  fetched: ReadonlySet<string>,
  nativeFetch: typeof fetch,
): Promise<void> {
  if (typeof caches === "undefined") return; // insecure context: no Cache API
  const cache = await openDistCache(caches);
  const { failed } = await ensureDistCached(bootCriticalUrls(indexUrl, fetched), cache, nativeFetch);
  // Code-only line, like the boot-policy line: no URLs or causes leave the Worker.
  if (failed.length > 0) console.info(`[almamesh] engine offline cache incomplete (${failed.length} files)`);
}

async function startRuntime(pyodideIndexUrl: string): Promise<PyodideInterface> {
  const scope = self as unknown as { fetch: typeof fetch };
  const nativeFetch = scope.fetch;
  const fetched = new Set<string>();
  scope.fetch = countingFetch(
    nativeFetch,
    pyodideIndexUrl,
    (received, total) => {
      runtimeStart.bytesReceived = received;
      runtimeStart.bytesTotal = total;
      runtimeStart.listener?.("bytes");
    },
    fetched,
  );
  try {
    // Version-scoped (`/pyodide/v<version>/`) so cached bytes of another release
    // can never be handed to this loader — see ./pyodideDist.ts.
    const indexUrl = versionedPyodideIndexUrl(pyodideIndexUrl);
    const pyodide = await loadPyodide({ indexURL: indexUrl });
    runtimeStart.stage = "packages";
    runtimeStart.listener?.("stage");
    // loadPackage resolves the whole list from the self-hosted lock. It does
    // NOT throw when a wheel fails to fetch (offline): it logs and moves on, so
    // check what actually arrived and fail loudly here.
    const loadErrors: string[] = [];
    const loaded = await pyodide.loadPackage([...LOAD_PACKAGES], {
      errorCallback: (message) => loadErrors.push(message),
    });
    assertPackagesLoaded(LOAD_PACKAGES, loaded, loadErrors);
    await cacheForOffline(indexUrl, fetched, nativeFetch);
    runtimeReady = true;
    return pyodide;
  } finally {
    scope.fetch = nativeFetch;
  }
}

function warmRuntime(pyodideIndexUrl: string): Promise<PyodideInterface> {
  runtimePyodide ??= startRuntime(pyodideIndexUrl);
  return runtimePyodide;
}

async function installEngine(pyodide: PyodideInterface, config: BootConfig): Promise<void> {
  const micropip = pyodide.pyimport("micropip") as unknown as Micropip;
  // Install bundled wheels in order, each deps:false: their deps are already
  // loaded above, and deps:true would make micropip resolve against PyPI.
  for (const wheel of config.wheels) {
    pyodide.FS.writeFile(`/${wheel.filename}`, wheel.bytes);
    await micropip.install.callKwargs(`emfs:/${wheel.filename}`, { deps: false });
  }
}

function seedSkyfieldData(pyodide: PyodideInterface, config: BootConfig): void {
  pyodide.FS.mkdirTree(SKYFIELD_DATA_DIR);
  for (const asset of config.skyfieldData) {
    pyodide.FS.writeFile(`${SKYFIELD_DATA_DIR}/${asset.filename}`, asset.bytes);
  }
}

async function boot(config: BootConfig, report: ReportBoot): Promise<void> {
  // The runtime may already be warming (or warm) from `prewarm`: start from
  // wherever it is and listen for the rest.
  let stage: BootProgressStage = runtimeStart.stage;
  let lastByteReport = Number.NEGATIVE_INFINITY;
  const progress = (): void =>
    report({
      stage,
      bytesReceived: runtimeStart.bytesReceived,
      bytesTotal: runtimeStart.bytesTotal,
    });
  const enter = (next: BootProgressStage): void => {
    stage = next;
    progress();
  };
  runtimeStart.listener = (event) => {
    if (event === "stage") {
      enter(runtimeStart.stage);
      return;
    }
    const now = Date.now();
    if (now - lastByteReport < BOOT_PROGRESS_INTERVAL_MS) return;
    lastByteReport = now;
    progress();
  };
  try {
    progress();
    const pyodide = await warmRuntime(config.pyodideIndexUrl);
    enter("wheels");
    await installEngine(pyodide, config);
    enter("data");
    seedSkyfieldData(pyodide, config);
    enter("engine");
    await pyodide.runPythonAsync(PY_BOOTSTRAP);
    enginePyodide = pyodide;
  } finally {
    runtimeStart.listener = undefined;
  }
}

function generateChart(birth: BirthInput): SiderealChart {
  if (enginePyodide === undefined) {
    throw new Error("chart worker not booted");
  }
  const fn = enginePyodide.globals.get("_almamesh_generate_chart") as unknown as PyChartFn;
  try {
    return JSON.parse(fn(JSON.stringify(birth))) as SiderealChart;
  } finally {
    fn.destroy();
  }
}

function computeMoonWindow(input: MoonWindowInput): MoonWindow {
  if (enginePyodide === undefined) {
    throw new Error("chart worker not booted");
  }
  const fn = enginePyodide.globals.get("_almamesh_compute_moon_window") as unknown as PyMoonWindowFn;
  try {
    return JSON.parse(fn(JSON.stringify(input))) as MoonWindow;
  } finally {
    fn.destroy();
  }
}

function computePredictive(input: PredictiveInput): EnginePredictiveContexts {
  if (enginePyodide === undefined) {
    throw new Error("chart worker not booted");
  }
  const fn = enginePyodide.globals.get("_almamesh_compute_predictive") as unknown as PyPredictiveFn;
  try {
    return JSON.parse(fn(JSON.stringify(input))) as EnginePredictiveContexts;
  } finally {
    fn.destroy();
  }
}

// THIS DEVICE's strength-receipt signing seed: generated once per Worker boot and
// reused for every predictive compute in the session.
//
// WHY device-local rather than a shipped key: a browser cannot keep a secret from
// its own operator, so embedding one shared private key in the bundle would
// manufacture a forgeable identity that merely LOOKS authoritative. A
// device-generated key is the honest local-first primitive — the receipt makes a
// stored or exported strength summary TAMPER-EVIDENT (mutate the % after the fact
// and verification fails) and carries its own public key so a holder can check it
// offline. It does NOT survive a reload, and it attests nothing about WHO computed
// the summary. Integrity, not identity.
let deviceSeedHex: string | undefined;

function deviceSeed(): string {
  deviceSeedHex ??= generateSeedHex();
  return deviceSeedHex;
}

/**
 * Compute the predictive superset, then seal every domain's strength summary.
 *
 * Sealing is unconditional and total — there is no unsealed mode and no feature
 * flag — so the receipt seam can never silently go dead. It adds no number: each
 * receipt payload is the engine's `StrengthSummary` verbatim.
 */
async function computeSealedPredictive(input: PredictiveInput): Promise<PredictiveContexts> {
  const engine = computePredictive(input);
  const seed = deviceSeed();
  return {
    ...engine,
    domain_strength_assays: composeDomainStrengths(engine.domains_context),
    domain_strength_receipts: await sealDomainStrengths(engine.domains_context, seed),
    strength_signer_public_key: await publicKeyHex(seed),
  };
}

function computeMeshEdge(input: MeshEdgeInput): MeshEdgeContext {
  if (enginePyodide === undefined) {
    throw new Error("chart worker not booted");
  }
  const fn = enginePyodide.globals.get("_almamesh_compute_mesh") as unknown as PyMeshFn;
  try {
    return JSON.parse(fn(JSON.stringify(input))) as MeshEdgeContext;
  } finally {
    fn.destroy();
  }
}

function computeRectification(input: RectificationInput): RectificationResultRaw {
  if (enginePyodide === undefined) {
    throw new Error("chart worker not booted");
  }
  const fn = enginePyodide.globals.get("_almamesh_compute_rectification") as unknown as PyRectificationFn;
  try {
    return JSON.parse(fn(JSON.stringify(input))) as RectificationResultRaw;
  } finally {
    fn.destroy();
  }
}

async function handle(request: ChartWorkerRequest): Promise<ChartWorkerResponse> {
  try {
    if (request.kind === "prewarm") {
      await warmRuntime(request.pyodideIndexUrl);
      return { ok: true, kind: "prewarm", id: request.id };
    }
    if (request.kind === "boot") {
      await boot(request.config, (progress) => {
        workerScope?.postMessage({
          ok: true,
          kind: "bootProgress",
          id: request.id,
          progress,
        } satisfies ChartWorkerResponse);
      });
      return { ok: true, kind: "boot", id: request.id };
    }
    if (request.kind === "computePredictive") {
      return {
        ok: true,
        kind: "computePredictive",
        id: request.id,
        predictive: await computeSealedPredictive(request.input),
      };
    }
    if (request.kind === "computeMoonWindow") {
      return {
        ok: true,
        kind: "computeMoonWindow",
        id: request.id,
        moonWindow: computeMoonWindow(request.input),
      };
    }
    if (request.kind === "computeMeshEdge") {
      return {
        ok: true,
        kind: "computeMeshEdge",
        id: request.id,
        meshEdge: computeMeshEdge(request.input),
      };
    }
    if (request.kind === "computeRectification") {
      return {
        ok: true,
        kind: "computeRectification",
        id: request.id,
        rectification: computeRectification(request.input),
      };
    }
    return { ok: true, kind: "generateChart", id: request.id, chart: generateChart(request.birth) };
  } catch (error) {
    return { ok: false, id: request.id, error: error instanceof Error ? error.message : String(error) };
  }
}

// Register the message handler only inside a real Worker scope. Outside one
// (Node/Bun test harnesses, the offline parity gate) `self` is absent, so this
// module stays importable for its exported `PY_BOOTSTRAP` glue without spawning
// a listener.
const workerScope =
  typeof self !== "undefined" ? (self as unknown as DedicatedWorkerGlobalScope) : undefined;
if (workerScope) {
  observeOrphanedLoadFailures(workerScope, () => runtimeReady);
  workerScope.addEventListener("message", (event: MessageEvent<ChartWorkerRequest>) => {
    void handle(event.data).then((response) => {
      workerScope.postMessage(response);
    });
  });
}
