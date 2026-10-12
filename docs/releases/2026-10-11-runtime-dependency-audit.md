# Runtime dependency audit — 2026-10-11

The browser engine uses the current stable Pyodide distribution, but that does
not mean every Python package embedded in it is the latest upstream package.
The previous native acceptance used an older Playwright/WebKit. Version drift
is established; the cause of the native crashes remains unproven.

## Versions and decisions

| Layer | Audited version | Current upstream | Decision |
|---|---|---|---|
| Playwright / bundled WebKit | 1.63.0 / revision 2359, WebKit 26.6 | Stable 1.64.0 / 2370, WebKit 27.2 | Candidate dependency updated to stable 1.64.0; fresh complete acceptance required. |
| Relevant preview WebKit | Not the release pin | 1.65.0-alpha-2026-10-11 / 2374 | Isolated diagnostic comparison only. |
| Pyodide | 314.0.7 | 314.0.7 | Retain current matched runtime and distribution. |
| Embedded CPython | 3.14.2 | Standalone 3.14.8; latest series 3.15.0 | Embedded interpreter cannot be replaced independently of Pyodide. |
| Emscripten | Pyodide 5.0.3; SQLite vendor 6.0.11 | 6.0.12 | Compiler version alone is not a compatible runtime update. |
| NumPy | Browser 2.4.6; backend lock 2.5.1 | 2.5.4 | Current PyPI metadata has no matching cp314 / pyemscripten_2026_0 Wasm wheel; retain distribution version pending a supported build. |
| SQLite core | 3.53.4 with five vendor patches | 3.54.0; official npm Wasm still 3.53.4-build2 | Update through the owning library, preserving its OPFS patches and version contracts. |
| sqlite-vector | 1.1.2 | 1.1.2 | Current. |
| @gainratio/browser | 0.4.1 | 0.4.1 | Current published stable. |
| Skyfield | Previous browser 1.53; backend 1.55 | 1.55 | Candidate source now vendors 1.55 and loads that wheel; actual Wasm parity and native gates remain required. |
| jplephem | 2.23 | 2.24 | New release replaces deprecated NumPy shape assignment; no matching crash trigger established. |
| sgp4 | 2.25 | 2.27 | Recent changes concern documentation/native C++ ABI, distinct from the vendored pure Python path. |
| Pydantic / core | Browser 2.12.5 / 2.41.5; backend 2.13.5 / 2.46.5 | 2.14.1 / 2.50.1 | A matching core Wasm wheel exists, but changing the distribution package set requires separate dependency, cache and compatibility proof. |
| pytz | Browser 2026.1.post1; backend 2026.4 | 2026.5 | Record timezone-data drift; do not claim identical environments. |
| edge-proc / edgeproc-core | Backend 0.5.0 / 0.4.3 | Same published stable versions | Current. |

The browser installs the signed engine wheels with `deps:false` to remain
offline. Backend dependency floors therefore do not validate the browser's
actual package versions. At audit time the browser's Skyfield, Pydantic and
pytz were below the corresponding floors in `backend/pyproject.toml`.
Skyfield alignment addresses that package's mismatch; it does not resolve or
silently redefine the other supported-version contracts.

The Skyfield regression first failed against the actual 1.53 wheel metadata
(below the declared 1.54 minimum and the locked 1.55 backend). Replacing the
wheel then failed the three old runtime-path checks before those paths were
corrected. Focused bundle/metadata/CLI tests pass 13/13; the exact-file backend
ingress contract passes 177/177. The new 1.55 pure Python wheel is 371137 bytes,
SHA-256 `9f98964855067460c94aa81a337194136f4a97a62ba8bbbfac1b8556f2b66ad4`,
verified against official PyPI metadata. These are source-level results, not
deployed-browser or native-crash proof.

## Browser bug evidence

