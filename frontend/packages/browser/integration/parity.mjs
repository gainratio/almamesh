// parity.mjs — LOCAL node parity helper (CPython == Pyodide-in-node).
//
// !! THIS IS NOT THE BYTE-PARITY GATE AND CI DOES NOT RUN IT. !!
//
// The gate is apps/web/scripts/verify-browser-parity.mjs, which drives the REAL
// browser Worker from a served origin on every PR and push to main. This file
// previously described itself as "the P2.6 exit-gate" while no workflow
// referenced it and its inputs did not exist in the tree — the README badge
// pointed at a script that had never run. That claim is gone.
//
// Node-hosted Pyodide is not browser Pyodide: different host, different worker
// semantics, different asset delivery (readFileSync here vs a signed bundle
// synced into OPFS there). A green run here says nothing about what users run.
//
// What it IS good for: bisecting an engine change without a browser in the loop.
//
// It does NOT run out of the box — it needs a hand-provisioned ~38 MB spike dir
// (see INPUTS below) that nothing in this repo creates. Without it the script
// exits on `missing required input`.
//
//     node integration/parity.mjs        (from packages/browser)
//     bun run test:parity                 (same, via package.json)
//
// What it asserts:
//   1. Pyodide boots OFFLINE from a self-hosted dist + local wheels (a network
//      tripwire hard-fails any http(s):// fetch — if boot completes, it was
//      provably offline).
//   2. The SAME entrypoint the chart Worker uses is called:
//          calculate_sidereal_context(dt, lat, lon,
//              reference_date=datetime(2025,1,1,tzinfo=UTC)).model_dump(mode="json")
//      The fixed reference_date is CRITICAL — it pins the "current" Vimshottari
//      maha dasha; a wall-clock reference would make current_maha drift and the
//      parity comparison would (correctly) fail.
//   3. Each of the 5 fixtures is canonicalized the SAME way the golden was made
//      (floats rounded to 6 decimals recursively, bool preserved, keys sorted)
//      and deep-compared against the committed golden entry. Per-fixture PASS/FAIL
//      is printed; the process exits non-zero on ANY mismatch.
//
// ---------------------------------------------------------------------------
// INPUTS (all local — nothing is fetched). These reference the proven P0 spike
// dirs to avoid duplicating a 38 MB runtime into the repo; the chart Worker
// receives the equivalent bytes synced from the signed edge-proc bundle.
// ---------------------------------------------------------------------------
//   PYODIDE_DIST  self-hosted Pyodide runtime + base wheels (pyodide-lock.json)
//   WHEEL_DIR     skyfield-stack pure-python wheels (jplephem, sgp4, skyfield)
//   ALMAMESH_WHEEL  the almamesh engine wheel (rebuild: cd backend && uv build --wheel)
//   SKYFIELD_DATA   ~/.skyfield-data/{de421.bsp,finals2000A.all} (DE421 ephemeris)
//   GOLDEN          the committed CPython golden, keyed by fixture ISO datetime

import { loadPyodide } from "pyodide";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOME = process.env.HOME;
// Repo root, resolved relative to THIS script so the parity gate is portable
// across clones (no hardcoded absolute paths). integration/ -> browser ->
// packages -> frontend -> repo root.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

const SPIKE = "/private/tmp/almamesh-spike";
const PYODIDE_DIST = join(SPIKE, "pyodide-dist");
const WHEEL_DIR = join(SPIKE, "offline-wheels");
const ALMAMESH_WHEEL = join(REPO_ROOT, "backend/dist/almamesh-0.1.0-py3-none-any.whl");
const SKYFIELD_DATA = `${HOME}/.skyfield-data`;
const GOLDEN_PATH = join(REPO_ROOT, "backend/tests/fixtures/chart_golden_de421.json");
// Phase-1 predictive transit golden (a SEPARATE context; natal golden stays
// byte-stable). MUST match backend/tests/test_transit_golden.py.
const TRANSIT_GOLDEN_PATH = join(REPO_ROOT, "backend/tests/fixtures/transit_golden_de421.json");

