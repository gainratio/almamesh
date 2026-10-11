# Time travel and deterministic chat verification — 11 October 2026

Status: the backend and frontend quality gates passed. Repeated constrained-device chat checks and the portable-state checks passed. On 11 October 2026 the user accepted local coherence and authorized the CI/CD release process. Hosted release verification is pending; cold-boot memory, wider restore memory, live inference and physical iPhone verification remain open. Nothing in this document establishes deployment of these changes.

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

## Current candidate checks

The candidate is on `codex/iphone-time-travel`, based on release #331 (`8d10fbbb`). The final local frontend gate rebuilt the normal review build as `2fa6ef951273` at `2026-10-11T19:36:31.267Z`; the separate hooked review build is `f2bddbf84f7c`, built at `2026-10-11T18:25:12.847Z`.

- Backend gate: 1,186 tests passed, 98.46% coverage; Ruff, formatting, mypy and complexity checks passed. Seven corrected slow-hit dates changed in reference fixtures; other fixture fields were unchanged.
- Final frontend gate: 5,877 tests plus four lint-contract checks passed, including the constrained-device memory policy, restore-generation and reload-diagnostic regressions. TypeScript, ESLint, production build, public-route prerender checks and absence of test hooks passed. The configured Knip report completed successfully but still reports unused-code/dependency diagnostics; it is not a clean unused-code result.
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

## Release preparation after local review

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
regressions pass; the complete native Mac lane is pending. Hosted Mac evidence
must be checked before merge: main's automatic deploy waits for Dagger, not the
parallel Mac workflow.

A new real-provider three-turn regression requires actual September 2017 tool
movement and calculated dasha facts, today's calculated facts while the historical
pin remains selected, then actual tool-driven Back to today. It checks provider
call IDs against successful local tool results and checks the final factual
summary against engine data. Scoped lint, E2E TypeScript and 22 real-model
contracts pass; live execution on the candidate is pending the hosted nightly.
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
assertions had passed. The test now classifies only that exact error when the
same previously requested worker has a matching cancelled Blob request before
commit, retaining the proof as an attachment. New-page, unmatched and all
uncaught page errors remain fatal. Twenty-nine classifier/wrapper regressions
passed after six initially failed. The complete lane must be rerun with this
test correction. The first run is retained at
`/tmp/almamesh-codex-final-native-mac-old-document-cancellation.log`.

After the reload-diagnostic correction, the full frontend gate passed again:
5,877 tests plus four lint-contract checks, with production build and public-route
verification. Log: `/tmp/almamesh-codex-prepush-final-frontend-gate.log`.
