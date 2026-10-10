# Time travel you can find: Dashboard entry, no-AI view, phone parity, chat tool

Date: 2026-10-10. Status: design approved by the owner ("ok to all"). Builds on
`2026-10-08-time-travel-design.md` (steps A–D, shipped).

## TL;DR

Time travel works, but almost nobody can reach it. The only way in is a ⏳ icon
inside the chat composer. That icon is hidden when AI is off, and on a phone it
has no label. On iPhone and Safari the Day tab and "Where?" are switched off.

We fix that in four PRs, merged in this order:

| # | PR | What the user gets |
|---|----|--------------------|
| 1 | Dashboard "Time travel" button | A labelled button in the Dashboard header, on every screen width, that opens the existing sheet. |
| 2 | Works without AI | Picking a moment shows that moment's dasha and transits on the Dashboard, computed on the device. No AI needed. |
| 3 | Full parity on iPhone and Safari | Day and "Where?" on every tier. Memory stays bounded because city rows and day results live in SQLite on OPFS, not in JS memory. CI fails if a memory budget is exceeded. |
| 4 | Chat `time_travel` tool | "Take me to March 2019" moves the thread and banner through the same code as the sheet. The model never sees coordinates. |

## Why

The owner could not find time travel on his own phone on 2026-10-10. Verified
causes, all on `origin/main` at `821bd6e8`:

| Finding | Where |
|---------|-------|
| The only entry point is a composer button, testid `time-travel-button`. | `frontend/apps/web/src/components/features/chat/ChatPanel.tsx:293` |
| It renders only inside the AI branch. With no AI the composer is replaced by the Connect-AI note (`chat-connect-ai`), so there is no button at all. | `ChatPanel.tsx:280` |
| On phones the label is `hidden sm:inline`, leaving a bare ⏳. | `ChatPanel.tsx:298` |
| Nothing on the Dashboard links to it. The header's "Generate/Refresh current timeline" (`generate-timeline` / `regenerate-timeline`) is unrelated and disabled without AI. | `frontend/apps/web/src/pages/Dashboard.tsx:764-787` |
| Minimal (all iOS) and lite (unknown memory, e.g. desktop Safari) set `periodSkyComputeAllowed: false`, which hides the Day tab and "Where?". | `frontend/packages/browser/src/deviceTier.ts:54/63/72`, `TimeTravelSheet.tsx:65` |
| `resolve_place` and every place read are full-tier only. | `frontend/apps/web/src/lib/chatToolset.ts:159,181` |
| `get_timing` can read any date, but no tool moves the thread or the pin. Pinning happens only in the sheet, through `useChatThread.pin/repin`. | `lib/timingTool.ts`, `hooks/useChatThread.ts:442-455` |

A feature you cannot reach is a broken feature. And a feature that exists only
for people who connected an AI contradicts the app's promise that the chart is
pure calculation and AI is optional.

## Design

### One code path for "travel to a moment"

Today three things move a pin: the sheet's Go, the banner's Change, and Back to
today. They call `pin`, `repin` and `backToToday` from `useChatThread`, which
write through `lib/timeTravelThreads.ts`. After this work there is a fourth
caller (the chat tool) and a second surface (the Dashboard). So we add one seam
first, in PR 1, and route everything through it:

```ts
// frontend/apps/web/src/lib/timeTravel.ts (new)
export interface TravelRequest {
  readonly asOf: ChatThreadAsOf;          // existing type, shared-types/src/chat.ts
  readonly source: 'dashboard-sheet' | 'chat-sheet' | 'chat-tool';
}
export interface TimeTravelController {
  readonly moment: ChatThreadAsOf | undefined;   // what the Dashboard shows
  travel(request: TravelRequest): Promise<void>; // saved before it resolves (Ruling 12)
  backToToday(): Promise<void>;
}
export function useTimeTravel(profileId: string | null, chartId: string | null): TimeTravelController;
```

`travel` does, in order:

1. Validates with the existing helpers (`endsBeforeBirthYear`, `asOfFromDraft`
   rules). A before-birth or malformed moment is rejected, never clamped.
