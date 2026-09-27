# Changelog

All notable changes to AlmaMesh are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project aims for
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- **A header-only deploy can no longer strand returning visitors on old
  headers.** The service-worker precache is now keyed on a hash of
  `public/_headers`: every entry's revision carries `headers-<sha256[:16]>`, so
  changing the headers re-fetches the app shell (with `cache: 'reload'`, past
  the year-long immutable HTTP cache) and Workbox deletes the old-header
  entries on activation. The `*-immutable` engine caches and OPFS are untouched.
  This replaces the #164 `precache-isolation-heal.js` repair script: the
  returning-visitor e2e now upgrades from both a pre-keyed service worker (no
  heal) and one keyed on different headers, and the engine boots in both.
- **The live `verify-pro-ui` and `verify-wave-d` journeys keyed predictive data
  to the UTC calendar day.** They seeded the chart's `referenceDate` from
  `toISOString()`, the same bug fixed in the unit tests below. They now use
  `scripts/predictiveReference.mjs`, which derives the chart's local-day instant
  exactly as `predictiveReferenceInstant` does. A unit test pins it against the
  app helper across the Asia/Kolkata day boundary.
- **The frontend gate went red every evening (UTC).** The report-PDF e2e seed
  and six unit-test files (`LifeAtlas`, `Predictive`, `LifeDomain`,
  `ReportView`, `Dashboard.regenerate`, `reportSectionParity`) keyed the
  predictive cache to the UTC calendar day. The app keys it to the chart's local
  day (`predictiveReferenceInstant`, Asia/Kolkata for every fixture). From 18:30
  UTC the two days differ and the seeded predictive facts read as stale: 14 unit
  tests failed, and sections IX–XII vanished from the downloaded PDF. The unit
  tests now use `predictiveReferenceInstant` itself. The e2e seed pins the page
  clock to 20:00 UTC, an instant where the two days differ, and derives the key
  from the chart's local day. The gate no longer depends on when CI runs.
- **Out-of-range birth coordinates silently produced a wrong chart.** Nothing
  range-checked latitude or longitude: `calculate_lagna` feeds
  `tan(radians(lat))`, whose period is 180°, so `latitude=200` returned the
  `latitude=20` chart; the Pyodide worker calls the engine directly, and the
  store's `requireFinite` used `Number.isNaN`, so `±Infinity` passed too. A new
  engine guard, `validate_coordinates` → `InvalidBirthInputError(ValueError)`,
  runs first in `calculate_sidereal_context` (covering natal, predictive and
  mesh) and in `compute_rectification_result` (which scores cusp candidates
  before any natal context). Stable, value-free messages:
  `invalid coordinate: latitude out of range (-90, 90)`,
  `invalid coordinate: longitude out of range [-180, 180]`,
  `invalid coordinate: <field> must be a finite number`. The poles are
  **rejected** (open latitude interval): the Ascendant is undefined there and
  `tan(90°)` is a huge float, not an error. `toBirthInput` now mirrors the same
  check and messages (`Number.isFinite` + range). Valid inputs and every golden
  fixture are unchanged.
- **The Lahiri table reader clamped instead of failing closed.**
  `AyanamsaCalculator.get_ayanamsa` returned the table's end value for any
  instant outside 1900-01-01..2100-12-31, contradicting its own "fails closed"
  docstring (e.g. a late-1899 birth, inside DE421, got the 1900 ayanamsa). It
  now raises `ValueError("Lahiri ayanamsa table range exceeded: …")`; in-range
  interpolation arithmetic is unchanged, so every value inside the table is
  byte-identical.
- **The shipped chart was not deterministic, and the README said it was.** The
  engine's `reference_date` — the instant that decides which Vimshottari mahā
  daśā is "current" — defaulted to `datetime.now(UTC)`, and the browser's chart
  glue passed nothing, so the SAME birth record produced a DIFFERENT chart on a
  different day. Reproduced against the shipped glue before any fix: identical
  input, two runs, `sha256 3b4ccf8a4ae01f4a` (31,996 bytes, `current_maha=sun`)
  versus `970082abe9eacc39` (31,977 bytes, `current_maha=rahu`). README
  ("chart computation remains local and deterministic") and `docs/ARCHITECTURE.md`
  ("same inputs → byte-identical chart on CPython and Pyodide") were both false
  on the path users actually walk.

  **The promise is kept, not narrowed.** `BirthInput.referenceDate` is now
  REQUIRED and `_almamesh_generate_chart` raises rather than substituting
  `now()` — the same rule `_almamesh_compute_predictive` and
  `_almamesh_compute_mesh` have always enforced; the natal path was the last
  straggler. A chart is a pure function of four recorded inputs
  `(datetimeUtc, latitude, longitude, referenceDate)`. Nothing on screen moved:
  the app mints that instant once per generation
  (`packages/store/src/chartReferenceInstant.ts` — the one sanctioned clock read
  on the chart path, sibling to `reportPdfDeterminism.ts`) and passes the SAME
  value to the engine and to the stored `calculation_timestamp`, which used to be
  a second, independent `new Date()`. The generation date printed on the report is
  now the key that reproduces the chart.

  **Two stated contracts are reversed here, deliberately.** The suite asserted the
  defect as the requirement. `chart.test.ts`'s "passes referenceDate through when
  given, **omits it otherwise**" proved the engine input could be built with no
  reference instant — the exact hole — and the `calculation_timestamp` block
  opened "The regenerate path passes NO referenceDate" and built a
  `birthWithoutRef` fixture to prove the stamp survived it. Both are inverted, not
  deleted. Worth naming: every e2e fixture and every harness already pinned
  `referenceDate`, which is precisely why no test ever caught that production did
  not — the guards measured a shape the tests supplied and the app did not.

  New guard: `backend/tests/test_chart_worker_glue.py` extracts `PY_BOOTSTRAP`
  from `chartWorker.ts` and runs the SHIPPED glue under CPython, so there is no
  second copy to drift. It pins the instant as load-bearing, the refusal, no-clock
  behaviour with `datetime.now` moved thirty years, and parity with
  `chart_golden_de421.json`.

- **The domain-strength band cut points were guarded by nothing that could
  fail.** `strength_summary.py` sets `_SAV_STRONG_AVG = 28.0` and
  `_SAV_WEAK_AVG = 25.0`, consumed only inside `_band()`, and no test imported
  `_band`. The nearest assertion, `test_life_domains.py:245`, read
  `assert summary.band in StrengthBand` — a tautology true at any cut point, so
  28.0 could be moved to 30.0 and the suite stayed green.
  `backend/tests/test_domain_strength_band.py` now pins both literals at their
  exact pivots (27.9 → MODERATE / 28.0 → STRONG, 24.9 → WEAK / 25.0 → MODERATE)
  plus the conjunctive `meets_minimum` interaction, and the tautology is inverted
  to assert the emitted band equals `_band()` over the emitted inputs.