// The fixed reference_date the golden was built with (UTC midnight 2025-01-01).
// MUST match backend/tests/test_chart_golden.py:FIXED_REFERENCE_DATE.
const REFERENCE_DATE = "2025-01-01T00:00:00+00:00";

// Transit-parity pins — MUST match backend/tests/test_transit_golden.py.
const TRANSIT_REFERENCE_DATE = "2024-01-01T00:00:00+00:00";
const TRANSIT_INSTANT = "2026-06-09T12:00:00+00:00";
// The parity-clean subset the transit golden was built on (Delhi/NYC/Tokyo).
const TRANSIT_FIXTURES = [
  { iso: "1990-01-15T12:00:00+00:00", lat: 28.6139, lon: 77.209, label: "Delhi" },
  { iso: "2000-12-31T23:59:00+00:00", lat: 40.7128, lon: -74.006, label: "NYC" },
  { iso: "2019-11-09T17:45:00+00:00", lat: 35.6895, lon: 139.6917, label: "Tokyo" },
];

// Wave-C LAZY predictive payload (transits + all vargas + strength + life
// domains, composed by almamesh/predictive.py — the entrypoint the chart
// Worker's `computePredictive` calls). SEPARATE golden; pins MUST match
// backend/tests/test_predictive_golden.py.
const PREDICTIVE_GOLDEN_PATH = join(REPO_ROOT, "backend/tests/fixtures/predictive_golden_de421.json");
const PREDICTIVE_REFERENCE_INSTANT = "2026-06-09T12:00:00+00:00";
// NOTE: this gate compares the ENGINE's four contexts. It does NOT cover strength
// receipts — those are minted in TypeScript by @gainratio/avow, outside Pyodide.
// Their CPython<->TypeScript byte-compatibility is proven by the shared golden
// vectors in testdata/vectors/, not here.
//
// This harness runs Pyodide under NODE. It is evidence about engine determinism,
// NOT about the browser: a package can load here and still fail to register in a
// real browser boot (which is exactly what pynacl's `_sodium` did).
const PREDICTIVE_FIXTURES = [
  { iso: "1990-01-15T12:00:00+00:00", lat: 28.6139, lon: 77.209, label: "Delhi" },
  { iso: "2000-12-31T23:59:00+00:00", lat: 40.7128, lon: -74.006, label: "NYC" },
];

// Relational MESH edge (mesh foundations): the SAME pairs the backend golden
// pins — built from the canonical parity-fixture births below. Pins MUST match
// backend/tests/test_mesh_golden.py (FIXED_REFERENCE_DATE + WINDOW_START/END;
// chart a is the bride role, chart b the groom).
const MESH_GOLDEN_PATH = join(REPO_ROOT, "backend/tests/fixtures/mesh_golden_de421.json");
const MESH_REFERENCE_DATE = "2025-01-01T00:00:00+00:00";
const MESH_WINDOW_START = "2025-01-01T00:00:00+00:00";
const MESH_WINDOW_END = "2027-01-01T00:00:00+00:00";

// The canonical parity fixtures (ISO UTC datetime, latitude, longitude).
// MUST match backend/tests/test_chart_golden.py:FIXTURES.
const FIXTURES = [
  { iso: "1990-01-15T12:00:00+00:00", lat: 28.6139, lon: 77.209, label: "Delhi" },
  { iso: "1985-07-23T04:30:00+00:00", lat: 19.076, lon: 72.8777, label: "Mumbai" },
  { iso: "2000-12-31T23:59:00+00:00", lat: 40.7128, lon: -74.006, label: "NYC" },
  { iso: "1972-03-10T08:15:00+00:00", lat: 51.5074, lon: -0.1278, label: "London" },
  { iso: "2010-06-21T18:00:00+00:00", lat: -33.8688, lon: 151.2093, label: "Sydney" },
  { iso: "2019-11-09T17:45:00+00:00", lat: 35.6895, lon: 139.6917, label: "Tokyo" },
  // NOTE: the Bengaluru Cancer/Leo cusp case is validated in backend pytest
  // (tests/test_chart_golden.py + test_timezone_correctness.py, CPython-deterministic).
  // It is intentionally NOT in the byte-parity set: a near-cusp dasha boundary can
  // land on a sub-microsecond float rounding edge where CPython and Pyodide differ
  // by 1µs — astrologically meaningless, and we keep this gate strictly
  // byte-identical rather than coarsen it.
];