2. Sets the Dashboard moment (a small in-memory Zustand slice,
   `useTimeTravelStore`, keyed by profile).
3. If AI is configured, pins chat too: `startPinnedThread` when the active
   thread is unpinned, `repinThread` when it is pinned. Same functions as today,
   so a failed save still rolls back and rethrows.

The Dashboard moment is view state, not user data, so it is not persisted (see
open question 1). The chat pin stays where it is today: on the thread, in the
SQLite-backed chat store, exported with the thread.

### PR 1 — Dashboard "Time travel" button

- New button in the Dashboard header row, immediately before
  `generate-timeline` / `regenerate-timeline` (`Dashboard.tsx` ~line 764).
  Testid `dashboard-time-travel-button`. ⏳ icon plus the text "Time travel"
  (`dashboard:actions.time_travel`, en/es/pt), visible at every width. No
  `hidden sm:inline`.
- Same classes as its neighbours, which already carry `min-h-11 min-w-11`
  (44 px). The test measures the rendered box, not the class name.
- Enabled whenever a chart exists. It does not depend on `aiConfigured`.
- Opens the existing `TimeTravelSheet`. The sheet is `absolute inset-x-0
  bottom-0`, positioned inside the chat panel. On the Dashboard it is mounted in
  a fixed bottom-sheet overlay (`DashboardTimeTravelSheet`, a thin wrapper:
  `fixed inset-0` scrim + `role="dialog"` is kept on the sheet itself). The
  sheet's focus trap and return-focus behaviour are reused unchanged.
- The chat composer's `time-travel-button` gets its label back on phones (drop
  `hidden sm:inline`) so the two entry points read the same.
- With AI off, Go in PR 1 sets the moment and shows the banner on the Dashboard
  (`dashboard-time-travel-banner`, reusing `TimeTravelBanner` with a new
  `testIdPrefix` prop). The moment card arrives in PR 2; PR 1 shows the banner
  only, so PR 1 must not ship to users alone if the banner promises content.
  Rule: PR 1 and PR 2 deploy in the same release (open question 2).

Acceptance:

| Check | Evidence |
|-------|----------|
| Button visible with its text label at 390×844 (iPhone 15) and 1280×800. | Playwright `toBeVisible` + `toHaveText`, screenshots |
| Box ≥ 44×44 CSS px on iPhone 15. | `boundingBox()` assertion |
| Visible and enabled with AI off. | e2e with no AI configured |
| Opens the sheet; Esc and Cancel return focus to the button. | e2e + unit |
| With AI on, Go also opens a pinned chat thread (existing `pin`). | e2e (stubbed AI) |

Claim touched: **"Time travel is one tap away on every device."** (New claim,
added to the README feature list in this PR.)

### PR 2 — Works without AI

The Dashboard shows a "moment card" under the banner while a moment is set.

| Element | Testid | Source |
|---------|--------|--------|
| Banner: "Time travel · {period} · Change · Back to today" | `dashboard-time-travel-banner`, `-change`, `-back` | `TimeTravelBanner` + `formatPinLabel` |
| Maha and antar dasha at the moment | `time-travel-moment-dasha` | `selectDashasForPeriod` over the natal chart's dasha list (pure selection; no new astrology in TS) |
| Transits for the moment | `time-travel-moment-transits` | The period-sky payload from `periodSkyCache()` via `createPeriodChartLoader`, trimmed with `restrictTransitsToPeriod`, rendered with the existing `TransitsPanel` gochara table |
| Progress while the engine runs (~30 s) | `time-travel-moment-working` | The same "Working out the sky for {period}…" string chat uses |
| Device can't compute the sky yet (minimal/lite until PR 3) | `time-travel-moment-dashas-only` | Uses `DEVICE_DASHAS_ONLY_NOTE` wording |

Rules:

- No new engine math. Dasha selection and transit trimming already exist in
  `@almamesh/llm` and are pure; importing them does not load or call any AI.
  (`TimeTravelSheet` already imports `endsBeforeBirthYear` from there.)
- The period compute goes through `periodSkyCache()` only. It must never touch
  `usePredictiveStore`, which holds today's one Life Atlas result
  (`lib/periodSky.ts` header explains why).
