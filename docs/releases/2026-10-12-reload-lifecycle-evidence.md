# Reload recovery and release follow-up

Release #333 merged as `dd2941c588c490ce1da26ba65859a6f982465d3b`, but its main checks failed. It has not deployed. Production remains release #331 (`8d10fbbb`). This follow-up requires fresh local, hosted, main and live verification before deployment.

## Observed failures

- Main Dagger run [38204589071](https://github.com/gainratio/almamesh/actions/runs/38204589071) failed the Chromium time-travel reload journey. The Dashboard button did not appear within the existing seven-minute test deadline. The failed container's screenshots were not exported, so the exact page state is unknown. An isolated local reproduction passed and does not clear the hosted failure.
- Main Mac run [38204589070](https://github.com/gainratio/almamesh/actions/runs/38204589070) passed 48 of 49 checks. One WebContent process crashed during post-restore engine startup, before the 18-month calculation. Its stack includes JavaScriptCore stack-overflow/JSPI handling. The report records a native crash, not an out-of-memory kill. System memory was available; the last sampled process RSS was 874 MiB, with a 986 MiB peak. An isolated local reproduction passed and does not establish a native fix.
- A deterministic local regression separately demonstrated that rejected canonical SQLite reads left the previous application indefinitely loading. This defect is fixed here; it has not been established as the cause of the hosted reload failure.
- Deployment's existing protected-main proof requires Dagger success. Native Mac runs independently and was not included in that decision. This follow-up also requires native acceptance for the exact main commit before building or uploading a release.
- The first local full Mac run of `51759a4` passed five original boots and five candidate memory journeys, then macOS WindowServer crashed during a Playwright capture. The OS reported possible IOSurface leakage or a system graphics-resource limit. Twenty-five later browser launches aborted in AppKit registration before creating a page. That run is rejected and its interrupted evidence retained. A fresh native persistent-browser launch and document evaluation passed on 12 October before starting a complete run in the restored graphical session. The graphics-resource leak's owner is unknown; this does not explain the separate hosted WebContent/JSC failure.

## Changes

- Canonical chart, profile and chat hydration report a failed read without marking data ready or replacing saved data. A later successful hydration can recover.
- Startup and profile migration require successful core hydration. The engine provider and application writers mount only after this barrier. Failed reads show a recovery card with a reload action.
- Local chart reads distinguish storage failure from a missing chart. Existing nonfatal interpretation recovery remains available.
- Synchronous Python bootstrap glue uses `runPython` after the existing asynchronous package installation. This avoids an unnecessary JSPI call; it does not disable JSPI or establish the native crash's cause or resolution.
- The reload journey retains bounded diagnostic metadata and first-attempt failure traces. Hosted browser journeys export a scanned snapshot, then enforce the original exit status. Missing or invalid evidence fails closed. Existing assertions, retries and time/memory budgets remain unchanged.
- Production delivery waits for the exact main/push native Mac workflow, its current attempt, all three native lanes and their aggregate check. It validates the jobs, check suite and check runs, then refreshes the run identity. Pending evidence polls within the existing bound; failed or mismatched evidence rejects delivery. The check runs before building and again immediately before upload, with a fresh container nonce each time. The deployment function itself opts out of Dagger function caching. Superseded releases still exit before this check. Dagger's existing protected-main, source, provider and live verification remain required.

## Verification

| Check | Result |
| --- | --- |
| Regression tests before changes | Failed core hydration, failed startup ordering and failed actual-browser storage recovery reproduced |
| Complete frontend quality gate | Passed: 6,333 unit tests, four lint contracts, types, lint, dependency usage and production build/public-route checks |
| Dagger module schema | Passed after the final uncached deployment annotation; evidence export and native-guard wiring load successfully |
| Complete repository contracts | Passed: 674 pure contracts and five actual Dagger CLI/container contracts, including the compiled credential-free Pages dry-run |
| Actual browser storage recovery | Passed in Chromium and native Mac WebKit, zero retries; recovery and retained-chart screenshots inspected |
| Real engine parity | Passed: 11/11 checks, including predictive and Moon-window reference comparisons, clean console and same-origin-only engine traffic |
| Complete native Mac lane | Passed on product commit `51759a4`: 50/50 checks, zero test retries (five original boots, five candidate memory journeys, 28 travel, eight export/import and four boot/storage recovery). Paired baseline 1,069 MiB; maximum candidate WebContent RSS 1,135 MiB (+66 MiB, below the unchanged +250 MiB allowance). Evidence finalized after normal cleanup and passed the artifact leak scan |
| Production native-check barrier | Four orchestration regressions cover failed/pending checks before building, superseded releases, and a newer failure before upload. All 46 HTTP-program fixtures pass; pending check-run propagation is covered. A fresh read-only GitHub API execution rejects the failed main commit `dd2941c5`. A failing-then-passing contract covers uncached deployment invocation |
| Final-head hosted Dagger, Mac and real-model nightly | Pending |
| Protected main checks, deploy and live journeys | Pending |

The local Mac and parity builds use product commit `51759a4`; its frontend tree is `b8d4e3e9049671280a71c61537a11bf79851da2d`. Subsequent changes affect release orchestration, its tests and this evidence document. Fresh hosted verification of the final candidate remains required. Native collection found no matching crash reports during the completed local run. Unified-log collection hit its fixed buffer bound (`ENOBUFS`); that diagnostic limitation is recorded in the finalized manifest.

No physical iPhone acceptance or native crash resolution is claimed. Long-history chat memory, aggregate cold-boot memory and wider restore memory remain open. The private report assessments and later reading/backup batches remain separate work.
