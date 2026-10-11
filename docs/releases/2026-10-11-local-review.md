# Local review before deployment

The user reviewed this local candidate and authorized the CI/CD release process on 11 October 2026. Hosted release checks, merge and deployment are pending. Production remains on release #331; the known limitations below remain visible and are not converted into passing checks.

## Start here

Open <http://127.0.0.1:4297> while the local preview is running. This is a production build without test hooks. Browser storage belongs to this local origin, so existing production data does not appear automatically.

Review build: `f74a4d090377`, built `2026-10-11T21:13:50.172Z` by the final frontend gate. The candidate is on `codex/iphone-time-travel`, based on release #331 (`8d10fbbb`). Reload an already-open local tab to load this candidate.

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
| Memory acceptance | Five Mac WebKit and five Chromium AI-off Day journeys passed. Chromium's maximum heap was 218.48 MiB against a 399.1 MiB limit. Ten final seeded WebKit chat journeys peaked at 1121 MiB, below the unchanged 1306 MiB allowance (earlier chat: 1326–1362 MiB). The final full export/import passed functionally but peaked at 1343 MiB in its source context (earlier: 1608 MiB); restore memory acceptance remains open. An earlier intermittent lookup failure remains unexplained, and the pre-existing aggregate cold-boot RSS limit remains exceeded. Live inference and long-history memory growth remain unverified. No memory budget has been raised. |
| Report evidence | Detection versus strength dependencies and confidence explanations are reviewed findings awaiting implementation. |
| Report layout/provenance | Chart clipping, orphan table headers, domain-house disclosure, unsupported cusp-time wording and provenance remain reviewed work. The supplied PDF has not been regenerated. |
| Disputed report claims | The Family SAV sum reconstructs correctly. Alleged collapsed planet/Sadbala/Sade Sati tables were not reproduced visually. Missing receipts are distinct from failed integrity verification. |
| Later feature batches | Reading immediately after the chart and Google Drive backup remain subsequent work. |

SQLite reduces the data copied into JavaScript when queries and caches are bounded. The engine, rendering, canonical application state and any local models still consume memory; moving storage to SQLite does not by itself eliminate those costs.

The private chart assessment is stored beside the supplied report and is not included in this repository. Passing a local checklist alone does not establish a deployment or a live-provider test. Final automated evidence is in [time-travel verification](2026-10-11-time-travel-evidence.md).