- **Ashtakoota `EXCELLENT` had a guard but no fixture.** The `>= 33.0` cut point
  was already pinned by `test_ashtakoota_bands.py`; what nothing showed was that
  a real pair of Moons can reach it. Sweeping all 11,664 nakshatra×pada pairs
  found the perfect 36 — Rohini bride × Mrigashira groom, both in Taurus (164
  pairs band EXCELLENT) — now a test with all eight koota scores hand-derived.

- **`moon_summary` refused an unplaceable nakshatra, and no test ever ran that
  line.** Every koota table is indexed by `nakshatra_index`, so a name outside
  `NAKSHATRA_NAMES` has no row anywhere and a fall-through would score a
  compatibility verdict against the wrong row. The refusal is now executed by
  `test_moon_summary_refuses_a_nakshatra_it_cannot_place`.

### Security
- **`@edgeproc/browser` bumped `333cbaf` → `02171df`** (edgeproc-browser main)
  in `@almamesh/browser`, `@almamesh/memory`, and `@almamesh/store`, with the
  lockfile, the Dagger pin check, and the repository-truth test moved in step.
  It brings (a) the anti-rollback floor fix (edgeproc-browser #13): a key change
  no longer clears the durable active pointer, so an old release re-signed by a
  new key can no longer be promoted without a freshness comparison; and (b)
  keyring trust-root support (#14): the trust-root URL may serve an
  `edgeproc.keyring/v1` document, and pointers may carry optional signed
  `key_id` / `expires_at`. AlmaMesh keeps its raw 32-byte `public.key` trust
  root (read as a keyring of one) and its signed pointers are unchanged, so
  they verify byte-identically; new errors map to the existing `integrity`
  Worker code, and no storage key or format changes. Operational note: releases
  must keep `sequence` strictly increasing across a key change (production's
  release guard already enforces this). `setup-dev-assets.sh` now signs the
  re-keyed local dev bundle at `--sequence $(date +%s)` (override with
  `DEV_BUNDLE_SEQUENCE`) instead of the CLI default `1`, so re-running it no
  longer trips `rollback` in a browser that synced an earlier dev bundle.
- **"Reset & reload" can now recover a rollback refusal in-app.** It cleared
  service workers, CacheStorage, localStorage and IndexedDB but not OPFS, where
  the signed-bundle cache and its durable active pointer (the anti-rollback
  floor) live, so a `RollbackError` survived the reset and the engine could
  never boot again, breaking the engine-recovery invariant (the code comments
  claimed it "clears the cached bundle"). `resetAppData` now first clears the
  bundle cache through `@edgeproc/browser`'s own `EngineClient.clear()` (OPFS
  primary + IndexedDB floor, under the sync Web Lock, bounded at 10 s), then
  sweeps every OPFS root entry as a fallback, then deletes IndexedDB. The
  rectification wizard's engine-failure card, whose "Reset & reload engine"
  only re-ran the same fail-closed sync, also offers **Clear the downloaded
  engine & reload**, which clears only the bundle cache and keeps user data.
  Security: an explicit reset returns the device to first-install trust (the
  next pointer is still verified against the pinned ed25519 key, just with no
  floor), and nothing clears the cache automatically on a `RollbackError`,
  because an automatic clear would defeat rollback protection. The automatic
  self-heal paths (`swSelfHeal`, `lazyWithRetry`, chunk-error recovery) still
  never touch OPFS and still keep the `*-immutable` engine caches. Tests pin
  all of this.
- **A rollback refusal can no longer be cleared with one unwarned click.**
  Anyone able to serve an older, validly signed `/bundle/latest` can cause a
  `RollbackError`, and the recovery UI would then steer the user into wiping
  the floor. The stable `EngineOperationError.code` now reaches every reset
  surface: the Onboarding error card, the rectification engine card, and the
  global ErrorBoundary, which reads the provider's recorded last boot failure.
  When the code is `rollback`, each surface shows a plain-language warning (en,
  es, pt) that the server offered an older engine and that this can mean
  tampering, and it requires the two-step inline confirm that "Start over"
  already uses before any clear that drops the floor. Other failures keep the
  one-click reset.
- **The locked clear is now reliable.** `resetAppData` clears the bundle cache
  *first*, while the service worker and caches can still serve the clear
  Worker's script offline. It first tears down the live runtime (the provider
  registers `AlmaMeshRuntime.dispose`) so the sync Worker releases its Web Lock
  and handles. A failed or timed-out clear (8 s, now a real failure that also
  terminates the clear Worker) is retried exactly once after another teardown.
  IndexedDB deletes are now awaited: success or error settles each one, and a
  `blocked` delete waits up to 3 s instead of being fired and forgotten.
- **The JavaScript dependency audit is green instead of documented away.** A
  fresh `bun audit` found 92 advisories (3 critical, 55 high) across the
  browser, build, and test dependency graph. Compatible workspace updates plus
  explicit patched transitive floors now produce `No vulnerabilities found`.
  `@hpcc-js/wasm-zstd` stays on the behaviorally verified 1.13 API because 1.15
  removed the compression-level argument; browser byte-parity, real onboarding,
  offline recovery, and report-PDF gates protect that deliberate pin.