[WebKit PR 70964](https://github.com/WebKit/WebKit/pull/70964), commit
`03e836de2f7bd5627a95f60357633d59fb6bb18d` / `319508@main`, fixes termination
while a Worker blocks in Atomics.wait or Wasm atomic wait. Its tests include
Worker termination and garbage collection. This is relevant to investigate,
but no retained AlmaMesh crash stack proves that trigger.

The exact upstream bases matter more than browser version labels:

| Playwright | WebKit base | Fix included? |
|---|---|---|
| 1.63.0 | `4d05d732e5a84f32675bef4cc135a2e7a9269a87` | No |
| 1.64.0 stable | `56453fdfe0b0ca6258c23e6453b34f70b885d13f` | No; base precedes the fix, with no matching bootstrap backport found |
| 1.65.0-alpha-2026-10-11 | `5b391e6d3b14d549908dad2c6695999291313f30` | Yes |

Official alpha package gitHead is
`d9f2fd3e2232ace8e317a84eda6cb86e25bcf49c`. The alpha base is 16 commits
after the fix; stable 1.64's base is 1981 commits before it. macOS 14 has an
older browser override even under these package versions; the release lane
uses macOS 15. Bundled Playwright WebKit is separate from installed Safari
and does not prove physical iPhone acceptance.

NumPy 2.5.4 includes an ArrayMethod scalar leak correction and malformed-output
accumulation crash corrections. No evidence connects those specific conditions
to the AlmaMesh native failures. Pyodide 314.0.7 already includes its documented
stack/FFI lifetime corrections. SQLite 3.54 includes four SAH-pool changes
already backported by the owning browser library; replacing its assets directly
would discard custom behavior and violate its 3.53.4 / 1.1.2 assertions.

A narrower upstream/source inspection found the scalar-reference leak in
upstream NumPy 2.4.6. Ordinary numeric ufunc initialization can reach it, but
legacy dtype wrappers are cached per ufunc: this supports setup retention,
not a demonstrated leak on every chart or an explanation for gigabytes of RSS.
The other examined crash triggers require malformed explicit accumulation
outputs or a private self-referencing array converter; no matching call was
identified in the inspected engine/astronomy paths. Pydantic use is based on
established model APIs and fixed module-level classes; no matching repeated
dynamic-class/serializer-cycle trigger was identified. These bounded source
checks do not rule out library bugs or replace runtime allocation evidence.

The isolated matched comparison ran each previously failing journey once, with
zero retries, against the same frozen `757cb225` application (Skyfield 1.53).
Stable Playwright 1.64 / WebKit 2370 passed 2/2 in 55.2 seconds; official
1.65.0-alpha-2026-10-11 / WebKit 2374 passed 2/2 in 55.4 seconds. Both retained
Node-side Worker lifecycle receipts. The hosted failure was not reproduced;
these results establish neither a preview-browser fix nor release acceptance.
The release pin remains stable 1.64. The comparison provenance, source hashes
and results are retained under `/tmp/almamesh-codex-pr333-webkit-comparison-*`.

DE421 is a deliberate small ephemeris with a bounded 1899–2053 range. Newer
DE440/441 datasets are not a drop-in bug fix: changing the kernel requires
accuracy, coverage, output-version and memory comparisons.

## Verification requirements

Keep budgets, deadlines, retries and required contexts unchanged. Re-run the
complete local frontend/backend contracts, actual browser engine parity and
native original/candidate memory and user journeys after the candidate freezes.
All final-head hosted Dagger, native Mac and required real-provider suites must
pass before merge. The previous head `757cb225` remains rejected. A local pass
or a preview-browser pass does not explain an intermittent hosted native crash.

The candidate backend gate passed 1219 tests with 98.46% coverage, plus Ruff,
formatting, mypy and complexity checks. Both source-only CI closures now export
the three exact public browser configuration files needed by the new dependency
contract. A missing-input regression failed before the correction, then the
177 ingress contracts passed. Full frontend and actual browser/native checks
for the refreshed candidate remain pending at this checkpoint.

The existing Dagger toolchain image records Playwright 1.63. Its installer
explicitly detects a lock/image mismatch and installs matching browsers and
system dependencies inline; no invented image digest or package publication
is needed for the stable update. Playwright 1.64 changes device screen
forwarding, so responsive and capability-tier checks remain required.

## Sources

- [Playwright stable release notes](https://playwright.dev/docs/release-notes#version-164), [stable browser pins](https://github.com/microsoft/playwright/blob/v1.64.0/packages/playwright-core/browsers.json), [stable upstream base](https://github.com/microsoft/playwright/blob/v1.64.0/browser_patches/webkit/UPSTREAM_CONFIG.sh).
- [Alpha browser pins](https://github.com/microsoft/playwright/blob/d9f2fd3e2232ace8e317a84eda6cb86e25bcf49c/packages/playwright-core/browsers.json), [alpha upstream base](https://github.com/microsoft/playwright/blob/d9f2fd3e2232ace8e317a84eda6cb86e25bcf49c/browser_patches/webkit/UPSTREAM_CONFIG.sh).
- [Pyodide changelog](https://pyodide.org/en/stable/project/changelog.html), [Pyodide ABI specification](https://pyodide.org/en/stable/development/abi/314.html), [Python releases](https://www.python.org/downloads/), [Emscripten 6.0.12](https://github.com/emscripten-core/emscripten/releases/tag/6.0.12).
- [NumPy 2.5.4 notes](https://numpy.org/devdocs/release/2.5.4-notes.html), [scalar leak fix](https://github.com/numpy/numpy/pull/32718), [accumulation crash fix](https://github.com/numpy/numpy/pull/32709).
- [SQLite 3.54.0](https://sqlite.org/releaselog/3_54_0.html), [SQLite Wasm distribution](https://github.com/sqlite/sqlite-wasm/releases/tag/3.53.4-build2), [sqlite-vector 1.1.2](https://github.com/sqliteai/sqlite-vector/releases/tag/1.1.2).
- [Skyfield changelog](https://rhodesmill.org/skyfield/installation.html), [jplephem changelog](https://github.com/brandon-rhodes/python-jplephem/blob/master/jplephem/__init__.py), [sgp4 2.27](https://pypi.org/project/sgp4/2.27/), [Pydantic 2.14.1](https://pypi.org/project/pydantic/2.14.1/), [pytz 2026.5](https://pypi.org/project/pytz/2026.5/).
- [Skyfield ephemeris guidance](https://rhodesmill.org/skyfield/planets.html), [JPL ephemerides](https://ssd.jpl.nasa.gov/planets/eph_export.html).
