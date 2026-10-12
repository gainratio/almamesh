# Time travel and deterministic chat verification — 11 October 2026

Status: hosted follow-up head `757cb225` is rejected; release is blocked. The refreshed candidate updates stable Playwright/WebKit and aligns the browser Skyfield wheel with backend 1.55; its complete frontend/browser/native checks remain pending. Earlier frozen product source `ce2548a709202f836b6ca14c169705233229692f` passed the complete native frontend gate (6,179 tests plus four lint contracts, types, lint, build, public routes and no-hooks checks) and the complete native Mac lane (49/49 checks, zero retries). The root independently finalized and scanned that saved evidence successfully. Earlier hosted Mac failures remain retained; local passes do not establish their cause or resolution. The user authorized the CI/CD process on 11 October 2026. Cold-boot aggregate memory, wider restore memory and physical iPhone verification remain open. Production remains on #331; merge and deployment require complete final-head hosted proof.

Hosted candidates `67addf61`, `ba2837a2` and `d42886cc` are rejected. Their outcomes,
including real browser failures, command/job timeouts, a report-section timeout
and thin-container/artifact harness failures, are recorded below. The follow-up
changes do not establish the native crashes' cause or resolution. Production
remains unchanged pending complete final-head proof.

The engine computes planetary facts deterministically. AI interprets those facts; it cannot identify a person's life events from a chart. Historical questions must receive selected-period engine facts, and explicit questions about today must use the viewer's current day even while a historical conversation remains pinned.

## Scope

- Day and place on every device tier, with one retained period in JavaScript and other computed periods in derived SQLite on OPFS.
- Offline cities imported in 25 hash-checked JSON batches and queried in bounded SQL result pages. No production import of the complete city JSON module.
- Native Web Locks serialize scoped derived database sessions; each session closes its Worker so another open tab can use the same database.
- Derived skies are excluded from portable backups and cleared/fenced on deletion, reset and restore. Boot-signed proofs are not persisted with derived skies.
- Chat tools read the current clock, chart facts, selected timing, and offline places, and queue travel or Back to today after a successful saved answer.
- Selected dashas and transits are supplied before inference. Explicit today questions override the historical pin for that turn's reads. The displayed pin changes only on an explicit movement.
- Literal, unambiguous en/es/pt calendar periods also receive timing facts before inference in an unpinned conversation. Ambiguous or unsupported precision requests clarification. Historical prompts exclude unrelated current predictive payloads.
- A thread/profile/chart change during the movement save prevents a stale Dashboard move or thread reselection. Search failures are distinct from no matches and offer Retry.
- Astronomy resource ownership and deterministic cleanup are documented separately in [astronomy lifetime evidence](2026-10-11-astronomy-lifetime-evidence.md).
- Circular slow-contact searches reject the opposition discontinuity instead of publishing it as a conjunction or return. Predictive persistence version 5 invalidates older results, and derived period rows use the signed engine manifest identity.
- Minimal and lite devices skip the optional MiniLM semantic-memory model and vector index for chat recall. Bounded keyword retrieval uses canonical profile-owned chat; full devices retain semantic memory. Constrained restore defers semantic backfill without clearing its durable recovery marker.

Reading onboarding and Google Drive backup are subsequent release batches, outside this change.

## Original release measurements