- **Bundle promotion refuses a rollback it cannot disprove — and this repo's own
  gate no longer asserts the opposite.** `backend/vendor/edge-proc/` pinned a
  0.1.4 snapshot that sat still through two upstream security releases. It
  carried both anti-replay holes 0.3.0 closes: a promote at an **equal** version
  was accepted, because `Version(x) < Version(x)` is `False` and that single
  `False` was read as affirmative proof of freshness; and an `active` pointer
  that existed but was not a regular file answered "nothing has ever been
  promoted", which is the one answer that tells the guard it has nothing to be
  fresher than, so the check was skipped outright. Replaying a genuinely signed
  pointer needs no forgery, so this was reachable with a signature that verifies.

  **A stated contract is reversed here, deliberately.** The vendored suite ran as
  part of `uv run poe gate` and asserted the fail-open *as the requirement* —
  `test_promote_allows_unparseable_version_covenant` was commented "the promote
  must still succeed (fail-OPEN), never fail-closed on the guard", and
  `test_promote_allows_equal_and_forward_versions` promoted a different bundle at
  an equal version on purpose. The covenant behind them ("the guard must never
  reject a validly-signed bundle") was the bug, not the contract: a signature
  proves *authorship*, never *freshness*, and a replayed pointer is validly
  signed by construction. Both assertions are now inverted, in
  `backend/tests/test_bundle_rollback_guard.py` — an equal-version promote and an
  unparseable-version promote must both raise `RollbackError` — with the
  allow-cases (forward bump, first promote) kept so fail-closed cannot quietly
  become fail-always.

  Blast radius, stated plainly: **latent, not live.** No user device ever ran
  this code. The device-side promote ships in the exact-commit
  [`@edgeproc/browser`](https://github.com/hseshadr/edgeproc-browser) dependency,
  which refuses an equal `sequence` unless the pointer is byte-identical. The
  Python path is reached only by the build-time publisher — which clears its
  origin dir before every publish, so it is always a first promote — and by
  `almamesh.edge.bundle.sync_constructs`, a public API of this package whose only
  callers today are its own tests. What shipped was a published module promising
  "fail-closed … never downgrades" over an implementation that did not, and a
  gate that certified the gap as intended.

### Changed
- **edge-proc 0.3.0 → 0.5.0, edgeproc-core 0.4.0 → 0.4.3** (backend lock; the
  `edge-proc[bundles]` floor is now `>=0.5.0`, which itself requires core
  `>=0.4.3` for its RFC 9457 wire-safety fix). Adapted to the 0.4/0.5 changes:
  - **Pointers stay byte-identical.** `almamesh-bundle` publishes through
    `build_bundle` and never stamps the new signed `key_id`/`expires_at` fields,
    so `latest` keeps its `bundle_id`/`channel`/`sequence` shape and every device
    on `@edgeproc/browser` 02171df keeps syncing. A test pins that, even with
    `EDGEPROC_PUBLISH_STAMP_KEY_ID`/`EDGEPROC_PUBLISH_EXPIRES_IN` set.
  - **`release_guard` checks a candidate the way a device does.** It now calls
    edge-proc's `verify_pointer`, so a pointer naming a key other than the pinned
    one, or one whose signed `expires_at` has passed, fails the preflight in
    `build-prod.sh` instead of shipping to devices that would refuse it.
  - **`EDGEPROC_*` is validated.** edge-proc's CAS store now reads and validates
    its settings, so a malformed value crashed `almamesh-bundle bundle` with a
    pydantic traceback mid-publish. The command now checks first and refuses with
    one line, `[config.invalid] invalid setting EDGEPROC_<NAME>: ...`, before
    anything is written.
  - **`almamesh-bundle keygen` prints the key's `key_id`** on a second line, like
    `edgeproc keygen`, for naming it in a trust-root keyring. The first line is
    unchanged.
  - The fail-closed model resolution (`EDGEPROC_MODEL_PATH`) is not applicable:
    AlmaMesh installs only the `[bundles]` extra and never loads `localvec`.
- **README rewritten on the portfolio template.** A plain-language first
  screen (tagline equal to the package descriptions, Beta status matching the
  v0.4.0 tag, a hero re-captured from a production build, and a "Try it in 60
  seconds" section) sits above the existing technical detail.
  `backend/tests/test_readme_contract.py` enforces that first screen, and checks
  that every relative link and in-page anchor resolves, inside `uv run poe gate`.
- **Semantic chat memory now uses the shared SQLite + sqlite-vector browser
  Lego end to end.** MiniLM still embeds locally in its own Worker, while exact
  cosine ranking, profile/generation filters, scoped deletion, and durable
  storage move from an IndexedDB-backed JavaScript `Map` into the shared
  `@edgeproc/browser/vector/sqlite` Worker with OPFS persistence. A real
  Chromium gate proves write, query, close, reopen, and query again. Browsers
  without working OPFS keep chat but fail closed to no semantic retrieval; the
  WebKit gate proves that refusal spawns no fallback Worker.

- **Browser signed-bundle infrastructure is one shared Lego, not an AlmaMesh
  fork.** The generic sync, verification, OPFS/IndexedDB persistence, locking,
  Worker protocol, and vector implementation now come from the public
  `@edgeproc/browser` repository at one exact Git commit. AlmaMesh keeps only a
  consumer-owned Vite Worker entry and a small product adapter that preserves
  the existing cache database/store/key layout and exit-gate fallback hook.
  The tracked duplicate workspace package and its duplicate fixtures/tests are
  removed. Dagger rejects any manifest/lock pin mismatch, and the real-browser
  gates require exactly one emitted sync Worker while exercising warm OPFS,
  forced IndexedDB, and offline reload paths.

- **Registry releases are accepted by evidence, not elapsed time.** The Bun
  publication-age delay and its exemption machinery are removed. Exact versions,
  frozen locks, registry integrity, provenance contracts, Gitleaks, and
  unsuppressed dependency audits remain mandatory.

- **`edge-proc` resolves from PyPI; `backend/vendor/` is gone.** The dependency
  moves to `edge-proc[bundles]>=0.3.0` with no `[tool.uv.sources]` override, and
  the vendored `edge-proc` + `shared-libs-python` snapshots (and the
  `test-vendored` gate step that ran their suites) are deleted. The vendoring
  existed because edge-proc was unpublished; it has been on PyPI since 0.1.5, and
  a path source is exactly what let a snapshot drift two security releases behind
  while looking pinned — `pip-audit` and Dependabot skip a package that does not
  resolve from an index. `edgeproc-core` replaces `shared-libs-python` as the
  transitive dependency, also from PyPI.

  **Breaking for publishers, inherited from edge-proc 0.3.0:** re-shipping under
  one version label now needs a strictly greater `--sequence`. AlmaMesh's own
  production publish is unaffected — `frontend/apps/web/scripts/build-prod.sh`
  clears `backend/origin-prod` before every run, so each publish is a first
  promote.

### Added
- **Life-domain strength now separates calculation from integrity evidence.**
  Each domain keeps the engine's existing `min(shadbala_pct, sav_pct)` headline
  unchanged. The TypeScript Worker now records that same minimum as a typed
  `@edgeproc/assay` result, then `@edgeproc/avow` seals the complete original
  strength summary under the existing per-boot key. Sibling “How calculated —
  Assay” and “What verified — Avow” panels appear in the domain list, domain
  detail, and downloadable report in English, Spanish, and Portuguese. Avow's
  status is fail-closed (`Verified`, `Failed`, or `Unavailable`) and is described
  only as tamper evidence for the currently shown summary since this engine
  boot—not correctness or identity. Assay details are deterministically checked
  against that signed summary and withheld when verification fails. Cached
  calculations survive reload, but the old Worker's receipts and signer do not.
  The Python/Pyodide engine remains free of Avow, PyNaCl, and Assay dependencies.

- **The Ashtakoota `excellent` band has a test.** `_band`'s top arm (`>= 33` of
  36) had no test and no fixture — every reference match landed in one of the
  three lower bands, so the threshold could have been any number, or the band
  unreachable, and the suite would have stayed green.
  `backend/tests/test_ashtakoota_bands.py` pins all four cut points to the
  literals `tables.BAND_SOURCE` prints for the reader, asserts every band is
  reachable by some real total, and fails if the code and the prose stop naming
  the same numbers.

### Fixed
- **The PDF export is now actually deterministic.** `README.md` has told readers
  the export is "deterministic (same input, same file every time)" for months and
  it was **false**. Measured on 2026-08-03: two exports of one chart, both
  129,913 bytes, SHA-256 `0e23f0f4…` vs `fbabb738…`, first differing byte at
  offset 8413, 37 differing runs / 179 bytes. Three causes, largest first.
  **(1) Random font subset tags — 30 of the 37 runs, across 8 faces.**
  `@react-pdf/pdfkit` picks each embedded font's six-letter prefix with
  `Math.random()` in `EmbeddedFont.embed()`, with no way to seed it. New seam
  `frontend/apps/web/src/lib/reportPdfDeterminism.ts` rewrites those tags after
  serialization to a value derived from the font's own PostScript name. The
  rewrite is length-preserving, so every xref byte offset stays valid, and it
  matches only `/FontName` and `/BaseFont` (pdfkit compresses stream *data*, not
  dictionaries, and writes no object streams, so no tag hides behind a filter).
  PDF 32000-1 §9.6.4 makes the tag arbitrary, so nothing a reader can observe
  changes. **(2) A wall-clock `/CreationDate`.** `ReportDocument.tsx` never
  passed the `creationDate` prop that @react-pdf already supports, so it
  defaulted to `new Date()`; `buildReportPdfData.ts` separately stamped the cover
  with `formatReportDate(new Date())`. Both now come from ONE instant — the
  chart's own `astronomical_calculations.calculation_timestamp` — threaded as a
  required, nullable `generatedAt` so no call site can quietly reach for the
  clock again. A chart that records no instant prints no date and stamps the
  epoch, rather than inventing one. **(3) The trailer `/ID`** needed no separate
  fix: pdfkit derives it from an MD5 over the info dictionary, so pinning
  `/CreationDate` pins it.

  Nothing had ever byte-compared two renders. `renderToBytes.test.tsx` asserted
  only `buf.length > 1000`, which passes at any content. Two new suites close
  that: `__tests__/deterministicExport.test.tsx` (two renders, identical object
  bodies, identical subset tags, `/CreationDate` pinned to a literal, stable
  `/ID`) and `lib/__tests__/reportPdfDeterminism.test.ts` (the rewriter's own
  properties). The whole-file SHA-256 comparison lives in
  `e2e/report-pdf.e2e.spec.ts`, which exports the same chart twice from a real
  Chromium *with the page clock moved on by a second between exports* — freezing
  it would have let a clock-reading export pass. It has to be the browser: Node's
  pdfkit build deflates through async `zlib.createDeflate()`, so its object write
  order varies between runs; the shipped browser build is single-threaded pako.

  One real bug fell out of writing those tests. The first cut of the rewriter used
  `TextDecoder('latin1')`, which is an Encoding-Standard alias for **windows-1252**:
  bytes 0x80–0x9F decode to printable code points (0x80 → U+20AC) and re-encode to
  something else, silently corrupting any deflated stream containing them. The
  "leaves every non-tag byte untouched" test caught it before it shipped.

- **`verify-report-pdf.mjs` can no longer pass by skipping its own verification.**
  The script rasterizes every PDF page to a PNG — that *is* the verification — and
  when `pdftoppm` was absent it printed "PDF written, PNGs skipped" and exited 0.
  It now preflights the binary before launching Chromium and exits 1 with install
  instructions, fails if rasterization errors, and fails if `pdftoppm` exits 0
  having written no PNGs (proven with a stub rasterizer: exit 1, was exit 0).
  Console errors during the flow now fail the run too, instead of being printed
  under a green exit. `pdftoppm`/`pdftotext` were undeclared binary dependencies;
  `CONTRIBUTING.md` now names poppler where a contributor will look.

### Changed
- **`@edgeproc/errors` now comes from npm instead of a vendored copy.** The
  library was published as `@edgeproc/errors@0.1.0`, so
  `frontend/packages/edgeproc-errors` (a 509-line snapshot pinned to upstream
  commit `7705a72`) is deleted and `apps/web` depends on `^0.1.0` like any other
  package. No behaviour change: the published catalog is a strict superset of
  the vendored one — same 18 codes, same registration order, same HTTP statuses,
  same English text — verified by a 222-check differential run across
  `classify` / `describe` / `httpStatusOf` / `errorNameOf` / `errorTextOf` and
  every code, with zero diffs. The library enters the app through the single
  seam `apps/web/src/lib/errors.ts`, which is unchanged apart from a comment.
  The library's own 48 tests move upstream to `hseshadr/errors` (now 114 tests
  across 13 files, with its own CI); AlmaMesh keeps its 43 consumer tests.

### Fixed
- **The exported PDF dropped the AI interpretation the app was still showing you.**
  `ReportView` gated the export on `status === 'complete'`, but a natal-only
  reading's status is downgraded to `'idle'` the moment the predictive layer
  computes (its `inputProvenance.predictiveRequestKey` is `null`, which stops
  being "current" once predictive facts exist). The dashboard kept rendering that
  same reading from the permissive `interpretation` value, so screen and export
  disagreed about a document the user could see. Both now read the one stored
  value; there is no third state left for them to disagree about. Regression test:
  *"exports the narrative the screen is showing, even after predictive turns the
  status stale"*.
- **Export PDF asked you to do things first.** The dashboard button was
  `disabled` until a finished AI reading existed — so a user with no API key
  could never export a document that is complete without any AI at all — and it
  did not export: it navigated to `/report`, where a second button had to be
  found. It is now one click, gated only on a stored chart. `canExportPdf` is
  deleted; its test suite asserted that gate as the requirement and has been
  inverted rather than removed.
- **The Interpretation section is no longer silently omitted.** With no reading,
  section VII simply vanished and the numbering jumped VI → VIII with no
  explanation. The section now always prints, carrying an honest note that a
  written interpretation appears once a reading is generated (optional,
  bring-your-own-key) and that the rest of the report is complete and unaffected.
- `isPlaceholderContent` now treats whitespace-only text as a placeholder; a
  summary of `"   "` previously rendered as an empty prose block.

### Added
- **A completeness guard so the export cannot silently fall behind the app
  again.** `lib/reportSections.ts` declares every report section once;
  `lib/__tests__/reportSectionParity.test.tsx` holds both renderers to it in
  both directions — a section on screen that is not declared fails by name, and
  a section declared exported that the PDF does not carry fails by name. Opting
  a section out requires writing the reason in the registry. Both directions were
  proven to fail before being trusted. Stated limit: this proves a section is
  *present*, not that it carries the same depth as the screen.
- `hooks/useReportPdfExport` — the single export assembly the dashboard and
  `/report` both call, reading persisted values only. It recomputes nothing, so
  the two entry points cannot drift into two different documents.
- **The Ed25519 signature check on strength receipts is now actually tested, and
  its failure modes are coded apart.** The suite had two "tamper" tests and
  neither one ever reached the signature: the mutated-`strength_pct` case leaves
  a stale `payload_hash` and dies at the content-hash compare, and the wrong-key
  case dies at the signer compare. Measured, not assumed — forcing avow's Ed25519
  verdict to always-succeed left all 12 tests green. A new test builds a genuinely
  valid receipt and flips **one hex nibble of the `signature` only**, leaving
  `payload_hash` and `public_key` correct, so both earlier gates pass and control
  reaches the Ed25519 check; under that mutation this test — and only this test —
  turns red. `@edgeproc/avow` moves `0.1.0` → `0.1.1`, which splits the single
  `SignatureInvalid` into `SignerMismatch` (wrong signer — a provenance failure)
  and `SignatureBytesInvalid` (right signer, bad bytes — a tamper failure), both
  still extending `SignatureInvalid`. The two existing tests are tightened to pin
  the specific subclass, so neither can silently stand in as signature coverage
  again. **No verification behavior changed** — the same receipts are rejected in
  the same order; only the typed error naming *which* gate rejected them is new.
- **Complete deterministic report artifacts (PR #62).** Exported daśā tables now
  cover **maha, antar, and pratyantar**; generation is keyed to the current
  **predictive cache identity**; AI-written sections require matching
  **interpretation provenance**; free-text event input uses
  **conservative life-event structuring**; and **semantic, geometric, and browser PDF gates**
  verify that the downloaded artifact is complete and readable.
- **Frontend dead-code gate (PR #65).** `knip` is wired into the single frontend
  gate, so the unused-export / dead-code axis auto-verifies on every `bun run
  gate` run — locally and in CI.

### Changed
- **Re-vendored the three vendored packages to their latest upstream releases**
  (provenance + recorded adaptations in each `VENDORED.md`; no storage-format,
  signing, or trust-root changes):
  - `backend/vendor/edge-proc`: v0.1.0 (`e3f1faa`) → **v0.1.2** (`3dabffa`).
    Docs/CI/release-plumbing delta only — zero changes to `edgeproc/` or its
    151-test suite. The snapshot keeps `[tool.uv.sources]` pointed at the
    sibling `../shared-libs-python` via upstream's own documented path-source
    toggle (now recorded as a local adaptation, since upstream ships a git-tag
    pin active).
  - `backend/vendor/shared-libs-python`: `0533ea0` → **v0.1.3** (`0ba9ba8`).
    Gate/CI/docs delta only — zero runtime code beyond the version string; the
    documented LICENSE-holder normalization is preserved.
  - `frontend/packages/edgeproc-browser`: edge-reco `999d987` → **`2471b0b`**
    (current main). Brings the embedder hardening + fail-closed bundle
    validation (`0da71f5`), signed ranking-config/co-occurrence support, and
    their parity suites. Local adaptations re-applied and now both recorded in
    `VENDORED.md`: the biome lint script/devDep drop, and the root-absolute
    `/public.key` resolution (+ `runtimeConfig.test.ts` regression test) that
    keeps deep-link loads verifying against the app origin's pinned key.
- **SEO, crawler delivery, and browser hardening (PR #61).** Split `/` into a
  brand-first shell (the full explainer stays at `/welcome`); stop assigning root
  content/canonicals to unknown routes and ship a branded static `404.html` with
  client-side `noindex`; replace blanket Pages/Workbox SPA fallbacks with explicit
  app-route allowlists; publish a factual `llms.txt`; and enforce HSTS,
  Permissions-Policy, and a CSP compatible with Pyodide/WASM, module/blob workers,
  Turnstile, embedded fonts, and user-configured AI endpoints.
- **AI error classification now routes through the vendored `@edgeproc/errors`
  registry (PR #68).** AlmaMesh becomes the reference consumer of the portfolio's
  canonical-errors standard — the hand-written `classifyConnectionError` chain is
  replaced by the shared coded-error registry. Behaviour-identical: the same HTTP
  status still yields the same coded error and the same existing `chat:errors.*`
  copy, with no i18n key changed.

### Fixed
- **Storage capability detection under SSR and Node 25.** Partial native
  `localStorage` shells are treated as unavailable by LLM settings and reset
  paths; browser tests install a deterministic in-memory Web Storage substitute,
  while real browser storage remains unchanged.
- **Compound life-event fallback extraction.** When AI is unavailable, dated
  milestones in one sentence are split into independent typed rows instead of
  collapsing onto the first detected category; the PDF can therefore render a
  clean event table from ordinary prose.
- **Deterministic report-PDF pagination (PR #63).** Report PDFs paginate the same
  way every time.
- **Rectification gated on current previews (PR #64).** Save and programmatic
  submit now fail closed until both candidate-time lagna previews are current and
  ready, so a slow-worker race can never skip the mandatory rising-sign-flip
  acknowledgement; preview failure surfaces a localized Retry action.
- **Specific AI-error messages in chat and reading (PR #67).** A shared coded
  mapper turns each HTTP status into precise copy (billing · bad key · dead
  model · rate limited · provider outage · endpoint unreachable), and the
  structured reading path now preserves the typed HTTP status instead of
  flattening it. New `chat:errors` keys (`auth_failed` / `rate_limited` /
  `server_error`) added in en/es/pt with a parity test.

### Security
- **Bumped `click` 8.3.1 → 8.3.3 to clear PYSEC-2026-2132.** `click` is a
  CLI-only transitive dependency (via `typer`, for the `almamesh-bundle` CLI) and
  is absent from the shipped PWA runtime, so this is pure supply-chain hygiene
  with no runtime-behavior change. Added a `click>=8.3.3,<8.4` floor to
  `[tool.uv] constraint-dependencies` and re-locked; the weekly Security-Audit
  now passes.
- **Re-locked vendored EdgeProc dependencies** to match its declared floors
  (`faiss-cpu` 1.14.3, `rank-bm25` 0.2.2, and the sibling `pgvector` floor),
  keeping the exact AlmaMesh gate reproducible.

## [0.4.0] - 2026-07-11

> Release-discipline note: tags v0.1.0–v0.3.0 were never cut (the public repo
> history begins at the 2026-06-25 "Initial public release" commit). Annotated
> tagging starts at **v0.4.0**; earlier versions are never backfilled.

Release notes: [docs/releases/v0.4.0.md](docs/releases/v0.4.0.md)

### Added
- **Backup & Restore (Spec 061).** Export all your data — profiles, charts,
  members, readings, settings — to a single file and import it in another
  browser. Everything stays client-side; the file is yours. Hardened with a
  follow-up integrity pass.
- **Robust birth-time rectification + comprehensive report (Spec 062).** The
  rectifier gains D9-lagna signals, deeper dasha keys, and a labeled score
  anatomy with honest qualitative bands (never a headline %); the wizard tells
  the per-event evidence story; the exported report grows to a comprehensive
  document including Section XII "Birth Time Authority"; chat + interpretation
  are grounded in the rectification record and live predictive contexts.
- **Opt-in cloud AI (Spec 063, then OpenRouter-first).** No AI by default —
  the chart is pure calculation. Opting in gets an OpenRouter-first setup with
  test-on-save connectivity checks, a model picker, an AI security gate, and
  live credits surfacing. (Spec 063's experimental on-device WebLLM tier
  shipped mid-cycle and was removed before this release — see Removed.)
- **SEO prerender (Spec 064).** Public routes (landing, welcome, legal) ship
  real HTML for crawlers — no JavaScript required — plus sitemap, robots, and
  IndexNow.
- **Regenerate reading + provenance.** Re-generate the AI reading on demand;
  every stored reading is stamped with the engine/model that produced it
  ("Generated by …").
- **Add people in place.** A ghost "+" star in the mesh constellation and a
  shared Add Person dialog — add a member without leaving the mesh view.
- **The full reading on the dashboard.** The complete AI interpretation —
  strengths, challenges, yoga narrative, guidance, remedies, upcoming
  periods — now renders on the dashboard with progressive disclosure, not
  only in the exported report.
- **Per-route social share cards.** Each public page (landing, welcome,
  legal) carries its own Open Graph image, generated at build time from the
  brand design tokens and self-hosted fonts — link previews are
  route-specific.
- **Online-primary birthplace search.** Birthplace lookup now queries
  Open-Meteo's geocoder first (with the offline city list as fallback), plus a
  coordinate-entry fallback for places missing from both.
- **"How this reading is made."** An honest grounding explainer on the
  dashboard names exactly what the deterministic engine computed and what the
  optional AI narrated.
- **Anonymous product feedback.** An optional, anonymous feedback signal
  (Cloudflare Pages Function + D1 + Turnstile), stamped with the app version.
- **Live e2e gates in CI.** A real first-run onboarding journey against the
  live in-browser engine, plus an unhappy-boot recovery drill (blocked bundle
  → recover).

### Changed
- **The Living Astrolabe.** The dashboard's 3D force-field hero is
  de-cluttered into one radiant core, a quiet zodiac wheel, and at most three
  dasha threads.
- **Landing page.** Readable hero, prominent open-source signal, the Generate
  CTA routes to your existing chart — and the data-privacy story is fully
  honest: the optional AI egress is named, with a data-portability blurb.
- **Rectification tone.** The life-events ask is reframed as an optional,
  warm invitation; the interview chat matches the chart chat (roomier
  textarea, shared bubbles, processing indicators).

### Fixed
- **Bundle signature verification on nested routes.** The verify key
  (`/public.key`) now resolves absolutely, so opening the app on a deep link
  no longer fails signature verification.
- **Onboarding birth-time entry.** The time field is draft-buffered — the
  first "Continue" click is no longer swallowed.
- **On-device chat defects**, fixed alongside the regenerate-reading control.
- **Public pages are indexable again.** The prerendered routes emitted
  directory indexes, so `/welcome` redirected to `/welcome/` while every
  canonical signal said `/welcome` — search engines saw a redirect loop and
  refused to index. The routes now emit flat files; the no-slash canonical
  serves directly.
- **Clearer AI failure surfaces.** A mistyped or retired cloud model id is
  detected (including OpenRouter's newer 400 response) and answered with a
  "switch model / check AI settings" prompt instead of a raw error.
- **Out-of-credits AI errors are honest now.** When a cloud AI account has run
  out of credits (e.g. an OpenRouter `402`), the reading says exactly that and
  points to billing — instead of the generic "check your model / try again"
  advice, which can never fix a billing problem.
- **Service worker self-heals.** A wedged service-worker session (the "site
  is down" symptom) now auto-recovers; `/public.key` is served NetworkFirst so
  a stale verify key can never be pinned by the cache.
- **Connectivity probe accepts reasoning models.** The test-on-save probe no
  longer rejects valid reasoning models (`max_tokens: 1` → 400).
- **Combustion carries into divisional charts** (D9 and the full D1–D60
  vargas).
- **Predictive layer persists.** Life Atlas no longer recomputes the full
  predictive superset on every reload.
- **Mobile.** Responsive layout pass kills horizontal overflow; the Regenerate
  button is reachable on mobile and the active-AI badge reads green.
- **Birthplace queries match natural input** — diacritics and state/country
  qualifiers no longer break matching.
- **Report PDF.** The life-events blob is cleaned up, with real
  render-to-bytes coverage.

### Removed
- **The on-device WebLLM AI tier.** Added mid-cycle (Spec 063), removed in
  favor of the cloud-only opt-in path — WebGPU model quality did not yet
  justify the weight. On-device AI may return when it does.

## [0.3.0] - 2026-06-11

### Added
- **The mesh — relational astrology (the namesake feature).** Add the people
  close to you as **members** (typed relationships, each owning a full chart;
  persisted with a versioned migration, managed in **Settings → People**) and
  read the relationship between two whole charts. A new Python `almamesh.mesh`
  engine computes the classical **Ashtakoota Guna Milan** (36-point Melapaka,
  cited tables) and **Mangal (Kuja) dosha** screening (3-reference, with
  chart-computable cancellations), a two-way chart overlay, **daśā synchrony**
  over both dated trees, and shared house/kāraka significators — frozen into a
  read-only `MeshEdgeContext` per pair (neither chart is ever mutated by the
  other). Surfaces as the `/mesh` constellation and a `/mesh/:memberId` edge
  view: the marriage tables render **only on spouse/partner edges**; the
  compatibility band is labeled a *classical convention, never a verdict*; doshas
  are presented fear-free; and the engine's read-only promise is printed at the
  foot of every edge. The optional AI reading is **role-anonymized** (you and
  "your spouse" — no name ever leaves the device) behind an explicit anti-scam
  relationship fence.
- **Periods explorer + "The Road Ahead".** The predictive route gains a full
  **Periods** view (the 120-year Vimśottarī daśā tree, drillable maha → antar →
  pratyantar) and a **Road Ahead** timeline of upcoming windows.
- **"Sky & Timing" predictive superset.** A second on-device engine pass adds
  current transits (Gochara) + Sade Sati, dasha depth (antar/pratyantar), the
  full **D1–D60** divisional-chart set, **Ashtakavarga + Shadbala** planetary
  strength, and **per-life-domain forecasts** (career, finances, health,
  relationships, …) — same zero-egress, byte-identical determinism as the natal
  chart. Surfaces on a new `/predictive` route, a dashboard timing section, and
  report sections VI–IX.
- **Classical yoga engine + professional dashboard + birth-time sensitivity.**
  Yoga detection is rebuilt against cited classical rules with honest displays
  (on-screen formation traces and sources, qualitative grades, no invented
  combinations or percentages), the dashboard is reworked into a professional
  identity + insight surface, and near-cusp charts get an unmissable callout
  naming the alternative rising sign with a one-click path to rectification.
- **English, Spanish & Portuguese.** Offline-bundled i18n catalogs (zero
  egress, service-worker precached), a persisted language setting with
  `<html lang>` sync, locale-aware dates, and the optional AI narrates in the
  selected language. English is authoritative; es/pt are machine-translated
  pending native review.
- **Birth-time rectification panel.** Settings → Profile gains an editable
  birth time with a live Ascendant preview, cusp awareness, and a
  time-confidence field — refine an uncertain birth time and watch the Lagna
  respond before saving.
- **Print-first Vedic report (`/report`).** A dedicated, paper-themed,
  multi-page report route replaces the old "print the dashboard" path; the
  gated Export PDF includes the interpretation and the D9 Navamsa. Engine
  values render verbatim.
- **"Ask About Your Chart" chat.** Streaming multi-turn chat grounded in the
  deterministic engine's own numbers, persisted per profile, and searchable
  via in-browser RAG (self-hosted MiniLM embeddings — chat history never
  leaves the device).
- **Structured Vedic interpretation.** A five-section, schema-validated
  reading (generated client-side) populates the dashboard and astrologer-view
  cards; a lite prompt variant lets small local models render valid readings.
- **Profile CRUD.** Profiles can be renamed and deleted; deleting one
  cascades to its charts.
- **Engine: rigorous-precession Lahiri, plus True-Chitra ayanamsa and
  True-node options** (engine-level; the UI ships the Lahiri default).
- **External golden-reference validation.** The golden fixtures are checked
  against an independent astropy code path, with new boundary + hemisphere
  reference charts.
- **Vendored DE421 ephemeris.** The backend ships the JPL DE421 kernel —
  charts compute offline from a clean clone with no download step.
- **Turnkey demo.** `uv run poe demo` (or `make demo`) installs, signs a dev
  bundle, builds, and opens the PWA in one command.
- **Distinct "engine warming" onboarding message.** The first-load chart path now
  surfaces a separate, retryable warming state instead of a generic error while
  the Pyodide engine boots.
- **Gitleaks secret-scan CI job.** Pushes and PRs are scanned for committed
  secrets.
- **Husky pre-push guard.** Pushes run lint + typecheck locally before they
  can reach `main`.

### Changed
- **The repo is now fully self-contained — a single `git clone` builds
  everything.** The three formerly-private dependencies are vendored in-tree
  with provenance, licenses, and a re-vendor policy (`VENDORED.md` in each):
  `backend/vendor/edge-proc`, `backend/vendor/shared-libs-python`, and
  `frontend/packages/edgeproc-browser` (`@edgeproc/browser`, now a regular Bun
  workspace package). CI runs every job from the single checkout — the
  `PORTFOLIO_PAT` secret, the private-sibling checkout/patch/symlink steps, and
  the pnpm toolchain it dragged in are gone, and the vendored suites are new
  gates (the edge-proc pytest suite; `@edgeproc/browser` typecheck + vitest).
  The `scripts/fetch-deps.sh` helper is deleted — there is nothing left to
  fetch.
- **Renamed `OnDeviceModelSettings` → `AiModelSettings`** and corrected stale
  "on-device WebLLM by default" copy: the default is the OpenRouter / BYO
  OpenAI-compatible cloud preset; the in-browser WebLLM engine ships dormant.
- **Yoga engine now fails loud.** A malformed yoga rule raises a typed
  `YogaRuleError` instead of being silently dropped.
- **Tiered LLM defaults.** Chat runs on a fast model that reuses the
  frontier-generated reading; interpretation keeps the deeper default — one
  shared OpenRouter / BYO OpenAI-compatible preset configures both.
- **Legal pages rewritten truthfully** for a no-account, local-first app (the
  old copy described accounts and registration that do not exist); shown with
  a machine-translation disclaimer outside English.

### Fixed
- **Engine: timezone-aware birth datetimes are converted — not relabeled — to
  UTC.** A `06:44+05:30` birth was previously treated as `06:44 UTC` by the
  offline CLI / standalone engine (the browser path already passed UTC);
  regression-tested across six offsets.
- **Engine: apparent positions + true obliquity of date** replace mean values.
- **OpenRouter LLM is now selectable and discoverable.** A dedicated
  `/settings/ai` tab plus a live header AI-status badge that links to it; the
  "Use OpenRouter" preset is promoted to the primary action.
- **Print/PDF birth header rendered the wrong date for near-midnight,
  non-UTC births.** The report header is now timezone-safe.
- **Settings rendered the birth date rolled back a day in some timezones**;
  it now shows the birth-local date.
- **Interpretation no longer fails silently on a retired model id** — it
  self-heals to a live default and surfaces the real provider error body; the
  generation timer shows honest elapsed time.
- **"Current Life Phase" card** populates from the engine's dasha sequence.
- **The 3D force-field fetched its text font from a CDN** — fonts are now
  self-hosted, restoring the zero-egress guarantee (a live exit-gate check
  pins it).
- **Stop tracking `*.tsbuildinfo` build artifacts** (generated, never tracked).

### Removed
- **Dead SaaS-era harness swept.** Deleted the Playwright / Supabase-auth test
  harness, the orval API codegen, and the deprecated Supabase / OAuth error
  cases.
- **Retired SaaS architecture diagrams deleted** (`docs/diagrams/`): the
  OAuth/Postgres/FastAPI-era C4, sequence, activity, and endpoint-map set
  described the deleted server; they remain in git history.

## [0.2.0] - 2026-05-31

### Added (observatory UI overhaul — the in-browser product surface)
- **Professional "observatory" UI.** A single design-token source
  (`@almamesh/constants` → generated Tailwind theme), a set of accessible UI
  primitives, an app shell, and self-hosted variable fonts (no font CDN — keeps
  the app zero-cross-origin and fully offline).
- **Degree-accurate North & South Indian charts.** Both classic kundli styles
  render off a pure `buildChartGeometry(SiderealChart)` adapter, with a style
  toggle, a rich planetary table, and 2D⇄3D planet cross-highlight.
- **3D planetary force-field hero.** Planets at their real ecliptic longitude
  exert animated force-beams on a lagna-tinted core (interference-driven aura),
  driven by a pure `buildEnergyFrame` adapter. Replaced and deleted the old
  dasha-timeline 3D helix.
- **Optional LLM interpretation + chat.** Interpretation and multi-turn chat run
  against a bring-your-own OpenAI-compatible endpoint — a one-click OpenRouter
  cloud preset by default, or any local endpoint (e.g. Ollama) — all PII-redacted
  and fail-closed `local_only`. (An in-browser WebLLM engine ships dormant in the
  tree, disabled in this build and kept for a future re-enable.)
- **Named profiles for a shared device.** Multiple people share one laptop with
  no passwords; each profile owns its charts; password-less switcher in the
  header; existing charts migrate into a default profile with no data loss.
- **D9 Navamsa divisional chart.** The deterministic engine now computes the
  Navamsa (canonical BPHS rule) and renders it in either kundli style; emitted
  additively so the D1 chart stays byte-identical (CPython↔Pyodide parity holds).

### Added (local-first / edge-proc)
- **AlmaMesh is now an edge-proc consumer.** The deterministic chart core is
  wrapped as a `ChartRuntime` (`almamesh/edge/`) that accepts a `LOCAL_ONLY`,
  `DETERMINISTIC` task and returns the full sidereal chart on-device; failures
  are encoded in the result envelope, never raised.
- **Signed content-addressed construct delivery.** The Lahiri ayanamsa table is
  published as a signed bundle and synced with fail-closed ed25519 verification
  against a pinned trust root (almamesh.com is delivery-only; compute stays
  local).
- **Offline `almamesh-chart` CLI** + `examples/run_chart.sh`: birth data to a
  deterministic chart with no network, account, or API key.
- **Bundle publisher (`almamesh-bundle` CLI).** `keygen` mints a raw ed25519
  keypair (private key written owner-only `0o600`, never silently overwritten;
  public key pinned into the SPA); `bundle` signs the engine constructs (Lahiri
  table + yoga rules), a provenance `almamesh_meta.json` (engine version,
  ephemeris file, ayanamsa, construct list), and any staged binaries
  (ephemeris/wheels) into a content-addressed origin a device can sync.
  Staging rejects symlinks, out-of-tree escapes, and names that collide with
  signed constructs — a published bundle can never smuggle or shadow a file.
- **`EPHEMERIS_FILE` setting** records which ephemeris a bundle ships; it is kept
  in lockstep with the engine default `calculations.DEFAULT_EPHEMERIS_FILE`.

### Changed (browser engine prep — P2)
- **Default ephemeris is now DE421 (~16 MB), down from DE440 (~114 MB).** The
  smaller kernel is the shippable in-browser payload and is accurate across the
  1900–2050 range AlmaMesh targets; the parallel ground-truth validator was moved
  to DE421 in lockstep and the full validation suite stays green.
- **Chart output is reproducible: injectable `reference_date`.** The "current"
  Vimshottari maha dasha is the period containing a reference instant.
  `calculate_sidereal_context(..., reference_date=...)` and the `ChartRuntime`
  payload key `reference_date` (ISO 8601) now make that instant explicit; omitting
  it falls back to the wall clock. Pinning it makes a chart a pure function of
  (birth data, reference date) — required for CPython↔Pyodide byte-parity and the
  deterministic session version-lock.

### Removed (local-first pivot)
- **The SaaS runtime is gone.** The browser now runs the engine on-device, so
  the FastAPI server, Supabase auth, SQLAlchemy/Postgres, Redis cache, rate
  limiting, and all HTTP routers were deleted (≈6.7k LoC), along with the deps
  they pulled in (`fastapi`, `uvicorn`, `sqlalchemy`, `asyncpg`, `alembic`,
  `redis`, `PyJWT`, `slowapi`, and the unused `litellm`). The backend is now
  the deterministic engine + the edge-proc delivery layer; the LLM
  sanitization logic and predictive schema are retained as the reference for
  the in-browser TypeScript port.
- **Dead SaaS artifacts swept project-wide.** Deleted the deploy/infra that
  targeted the removed server — `render.yaml`, root `docker-compose.yml`,
  `backend/Dockerfile`, Alembic migrations, `scripts/setup_auth.py`, the
  database debug script — plus unwired BDD `.feature` files and the unused
  `pytest-bdd` dev dep. Deleted specs documenting the deleted SaaS backend
  (REST API, DB schema, auth migration, backend parity/stability).
- **Real PII removed from tests.** A committed name + birth data became an
  anonymous "Reference Chart" fixture (golden astronomical values unchanged).
- **Server-style Python LLM scaffolding deleted.** The cloud/server-era LLM
  port-reference is gone: `almamesh/llm.py`, the `almamesh/predictive/` package
  (canonical schema + claim generator), `almamesh/constants/llm.py`, the cloud
  `Settings` fields (`OPENAI_API_KEY`, `OPENROUTER_*`, `LITELLM_*`,
  `LLM_API_BASE`, `LLM_PRIVACY_MODE`), the `pydantic-ai` `[llm]` optional
  dependency (and its `almamesh[llm]` `dev` reference), and their tests. The
  only LLM in the product is now the in-browser `@almamesh/llm` (WebLLM / BYO
  OpenAI-compatible). The backend is purely the deterministic engine + the
  edge-proc bundle publisher. (`pyyaml`, previously satisfied transitively via
  the LLM stack, is now a declared core dependency — the yoga-rules engine needs
  it.)
- **Dead CI removed / reworked.** Deleted the `e2e.yml` workflow (it booted the
  removed FastAPI server). The backend test job now also runs `mypy src/`; the
  frontend job builds package declarations in dependency order before the
  workspace typecheck (fixes a clean-checkout `tsc` project-reference race).

### CI note
- Backend CI installs the unpublished `edge-proc` / `shared-libs-python` (local
  path sources) by checking the private siblings out into `.deps/` and patching
  the uv path sources before sync (mirrors edge-reco). Needs a `PORTFOLIO_PAT`
  secret with read access until `edge-proc` ships to PyPI (M5).

### Documentation
- **README rewritten for local-first.** Lead TL;DR + a one-command offline-chart
  quickstart (`almamesh-chart`), the bundle-publish flow, an architecture map,
  and an honest status/roadmap (engine + CLIs work; browser UI in progress).
- **`docs/tech-stack.md` rewritten** to the local-first stack (Python engine →
  Pyodide, edge-proc signed delivery, static origin) — dropped the
  FastAPI/Postgres/Redis/Supabase/Render framing.

### Fixed
- **Dasha-year convention is now declared and applied uniformly.** Mahadasha
  duration previously used a 360-day year while Antardasha, Chara, and Yogini
  periods used 365.25 — a silent, mixed convention that drifted sub-period
  timing. A single `DashaYearConvention` (`dasha/convention.py`) is now the one
  source of truth; antardashas are derived as exact fractions of their
  mahadasha's span, so they tile it with no overhang under any convention.
  `reconcile_vimshottari` exposes all three conventions side-by-side.
- **Pratyantardasha (3rd-level Vimshottari) is now populated.** `pd_lord` was
  consumed by signal extraction but never set; the active state now names it,
  derived as an exact fraction of the antardasha span.

### Changed
- Dropped the unused AGPL `pyswisseph` dependency (Skyfield over public-domain
  JPL ephemerides is the sole astronomy path).

### Added
- MIT `LICENSE`.
- `.env.example` documenting every backend environment variable.

## [0.1.0]

- Initial functional prototype: deterministic sidereal chart engine
  (lagna, planets, Whole Sign houses, nakshatras), composite dasha engine
  (Vimshottari + Jaimini Chara + Yogini), YAML-driven yoga detection, and a
  fenced-off LLM interpretation layer.