// Mesh pairs (a, b, relationship) — reuse the parity-fixture births; the golden
// key is `${a.iso}|${b.iso}|${relationship}`. MUST match the backend PAIRS.
const fixtureByLabel = Object.fromEntries(FIXTURES.map((fx) => [fx.label, fx]));
const MESH_PAIRS = [
  { a: fixtureByLabel.Delhi, b: fixtureByLabel.Mumbai, relationship: "spouse" },
  { a: fixtureByLabel.London, b: fixtureByLabel.NYC, relationship: "business" },
  { a: fixtureByLabel.Sydney, b: fixtureByLabel.Tokyo, relationship: "friend" },
];

// Bundle wheels, installed leaf-first: the skyfield stack (jplephem, sgp4 ->
// skyfield) before the almamesh engine wheel that imports them. Must live in
// WHEEL_DIR. No avow/rfc8785 — the engine is crypto-free.
const SKYFIELD_STACK = [
  "jplephem-2.23-py3-none-any.whl",
  "sgp4-2.25-py3-none-any.whl",
  "skyfield-1.53-py3-none-any.whl",
];

// Pyodide-shipped base packages (all in the self-hosted lock — no PyPI).
// Mirrors chartWorker.ts LOAD_PACKAGES — no pynacl: signing is TypeScript-side.
const LOAD_PACKAGES = [
  "micropip",
  "numpy",
  "pydantic",
  "pyyaml",
  "python-dateutil",
  "pytz",
  "certifi",
];

// ---------------------------------------------------------------------------
// NETWORK TRIPWIRE: any http(s):// fetch hard-fails. file:// and local paths
// pass. If boot + compute complete, the run was provably offline.
// ---------------------------------------------------------------------------
const networkAttempts = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (resource, opts) => {
  const url = typeof resource === "string" ? resource : (resource?.url ?? String(resource));
  if (/^https?:\/\//i.test(url)) {
    networkAttempts.push(url);
    throw new Error(`OFFLINE VIOLATION: network fetch attempted -> ${url}`);
  }
  return realFetch(resource, opts);
};

function assertInputsPresent() {
  const required = [PYODIDE_DIST, WHEEL_DIR, ALMAMESH_WHEEL, SKYFIELD_DATA, GOLDEN_PATH];
  for (const p of required) {
    if (!existsSync(p)) throw new Error(`missing required input: ${p}`);
  }
  const present = new Set(readdirSync(WHEEL_DIR));
  for (const w of SKYFIELD_STACK) {
    if (!present.has(w)) throw new Error(`missing bundled wheel: ${w}`);
  }
}

