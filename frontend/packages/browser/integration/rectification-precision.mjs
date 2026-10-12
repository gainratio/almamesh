// rectification-precision.mjs — OFFLINE behavioural gate: proves the browser
// worker glue threads each life-event's `precision` END-TO-END into the engine,
// so the "approximate-date" rectification feature is NOT a silent no-op.
//
// This is NOT part of the vitest unit suite (a fast string/type guard for the
// same regression lives in src/pyodide/__tests__/rectificationPrecision.test.ts).
// Like integration/parity.mjs it boots ~38 MB of Pyodide and runs explicitly:
//
//     node integration/rectification-precision.mjs     (from packages/browser)
//     bun run test:parity-rectify                       (same, via package.json)
//
// It runs the EXACT `PY_BOOTSTRAP` glue from src/pyodide/chartWorker.ts (extracted
// from source, never a drifting copy) under Pyodide, then calls
// `_almamesh_compute_rectification` twice on one SYNTHETIC native — once with the
// discriminating event at `precision: "exact"`, once at `precision: "approx"`.
//
// The native + event are lifted from backend/tests/test_rectification_scorer.py
// (the proven `_BIRTH_A`, Leo rising): a MARRIAGE on 2023-02-01 has Saturn in the
// 7th house, so it fires `slow_transit_h7` under EXACT but is hard-zeroed under
// APPROX. With the glue fix the two RectificationResults DIFFER; with the bug
// (precision dropped) they are byte-identical. NO real birth data — synthetic only.
//
// PREREQUISITE: a CURRENT almamesh wheel (the committed one may predate the
// approximate-date engine). Rebuild: `cd backend && uv build --wheel`.

import { loadPyodide } from "pyodide";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..", "..");
const HOME = process.env.HOME;

const SPIKE = "/private/tmp/almamesh-spike";
const PYODIDE_DIST = join(SPIKE, "pyodide-dist");
const WHEEL_DIR = join(SPIKE, "offline-wheels");
const ALMAMESH_WHEEL = join(REPO_ROOT, "backend/dist/almamesh-0.1.0-py3-none-any.whl");
const SKYFIELD_DATA = `${HOME}/.skyfield-data`;
const CHART_WORKER = join(HERE, "..", "src", "pyodide", "chartWorker.ts");

const SKYFIELD_STACK = [
  "jplephem-2.23-py3-none-any.whl",
  "sgp4-2.25-py3-none-any.whl",
  "skyfield-1.55-py3-none-any.whl",
  "rfc8785-0.1.4-py3-none-any.whl",
  "avow-0.1.0-py3-none-any.whl",
];
// pynacl (avow's Ed25519 backend) loads from the lock with cffi/pycparser.
const LOAD_PACKAGES = ["micropip", "numpy", "pydantic", "pynacl", "pyyaml", "python-dateutil", "pytz", "certifi"];

// --- Extract the REAL chart-Worker glue (no `${}` interpolation in it) --------
function extractPyBootstrap() {
  const src = readFileSync(CHART_WORKER, "utf8");
  const m = src.match(/export const PY_BOOTSTRAP = `([\s\S]*?)`;/);
  if (!m) throw new Error("could not extract PY_BOOTSTRAP from chartWorker.ts");
  return m[1];
}

function assertInputsPresent() {
  for (const p of [PYODIDE_DIST, WHEEL_DIR, ALMAMESH_WHEEL, SKYFIELD_DATA]) {
    if (!existsSync(p)) throw new Error(`missing required input: ${p} (rebuild the wheel? see header)`);
  }
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// One SYNTHETIC native (backend _BIRTH_A, Leo rising) + a single discriminating
// marriage event; only `precision` varies between the two calls.
const NATIVE = {
  datetimeUtc: "1988-08-08T01:14:00+00:00",
  latitude: 12.9716,
  longitude: 77.5946,
  utcOffsetMinutes: 330,
  mode: "cusp",
  referenceDate: "2026-06-09T12:00:00+00:00",
};
const withPrecision = (precision) => ({
  ...NATIVE,
  events: [{ date: "2023-02-01", category: "marriage", precision }],
});
const allSignals = (result) =>
  result.candidates.flatMap((c) => c.supporting_events.flatMap((e) => e.signals));

const t0 = Date.now();
assertInputsPresent();
console.error("[rectify-precision] booting Pyodide offline...");

const pyodide = await loadPyodide({ indexURL: PYODIDE_DIST + "/" });
await pyodide.loadPackage(LOAD_PACKAGES);
const micropip = pyodide.pyimport("micropip");
for (const w of SKYFIELD_STACK) {
  pyodide.FS.writeFile(`/${w}`, readFileSync(join(WHEEL_DIR, w)));
  await micropip.install.callKwargs(`emfs:/${w}`, { deps: false });
}
const ALMAWHEEL = "almamesh-0.1.0-py3-none-any.whl";
pyodide.FS.writeFile(`/${ALMAWHEEL}`, readFileSync(ALMAMESH_WHEEL));
await micropip.install.callKwargs(`emfs:/${ALMAWHEEL}`, { deps: false });
pyodide.FS.mkdirTree("/home/pyodide/.skyfield-data");
pyodide.FS.writeFile("/home/pyodide/.skyfield-data/de421.bsp", readFileSync(`${SKYFIELD_DATA}/de421.bsp`));
pyodide.FS.writeFile(
  "/home/pyodide/.skyfield-data/finals2000A.all",
  readFileSync(`${SKYFIELD_DATA}/finals2000A.all`),
);
console.error(`[rectify-precision] booted in ${Date.now() - t0}ms`);

// Run the EXACT production glue.
await pyodide.runPythonAsync(extractPyBootstrap());
const fn = pyodide.globals.get("_almamesh_compute_rectification");

let exact, approx;
try {
  exact = JSON.parse(fn(JSON.stringify(withPrecision("exact"))));
  approx = JSON.parse(fn(JSON.stringify(withPrecision("approx"))));
} finally {
  fn.destroy();
}

const exactSignals = allSignals(exact);
const approxSignals = allSignals(approx);
const exactHasTransit = exactSignals.some((s) => s.startsWith("slow_transit"));
const approxHasTransit = approxSignals.some((s) => s.startsWith("slow_transit"));

console.error(`[rectify-precision] exact  fit_scores: ${JSON.stringify(exact.candidates.map((c) => c.fit_score))}`);
console.error(`[rectify-precision] approx fit_scores: ${JSON.stringify(approx.candidates.map((c) => c.fit_score))}`);
console.error(`[rectify-precision] exact  signals: ${JSON.stringify(exactSignals)}`);
console.error(`[rectify-precision] approx signals: ${JSON.stringify(approxSignals)}`);

const failures = [];
if (deepEqual(exact, approx)) {
  failures.push("EXACT and APPROX results are byte-identical — precision was DROPPED on the browser path");
}
if (!exactHasTransit) {
  failures.push("EXACT result fired no slow_transit signal — fixture no longer discriminates (check wheel)");
}
if (approxHasTransit) {
  failures.push("APPROX result still fired a slow_transit signal — precision not honoured by the engine");
}

console.error("");
if (failures.length) {
  for (const f of failures) console.error(`[rectify-precision] FAIL  ${f}`);
  console.error(`[rectify-precision] GATE FAILED  (total ${Date.now() - t0}ms)`);
  process.exit(1);
}
console.error("[rectify-precision] PASS  precision threads end-to-end: EXACT keeps transit, APPROX zeroes it, results differ");
console.error(`[rectify-precision] GATE PASSED  (total ${Date.now() - t0}ms)`);
process.exit(0);