- While a moment is set, today's sections (Life Atlas, Sky & Timing link) get a
  small "Today" label so nobody mistakes them for the moment (open question 3).
- Back to today clears the moment and, with AI on, calls the existing
  `backToToday`.

Acceptance:

| Check | Evidence |
|-------|----------|
| AI off, desktop Chromium: pick March 2019, see the maha/antar that the engine's dasha list gives for that month, and the transits table. | e2e with a synthetic native whose dasha boundaries are known; screenshot |
| AI off, iPhone 15 WebKit (still minimal tier here): dashas show, transits show the dashas-only note. | macOS WebKit lane; screenshot |
| Change reopens the sheet with the current moment; Back to today removes banner and card. | e2e |
| No request leaves the app origin during the journey, service worker included. | Extend `e2e/time-travel.spec.ts:1026` (`@sw nothing leaves the app origin`) to the Dashboard journey |
| Today's Life Atlas result is not evicted by a moment compute. | unit on `periodSky` + e2e: Life Atlas shows instantly after Back to today |

Claim touched: **"The chart is pure calculation; AI is optional."** and
**"Nothing leaves your browser with AI off."**

### PR 3 — Full parity on iPhone and Safari

Turn on Day and "Where?" on every tier, and keep memory bounded with SQLite.

What changes:

1. `deviceTier.ts`: `periodSkyComputeAllowed` becomes `true` on `minimal` and
   `lite`. The flag stays (it is the test seam), but no tier hides features.
2. **City list in SQLite.** Today the first lookup parses the 2 MB
   `src/data/cities.min.json` into JS rows (gated at ≤ 48 MiB heap growth,
   `e2e/memoryBudget.ts`, `PLACE_LOOKUP_HEAP_GROWTH_MIB`). Instead, the rows go
   into a `cities` table in the app's SQLite database on OPFS, with an index on
   the normalised name (FTS5 if the edgeproc-browser build has it; see open
   question 5). Lookups become SQL queries. JS holds only the ≤ 5 candidates
   (`PLACE_CANDIDATE_LIMIT`). The import runs once per city-list hash, in
   batches, so its peak is a batch, not the whole file.
3. **Per-day period-sky results in SQLite.** A `period_sky` table keyed by
   `(engine manifest hash, natal identity, reference instant, place key)`.
   Read before computing; write after. The engine memo's `retention: 'period'`
   pool (`periodSkyCacheSize` 5/3/1) drops to 1 on every tier, because the
   durable copy is in SQLite.
   - Payloads carry strength receipts signed with a per-boot key, which must
     never be durable (`engineMemo.ts` header). Rows are written through the
     same `withoutBootProof` strip the predictive store uses. A test forges a
     row with a receipt and expects the write to refuse.
   - A new engine bundle hash makes old rows unreadable by key, and a startup
     sweep deletes them.
   - Rows are derived personal data. Profile delete, reset, and restore purge
     them through `lib/profileDataLifecycle.ts`. They are not exported (they
     are recomputable); `portable-invariants.spec.ts` lists the table as
     "cache, not exported" so the round-trip invariant stays honest.
4. SQLite is owned by edgeproc-browser (`@gainratio/browser/sqlite`). Its page
   cache is already sized per tier (`memoryProfile.ts`: 64 / 16 / 4 MiB for
   full / lite / minimal). We add no second SQLite runtime and no in-memory
   fallback. If OPFS is refused, the app already shows the storage block screen.
   No IndexedDB, no localStorage.
5. `chatToolset.ts:159,181`: `resolve_place`, `placeFromRef` and
   `loadMoonWindow` are registered on every tier.

Honest limit. SQLite bounds what we **keep**. It does not bound what **one
engine run** allocates. Step A measured one period compute growing the
page+workers heap by ~165 MiB (to 425 lite / 419 minimal, `deviceTier.ts:37-41`),
and the Pyodide wasm heap does not shrink. Retained payloads are only ~60 KB
each. So the real risk on iPhone is the peak of the first Day compute, not the
cache. The plan:

- Measure that peak first (Task 1 of PR 3, below).
- If it fits the budget: ship.
- If it does not: PR 3 adds a slim Python entry, `compute_period_sky` (transits
  + dasha only; no 16 vargas, Shadbala or Ashtakavarga), with a golden
  CPython==Pyodide parity fixture, and the Dashboard and `get_timing` use it for
  periods. That becomes PR 3a, and PR 3b turns the tiers on. We do not raise the
  budget to get a run green.

Contract reversals (tests that assert the old restriction and must be
inverted, not deleted; the PR says so loudly):

| Test | Today it asserts | After |
|------|------------------|-------|
| `e2e/time-travel.spec.ts:886` `@iphone offers Month and Year…` | no Day tab on iPhone | Day tab + place on iPhone |
| `e2e/time-travel.spec.ts:950` `@safari no Day pin on the lite tier` | no Day on lite | Day pin works on lite |
| `packages/browser/src/__tests__/deviceTier.test.ts` | `periodSkyComputeAllowed` false on minimal/lite | true on all tiers |
| `lib/__tests__/chatToolset*.test.ts` | lite registers no `resolve_place` | registered on every tier |
| Plan Inc C Ruling 3 ("the city list never loads on a weak device") | city data absent on weak devices | city rows in SQLite, read by query |