Base: `8d10fbbb76336a8a5efe272912e392e260b3fef5` (#331). Measurements used a detached checkout and its signed original engine assets. The Day probe changed only the device capability flags. These are local Playwright WebKit results on macOS, not proof on a physical iPhone.

| Journey | Runs | Results |
| --- | ---: | --- |
| Chromium minimal month journey | 5 | Peak combined heap 255.50, 255.59, 256.05, 255.52, 255.50 MiB |
| WebKit iPhone 15 boot | 5 | Peak single WebContent RSS 1038, 1042, 1022, 1047, 1056 MiB |
| WebKit iPhone 15 month journey | 5 | Peak single WebContent RSS 1053, 1019, 1051, 1031, 1045 MiB |
| Chromium minimal Day + Bogotá probe | 5 | Peak combined heap 335.22, 335.01, 380.05, 335.60, 379.85 MiB |
| Chromium Day probe city lookup | 5 | Heap growth 10.45, 10.64, 10.95, 10.79, 10.80 MiB |
| Chromium Day probe revisit | 5 | Heap growth 0.02, 0.14, 45.10, 0.45, 44.97 MiB |
| WebKit iPhone 15 Day + Bogotá probe | 5 | Peak single WebContent RSS 1142, 1191, 1165, 1176, 1179 MiB |

The pre-SQL city and revisit growth values are evidence, not passes against the final growth limits. The original Day first-compute peaks were below the provisional 440 MiB heap cap and the boot baseline of 1056 MiB + 250 MiB WebContent allowance. No additional engine reduction was needed to make the first-compute probe fit those provisional caps. The month WebKit command used the earlier 1047 MiB baseline, a stricter cap, and all runs still passed. Initial Chromium month measurements sampled through the settled Dashboard; later harness revisions explicitly waited for Life Atlas before starting travel.

An independent original-release cold-boot check passed functional onboarding and the heap cap but failed the existing settled aggregate RSS budget: 1307.8 MiB versus 1100 MiB (peak 1342.75 MiB versus 1400 MiB). That failure must be resolved or retained as an explicit release limitation; the budget must not be raised to hide it.

## Final acceptance limits

| Measurement | Limit |
| --- | ---: |
| Combined Chromium page/Worker heap peak | 399.1 MiB (original Day probe maximum × 1.05, rounded up to 0.1 MiB) |
| Revisiting an evicted period, settled heap growth | 5 MiB |
| First offline city lookup, settled heap growth | 8 MiB |
| Single WebContent RSS above measured original boot baseline | 250 MiB |

`TT_MEMORY_PHASE=final` gates all Chromium limits. WebKit requires a finite positive `TT_WEBKIT_BASELINE_MIB`; report-only runs cannot establish acceptance. Provisional limits may be lowered after final samples and may not be raised to pass.

## Regression evidence

- September 2017 grounding and a pinned `outlook today?` follow-up failed before the chat fix.
- Cached current dasha markers disagreed with the selected day; date selection now uses the engine's dated dasha tree for both timing and chart-fact tools.
- Queued aborted dates caused four unnecessary engine calls instead of one; canceled unstarted jobs are now removed.
- A writer waiting for a derived session inserted a stale row after a canonical epoch change; an acquired-session guard plus transactional SQL fence now blocks it.
- A cold place lookup exceeded the agent's old two-second default timeout; place tools now have a bounded explicit deadline.
- The movement hook drops actions on answer failure, persistence failure, changed profile/thread/pin/intent, or blank output.
- Deleting the source pinned thread while its movement save was held still moved the Dashboard; the post-save guard now also requires that source thread to exist and belong to the same profile.
- A comparison with today silently selected today when the other period used unsupported date syntax. It now requests clarification, while an appositive current-date label still reads today. The timing tool no longer instructs the model to invent a range for vague dates.
- The iPhone chat regression fetched MiniLM configuration, tokenizer, ONNX weights and the ONNX runtime despite being a minimal device. A browser regression now asserts no local model downloads on constrained chat, and unit regressions cover the policy, keyword recall, cleanup and deferred restores.

## Reproduce

Run the complete current native lane from `frontend/apps/web`:

```sh
env -u TT_WEBKIT_BASELINE_MIB -u WEBKIT_LANE_ARTIFACTS \
  BUILD_COMMIT="$(git rev-parse HEAD)" \
  bash scripts/webkit-macos-lane.sh all
bash scripts/webkit-macos-lane.sh --collect-native-evidence all
bash scripts/webkit-macos-lane.sh --finalize-evidence all
node scripts/artifactLeakScan.mjs webkit-lane-evidence-all
```

This measures five original-release boots and five candidate Day/place journeys
on the same host, followed by all 28 travel, eight portable-state and three
boot/recovery cases. It does not accept a scalar baseline override. The final
snapshot and its provenance must be retained together.

The earlier focused measurement commands were:

From `frontend/apps/web`, serve a production build with signed engine assets, then run:

```sh
TT_MEMORY_PHASE=final TT_MEMORY_GRANULARITY=day \
  MEMORY_BUDGET_E2E_BASE_URL=http://127.0.0.1:4297 \
  bunx playwright test --config=playwright.memory-budget.config.ts \
  --grep 'time-travel journey' --repeat-each=5

TT_MEMORY_PHASE=final TT_MEMORY_GRANULARITY=day TT_WEBKIT_BASELINE_MIB=1056 \
  TIME_TRAVEL_E2E_BASE_URL=http://127.0.0.1:4297 \
  bunx playwright test --config=playwright.time-travel.config.ts \
  --project=iphone-15-webkit --grep 'WebContent RSS budget' --repeat-each=5
```

Use a separate build with `VITE_EXIT_GATE_HOOKS=1` for seeded time-travel, two-tab database and portable-invariant contract tests. Production memory journeys use actual onboarding without exit hooks. A real provider test requires `OPENROUTER_API_KEY` in the invoking environment. No such key was available for this continuation; stubbed provider protocol plus the real browser engine is not live-model verification.

The final constrained-chat repetition used the hooked build:

```sh
TIME_TRAVEL_E2E_BASE_URL=http://127.0.0.1:4296 \
  bunx playwright test --config=playwright.time-travel.config.ts \
  --project=iphone-15-webkit --grep 'September 2017|chat executes' \
  --repeat-each=5 --max-failures=1
```

Both cases assert that no `/models/` requests occur. The ten recorded `peakSingleWebMiB` values were checked for finite positive samples and compared with the unchanged 1306 MiB allowance; all passed. These seeded chat cases use the real engine and a stubbed provider, rather than actual onboarding or live inference.

## Earlier candidate checks through 22f2a947

The candidate is on `codex/iphone-time-travel`, based on release #331 (`8d10fbbb`). At this earlier checkpoint, the local frontend gate rebuilt the normal review build as `e59cfce23f34` at `2026-10-12T00:15:23.358Z`. Final source native acceptance and earlier rejected hosted results are recorded below; release remains blocked pending hosted acceptance.

- Backend gate in Dagger: 1,214 tests passed, 98.46% coverage; Ruff, formatting, mypy and complexity checks passed. This includes 28 new public-doc export regressions. Seven corrected slow-hit dates changed in reference fixtures; other fixture fields were unchanged. Log: `/tmp/almamesh-codex-pr333-backend-dagger-green.log`.
- Earlier `22f2a947` local frontend gate: 6,128 tests plus four lint-contract checks passed, including constrained-device memory, restore generations, terminal-Worker containment and recovery, SQL teardown, reload diagnostics, artifact scanning and real-tool envelopes. TypeScript, ESLint, production build, public-route prerender checks and absence of test hooks passed. Knip completed with its documented unused-code/dependency diagnostics. Log: `/tmp/almamesh-codex-pr333-final-source-frontend-gate.log`.
- Real-browser engine parity: 11/11 checks passed against the CPython reference, including updated predictive fixtures, explicit-date sensitivity, Moon windows, clean console and same-origin engine traffic.
- The broad Chromium functional run passed 16 journeys and exposed one stale test assertion: it expected one city download instead of the new 25 bounded parts. After updating that assertion to the manifest count and proving no repeated part downloads, all seven affected journeys passed on the candidate before the constrained-device recall policy. These cover typed historical questions, multi-place timing, slow-save Back to today, Day/revisit, two tabs, September 2017 → today, and chat tool movement in both directions. The engine is real; provider replies in chat cases are locally stubbed.
- Mac WebKit iPhone 15 functional checks before the recall policy passed 4/4: Day/revisit/Back, two tabs, September 2017 → today, and chat tool movement. Single-WebContent RSS peaks were 1069, 862, 1326 and 1362 MiB respectively. Those were functional checks, not memory-budget passes: the chat peaks exceeded the 1306 MiB reference allowance and motivated the recall policy change.
- After the recall policy, both chat cases passed five repeats each (10/10), with no local model downloads and clean consoles. September → today single-WebContent peaks were 1074, 1060, 1053, 1055 and 1074 MiB; tool-driven travel/back peaks were 1090, 1121, 1116, 1114 and 1092 MiB. All were below 1306 MiB. This accepts the measured seeded chat journeys; live inference, long-history growth and physical iPhone Safari remain unverified. Logs: `/tmp/almamesh-codex-minimal-model-final.log`; numeric check: `/tmp/almamesh-codex-minimal-model-final-rss.json`.
- Mac WebKit iPhone 15 Day journeys: five runs passed, with single-WebContent RSS peaks of 1055, 1086, 1061, 1081 and 1078 MiB against the 1056 + 250 MiB limit. Physical iPhone Safari remains unverified.
- Chromium production Day journeys: five final runs passed with actual onboarding, repeated city lookup, two days, an evicted revisit and Back to today. Maximum combined heap was 218.48 MiB, city lookup growth 0.192 MiB and revisit growth 0.333 MiB, all below their limits. These use a minimal device tier and iPhone user agent; they are not iPhone Safari results.
- Portable-state journeys before the recall policy passed 4/4 on Chromium and iPhone-viewport WebKit: complete entity round-trip/deletion and Day/place pin round-trip. The WebKit export/import journey reached 1608 MiB single-WebContent RSS.
- After the recall policy, both portable journeys passed again on iPhone-viewport WebKit (2/2). Full seed/mutate/export/import measured 1343 MiB in the source context and 1020 MiB in the fresh import context; Day/place pin round-trip measured 1170 and 1016 MiB respectively. These are functional passes with diagnostic RSS samples, not a formal restore memory acceptance result. The full source journey still exceeded the chat/Day reference allowance; large-history and repeated-restore memory remain unmeasured. Log: `/tmp/almamesh-codex-policy-portable-final.log`.
- An earlier Chromium production memory journey failed on the second place lookup. Hooked reproductions with a minimal device, continuous heap sampling and service workers both enabled and disabled passed, as did the five final production repeats. The original failure is still unexplained; passing later runs does not establish an underlying SQL fix. Failed journeys now capture a public-module lookup diagnostic before closing the page, and the UI distinguishes lookup errors from no matches and offers Retry.

The legacy cold-boot aggregate renderer RSS gate remains red on this Mac. With its original chart-ready protocol, the new code measured 189.63 MiB heap, 1324.78 MiB RSS peak and 1317 MiB settled RSS. After correcting the sampler to wait for predictive readiness, it measured 189.27 MiB heap, 1342.63 MiB RSS peak and 1329.61 MiB settled RSS against limits of 300, 1400 and 1100 MiB respectively. The settled value sums four renderer processes; it is not a single WebContent measure. No budget was raised, and these results do not establish the cause or resolution of previous Safari crashes.

The user's local checklist and outstanding report work are recorded in [local review](2026-10-11-local-review.md). Private chart material and the supplied report were not added to this repository. The remaining report presentation/evidence findings are reviewed work, not implemented changes.

## Earlier release preparation after local review

The release is one batched PR. Local production → candidate smoke passed 2/2
(`@fresh`, `@returning`), using the original `8d10fbbb` source and wheel for the
previous build and the reviewed candidate for the new build. Both used the same
throwaway development public key, with the candidate signed sequence greater
than the previous build. No production private key was used. Engine boot took
2616 ms for a fresh candidate, 3176 ms for the previous visit and 2132 ms after
upgrade. Log: `/tmp/almamesh-codex-local-upgrade-smoke.log`.

The service-worker update suite passed 3/3 against those same distinct builds:
version-poller banner, Workbox waiting event, and accepting an update while the
previous worker still downloaded a response held for 30 seconds. Each case
verified that the browser executed the new entry chunk after accepting the
update. Log: `/tmp/almamesh-codex-local-sw-upgrade.log`.

The final CI integration audit found a missing hosted WebKit RSS baseline and
stale ingress contracts for the new memory command. The lane now archives the
fixed original release, builds its own signed engine and production frontend,
and measures five fresh original boots using the candidate's sampler. It rejects
incomplete, retried, wrongly identified or caller-supplied hosted measurements.
The same host then runs five candidate Day/place journeys against the measured
original maximum plus the unchanged 250 MiB allowance. The baseline and ingress
regressions passed; the complete native Mac lane was pending at this checkpoint. Hosted Mac evidence
must be checked before merge: main's automatic deploy waits for Dagger, not the
parallel Mac workflow.

A new real-provider three-turn regression requires actual September 2017 tool
movement and calculated dasha facts, today's calculated facts while the historical
pin remains selected, then actual tool-driven Back to today. It checks provider
call IDs against successful local tool results and checks the final factual
summary against engine data. Scoped lint, E2E TypeScript and 22 real-model
contracts passed; live execution was pending at this checkpoint. The later
`d42886cc` nightly result is recorded below; final-head hosted acceptance remains required.
The prompts explicitly request tool use and a structured factual summary. This
checks the live routing/facts contract rather than spontaneous tool selection or
the quality of a complete interpretation.

The local Dagger CLI integration run passed 517 checks and timed out on the
contracts wrapper's 120-second limit, after its container checks and Wrangler
dry-run had completed. Re-running that exact wrapper without changing the limit
passed in 90.65 seconds. The separate deploy dry-run passed in the first run.
This retains the initial timeout as evidence rather than treating it as a pass.

Immediately before the local release commit, the complete frontend gate passed
again (5,848 tests plus four lint-contract checks), and all 472 selected Dagger
and WebKit-baseline contracts passed. Logs:
`/tmp/almamesh-codex-prepush-frontend-gate.log` and
`/tmp/almamesh-codex-prepush-pure-contracts.log`.

The first complete native lane stopped before browser measurements because
`git archive` inherited the web-app working directory and omitted the reference
repository paths. The lane now archives explicitly from the repository root
and creates the reference public directory before copying downloaded runtime
assets. Two failing regressions became green; the ingress suite passed 102/102.
The initial failure is retained in
`/tmp/almamesh-codex-final-native-mac-archive-setup-failure.log`.

The next complete Mac run measured five original-release boots (1010, 1017,
1023, 1028 and 1040 MiB single-WebContent RSS). All five candidate Day/place
journeys passed against 1040 + 250 MiB, measuring 1072, 1067, 1111, 1068 and
1105 MiB. The travel suite passed 27/28, portable-state checks passed 8/8 and
boot-retry checks passed 2/2. No `page crashed` failure was recorded.

The remaining travel failure was a clean-console assertion during an explicit
reload. Its trace showed an old SQL worker's nested Blob request cancelled
before navigation committed; the optional `opfs-wl` initializer logged an Event
before new-page scripts loaded. Pin persistence, timing, prompt and privacy
assertions had passed. At that stage, the test classified only that exact error when the
same previously requested worker has a matching cancelled Blob request before
commit, retaining the proof as an attachment. New-page, unmatched and all
uncaught page errors remain fatal. Twenty-nine classifier/wrapper regressions
passed after six initially failed. The complete lane must be rerun with this
test correction. The first run is retained at
`/tmp/almamesh-codex-final-native-mac-old-document-cancellation.log`.

After the reload-diagnostic correction, the full frontend gate passed again:
5,877 tests plus four lint-contract checks, with production build and public-route
verification. Log: `/tmp/almamesh-codex-prepush-final-frontend-gate.log`.

The next Mac run passed all five original boots (1020, 1028, 1024, 1053 and
1036 MiB) and five candidate Day/place journeys (1084, 1089, 1059, 1084 and
1086 MiB, against 1053 + 250 MiB). The same reload assertion exposed a different
old-document diagnostic: an exact Blob access-control message before navigation
commit, with no cancelled-request event. The existing classifier correctly kept
it fatal. The run was stopped to investigate rather than repeating the remaining
journeys. Its evidence is retained at
`/tmp/almamesh-codex-final-native-mac-access-control-diagnostic.log`.

A targeted three-repeat probe passed once and reproduced the assertion failure
twice. Public Playwright events tied each Blob request's Referer to the SQL worker
requested before reload. In one failure the Blob completed with status 200 before
the access-control message; in the other it was cancelled and both `opfs` and
`opfs-wl` initializer Events were recorded. All occurred before the first main-frame
commit, and the functional persistence assertions passed. [WebKit's pinned source](https://github.com/WebKit/WebKit/blob/4d05d732e5a84f32675bef4cc135a2e7a9269a87/Source/WebCore/loader/cache/CachedResourceLoader.cpp#L1370)
supports a navigation-related resource rejection being labelled access control;
the exact native branch remains an inference, not a demonstrated CORS defect or
an explanation of previous Safari crashes. Log:
`/tmp/almamesh-codex-opfs-reload-observe.log`. The test harness was extended with
the narrowly bounded categories below, while retaining all unmatched errors and
all uncaught exceptions. The complete Mac lane was pending at that stage.

The strict resource classifier then passed four of five targeted reloads,
retaining actual cancellation/completed-resource proof in three passing runs.
The remaining failure contained no matching Blob request anywhere in the trace.
It occurred after the explicit HTTP reload began and before the first main-frame
commit; new-page entry scripts loaded afterward. Log:
`/tmp/almamesh-codex-opfs-reload-final.log`.

The harness therefore distinguishes a third category: an outgoing-navigation
diagnostic with source and cause explicitly unproven. This accepts at most one
exact native, empty-location, same-origin Blob access-control message strictly
before commit, only when the old and committed HTTP(S) document URLs match and
a complete bounded capture history contains no matching resource event. Blob URL
history and overflow survive public frame-navigation events, including SPA
navigation; retaining prior documents is a conservative superset.
Any matching event, missing evidence, history overflow, different target/origin,
post-commit message or uncaught exception stays fatal. This category cannot
justify initializer errors. Every scope and matched category is written to a
physical JSON file, including successful runs with the list reporter. The
107 focused contracts passed. The next native reload probe passed 5/5 with five
physical scope files retained, including actual cancellation and resource-rejection
proofs; no outgoing-navigation exception was needed in those five runs. Log:
`/tmp/almamesh-codex-opfs-reload-navigation-final.log`. Two subsequently added
regressions failed before the conservative history-retention fix and passed
afterward; the complete native lane will verify that final source. These are
functional journeys with archived pre-commit diagnostics, not an assertion that
the outgoing page emitted no console messages. A coincident outgoing-document
Blob defect remains a residual risk; post-reload persistence, timing and privacy
assertions remain unchanged.

## Final local Mac snapshot

The complete lane passed on `e80d708a64a24ff8dc4634d2b7c6a52e4f1ae026`, without
test retries: 28/28 time-travel/chat journeys, 8/8 portable-state journeys and
2/2 intentional engine boot-recovery cases. Five original boots measured 1041,
1022, 1029, 1040 and 1038 MiB. Five candidate Day/place journeys measured 1083,
1079, 1063, 1071 and 1060 MiB against the unchanged 1041 + 250 MiB limit.
There was no `page crashed` failure. The three explicit reload scopes retained
actual cancellation/resource-rejection proof; none needed the unproven outgoing
exception in this run. Log: `/tmp/almamesh-codex-final-native-mac.log`.

The subsequent local artifact scan falsely classified the public installation
paths `HOMEBREW_CELLAR`, `HOMEBREW_PREFIX` and `HOMEBREW_REPOSITORY` as secrets
and deleted the raw evidence directory. The run log survives. The scanner now
excludes only those three exact public names; other Homebrew variables and
arbitrary secrets remain scanned. Four regressions failed before the correction;
all 40 scanner tests then passed. No environment variable was unset to bypass
the scan. The retained run log and an explicitly derived summary passed the
corrected scanner against the full local environment (16 secret needles).
Those retained files are not recreated raw diagnostics. Logs:
`/tmp/almamesh-codex-final-native-mac-artifact-scan.log` and
`/tmp/almamesh-codex-final-native-mac-retained-scan.log`; retained directory:
`/tmp/almamesh-codex-final-native-mac-retained`.

The scanner-only correction does not change the application or memory sampler.
The final hosted Mac lane must rerun the full protocol and clear its complete
diagnostic artifacts before merge. Its green check cannot be replaced by the
local retained-log scan.

## Candidate PDF fixture correction

The first PR #333 Dagger run (`38173156241`, candidate `0078a19c`) failed the
synthetic maximal PDF assertion for `transits & timing`. The same test failed
locally before any correction. Its fixture still seeded predictive persistence
version 4; version 5 deliberately invalidates those older astronomy results.
The real computed-predictive PDF journey passed in that hosted run.

The fixture now imports the current persistence version and both synthetic
journeys require all four comprehensive report sections to be visible before
export. Existing downloaded-PDF content assertions remain unchanged. This
changes test data rather than application cache migration or report behavior.
The first candidate nightly (`38173157417`) was cancelled before the real-model
suites because it would encounter the same PDF failure. The corrected candidate
must pass a fresh nightly and the full PR workflows before merge.

The corrected local PDF gate passed 4/4, including the real no-hooks onboarding
and the complete synthetic download. Its yoga fixture also uses the current
`factor_type` contract and a supported `dignity` value. Strict all-E2E TypeScript
with the current ECMAScript library and scoped ESLint passed. The frontend gate
passed again with 5,963 tests plus four lint-contract checks. Logs:
`/tmp/almamesh-codex-pr333-pdf-schema-final.log`,
`/tmp/almamesh-codex-pr333-fixture-e2e-types-final.log` and
`/tmp/almamesh-codex-pr333-fixture-frontend-gate.log`.

The same first hosted candidate also exposed two CI integration mismatches.
The report-only embedder memory case inherited an iPhone context, which is now
minimal and deliberately never starts that Worker. The backend documentation
contract invoked Git inside the Git-free source export. Both failures are
retained; neither can be replaced by the earlier local frontend/backend pass.
Logs: `/tmp/almamesh-codex-pr333-linux-webkit-failure.log` and
`/tmp/almamesh-codex-pr333-backend-failure.log`.

The corrected memory cases passed 4/4 on the production build: full-tier desktop
semantic search, true-lite chat opening, and minimal/lite saved-answer keyword
hits followed by unmatched queries after reload. The full-tier report measured
202 MiB before and 297 MiB after semantic search (95 MiB model delta); it remains
report-only. Both constrained journeys observed no embedder/ORT Worker or
page-initiated model traffic. The original gated iPhone boot case and all memory
budgets remain unchanged. An initial new-test assertion incorrectly expected
Send to stay enabled after its composer cleared; it was replaced with the
existing turn-settlement control, and the canonical reload/search proof remains.
Red and green logs: `/tmp/almamesh-codex-pr333-memory-policy-green.log` and
`/tmp/almamesh-codex-pr333-memory-policy-final.log`.

The backend job now exports a sorted public-doc inventory from host Git after
checkout and before Dagger, recording that checkout's full SHA. Local checks
continue to use Git; a Git-free export must carry a valid manifest and never
falls back to walking all files. This preserves tracked ignored documentation
and excludes private/local notes from the README inventory. It does not change
Dagger's broader workspace selection rules. Manifest freshness comes from the
host export step; its recorded SHA is provenance rather than an independent
archive identity check.

Forty focused documentation tests passed in a real-docs Git-free archive with
Git absent from `PATH`. The complete local backend then passed inside Dagger
(1,214 tests, 98.46% coverage), and the final frontend gate passed again (5,963
tests plus four lint contracts). All 487 selected CI contracts and strict E2E
TypeScript passed. Logs: `/tmp/almamesh-codex-pr333-backend-dagger-green.log`,
`/tmp/almamesh-codex-pr333-final-frontend-gate.log`,
`/tmp/almamesh-codex-pr333-final-pure-contracts.log` and
`/tmp/almamesh-codex-pr333-final-e2e-types.log`.

## Hosted artifact metadata correction

The first hosted Mac run (`38173156264`, candidate `0078a19c`) was cancelled
when its replacement started. It completed five candidate Day measurements
(1359, 1450, 1365, 1386 and 1268 MiB, below the fresh 1388 + 250 MiB allowance)
and 26 of 28 travel cases. Export/import and boot recovery had not started.
These are partial results, not a complete hosted Mac pass.

Its always-run artifact scan mistook the public `GITHUB_RUN_ID` and
`GITHUB_WORKFLOW_SHA` for secrets and deleted its raw evidence. Playwright
records the public Actions run URL in its trace metadata; the checkout SHA is
also public provenance. The scanner now excludes only those two exact names.
Neighboring token/secret/control names still fail, including a secret whose
value happens to equal either public metadata value. Compressed trace ZIPs
remain scanned and real credential matches still delete the artifact directory.

Five focused regressions failed before this correction; all 59 scanner tests
then passed. Independent diff review found no material issue. The complete
frontend gate passed with 5,982 tests plus four lint contracts, and all 487
selected CI contracts passed again. Logs:
`/tmp/almamesh-codex-pr333-scanner-final-frontend-gate.log` and
`/tmp/almamesh-codex-pr333-scanner-final-contracts.log`.

The replacement Mac run (`38175621224`) and nightly (`38175631068`) were
cancelled early to avoid rerunning the known scanner failure. Neither supplies
release acceptance or live-provider proof. Application behavior and memory
limits are unchanged by this scanner correction. Fresh complete hosted checks,
including clearance and upload of the Mac diagnostics, remain required.

## Hosted Dagger pass and real-tool test correction

Dagger run `38176164704` passed all 12 product gates and its aggregate check on
candidate `22d89beae086cde962ba5ba967187b64825526ef`. The hosted backend passed
1,214 tests. The frontend passed 5,981 Vitest tests plus four lint contracts,
with its existing Node-SQLite-dependent fixture skip. All 17 Chromium
time-travel tests, two boot-retry cases and 11 engine parity checks ran and
passed. Four PDF exports passed. The final Chromium Day journey measured
218.02 MiB heap, 0.102 MiB revisit growth and 0.126 MiB city-lookup growth,
inside the unchanged limits. All four corrected device-tier memory cases ran;
the separate hook-only lookup retained its explicit no-hooks-build skip.

Nightly `38176165810` failed the new September 2017 real-provider test at its
first movement-result assertion. The provider emitted actual tool calls and
the movement returned `{ok: true, value: {status: "queued", action: "travel"}}`.
The test incorrectly expected an unwrapped result. Four earlier live tests
passed; the new test's today/return legs and the final no-real-skips guard did
not run. This does not establish complete live-provider acceptance.

The test now requires an object envelope with `ok === true`, rejects protocol
and domain errors, and then reads the object value. Provider-emitted IDs,
matching result names, three-call limit, exact period/lord summaries and all
movement/Today/Back UI assertions are preserved. The separately pregrounded
today facts keep their raw-result contract. The extracted old parser failed
21 regressions; all 28 now pass. The complete local frontend gate passed
6,010 tests plus four lint contracts, and strict E2E TypeScript passed.

This is a test-only correction. Fresh Dagger, complete native Mac and nightly
results on the corrected head remain required. Logs:
`/tmp/almamesh-codex-pr333-dagger-22d89be.log`,
`/tmp/almamesh-codex-pr333-nightly-22d89be.log`,
`/tmp/almamesh-codex-pr333-envelope-frontend-gate.log` and
`/tmp/almamesh-codex-pr333-envelope-e2e-types.log`. Completed job details:
`/tmp/almamesh-codex-pr333-dagger-22d89be-jobs/EVIDENCE.md`.

## Hosted timeout and native fatal investigation

On candidate `67addf6127761560dbf7f9dbd9b791998715d584`, nightly
`38178028884` passed the actual September 2017 → grounded today → tool return
journey in 52.5 seconds. Its executed final guard confirmed eight required
real-provider tests ran with none skipped. The opt-in local Ollama case was
explicitly exempt; this was not a skipped OpenRouter acceptance test.

Dagger `38178025125` passed 11 of 12 product gates. Both attempts reached the
unchanged 900-second time-travel command limit after 14/17 and 15/17 passing
cases, without assertion failures. The combined command is now two sequential
single-Worker commands. Browser-free Playwright collection confirms 9 + 8
cases, no overlap, and the identical original set of 17 test IDs. Each command
retains the 900-second watchdog and the job retains its 60-minute limit.

Native Mac `38178025014` is rejected. Five candidate Day/place samples peaked
at 1,366, 1,309, 1,431, 1,324 and 1,478 MiB, inside the freshly paired
1,308 + 250 = 1,558 MiB allowance. Travel completed 27/28; its iPhone 13
service-worker journey reached the final clean-console assertion with a real
Pyodide fatal `RuntimeError: Out of bounds memory access` in `__pyproxy_apply`.
The final visible March 2019 card and same-origin assertions had passed, which
does not identify which boot, computation or document produced the fatal.
Export/import reached 7/8 before the 45-minute whole-job timeout; boot recovery
did not run. The scanner then hit ENOENT during cancellation cleanup, and no
artifact was uploaded. Original per-run samples and provenance JSON cannot be
reconstructed from the surviving log. This is not evidence of RAM exhaustion,
physical Safari acceptance or a harmless error.

Three unmodified local reproductions and three instrumented reproductions
passed on the unchanged application build, with zero retries. The instrumented
runs saved 61 lifecycle events each, all nine journey phases, no fatal errors
and no boot retries. The observer preserves all original navigation, waits and
assertions, and labels the observed page URL as receipt-time context rather
than proof of the event's source document or Worker.

The audit also reproduced a separate containment defect with a fake Worker:
a fatal compute reply rejected one request but left the poisoned Worker usable.
The client now uses its existing Wasm-trap classifier to terminate once, reject
pending/future calls and clear deadlines. Ordinary Python, domain and network
errors remain request-local. Four new fatal regressions failed before the fix;
client/classifier/runtime suites then passed 95/95. The complete frontend gate
passed 6,020 tests plus four lint contracts, types, lint, production build and
public-route checks. Knip retained its documented diagnostics. This contains a
recognized fatal instance; it does not prevent or explain the hosted trap.

The new containment build then passed three native WebKit service-worker
journeys with diagnostics and both existing native boot-recovery cases, with
zero retries. The production build identity is `68e74f1fb9eb`, built at
`2026-10-11T22:47:03.770Z`. The generated diagnostic directories are ignored by
Git and explicitly excluded from local Dagger source inputs; a failing-before-
fix contract also checks that application and test source remain included.
These focused passes are not complete hosted Mac acceptance.

The Mac workflow now separates same-runner original/candidate memory
acceptance and complete functional acceptance into independent 45-minute jobs,
with zero retries. Its stable acceptance check requires both. All 28 travel,
eight portable-state and two boot-recovery cases are preserved. Evidence is
copied to a fresh private snapshot, then scanned and uploaded from that same
snapshot. Shell cleanup does not prove detached browser/ffmpeg quiescence;
interrupted source evidence may be incomplete. Missing cleanup markers, failed
copies and stale/symlink destinations fail closed. A real detached-writer
regression proves that continued source writes do not change the copied tree.
The full 12-file CI contract suite passed 517/517, and Bash syntax passed.
Complete final-head Dagger, Mac and nightly acceptance remains required; no
merge or deployment is established here.

Logs and receipts: `/tmp/almamesh-codex-pr333-mac-67addf6.log`,
`/tmp/almamesh-codex-pr333-journeys-67addf6-attempt2.clean.log`,
`/tmp/almamesh-codex-pr333-nightly-67addf6.log`,
`/tmp/almamesh-codex-pr333-shard-coverage.json`,
`/tmp/almamesh-codex-pr333-sw-repro.log`,
`/tmp/almamesh-codex-pr333-sw-diagnostic-repro.log`,
`/tmp/almamesh-codex-pr333-fatal-containment-frontend-gate.log` and
`/tmp/almamesh-codex-pr333-timeout-followup-contracts.log`.


## Minimal-container artifact test correction

Candidate `ba2837a26cd8c8ebc70ecd8d4b1339475d2d1cca` exposed four artifact
harness failures in hosted contracts `38183027018` (513 passed). The thin
Bun container deliberately has no copied scanner or installed `fflate`.
Its fallback `node` alias also dropped the detached fixture's eval argument;
`ps` was unavailable. These fixtures passed on the fully installed Mac and
therefore did not establish the container contract.

The detached fixture now uses the guaranteed current runtime and a native
process-group existence probe, with explicit spawn/exit diagnostics. Snapshot
copy/path/stability assertions stay in the thin contract. The four actual
finalizer/scanner CLI checks moved to the frontend suite, which already owns
the scanner and its locked dependencies. The workflow still scans the actual
snapshot before upload; no scanner bypass or test skip was added.

The original selected-source closure reproduced 132 passed / four failed in
the exact cached Bun image with network disabled. The corrected closure
passed 136/136; frontend scanner tests passed 63/63. These focused results do
not replace the complete gates or final-head hosted acceptance. Logs:
`/tmp/almamesh-codex-pr333-contracts-bun-closure-red.log`,
`/tmp/almamesh-codex-pr333-contracts-bun-closure-green.log` and
`/tmp/almamesh-codex-pr333-artifact-integration-green.log`.

## Hosted artifact metadata and completed local functional checks

On the same `ba2837a2` candidate, Dagger `38183027018` completed all eleven
other product gates successfully. The split Chromium time-travel commands ran
9/9 cases in 7.2 minutes and 8/8 in 5.6 minutes, within the unchanged
900-second command limits. The aggregate remains failed because of the four
container fixture failures above; this is not final-head release acceptance.

The native Mac memory job in `38183027014` completed its original-release
baseline validation and five candidate Day/place journeys. Candidate peaks
were 1,356, 1,353, 1,385, 1,306 and 1,341 MiB against 1,463 + 250 = 1,713 MiB.
Evidence finalization passed, but the scanner rejected the public
`GITHUB_ACTION` step identifier. Upload was skipped and the failed snapshot was
removed; the original individual baseline samples and provenance cannot be
recovered from the surviving log. This rejected job is not an artifact-backed
memory acceptance result.

The scanner now recognizes only the exact `GITHUB_ACTION` variable as public
runner metadata. Eight new regressions failed before that correction; all
77 scanner tests now pass. Plain and ZIP snapshots with the public step name
pass; the same value in `GITHUB_TOKEN`, similarly named token/secret variables
and an unrelated API key still fails and removes unsafe artifacts. No prefix
allowlist was added.

With these harness and metadata corrections, the complete local frontend
gate passed 6,038 tests plus four lint contracts, types, lint, build,
public-route checks and the production no-hooks check. Knip retained its
documented diagnostics. The actual Dagger contracts entrypoint also passed
517/517 in its selected-source Linux container and completed the Wrangler
deployment dry-run. The normal build was `80eac01dd855`, built at
`2026-10-11T23:27:27.854Z`.

The complete local native Mac functional lane on the `ba2837a2` application
passed 28/28 travel, 8/8 portable-state and 2/2 boot-recovery cases with zero
retries. Both service-worker diagnostic receipts contained 61 events, all nine
phases and no recorded errors. Its finalized snapshot passed the scanner.
These results do not cover the subsequent post-ready fatal recovery fix and
do not explain the earlier hosted Pyodide trap or establish physical iPhone
Safari acceptance.

Logs: `/tmp/almamesh-codex-pr333-journeys-ba2837a.log`,
`/tmp/almamesh-codex-pr333-mac-ba2837a-memory.log`,
`/tmp/almamesh-codex-pr333-github-action-scanner-red.log`,
`/tmp/almamesh-codex-pr333-github-action-scanner-green.log`,
`/tmp/almamesh-codex-pr333-action-final-frontend-gate.log`,
`/tmp/almamesh-codex-pr333-harness-final-dagger-contracts.log`,
`/tmp/almamesh-codex-pr333-local-functional-ba2837a.log` and
`/tmp/almamesh-codex-pr333-local-functional-ba2837a-scan.log`.

## Post-ready engine recovery

The next audit reproduced a recovery defect: fatal compute containment closed
the client, but the runtime retained its resolved engine and bootstrap promise.
Retry could therefore reuse the closed Worker. The same defect applied to
terminal client errors, unreadable messages and request deadlines.

The runtime now invalidates readiness and notifies the provider once for an
active terminal failure. Generation guards surround memo access and awaited
results, so retained references, cached calls and late failures cannot return
old results or dispose a replacement. Exact client terminal state handles
non-Wasm closure without classifying ordinary calculation/network errors as
fatal. Boot-time Wasm retry remains unchanged; failed calculations are not
automatically replayed.

The provider fences pending boot awaiters and disposes the old runtime before
an explicit shared recovery. Time-travel and Life Atlas Retry use the fresh
engine, while changed inputs and unmounted views cannot resume old requests.
The predictive retry gate releases after boot so an older long calculation
cannot block a new profile. Each submitted chat question lazily shares one
recovery across current, historical and placed-day tools; natal-only questions
do not reboot, and a failed recovery is not repeated within the same turn.

Failing regressions preceded these changes. Focused verification passed 151
browser runtime/client checks, 78 consumer checks, 34 provider checks and 120
chat/tool checks (overlapping suites, not additive totals). Independent source
review found no material integration bugs. The full native frontend gate
passed 6,099 tests plus four lint contracts. The actual Linux Dagger frontend
gate passed 6,098 tests plus four lint contracts, with one existing
`node:sqlite` fixture-identity test skipped because its Node lacks that builtin;
the native gate ran and passed that test. All 517 selected CI contracts passed.

The new browser regression injects one correlated terminal error after a real
engine boot. It requires an explicit Retry, a second real Worker, a newly
computed chart and March 2019 transits without a page reload. Browser execution
subsequently passed on the frozen recovery product: all 28 native travel,
eight portable-state and three boot cases passed with zero retries. The new
case passed in 22.5 seconds and verified same-document fresh-Worker recovery.
This run precedes the later derived-database teardown guard; complete final
source native/hosted acceptance remains pending. Its test-only correlated error
does not reproduce the hosted native crash or explain the Wasm trap's cause.

Logs: `/tmp/almamesh-codex-pr333-runtime-fatal-recovery-red.log`,
`/tmp/almamesh-codex-pr333-runtime-terminal-recovery-red.log`,
`/tmp/almamesh-codex-pr333-consumer-fatal-retry-red.log`,
`/tmp/almamesh-codex-pr333-predictive-recovery-liveness-red.log`,
`/tmp/almamesh-codex-provider-fatal-red.log`,
`/tmp/almamesh-codex-pr333-chat-fatal-retry-red.log`,
`/tmp/almamesh-codex-pr333-recovery-final-frontend-gate.log`,
`/tmp/almamesh-codex-pr333-recovery-final-dagger-frontend.log` and
`/tmp/almamesh-codex-pr333-recovery-final-contracts.log`. Browser log:
`/tmp/almamesh-codex-pr333-local-functional-recovery.log`.

## Additional rejected hosted results on ba2837a2

Nightly `38183033157` passed seven required real-provider cases, including the
new September 2017 → grounded today → tool return journey in 1.3 minutes. The
full-report case failed: run three's `guidance2` section reached its production
300,000 ms deadline. Separately, successful runs one's and two's technical
median was 271.5 words against the 273-word threshold. The timeout is excluded
from that median and does not explain the short result. The final none-skipped
guard did not execute. This is a failed acceptance run.

Native Mac functional `114599420607` completed travel with 26 passes and two
failures in 38 minutes: a desktop SQL Worker access-control page error during
reload, and an iPhone 15 viewport page crash before initial Life Atlas
readiness. Both service-worker lifecycle cases passed; no Pyodide out-of-bounds
fatal appears in the surviving log. Portable-state tests completed three
passes before the 45-minute job cancellation; boot recovery did not run.
Evidence finalization, scanning and upload succeeded. Neither the native
failures nor the timeout can be treated as acceptance. Diagnostics and the
report-model configuration require investigation before another release claim.

Logs: `/tmp/almamesh-codex-pr333-nightly-ba2837a.log` and
`/tmp/almamesh-codex-pr333-mac-functional-ba2837a.log`.

## Timeout separation and retained native diagnostics

The timeout layers are distinct: Dagger's browser-lane per-command watchdog is 900 seconds,
its gate runner is 45 minutes, and its hosted jobs are 60 minutes. Native Mac
jobs are 45 minutes. Nightly's job is 120 minutes; the full-report case has a
40-minute bound, each default report run has a 10-minute deadline, and production
report sections have a five-minute deadline. Predictive Worker requests have
their own three-minute application deadline. These limits were not raised.
Nightly uses direct commands rather than that browser-lane watchdog, so its
full-report test is not truncated after 900 seconds. The required Dagger
verdict job has a separate 20-minute limit.

The Mac workflow now schedules memory, travel and portable/boot as three
independent 45-minute jobs. Travel retains every one of its 28 cases; the
portable job retains all eight state cases and all three boot cases. Every
browser invocation still uses zero retries. The stable acceptance job requires
all three jobs to succeed, including rejecting cancelled or skipped lanes.
Memory retains five original boots followed by five candidate Day journeys on
the same host, without test hooks or a scalar baseline override. Local
`functional` remains the complete travel + portable + boot sequence.

This prevents travel consuming the portable/boot job's budget; it does not fix
or waive browser errors. Failing contracts preceded the split: 13 new failures
became 155 passing ingress contracts; 79 scanner checks passed. An independent
source review found no material issue. Hosted timing and complete final-head
acceptance remain pending.

The retained desktop trace maps the reload page error to the derived database's
top-level SQL Worker constructor. It occurred after reload began and before the
new document committed. The exact initiating lookup and pagehide timing were
not recorded. The opener has asynchronous epoch/lock gaps without a pagehide
guard; a regression and a guard are being prepared without relaxing the fatal
page-error assertion.

The iPhone 15 viewport crash preceded initial Life Atlas readiness and all
chat/provider requests. Its last sole observed WebContent process measured
1,019 MiB RSS just before disappearing (peak 1,024 MiB); the host reported 74%
free memory and no swap. These measurements do not identify the termination
cause or exclude a per-process limit. No native crash report or unified log was
retained in the uploaded snapshot. The last navigation requested canonical SQL
and EdgeProc workers, with no new chart Worker/Pyodide request afterward; this
does not establish a Pyodide cause. Native termination capture remains an
evidence gap.

The real full-report test also used the generic DeepSeek test model instead of
the production report model. Its default now imports `REPORT_ENGINE_MODEL`
(GPT-6 Luna), retaining the dedicated alternate-model override, all three full
runs, all nine sections, the production 300-second section deadline and all
length/cost/provider assertions. Safe section lifecycle metadata was added.
Failing model/diagnostic contracts preceded the correction: eight failures
became 31 passing contracts; the combined focused suite passed 49 checks.
The follow-up stdout regression reproduced missing hosted diagnostics with five
failures; 36 model/diagnostic contracts and 54 combined focused checks now pass.
Each run's `finally` emits at most 18 closed-allowlist metadata entries, including
failed runs, without report/chart/prompt/key/request/raw-error content.
This correction has not yet supplied a successful Luna acceptance run.

Logs: `/tmp/almamesh-codex-mac-three-lanes-red.log`,
`/tmp/almamesh-codex-mac-three-lanes-green.log`,
`/tmp/almamesh-codex-mac-three-lanes-scanner.log` and
`/tmp/almamesh-codex-pr333-report-model-default-red.log`.

## Derived SQL teardown guard

Thirteen failing regressions reproduced delayed-session teardown gaps. The app
now observes pagehide/pageshow before the first derived lookup, without eagerly
opening SQLite or reading the ledger. One listener pair per target tracks the
document generation; active sessions unsubscribe their cancellation callbacks
when finished. Hidden documents reject new lookups, and pageshow permits fresh
sessions without reviving abandoned work.

Checks immediately before the public SQL opener, before migration, after user
work and after connection close prevent late Worker creation and publication of
old results. Unadopted late handles still close, and ready handles retain the
existing rollback/close barrier. Reset generation, deletion and native-lock
semantics are unchanged. The public removal API uses OPFS directly and does not
create a Worker, so this change does not expand destructive-operation behavior.

All 24 owned session checks and 97 checks across seven related suites passed;
strict web types and scoped lint passed. Independent source review found no
material issue. This proves the tested lifetime guard; it does not establish
the unrecorded hosted pagehide timing or explain the separate iPhone page crash.
Complete gates and native checks on this final product remain pending.

The subsequent complete native frontend gate passed 6,128 tests plus four lint
contracts, strict types, lint, build, public-route verification and the check
that production scripts contain no boot-fault/test diagnostic hooks. Knip
retains its documented diagnostic backlog. Normal review build:
`e59cfce23f34`, built `2026-10-12T00:15:23.358Z`. The actual Linux Dagger
frontend gate then passed 6,127 tests plus four lint contracts, with the same
single existing `node:sqlite` fixture-identity skip described above. All build,
types, lint and production-route/hook checks passed there as well. Final native
and hosted acceptance remain pending.

Logs: `/tmp/almamesh-codex-derived-pagehide-red.log`,
`/tmp/almamesh-codex-derived-pagehide-expanded-red.log`,
`/tmp/almamesh-codex-derived-pagehide-final-boundary-red.log` and
`/tmp/almamesh-codex-derived-pagehide-final.log`. Complete gate:
`/tmp/almamesh-codex-pr333-final-source-frontend-gate.log`; Linux:
`/tmp/almamesh-codex-pr333-final-source-dagger-frontend.log`.

## Observable native collection and final harness checks

Each native job now has an explicit `always()` collection step before evidence
finalization, in addition to normal shell cleanup. A non-hidden
`native-collection-status.json` records missing/searchable roots, matched and
copied report counts, copy failures and unified-log success/error/timeout.
Collection is bounded to 32 considered reports, 16 MiB per report and 64 MiB
reserved reads; excluded reports receive explicit limit statuses. Fixed-size
reads reject changed/truncated files. Find calls have five-second limits and
the unified-log query has a 15-second limit; later attempts append logs rather
than erasing an earlier capture.

Diagnostic unavailability is recorded without changing product acceptance.
Failure to write the required manifest is fatal; browser failures, snapshot
finalization, scanning and upload retain their failure behavior. A hard runner
termination can still leave incomplete evidence. No native cause is inferred
from a missing report or a successful zero-report collection.

Nine initial collector regressions and three later copy-cap regressions failed
before their fixes. All 176 ingress contracts now pass. Root verification
passed all 557 selected contracts across 12 files and 79 actual scanner/CLI
checks. Tests use Bun's executable in the thin environment; the selected source
closure adds only the existing dependency-free crash-report helper. Bash
syntax, scoped lint and independent source review passed. Actual Linux
contracts and native collection remain pending at this point.

The first actual Linux contracts gate passed 556 checks but failed the TERM
fixture: Linux's `bash -c` function source was `environment`, so the test's
collector resolved its adjacent helper from the wrong directory. Its stderr
confirmed the missing module. The test now executes a physical extracted Bash
file with the exact helper beside it, matching actual lane invocation; the
143 exit, complete manifest and cleanup-marker assertions remain, with added
no-error/no-stderr checks. Production code is unchanged. The exact 45-file thin
closure on pinned Bun 1.3.5 reproduced red then passed the targeted case and all
176 ingress contracts without network, Node or `ps`. The full root Dagger
rerun passed all 557 selected checks and the deployment dry-run dependency.
Native collection and final native/memory acceptance remain pending.

Logs: `/tmp/almamesh-codex-pr333-native-collector-green.log`,
`/tmp/almamesh-codex-pr333-native-copy-caps-red.log`,
`/tmp/almamesh-codex-pr333-final-source-contracts.log` and
`/tmp/almamesh-codex-pr333-final-source-scanner.log`. Linux failure and fix:
`/tmp/almamesh-codex-pr333-final-source-dagger-contracts.log`,
`/tmp/almamesh-codex-pr333-native-term-thin-red.log` and
`/tmp/almamesh-codex-pr333-native-ingress-thin-green.log`. Full green Dagger:
`/tmp/almamesh-codex-pr333-final-source-dagger-contracts-green.log`.

## Complete final-source local native acceptance

The frozen product commit was `22f2a9478f3e65d264f6c377a48d8332ade45caa`.
The actual in-repository `all` script completed with exit zero, zero retries,
28/28 travel cases in 9.4 minutes, 8/8 portable-state cases in 5.0 minutes and
3/3 boot cases in 36.2 seconds. This includes the final SQL lifecycle guard and
the previously failing iPhone-viewport chat/tools and reload journeys.

The same-host original-release provenance records reference `8d10fbbb`,
measurement commit `22f2a947`, Playwright 1.63.0 and five boot peaks of 1031,
1042, 1049, 1037 and 1009 MiB. Five candidate production Day/place journeys
passed at 1085, 1104, 1086, 1064 and 1073 MiB. Candidate maximum growth is
55 MiB against the unchanged 250 MiB allowance, with no scalar override,
report-only mode or test hooks in those memory builds.

Both service-worker receipts contain 61 events across all nine phases and
completed bodies; their five console events each are informational. All three
reload scopes record no page errors or fatal diagnostics. The pinned-year
scope retains two matched old-document resource console rejections: a blob
request with a successful response/completion, then access-control and OPFS
asyncer messages before the new document committed. These are explicit scoped
exceptions, not a universally clean console or evidence that the earlier
hosted top-level Worker page error was harmless.

The post-ready test passed in 21.4 seconds. Its receipt records one deliberately
injected correlated error, termination of Worker 1, explicit Retry, two ready
generations, and Worker 2 calculating a chart, March 2019 and the viewer's
current day in the same document. No automatic retry was recorded. This
controlled error is not a reproduction or explanation of the native crashes.

Normal and independent native collection completed with both report roots
searched and unified logs collected. One report, `JetsamEvent-2026-10-11-174019.ips`,
identified only `stickersd` PID 82580 as killed for `per-process-limit`; that PID
does not occur in lane RSS samples. Other listed processes are a system
snapshot, not killed-process evidence. This report does not identify a lane
WebContent termination or establish the earlier crashes' cause.

The same finalized snapshot passed the artifact leak scanner (16 configured
secrets checked). Logs: `/tmp/almamesh-codex-pr333-final-native-all.log` and
`/tmp/almamesh-codex-pr333-final-native-all-scan.log`. Snapshot:
`frontend/apps/web/webkit-lane-evidence-all`. These are local Mac WebKit
results; physical iPhone Safari, broad restore/long-history memory and the
pre-existing aggregate settled RSS limit remain open. Hosted acceptance must
still bind to the final pushed head and actual synthetic checkout.

## Rejected hosted reference measurement on d42886cc

Candidate `d42886cc4137e306af723acf2c9db5896a2d1d04` contains product
`22f2a947` plus the two evidence-document updates. Its PR synthetic checkout
was `9d382828e7ad23e128612b6d330fa85791fd31ff`, with exact ordered parents
`8d10fbbb` and `d42886cc`; its tree matches the candidate tree.

[Dagger run 38189548221](https://github.com/gainratio/almamesh/actions/runs/38189548221)
passed all 12 gates and the required Dagger verdict on attempt 1. Actual hosted
logs record 557 contracts, 6,127 frontend tests plus the existing environment
skip and four lint contracts, and 1,214 backend tests.

[Mac run 38189548234](https://github.com/gainratio/almamesh/actions/runs/38189548234)
failed its memory lane on the **original release**, before any candidate Day
measurement. Four original onboarding runs passed (peaks 1117, 1308, 1102 and
1175 MiB); the fifth reached `CHART_GEN_001` and timed out waiting 300,000 ms
for the Dashboard. Its result is failed, `completed:false`, retry zero and
peak 1207 MiB. There is no final baseline provenance or candidate comparison;
this is neither a candidate memory-budget failure nor accepted memory proof.

The failed reference served exact original commit `8d10fbbb`, build
`df32701185cb`. Its trace has 609 HTTP 200 responses, no recorded failed
request/page error/page crash, and a sanitized typed-error event about one
second after Pyodide assets arrived. The original recovery card maps both
bootstrap and compute/persistence errors to this code. Worker response metadata
was absent, so the underlying cause cannot be distinguished from this trace.

Memory collection, finalization, scanning (51 configured secrets) and upload
passed. Both native report roots were searched; one earlier Bun disk-write
diagnostic records no action taken. Unified-log collection explicitly timed
out. This evidence does not establish a browser kill or memory exhaustion.
Memory artifact 11720812180 has SHA-256
`2404e98ac1b0e8d54c234a8c7a3ec09d438edac0a25469c2a486a5e1d194616c`.

The separate hosted portable job passed all eight state cases and three boot
recovery cases, with zero retries, finalization, scanning and upload successful.
Travel finished with 26 passed and two failed, zero retries, in 34.6 minutes,
before its 45-minute job limit. The desktop chat-tool contract page crashed on
Settings / Data; the iPhone service-worker journey crashed on the Dashboard.
The required aggregate correctly failed. Native reports were retained for both
WebContent processes: the desktop report records `EXC_BREAKPOINT`, a Foundation
termination and a WebCore Worker stack through WebAssembly runtime-error stack
generation; the iPhone report records `EXC_BAD_ACCESS` / `SIGSEGV` in a WebCore
Worker. Neither report establishes Jetsam or memory exhaustion. The precise
application operation and causal defect remain unproved. Travel artifact
11721554745 has SHA-256
`41962ea69ddda068884077543dc3c9755ad308954be1887f1ed3cdad26e657db`.

Logs: `/tmp/almamesh-codex-pr333-mac-d42886cc-memory.log`,
`/tmp/almamesh-codex-pr333-mac-d42886cc-portable.log` and
`/tmp/almamesh-codex-pr333-mac-d42886cc-travel.log`; finalized artifacts:
`/tmp/almamesh-codex-pr333-mac-d42886cc-artifacts`.

[Required nightly 38189557787](https://github.com/gainratio/almamesh/actions/runs/38189557787)
passed on exact `d42886cc`, attempt 1, in 35 minutes 36 seconds. Actual output
records 28 passed and one exempt local-Ollama skip; the required guard explicitly
reports eight real-provider tests executed and none skipped. The September
2017 / grounded today / tool-return case passed. The full report used the
production `REPORT_ENGINE_MODEL` default (`openai/gpt-6-luna`) through the
unchanged request path. All three report runs recorded nine starts and nine
completions, with no section errors, and completed their last sections at
33,016 / 34,809 / 34,609 ms. Existing nine-section HTTP-200 coverage, catalog-cost
bounds, request-shape assertions and both-voice word-median limits passed.
The hosted log does not export exact word counts, billed costs or upstream
provider names; those values cannot be claimed from this receipt. Actual
executed guard and safe lifecycle extraction are in
`/tmp/almamesh-codex-pr333-nightly-d42886c-safe-evidence.log`; full log:
`/tmp/almamesh-codex-pr333-nightly-d42886c.log`.

A bounded external Worker observer and early error-card failure are being
added to the memory test harness. They change neither original product code
nor retries, memory limits or deadlines. They close a diagnostic gap; they do
not establish an underlying engine fix or authorize accepting four samples.

The diagnostic harness passed red-to-green regressions (three failing
finalization cases, then 37/37 focused tests), independent review, strict web
and E2E types, and lint. A subsequent complete native frontend gate passed
6,165 tests plus four lint contracts, types, lint, build, public-route checks
and absence of application test hooks. Its log is
`/tmp/almamesh-codex-pr333-memory-diagnostics-frontend-gate.log`.
The observer forwards native Worker constructor/options, transferables,
return values and exceptions unchanged. It retains only bounded operation,
correlation, elapsed-time and closed error-category metadata. A two-second
snapshot deadline cannot prevent native RSS cleanup/reporting; evidence
attachment failures remain fatal and preserve an existing journey error.
Original-release and candidate tests use the same external observer. The
controlled native execution of this harness remains pending at this point.

## Controlled diagnostic execution on e2bde09

The test-harness source was frozen at
`e2bde09de74f6cddac3caa0f71877f34686dcbe5`, with product code unchanged from
`22f2a947`. The root ran the native `memory` lane once, without a supplied
baseline, hooks, report-only mode or retries. All five original-release boots
and five candidate Day/place journeys passed. Original peaks were 1044, 1058,
1016, 1035 and 1014 MiB; candidate peaks were 1078, 1067, 1090, 1080 and
1099 MiB. The comparison is 1099 against 1058 + the unchanged 250 MiB allowance.
Reference `8d10fbbb` served build `88b6bb44dbee`; recorded measurement source is
exact `e2bde09`. The machine was Darwin 27 arm64 with 64 GiB RAM.

All ten diagnostic snapshots were available, with zero observer failures,
unobserved Workers, pending correlations or recorded error replies. The bounded
latest-event buffer dropped 88 earlier events per original boot and 574 per
candidate journey, explicitly reported; it is not a full protocol history.
The native manifest is complete, both report roots were searched, unified-log
collection succeeded and one Bun diagnostic was retained. Independent
collection, finalization and the finalized-snapshot scan all exited zero
(16 configured secrets). Raw source and finalized snapshot remain in
`frontend/apps/web/webkit-lane-artifacts-memory` and
`frontend/apps/web/webkit-lane-evidence-memory`; logs are
`/tmp/almamesh-codex-pr333-memory-diagnostics-native.log`,
`/tmp/almamesh-codex-pr333-memory-diagnostics-finalization.log` and
`/tmp/almamesh-codex-pr333-memory-diagnostics-scan.log`.

This establishes that the external diagnostics run on actual original and
candidate production builds. It neither reproduces the hosted failures nor
establishes their resolution. The earlier complete `22f2a947` native artifacts
and finalized evidence were preserved, without deletion, at
`/tmp/almamesh-codex-pr333-22f2a947-native-all-artifacts` and
`/tmp/almamesh-codex-pr333-22f2a947-native-all-evidence` before the next full lane.

## Follow-up lifecycle and cache-session changes

Read-only native triage identified a source-reproducible lifecycle gap, without
establishing that it caused either hosted crash. In overlap boot mode, a held
sync or asset read could resume after pagehide and prewarm/boot the existing
Worker; a held boot could publish readiness after pagehide. Three regression
tests failed against the prior runtime. The fix suppresses idle prewarm while
tearing down and checks page liveness after sync, asset assembly and boot, plus
immediately before booting either a new or an already-created Worker. Existing
cancellation, cleanup, generation checks and explicit retry are reused.

The three cases passed after the fix, followed by 115 focused runtime,
boot-policy, fault and teardown tests; package types and lint passed. Independent
review found no material issue. The existing pagehide/pageshow boolean policy
is deliberately preserved; this does not add a durable runtime document fence.
Logs: `/tmp/almamesh-codex-runtime-pagehide-{red,green,focused,types,lint}.log`.
At this stage the complete frontend gate and native lane were pending; their
subsequent frozen-source results are recorded below.

The first-period lookup previously opened three derived SQL sessions for its
epoch fence, engine sweep and cache read, followed by a separate write session
after calculation. A regression observed all three precompute opens. The
combined lookup now performs those operations in one scoped session, closes
before engine calculation and retains a separately fenced write. It reuses
connection-taking helpers, avoiding a recursive acquisition of the same Web
Lock. Cache payload validation, exact engine/request keys, canonical and SQL
epoch checks, transactional purge, proof exclusion, city namespace and the
existing derived-database lifecycle/reset fences are preserved. This reduces
Worker startups; it does not establish a measured memory reduction or a native
crash fix.

Initial cache regressions produced five failures / 37 passes before the change,
then 69/69 passed across period cache, rows and derived-database tests. Final
review found a cancellation boundary introduced by waiting for the initial
lookup: an aborted later date could still open another SQL Worker. A new
regression failed with two lookups instead of one; one post-await cancellation
guard fixed it. The final focused suites passed 70/70, with web types, scoped
lint and whitespace checks passing. Independent review confirmed the scoped
session, close-before-compute, fenced-write and data-lifecycle invariants.
Logs: `/tmp/almamesh-codex-period-batching-{red,green,types,lint}.log` and
`/tmp/almamesh-codex-period-batching-cancel-{red,green,types,lint}.log`.

The first combined complete frontend gate passed 6,178 tests plus four lint
contracts and all type/lint/build/public-route/no-hooks checks. After the final
cancellation guard and regression, the root repeated that complete gate:
6,179 tests plus four lint contracts passed, along with types, lint, build,
public-route verification and absence of test hooks. Logs:
`/tmp/almamesh-codex-pr333-followup-frontend-gate.log` and
`/tmp/almamesh-codex-pr333-followup-final-frontend-gate.log`.
The subsequently completed frozen-source native full lane is recorded below.


## Frozen follow-up source ce2548a: complete local acceptance

Product source `ce2548a709202f836b6ca14c169705233229692f` includes the bounded
external diagnostics, lifecycle checks and batched period lookup described
above. The complete native `all` lane ran once with no supplied baseline,
no application hooks, no report-only mode and zero Playwright retries. The
root observed process exit zero, then independently collected native evidence,
finalized it and scanned that same immutable snapshot; all exited zero. The
scanner checked 16 configured secrets. No limits or retry settings were raised.

| Phase | Result |
| --- | --- |
| Original-release reference boots | 5/5; peaks 1039, 1043, 1047, 1014, 1050 MiB |
| Candidate Day/place journeys | 5/5; peaks 1088, 1061, 1094, 1101, 1070 MiB |
| Travel, tools, reload and service-worker journeys | 28/28; 9.3 minutes |
| Portable data and pin round trips | 8/8; 4.9 minutes |
| Boot and post-ready fresh-Worker recovery | 3/3; 36.1 seconds |
| Total | 49/49, zero retries |

Provenance records original release `8d10fbbb`, reference build `948e9bb45782`,
measurement commit exact `ce2548a`, Playwright 1.63.0 and Darwin 27 arm64 with
64 GiB RAM. The candidate maximum is 1101 MiB against the measured original
maximum of 1050 MiB plus the unchanged 250 MiB allowance. This paired acceptance
does not prove a reduction from an earlier candidate on a different run.

All ten bounded Worker snapshots were available, with zero instrumentation
failures, unobserved Workers, pending correlations or recorded error replies
in the retained events. Original boots dropped 88 older events each; candidate
journeys dropped 464 each. These are bounded latest-event snapshots, not full
protocol histories. Both service-worker receipts completed all nine phases,
with 57 events each and no recorded error-console, page-error or crash events.

Three reload scopes contain no fatal diagnostics or page errors. The pinned-year
scope retains one explicitly correlated old-document resource rejection; the
other two contain no exceptions. The console is therefore not universally
error-free. Post-ready recovery records one injected fatal request, termination
of Worker 1, explicit recovery into Worker 2, a chart and both historical and
current-day predictive results. No automatic post-ready retry occurred.

The final native manifest is complete: both diagnostic-report roots were
searched, zero matching reports were found and unified-log collection succeeded
without timeout. Raw evidence is in `frontend/apps/web/webkit-lane-artifacts`;
finalized evidence is in `frontend/apps/web/webkit-lane-evidence-all`. Root logs:
`/tmp/almamesh-codex-pr333-followup-native-all.log` and
`/tmp/almamesh-codex-pr333-followup-native-scan.log`.

The separate normal production review build identifies exact `ce2548a`, version
`0b4104ac4c36`, built at `2026-10-12T01:48:59.218Z`; public-route and no-hooks
checks passed. It is served locally on port 4297. Build log:
`/tmp/almamesh-codex-pr333-followup-review-build.log`.

This local pass permits submitting the frozen candidate for hosted acceptance.
Dagger, the complete native Mac workflow and the required real-provider nightly
must all pass on the final pushed head before protected merge. The rejected
`d42886cc` results remain evidence of actual prior failures. Native crash
causality, physical iPhone behavior and wider memory limitations remain open.


## Hosted follow-up 757cb225: rejected

The documentation-only release head `757cb2259c1225301d8ec1a13100ead14dae259a`
was tested against synthetic merge `76d058faa998c0ecede1f3669ef1cc20fd224579`,
whose parents are the original base and exact head and whose tree matches the
candidate. All runs were attempt 1; no blind rerun was accepted.

[Dagger 38195293391](https://github.com/gainratio/almamesh/actions/runs/38195293391)
passed all 12 gates and stable aggregate `114642648633`: 557 contracts; 6,178
frontend tests plus four lint contracts and the existing container-only skip;
1,214 backend tests / 98.46% coverage; PDF prerequisite plus four PDF cases;
all browser groups. Local native frontend had passed the skipped fixture.

[Mac 38195293416](https://github.com/gainratio/almamesh/actions/runs/38195293416)
failed its stable aggregate `114643307766`: 47/49 checks passed, zero retries.
Memory `114636489764` passed all five original and five candidate runs. Original
peaks were 1163, 1337, 1444, 1445 and 1336 MiB; candidate peaks were 1334, 1579,
1348, 1473 and 1379 MiB. Maximum 1579 is within baseline 1445 + unchanged 250.
Reference build `8cad9737b891`, Playwright 1.63.0, Darwin 24.6 arm64 / 7 GiB,
measurement source exact synthetic `76d058f`. Ten diagnostic snapshots were
available with zero instrumentation failures or retained error replies;
bounded events were dropped explicitly.

Portable/recovery `114636489906` passed 8 + 3 cases, including explicit fresh
Worker recovery. Travel `114636489828` passed 26/28 (31.0 minutes). The desktop
pinned-year reload recorded an outgoing SQL WASM request cancelled after reload
started, followed by seven fatal console diagnostics; none were exempted. The
desktop tool case had a native page crash on `/settings/data` during setup,
before tool execution. Its native WebContent `.ips` is retained. All iPhone
travel cases passed. This does not establish physical iPhone acceptance, OOM,
or the native crash cause.

All three snapshots finalized, scanned clean against 51 configured secrets and
uploaded. Native manifests are complete; portable and travel unified-log reads
explicitly timed out at 15 seconds. Artifact identities:

| Snapshot | Artifact | SHA-256 |
| --- | ---: | --- |
| Memory | 11723332873 | `ac728f6cb0edb14f149b3583612c75ddc08b2b6658fea3f3cfdd4764e79bccfe` |
| Portable | 11723632404 | `526dbb3d722766dbd397e5a4e7fd6f4c1001cfe2a1c261ad547983299d3a4f04` |
| Travel | 11724445671 | `ae5787286f3e91d3946555a54180ecdc1fdc79609fe86a45afa35e39d66c5ffd` |

[Required nightly 38195302977](https://github.com/gainratio/almamesh/actions/runs/38195302977)
failed: 21 passed, one failed, one exempt local-Ollama skip. The self-heal test
passed initial engine/chart, persisted repaired-model and retired-localStorage
assertions; `reading-section` did not appear within its unchanged 480000 ms
wait. Five subsequent suites containing six required real cases, the three
Luna full reports and the executed none-skipped guard did not run. No failure
artifact was uploaded. Logs cannot distinguish a held provider request, section
failure, invalid core summary or blocked persistence; no deadline increase or
product/model substitution is justified by this receipt.

Private logs and snapshots are under
`/tmp/almamesh-codex-pr333-{dagger,mac,nightly}-757cb225*`. Production remains
unchanged; there has been no merge or deployment. Further diagnosis is required.

## Stable runtime refresh and retained failure diagnostics

The next candidate upgrades Playwright to stable 1.64.0 (WebKit 2370 / 27.2)
and aligns the signed browser Skyfield wheel with the backend's locked 1.55.
See the [dependency audit](2026-10-11-runtime-dependency-audit.md) for upstream
versions, compatible Wasm constraints and the isolated preview comparison.
Both stable and preview passed the two previously failing journeys once;
neither reproduced the hosted crash. This is diagnostic evidence only.

New regression coverage requires the complete seven-message outgoing SQLite
Wasm cancellation chain, corroborated by the old Worker request, readable
Referer, exact cancelled request, same origin and pre-commit ordering. Partial,
incoming, unproven or page-error cases remain fatal. The retained hosted receipt
replays as seven explicitly classified messages with zero fatal messages; the
physical console/request receipt remains available. This classification is not
a product correction or a claim that the console was clean.

Public Playwright Worker/page events now produce bounded Node-side lifecycle
receipts that survive page loss, without injecting a Worker wrapper. Generic
Worker assets and unobserved nested Workers remain explicitly unattributed.
Fixture cleanup attempts diagnostic retention and profile removal even when
launch, watch or close fails, and preserves the original failure and video.
Real-reading diagnostics retain only closed endpoint categories, HTTP status,
elapsed lifecycle values and UI-presence bits; no keys, chart/prompt bodies or
raw provider errors enter those receipts. They preserve the original assertion
and the existing reading deadline. No provider failure is claimed fixed.

The backend gate passed 1219 tests / 98.46% coverage, Ruff, formatting, mypy
and complexity checks. Both backend and contract CI source closures include the
three exact browser configuration files required by the metadata regression;
177 ingress contracts pass after a missing-input regression failed. Complete
frontend, actual browser parity and native acceptance for this refreshed source
remain pending at this checkpoint. Budgets, retries and deadlines are unchanged.
