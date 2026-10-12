# Local review before deployment

The user authorized the CI/CD release process on 11 October 2026. PR #333 passed its final-head hosted checks and merged as `dd2941c588c490ce1da26ba65859a6f982465d3b`, but main subsequently failed Chromium reload and native Mac startup checks. Deployment remains blocked and production remains release #331. The [reload recovery follow-up](2026-10-12-reload-lifecycle-evidence.md) records the failures, changes and fresh verification required. The local preview and measurements below describe the earlier candidate and do not clear the follow-up.

## Start here

Open <http://127.0.0.1:4297> while the local preview is running. This is a production build without test hooks. Browser storage belongs to this local origin, so existing production data does not appear automatically.

Review build: `6caf4018313f`, built `2026-10-12T03:54:39.247Z`, with exact source `46a0dab798d1e508d4cfa8878b57516fb3e249e6`. The candidate is on `codex/iphone-time-travel`, based on release #331 (`8d10fbbb`). Reload an already-open local tab to load this candidate. The browser Skyfield wheel now matches backend 1.55; acceptance uses stable Playwright 1.64 / WebKit 2370. Follow-up lifecycle checks suppress stale boot work after pagehide; batched cache lookups use one scoped precompute SQL session. The prior hosted native failures remain retained, and release awaits complete final-head hosted checks.

Use **Settings → Data** to import an encrypted `.almamesh` backup, or create a test profile. Configure AI locally to exercise a real provider; time travel itself works without AI. Never paste keys into a test report or issue.

The disclosure in **Settings → AI** applies: chart and period facts can reveal a birth date, and life-event text is sent as written to the selected provider.

## User-facing checklist

| Check | Expected behavior |
| --- | --- |
| Month travel | Choose September 2017. Dashboard shows that period's dashas and transits. |
| Historical chat | Ask about a difficult time in the selected month. Chat receives deterministic timing facts before inference, uses them in its interpretation, and asks what occurred instead of inventing an event. |
| Unpinned dated chat | In an ordinary thread, ask about one explicit month and year. Its facts come from that period. Ambiguous dates prompt clarification. |
| Today in a historical thread | Ask `outlook today?`, then `What are my transits today, October 11?` with the actual current date. The answer uses the current day; the displayed historical pin remains until an explicit movement. |
| Day and place | Pick a day and a city. Change the day, then revisit the first day. Both dashas and transits remain available. Try another city too. |
| Chat movement | Ask chat to take you to a month, or to a day and place. After a successful saved answer, the Dashboard and chat agree on the selected moment. |
| Back to today | Return using the Dashboard, chat banner, and chat tool. The historical banner disappears and today's Life Atlas remains available. |
| Slow save and selection | Switch threads or profiles while a movement is saving. The old action must not pull you back or move the newly selected profile. |
| Place failure | A failed local search offers Retry; it does not falsely claim the city is absent. |
| Profile isolation | Use two profiles with different charts. Timing, places and chat stay associated with the active profile. |
| Chat recall | Search for a distinctive word from a saved conversation. Constrained devices use keywords; full devices retain semantic recall. Deleted conversations and other profiles must not appear. |
| Backup | Export, import in a fresh browser context, and compare profiles, charts, chats and pins. Recomputable period rows do not travel in the backup. |
| Report timing | Newly computed conjunctions and returns must be genuine contacts. Previously cached predictive results are recomputed after this update. |

Record the browser/device, steps, expected result and actual result for any failure. A Mac WebKit emulation pass does not establish physical iPhone Safari acceptance.

## Fixed and remaining scope

| Area | Candidate status |
| --- | --- |
| Deterministic circular contacts | Corrected opposition/conjunction selection for all charts; backend regressions and reference fixtures updated. |
| Time travel and chat | Implemented; final candidate browser checks are recorded in the companion evidence document. |
| Bounded storage | City reference data and reusable period skies use derived SQLite; one period is retained in the JavaScript memo. |
| Optional semantic recall model | Minimal and lite devices use bounded keyword recall from canonical chat without starting MiniLM or its vector Worker. Full devices retain semantic recall. Deferred rebuild markers remain available for a later capable device. Interpretation AI remains available. Ten final WebKit chat runs passed and requested no local model files. |
| Astronomy resources | Explicit ownership/cleanup implemented. This reduces retained kernels; it does not prove the cause of previous Safari crashes. |
| Memory acceptance | Refreshed paired acceptance: five original boots peaked at 1045 MiB and five candidate Day/place journeys at 1152 MiB, a +107 MiB increment within the unchanged +250 MiB allowance. All 49 native checks passed on stable Playwright 1.64. Earlier measurements, restore-memory limitations and rejected hosted runs remain in the companion evidence document. Wider restore memory acceptance, aggregate cold-boot RSS, live inference and long-history growth remain open. No memory budget has been raised, and the native crash cause is not established. |
| Report evidence | Detection versus strength dependencies and confidence explanations are reviewed findings awaiting implementation. |
| Report layout/provenance | Chart clipping, orphan table headers, domain-house disclosure, unsupported cusp-time wording and provenance remain reviewed work. The supplied PDF has not been regenerated. |
| Disputed report claims | The Family SAV sum reconstructs correctly. Alleged collapsed planet/Sadbala/Sade Sati tables were not reproduced visually. Missing receipts are distinct from failed integrity verification. |
| Later feature batches | Reading immediately after the chart and Google Drive backup remain subsequent work. |

SQLite reduces the data copied into JavaScript when queries and caches are bounded. The engine, rendering, canonical application state and any local models still consume memory; moving storage to SQLite does not by itself eliminate those costs.

The private chart assessment is stored beside the supplied report and is not included in this repository. Passing a local checklist alone does not establish a deployment or a live-provider test. Final automated evidence is in [time-travel verification](2026-10-11-time-travel-evidence.md).