`e2e/memory-budget.e2e.spec.ts:316` ("opening chat never requests the city
list") stays true: opening chat still loads nothing; only a lookup does.

Acceptance:

| Check | Evidence |
|-------|----------|
| iPhone 15 WebKit (minimal): Day + Bogotá pin shows dasha and transits on the Dashboard; chat answers with the place's Moon rows. | macOS WebKit lane, screenshots, clean console |
| Desktop Safari (lite): same journey. | macOS WebKit lane |
| Second visit to the same day reads SQLite, no engine call. | e2e counts engine calls via the existing runtime observability hook |
| Memory budgets below hold. | budget gate, red run attached |
| No IndexedDB database is created; no in-memory SQLite. | existing `verify-webkit-engine.mjs` checks, extended to this journey |
| Profile delete removes its `period_sky` rows. | unit on `profileDataLifecycle` + e2e |

Claim touched: **"Every feature works on every device, within a memory
budget."** and **"SQLite on OPFS is the only place your data lives."**

### PR 4 — Chat `time_travel` tool

```ts
// frontend/apps/web/src/lib/timeTravelTool.ts (new)
export const TIME_TRAVEL_TOOL_NAME = 'time_travel';
parameters: {
  type: 'object',
  properties: {
    period:    { enum: ['day', 'month', 'year'] },
    date:      { type: 'string', pattern: ISO day | YYYY-MM | YYYY },
    place_ref: { type: 'string', pattern: PLACE_REF_PATTERN },  // '^city:\d{1,6}$', from resolve_place
  },
  required: ['period', 'date'],
  additionalProperties: false,
}
```

- `execute` validates and builds a `ChatThreadAsOf` with the same helpers as the
  sheet. A Day without a place returns `NEEDS_PLACE_ERROR`, like `get_timing`.
  `place_ref` is resolved on the device with `placeFromRef`; the coordinates go
  into the pin and never into the result.
- The result the model sees: `{ status: 'moved', period_label, place_label?,
  time_zone? }` or `{ error }`. Never latitude or longitude. Reuses the
  coordinate-leak assertions from `placeEgress.test.ts` and the e2e at
  `time-travel.spec.ts:866-870`.
- **Mutations are UI-applied, after the turn.** `execute` records one pending
  travel on the turn. When the turn ends, the chat UI calls
  `useTimeTravel().travel({ source: 'chat-tool', asOf })`. Applying it mid-turn
  would trip the existing guard that rejects an answer whose pin changed while
  it streamed (`useChatThread.ts:381`, `chat:errors.pin_changed`). Last call
  wins if the model calls it twice.
- "What about the day I moved to Pune" works only when the date is in the
  conversation. The model does not see life-event dates (rectification sends a
  PII-safe slice with no dates). See open question 6.
- The tool is registered on every tier (after PR 3) and only when AI is
  configured (it is a chat tool).

Acceptance:

| Check | Evidence |
|-------|----------|
| "take me to March 2019" moves the banner on chat and Dashboard to March 2019; the next answer reads March 2019. | stubbed-model e2e, desktop Chromium + iPhone 15 WebKit, screenshots |
| A Day with a place: no model request body contains coordinates. | e2e body scan + unit |
| Before-birth date returns an error and moves nothing. | unit |
| The sheet and the tool produce byte-equal `as_of` for the same input. | unit on `timeTravel.ts` |
| One real-model run (cheapest OpenRouter model by live price) in the nightly real lane. | nightly `*.real.*` spec |

Claim touched: **"Coordinates never reach the model; only a place label and its
time zone do."**

## Per-PR proof (applies to every PR)

| Step | What | Done when |
|------|------|-----------|
| TDD red | Write the failing test first. Paste the red run (command + failing assertion) in the PR. | Red for the right reason, then green |
| Mutation red | Break the property in source, show the guard go red, revert. | One per claim, listed below |
| Gate | `make gate` (backend + frontend) and the Dagger PR lane | Green CI run link |
| Live, desktop Chromium | `bun run build && bun run preview`, drive the exact journey | Screenshots + clean console log attached |
| Live, iPhone 15 WebKit | Playwright `devices['iPhone 15']` on the macOS WebKit lane (`webkit-macos.yml`; Linux WebKit can't open SQLite's nested-Worker OPFS) | Screenshots + clean console log attached |
| Grade | Dispatch `northstar` against the PR's claim | Grade A before merge |

The existing lanes use `devices['iPhone 13']` (`playwright.time-travel.config.ts:48`,
`verify-webkit-engine.mjs:270`). PR 1 adds an `iphone-15-webkit` project to the
time-travel config rather than replacing iPhone 13.

Mutations to run:

| PR | Mutation | Test that must go red |
|----|----------|-----------------------|
| 1 | Put `hidden sm:inline` back on the Dashboard label | label-visible-at-390px e2e |
| 1 | Render the button only when `aiConfigured` | AI-off Dashboard e2e |
| 1 | Shrink the button to `min-h-8` | 44 px bounding-box assertion |
| 2 | Compute the moment card with today's reference instant | known-boundary dasha e2e |
| 2 | Route the moment compute through `usePredictiveStore` | Life Atlas not-evicted test |
| 2 | Add a `fetch` to any cross-origin URL in the moment path | `@sw` no-egress e2e |
| 3 | Set `periodSkyComputeAllowed: false` on minimal | iPhone Day e2e |
| 3 | Look up cities by parsing the JSON instead of SQL | city-lookup heap growth gate |
| 3 | Keep period payloads in a JS `Map` with no bound | time-travel memory budget gate |
| 3 | Write a row without stripping the boot proof | durable-receipt refusal unit |
| 3 | Skip the `period_sky` purge on profile delete | deletion test |
| 4 | Add `latitude` to the tool result | coordinate-leak unit + e2e body scan |
| 4 | Apply the pin inside `execute` (mid-turn) | UI-applied / pin_changed test |
| 4 | Call `setThreadAsOf` directly instead of `travel()` | sheet/tool byte-equality unit |

## Memory budget

What we measure, on the same journey before and after PR 3:

> boot → Dashboard → Time travel → Day + place → moment card shows transits →
> a second, different Day → back to the first Day (cache hit) → Back to today.

| Lane | Metric | How |
|------|--------|-----|
| Chromium, iPhone UA, tier forced to minimal (Dagger PR lane, Linux) | page+workers JS/wasm heap peak; renderer RSS peak | `measureUserAgentSpecificMemory` + `/proc` sampler, as `e2e/memory-budget.e2e.spec.ts` does today |
| WebKit, iPhone 15 profile (macOS lane) | WebContent process RSS peak (the process iOS jetsam kills) | The macOS sampler `scripts/webkitProcessMemory.mjs` from PR #317 |

Correction to the brief: on `main` the WebKit RSS sample (`processMemory.mjs`)
reads Linux `/proc` only and reports null on macOS. The macOS sampler lives in
open PR #317. PR 3 depends on #317 merging, or on that sampler landing on its
own first.

Budgets (provisional until the baseline runs; written into
`e2e/memoryBudget.ts` as `TIME_TRAVEL_MEMORY_BUDGET`):

| Metric | Provisional budget | Basis |
|--------|--------------------|-------|
| Chromium heap peak, whole journey, minimal | ≤ 440 MiB | Step A measured 419 for one period compute on minimal at 4x throttle |
| Heap growth on the cache-hit revisit | ≤ 5 MiB | A SQLite read, no engine run |
| Heap growth on first city lookup | ≤ 8 MiB (down from 48) | Candidates only; rows stay in SQLite |
| WebContent RSS peak, iPhone 15 WebKit | ≤ (baseline boot peak) + 250 MiB | Baseline from 5 runs on `main` |

How the numbers become final: PR 3's first task runs the journey 5 times on
`main` (Month pin, since Day is off there) and 5 times on the branch. The PR
records every sample. Budgets are set at the measured max plus 5 %, then never
raised to make a red run green. If the branch can't meet "baseline + 250 MiB"
on WebKit, we stop and do PR 3a (slim engine entry), as above. The gate fails
on NaN, like `overBudget` does today.

### The JavaScriptCore wasm fault (PR #317)

PR #317 shows that a wasm out-of-bounds fault in the Pyodide Worker can hit a
JSC `RELEASE_ASSERT` and kill WebContent. It was red in 5 of 23 macOS lane runs.
More engine runs on iPhone means more exposure. Rules for PR 3:

- No new Worker and no second Pyodide runtime. Period computes stay on the one
  engine queue (`periodSky.ts`, one at a time).
- The cache-hit path must not touch the engine at all.
- Run the time-travel spec 20 times on the macOS lane before and after (with
  `--retries=0`). The after crash count must not exceed the before count. Both
  counts go in the PR.
- The boot retry (#316, #320) is not a reason to accept new crashes.

## Privacy and egress

| PR | Network | Model sees | Stored on device |
|----|---------|-----------|------------------|
| 1 | None new | Nothing new | Nothing new (moment is in memory) |
| 2 | None. AI off means zero requests beyond the app origin | Nothing (no AI) | Nothing new |
| 3 | None. City rows come from the same-origin, SW-precached chunk; lookups are SQL on the device | Unchanged | `cities` table (reference data) and `period_sky` rows (derived personal data) in SQLite on OPFS; purged with the profile; not exported |
| 4 | Only the user's configured AI endpoint, as today | The tool's echo: period label, place label, IANA zone. Never coordinates | The chat pin, as today |

The privacy policy and legal copy (en/es/pt) gain one line in PR 3 about the
derived `period_sky` cache and its deletion. The online geocoder (Open-Meteo,
onboarding only) is not touched; the Dashboard and chat use the offline list.

## Open questions

1. Should the Dashboard moment survive a reload? Proposed: no. A reload returns
   to today, so nobody reads an old moment as today. The chat pin persists as
   it does now.
2. Should PR 1 ship to production before PR 2? Proposed: no. Merge both, then
   deploy, so the banner never promises a card that isn't there.
3. While a moment is set, should Life Atlas switch to the moment too? Proposed:
   no, label it "Today" for now. Switching it means a second domains compute.
4. If PR 3's first Day compute breaks the budget, is the slim Python entry
   (`compute_period_sky`) acceptable as PR 3a, ahead of the tier change?
5. Does the edgeproc-browser SQLite build include FTS5? If not, a normalised-name
   prefix index is enough for ≤ 5 candidates. Could edgeproc-browser instead
   open a prebuilt read-only cities database shipped with the bundle (no import
   step)? That would be an upstream feature.
6. "The day I moved to Pune": should chat get a life-events tool that returns
   the user's own event dates? That is a new disclosure (dates reach the model)
   and is out of scope here.
7. When the chat tool fires in an unpinned thread, should the move open a new
   pinned thread right away, or show a one-tap "Go to March 2019" chip first?
   Proposed: move right away, same as the sheet's Go.
