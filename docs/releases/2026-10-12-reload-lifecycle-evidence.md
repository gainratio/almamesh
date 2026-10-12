# Reload recovery and release follow-up

Release #333 merged as `dd2941c588c490ce1da26ba65859a6f982465d3b`, but its main checks failed. It has not deployed. Production remains release #331 (`8d10fbbb`). This follow-up requires fresh local, hosted, main and live verification before deployment.

## Observed failures

- Main Dagger run [38204589071](https://github.com/gainratio/almamesh/actions/runs/38204589071) failed the Chromium time-travel reload journey. The Dashboard button did not appear within the existing seven-minute test deadline. The failed container's screenshots were not exported, so the exact page state is unknown. An isolated local reproduction passed and does not clear the hosted failure.
- Main Mac run [38204589070](https://github.com/gainratio/almamesh/actions/runs/38204589070) passed 48 of 49 checks. One WebContent process crashed during post-restore engine startup, before the 18-month calculation. Its stack includes JavaScriptCore stack-overflow/JSPI handling. The report records a native crash, not an out-of-memory kill. System memory was available; the last sampled process RSS was 874 MiB, with a 986 MiB peak. An isolated local reproduction passed and does not establish a native fix.
- A deterministic local regression separately demonstrated that rejected canonical SQLite reads left the previous application indefinitely loading. This defect is fixed here; it has not been established as the cause of the hosted reload failure.

## Changes

- Canonical chart, profile and chat hydration report a failed read without marking data ready or replacing saved data. A later successful hydration can recover.
- Startup and profile migration require successful core hydration. The engine provider and application writers mount only after this barrier. Failed reads show a recovery card with a reload action.
- Local chart reads distinguish storage failure from a missing chart. Existing nonfatal interpretation recovery remains available.
- Synchronous Python bootstrap glue uses `runPython` after the existing asynchronous package installation. This avoids an unnecessary JSPI call; it does not disable JSPI or establish the native crash's cause or resolution.
- The reload journey retains bounded diagnostic metadata and first-attempt failure traces. Hosted browser journeys export a scanned snapshot, then enforce the original exit status. Missing or invalid evidence fails closed. Existing assertions, retries and time/memory budgets remain unchanged.

## Verification

| Check | Result |
| --- | --- |
| Regression tests before changes | Failed core hydration, failed startup ordering and failed actual-browser storage recovery reproduced |
| Complete frontend quality gate | Passed: 6,333 unit tests, four lint contracts, types, lint, dependency usage and production build/public-route checks |
| Dagger module schema | Passed; the evidence export function is exposed |
| Complete repository contracts | Pending |
| Actual browser storage recovery | Passed in Chromium and native Mac WebKit, zero retries; recovery and retained-chart screenshots inspected |
| Real engine parity | Passed: 11/11 checks, including predictive and Moon-window reference comparisons, clean console and same-origin-only engine traffic |
| Complete native Mac lane | Pending on this candidate; original-release paired memory baseline and zero retries required |
| Final-head hosted Dagger, Mac and real-model nightly | Pending |
| Protected main checks, deploy and live journeys | Pending |

No physical iPhone acceptance or native crash resolution is claimed. Long-history chat memory, aggregate cold-boot memory and wider restore memory remain open. The private report assessments and later reading/backup batches remain separate work.