// Deep structural equality on canonicalized JSON (both sides already have
// floats rounded + keys are insertion-ordered from sorted Python dicts; we
// compare by value, order-independent for objects).
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === "object") {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

// First diff path between two canonicalized values (for actionable failure).
function firstDiff(a, b, path = "") {
  if (deepEqual(a, b)) return null;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return { path: path || "(root)", cpython: a, pyodide: b };
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    return { path: path || "(root)", cpython: a, pyodide: b };
  }
  if (Array.isArray(a)) {
    if (a.length !== b.length) {
      return { path: `${path}.length`, cpython: a.length, pyodide: b.length };
    }
    for (let i = 0; i < a.length; i++) {
      const d = firstDiff(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const d = firstDiff(a[k], b[k], path ? `${path}.${k}` : k);
    if (d) return d;
  }
  return { path: path || "(root)", cpython: a, pyodide: b };
}

const t0 = Date.now();
assertInputsPresent();

console.error(`[parity] OFFLINE byte-parity gate (CPython == Pyodide)`);
console.error(`[parity] dist   : ${PYODIDE_DIST}`);
console.error(`[parity] wheels : ${WHEEL_DIR} (+ ${ALMAMESH_WHEEL})`);
console.error(`[parity] ephem  : ${SKYFIELD_DATA}/de421.bsp`);
console.error(`[parity] golden : ${GOLDEN_PATH}`);
console.error(`[parity] booting Pyodide offline...`);

const pyodide = await loadPyodide({ indexURL: PYODIDE_DIST + "/" });
await pyodide.loadPackage(LOAD_PACKAGES);
const micropip = pyodide.pyimport("micropip");

for (const w of SKYFIELD_STACK) {
  pyodide.FS.writeFile(`/${w}`, readFileSync(join(WHEEL_DIR, w)));
  await micropip.install.callKwargs(`emfs:/${w}`, { deps: false });
}
const almamashWheelName = "almamesh-0.1.0-py3-none-any.whl";
pyodide.FS.writeFile(`/${almamashWheelName}`, readFileSync(ALMAMESH_WHEEL));
await micropip.install.callKwargs(`emfs:/${almamashWheelName}`, { deps: false });

pyodide.FS.mkdirTree("/home/pyodide/.skyfield-data");
pyodide.FS.writeFile(
  "/home/pyodide/.skyfield-data/de421.bsp",
  readFileSync(`${SKYFIELD_DATA}/de421.bsp`),
);
pyodide.FS.writeFile(
  "/home/pyodide/.skyfield-data/finals2000A.all",
  readFileSync(`${SKYFIELD_DATA}/finals2000A.all`),
);

const bootMs = Date.now() - t0;
console.error(`[parity] booted offline in ${bootMs}ms`);

// Define the SAME entrypoint the chart Worker uses, plus the EXACT canonicalize
// from backend/tests/test_chart_golden.py (round floats to 6 dp recursively,
// preserve bool, sort dict keys). Returns canonical JSON for one fixture.
await pyodide.runPythonAsync(`
import json
from datetime import UTC, datetime
from almamesh.calculations import calculate_sidereal_context

_REFERENCE_DATE = datetime.fromisoformat("${REFERENCE_DATE}")

def _canonicalize(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, float):
        return round(value, 6)
    if isinstance(value, dict):
        return {k: _canonicalize(value[k]) for k in sorted(value)}
    if isinstance(value, list):
        return [_canonicalize(item) for item in value]
    return value

def _parity_chart(iso_dt, lat, lon):
    dt = datetime.fromisoformat(iso_dt)
    ctx = calculate_sidereal_context(dt, lat, lon, reference_date=_REFERENCE_DATE)
    return json.dumps(_canonicalize(ctx.model_dump(mode="json")), sort_keys=True)

# Phase-1 predictive transit parity — the SEPARATE TransitContext at a pinned
# instant. Same position/ayanamsa pipeline as the natal chart; pure-bisection
# root-finds (fixed constants) make it byte-identical on Pyodide too.
from almamesh.transits import calculate_transit_context
_TRANSIT_REF = datetime.fromisoformat("${TRANSIT_REFERENCE_DATE}")
_TRANSIT_INSTANT = datetime.fromisoformat("${TRANSIT_INSTANT}")

def _parity_transit(iso_dt, lat, lon):
    dt = datetime.fromisoformat(iso_dt)
    natal = calculate_sidereal_context(dt, lat, lon, reference_date=_TRANSIT_REF)
    tc = calculate_transit_context(natal, dt, transit_instant=_TRANSIT_INSTANT)
    return json.dumps(_canonicalize(tc.model_dump(mode="json")), sort_keys=True)

# Wave-C predictive payload parity — the SAME composed entrypoint the chart
# Worker's computePredictive uses, at one pinned EXPLICIT reference instant
# (it pins both the "current" dasha and the transit "now"; no silent now()).
from almamesh.predictive import compute_predictive_contexts
_PREDICTIVE_INSTANT = datetime.fromisoformat("${PREDICTIVE_REFERENCE_INSTANT}")

def _parity_predictive(iso_dt, lat, lon):
    dt = datetime.fromisoformat(iso_dt)
    ctx = compute_predictive_contexts(dt, lat, lon, _PREDICTIVE_INSTANT)
    return json.dumps(_canonicalize(ctx.model_dump(mode="json")), sort_keys=True)

# Mesh-edge parity — the relational bundle between two charts, with the SAME
# pinned reference + synchrony window the backend golden was built with. The
# natal contexts are recomputed here exactly as the chart Worker's
# computeMeshEdge does (no chart crosses any boundary).
from almamesh.mesh import compute_mesh_edge
from almamesh.schemas.mesh import MatchRole, Relationship
_MESH_REF = datetime.fromisoformat("${MESH_REFERENCE_DATE}")
_MESH_WINDOW_START = datetime.fromisoformat("${MESH_WINDOW_START}")
_MESH_WINDOW_END = datetime.fromisoformat("${MESH_WINDOW_END}")

def _parity_mesh(a_iso, a_lat, a_lon, b_iso, b_lat, b_lon, relationship):
    a = calculate_sidereal_context(
        datetime.fromisoformat(a_iso), a_lat, a_lon, reference_date=_MESH_REF
    )
    b = calculate_sidereal_context(
        datetime.fromisoformat(b_iso), b_lat, b_lon, reference_date=_MESH_REF
    )
    edge = compute_mesh_edge(
        a,
        b,
        relationship=Relationship(relationship),
        role_a=MatchRole.BRIDE,
        role_b=MatchRole.GROOM,
        window_start=_MESH_WINDOW_START,
        window_end=_MESH_WINDOW_END,
    )
    return json.dumps(_canonicalize(edge.model_dump(mode="json")), sort_keys=True)
`);

const parityChart = pyodide.globals.get("_parity_chart");
const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8"));

let failures = 0;
const results = [];
for (const fx of FIXTURES) {
  const fxT0 = Date.now();
  const canonJson = parityChart(fx.iso, fx.lat, fx.lon);
  const pyodideChart = JSON.parse(canonJson);
  const goldenChart = golden[fx.iso];
  const ok = goldenChart !== undefined && deepEqual(pyodideChart, goldenChart);
  const ms = Date.now() - fxT0;
  results.push({ fx, ok, ms });
  if (ok) {
    console.error(`[parity] PASS  ${fx.iso}  (${fx.label})  ${ms}ms`);
  } else {
    failures += 1;
    console.error(`[parity] FAIL  ${fx.iso}  (${fx.label})  ${ms}ms`);
    if (goldenChart === undefined) {
      console.error(`         golden has no entry for ${fx.iso}`);
    } else {
      const d = firstDiff(goldenChart, pyodideChart);
      console.error(`         first diff at: ${d.path}`);
      console.error(`           cpython(golden): ${JSON.stringify(d.cpython)}`);
      console.error(`           pyodide        : ${JSON.stringify(d.pyodide)}`);
    }
  }
}
parityChart.destroy();

// --- Phase-1 transit parity (separate golden; natal golden untouched) ---
const parityTransit = pyodide.globals.get("_parity_transit");
const transitGolden = JSON.parse(readFileSync(TRANSIT_GOLDEN_PATH, "utf8"));
console.error("");
console.error(`[parity] transit context (Phase-1 predictive)`);
for (const fx of TRANSIT_FIXTURES) {
  const fxT0 = Date.now();
  const pyodideTransit = JSON.parse(parityTransit(fx.iso, fx.lat, fx.lon));
  const goldenTransit = transitGolden[fx.iso];
  const ok = goldenTransit !== undefined && deepEqual(pyodideTransit, goldenTransit);
  const ms = Date.now() - fxT0;
  if (ok) {
    console.error(`[parity] PASS  transit ${fx.iso}  (${fx.label})  ${ms}ms`);
  } else {
    failures += 1;
    console.error(`[parity] FAIL  transit ${fx.iso}  (${fx.label})  ${ms}ms`);
    if (goldenTransit === undefined) {
      console.error(`         transit golden has no entry for ${fx.iso}`);
    } else {
      const d = firstDiff(goldenTransit, pyodideTransit);
      console.error(`         first diff at: ${d.path}`);
      console.error(`           cpython(golden): ${JSON.stringify(d.cpython)}`);
      console.error(`           pyodide        : ${JSON.stringify(d.pyodide)}`);
    }
  }
}
parityTransit.destroy();

// --- Wave-C predictive payload parity (separate golden; others untouched) ---
const parityPredictive = pyodide.globals.get("_parity_predictive");
const predictiveGolden = JSON.parse(readFileSync(PREDICTIVE_GOLDEN_PATH, "utf8"));
console.error("");
console.error(`[parity] predictive payload (Wave-C lazy superset)`);
for (const fx of PREDICTIVE_FIXTURES) {
  const fxT0 = Date.now();
  const pyodidePredictive = JSON.parse(parityPredictive(fx.iso, fx.lat, fx.lon));
  const goldenPredictive = predictiveGolden[fx.iso];
  const ok = goldenPredictive !== undefined && deepEqual(pyodidePredictive, goldenPredictive);
  const ms = Date.now() - fxT0;
  if (ok) {
    console.error(`[parity] PASS  predictive ${fx.iso}  (${fx.label})  ${ms}ms`);
  } else {
    failures += 1;
    console.error(`[parity] FAIL  predictive ${fx.iso}  (${fx.label})  ${ms}ms`);
    if (goldenPredictive === undefined) {
      console.error(`         predictive golden has no entry for ${fx.iso}`);
    } else {
      const d = firstDiff(goldenPredictive, pyodidePredictive);
      console.error(`         first diff at: ${d.path}`);
      console.error(`           cpython(golden): ${JSON.stringify(d.cpython)}`);
      console.error(`           pyodide        : ${JSON.stringify(d.pyodide)}`);
    }
  }
}
parityPredictive.destroy();

// --- mesh-edge parity (separate golden; natal/transit/predictive untouched) ---
const parityMesh = pyodide.globals.get("_parity_mesh");
const meshGolden = JSON.parse(readFileSync(MESH_GOLDEN_PATH, "utf8"));
console.error("");
console.error(`[parity] mesh edge (relational bundle between two charts)`);
for (const pair of MESH_PAIRS) {
  const fxT0 = Date.now();
  const key = `${pair.a.iso}|${pair.b.iso}|${pair.relationship}`;
  const pyodideMesh = JSON.parse(
    parityMesh(
      pair.a.iso,
      pair.a.lat,
      pair.a.lon,
      pair.b.iso,
      pair.b.lat,
      pair.b.lon,
      pair.relationship,
    ),
  );
  const goldenMesh = meshGolden[key];
  const ok = goldenMesh !== undefined && deepEqual(pyodideMesh, goldenMesh);
  const ms = Date.now() - fxT0;
  const label = `${pair.a.label}+${pair.b.label} ${pair.relationship}`;
  if (ok) {
    console.error(`[parity] PASS  mesh ${key}  (${label})  ${ms}ms`);
  } else {
    failures += 1;
    console.error(`[parity] FAIL  mesh ${key}  (${label})  ${ms}ms`);
    if (goldenMesh === undefined) {
      console.error(`         mesh golden has no entry for ${key}`);
    } else {
      const d = firstDiff(goldenMesh, pyodideMesh);
      console.error(`         first diff at: ${d.path}`);
      console.error(`           cpython(golden): ${JSON.stringify(d.cpython)}`);
      console.error(`           pyodide        : ${JSON.stringify(d.pyodide)}`);
    }
  }
}
parityMesh.destroy();

const totalMs = Date.now() - t0;
console.error("");
const totalFixtures =
  FIXTURES.length + TRANSIT_FIXTURES.length + PREDICTIVE_FIXTURES.length + MESH_PAIRS.length;
console.error(
  `[parity] ${totalFixtures - failures}/${totalFixtures} fixtures byte-identical ` +
    `(${FIXTURES.length} natal + ${TRANSIT_FIXTURES.length} transit + ` +
    `${PREDICTIVE_FIXTURES.length} predictive + ${MESH_PAIRS.length} mesh)`,
);
console.error(`[parity] cold boot ${bootMs}ms | total ${totalMs}ms`);

if (networkAttempts.length) {
  console.error(`[parity] OFFLINE VIOLATIONS: ${networkAttempts.length}`);
  for (const u of networkAttempts) console.error("  " + u);
  process.exit(1);
}
console.error(`[parity] http(s) network fetches: 0 (verified offline)`);

if (failures > 0) {
  console.error(`[parity] GATE FAILED: ${failures} fixture(s) mismatched`);
  process.exit(1);
}
console.error(`[parity] GATE PASSED: CPython == Pyodide, byte-identical, offline`);
process.exit(0);
