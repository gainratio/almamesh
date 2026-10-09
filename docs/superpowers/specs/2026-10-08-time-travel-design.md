# Time travel: ask the chat about any period, past or future

Status: approved design (Harish, 2026-10-08). Written against `main` at `468feaa4`.

## TL;DR

Today the chat can only read the sky for one day: today. Time travel lets a person ask about
any period, like "June 2019", "2027", or "15 June 2026", and get a reading for that period.

There are no new "time travel tools". The one timing tool the chat already has learns two
optional dates, `start` and `end`. Leave them out and nothing changes. The model turns plain
words into dates, the app checks them, and every answer says which period it looked at.

Places only matter for a single day, and only sometimes. The app works out when, and asks
then. City lookup stays on the device.

A "⏳ Time travel" button opens a new chat thread pinned to a period. The pin is saved with the
thread and travels with export and import.

The work ships in four increments (see [Increments](#increments)):

| Inc | What ships | User sees |
| --- | --- | --- |
| A | Timing tool takes dates; dashas picked by date; period label in prompts | Typed questions about any period work |
| B | Engine reports Mars, Rahu/Ketu sign changes and retrograde stations; 24-month window | Fuller slow-planet picture for long periods |
| C | Places: `resolve_place`, location check for single days, split periods | "Where were you?" asked only when it matters |
| D | Button, pinned threads, banner, export/import of the pin | One-tap time travel |

## Why

People mostly want to understand a time they lived through ("why was 2019 so hard?") or plan
for one coming up ("what about 2027?"). Today the app can't answer either. It reads today's sky
and the birth chart, and the prompt labels everything "today". If someone asks about June 2019,
the model either refuses or, worse, answers from today's transits.

The engine can already do this. `compute_predictive_contexts`
(`backend/src/almamesh/predictive.py:72`) takes any reference instant, and the dasha tree
already carries dated maha and antar periods. What's missing is a way for the chat to ask for a
date other than today, and a prompt that says which date it used.

## User journeys

### 1. "What happened in June 2019?" typed in a normal chat

1. Priya types "what was going on for me in June 2019?" into the Dashboard chat.
2. The model calls the timing tool with `section: "dashas"`, `start: "2019-06-01"`,
   `end: "2019-06-30"`.
3. Dashas need no engine run. The app picks the maha and antar running in June 2019 from the
   dated tree and replies at once.
4. The model calls the tool again with `section: "transits"` for the same dates. This needs an
   engine run, so the status line says "Working out the sky for June 2019… (about 30 s)".
5. The answer opens with "I looked at 1–30 June 2019." It talks about the Saturn antar that
   was running and Jupiter's transit that month. It does not ask where she was. A month-long
   reading doesn't depend on place.

### 2. Time travel button, "2027"

1. Marco taps "⏳ Time travel" beside the chat input on MeshEdge.
2. The sheet asks "When?" with Day / Month / Year tabs. He picks Year → 2027 and taps Go.
   There is no "Where?" field. It only shows on the Day tab.
3. A new thread opens, titled "Time travel · 2027", with a ⏳ badge in the thread list and a
   banner: "⏳ 2027 · answers are about this period · Change · Back to today".
4. Starter questions are future-tense: "What should I prepare for?", "Which months look
   strongest?".
5. He asks "will work get easier?". The timing tool defaults to 2027 because the thread is
   pinned. The answer says "I looked at 1 January–31 December 2027" and speaks in the future
   tense, because the date tool reports `relative: "future"`.

### 3. "June 15 2026, first half in LA then Bogotá"

1. Ana types "how was June 2026 for me? I was in LA the first half, then Bogotá."
2. The model calls the timing tool for 2026-06-01..2026-06-30. It does not call `resolve_place`.
   It tells her plainly: "Being in LA and then Bogotá doesn't change June's reading. Dashas
   come from your birth chart and planet positions are the same from anywhere on Earth."
3. She follows up: "what about June 15 itself?". Now it's a single day. The model uses her home
   zone and says so in one line: "I'm reading 15 June in your home time zone
   (America/Los_Angeles)."
4. The tool checks whether the Moon's sign, nakshatra or tithi on 15 June differs anywhere
   between UTC−12 and UTC+14. If not, the place doesn't matter and nothing is asked. If it
   does, the tool returns `location_sensitive: true` and the model asks "Were you in LA or
   Bogotá on the 15th?".
5. She says Bogotá. The model calls `resolve_place("Bogotá")`, which searches the bundled city
   list on the device. The model sees only `Bogotá, Colombia` and `America/Bogota`. The
   coordinates stay on the device.
6. If she had asked "what about 3 pm on the 15th?", the model would always ask where. An event
   ascendant needs a real latitude and longitude.

## Design

### Part 1: one timing tool that takes dates

#### The tool contract

The chat's timing tool is `get_current_timing` today
(`frontend/apps/web/src/lib/chatAgentTools.ts:150`). It takes `section` (dashas, transits,
domains, strength) and reads the sky at `todayAnalysisInstant(context.now)` (line 170).

It is renamed `get_timing` and gains two optional arguments.

| Argument | Type | Required | Meaning |
| --- | --- | --- | --- |
| `section` | `"dashas" \| "transits" \| "domains" \| "strength"` | yes | Same as today |
| `start` | `YYYY-MM-DD` | no | First day of the period. Omitted → today |
| `end` | `YYYY-MM-DD` | no | Last day, inclusive. Omitted → same as `start` |

The rename is safe. Tool names are not saved in chat history (`ChatMessage` in
`frontend/packages/shared-types/src/chat.ts:36` stores text only). The old name appears only in
code and tests: `Dashboard.tsx:360`, `MeshEdge.tsx:351`, `chatAgentTools.test.ts:56`,
`MeshEdge.test.tsx:327`, `e2e/chat.grounding.spec.ts:431`, `e2e/dashboard.agentic.real.spec.ts:199`.
All change in the same PR.

The model does the language work. The tool description tells it how:

| User says | Model sends |
| --- | --- |
| "12 March 2019" | `start = end = 2019-03-12` |
| "June 2026" | `2026-06-01` .. `2026-06-30` |
| "2019" | `2019-01-01` .. `2019-12-31` |
| "summer 2019", "the last few months" | The model picks a sensible range and says which |

Every result echoes the period it resolved:

```json
{ "period": { "start": "2026-06-01", "end": "2026-06-30", "days": 30, "basis": "period" },
  "section": "transits", "notes": [], "...": "section data" }
```

The tool description and the system prompt both require the model to state that period in its
answer: "I looked at 1–30 June 2026."

#### Rules the app enforces

The model can send anything. The app checks it before any work happens.

| Input | Result |
| --- | --- |
| Not `YYYY-MM-DD`, or not a real date | Tool error to the model: "start must be a date like 2026-06-01" |
| `end` before `start` | Tool error: "end is before start" |
| Whole period ends before 1 January of the birth year | Refused: "This period starts before the birth date. Ask about a period after it." The birth date is not in the message. A period that ends anywhere in the birth year is answered (see Privacy: the refusal boundary is the year, not the day). |
| Span over 2 years | Dashas only. `notes: ["Over 2 years: showing dashas only. Ask about a shorter span for transits."]` |
| Any day after 2052-12-31 | Dashas only, with a note. The engine's ephemeris stops at 2053 (`backend/src/almamesh/transits/slow_hits.py:36`). |
| Span over 12 months (until Inc B) | Transit events for the first 12 months only, with a note. The engine's timeline window is 12 months (`backend/src/almamesh/transits/timeline.py:53`). |

#### What each section returns for a period

| Section | Single day | Period longer than a day |
| --- | --- | --- |
| `dashas` | Maha, antar (and pratyantar when available) on that day | Every maha and antar running at any point in the period, in order, with month-precision start and end, so a change mid-period shows |
| `transits` | All nine grahas, including the Moon and other fast planets | Slow grahas only (Jupiter, Saturn, Rahu/Ketu, Mars): position at the start, plus sign changes and retrograde stations inside the period |
| `domains`, `strength` | As today, at that day | As computed at the period start, labelled "at the start of the period" |

Fast planets (Sun, Moon, Mercury, Venus) are left out of multi-day results. A month of Moon
positions is noise, and the model would read meaning into it.

Until Inc B lands, the engine's timeline only reports Jupiter and Saturn sign changes
(`_SLOW_GRAHAS`, `backend/src/almamesh/transits/timeline.py:29`) and emits no retrograde
stations (`TransitEventKind.STATION` exists in `backend/src/almamesh/schemas/transits.py:44`
but nothing produces it). So the result carries `covered_events: ["jupiter_ingress",
"saturn_ingress", "dasha_change", "sade_sati_phase"]`. The model must not say "Mars didn't
change sign" when Mars was never checked.

#### Dashas by date

Dashas need no engine run. The chart already stores the dated maha sequence, each with its
dated antar sequence. Today `sanitizeDashas` (`frontend/packages/llm/src/sanitize.ts:358`)
does not re-pick `current_maha` or `current_antar` for a date. It passes through the ones the
engine picked at the chart's reference date and only recomputes months remaining.

A new pure function, `selectDashasForPeriod(dashas, start, end)`, walks the dated tree and
returns every maha and antar that overlaps the period. Every maha row already carries its
full dated `antar_sequence` (`backend/src/almamesh/schemas/astrology.py:130`), so this is a
date-overlap filter over engine-stated dates, not astrology. It lives in `@almamesh/llm` beside
`sanitizeDashas` so it goes through the same month-precision rules.

Pratyantar dashas are only stored for the chart's current antar (`pratyantar_sequence`). When
the period falls outside that antar, the result says so:
`notes: ["Pratyantar dashas are only available for the current antar."]`.

#### Telling the prompt which period it is

`AnalysisInstant.basis` is `"chart" | "today"` today (`frontend/packages/llm/src/sanitize.ts:223`).
It gains a third kind:

```ts
export type AnalysisInstant =
  | { readonly basis: "chart" | "today"; readonly instant: Date }
  | { readonly basis: "period"; readonly instant: Date; readonly period: { start: string; end: string } };
```

`instant` is the period's start day. `SanitizedAsOf` gains optional `period_start` and
`period_end`. `facts.ts:98`, which writes "as of <date>, today", writes
"as of 1–30 June 2026 (the period asked about)" for this basis. A new helper,
`periodAnalysisInstant(start, end)`, sits beside `todayAnalysisInstant` (sanitize.ts:258).

#### Computing a period's sky

Transits, domains and strength need the engine. For a period it runs once, at the period's
start day, using the same input builder as today: `buildEnsurePredictiveInput`
(`frontend/apps/web/src/lib/predictive.ts:65`), which now requires `utcOffsetMinutes`, with
`referenceInstant = predictiveReferenceInstant(start)` (predictive.ts:27). The engine's
12-month forward timeline then covers the period, and the tool keeps only events inside it.

This must not go through the predictive store's single slot. `usePredictiveStore` holds one
result keyed by `requestKey` (`frontend/packages/store/src/predictive.ts:118`) and persists it.
A time-travel compute there would evict today's Life Atlas, and the Life Atlas would then
recompute for 30 seconds on next open.

So period computes go through a separate module, `apps/web/src/lib/periodSky.ts`:

- Keyed by `predictiveRequestKey(input)`, the same key shape as the store.
- Before computing, it checks the predictive store. If the store already holds that exact key
  (say, the period starts today), it reads that result and computes nothing.
- Otherwise it calls `runtime.computePredictive(input)` directly and keeps the result in an
  in-memory LRU of the last 5 periods.
- One compute in flight at a time. A second request for the same key joins the first.

#### The regex router

Dashboard and MeshEdge run the timing tool before the model sees the question when
`requiresCurrentPlanetaryContext` matches (`chatAgentTools.ts:77-80`, called at
`Dashboard.tsx:359` and `MeshEdge.tsx:350`). The pattern matches words like "today", "now",
"current", "this month", "transits", "timing" in en/es/pt.

That breaks for dated questions. "Transits in June 2019" matches "transits", so the app spends
30 seconds computing today's sky and the prompt is labelled "today".

The fix: a second function, `mentionsExplicitPeriod(question)`, matches a 4-digit year
(1900–2099) or a month name in en/es/pt. The router becomes:

| Thread | Question | Pre-run |
| --- | --- | --- |
| Normal | Matches "today" words, no explicit period | Today (as now) |
| Normal | Mentions an explicit period | Nothing. The model calls `get_timing` with dates |
| Pinned | Anything | The pinned period |

A pinned thread never pre-runs today. If the user says "compare with today", the model calls
`get_timing` without dates.

#### One tool builder for both surfaces

Dashboard and MeshEdge each build `loadCurrentChart` and call `createChatAgentTools` with
near-copies of the same code (`Dashboard.tsx:325-351`, `MeshEdge.tsx:324-347`). They already
differ: Dashboard keys the day on `viewerTimeZone()` (`Dashboard.tsx:338`) and MeshEdge on the
birth zone (`MeshEdge.tsx:334`).

Time travel adds period loading, place lookup and a pinned period to both. Rather than copy it
twice, one builder, `buildChatToolset` in `apps/web/src/lib/chatToolset.ts`, takes the chart,
birth data, engine context and optional pinned period, and returns the tools plus the router.
The builder reads "today" in one zone for both pages: the viewer's (device) zone, from
`viewerTimeZone()`. Pages do not pass a day zone. MeshEdge's "today" moves from the birth zone to
the viewer zone, which is the zone every "As of" on screen is already printed in (see open
question 1, decided).

### Part 2: places

#### When to ask

| What is being read | Ask where? | Why |
| --- | --- | --- |
| A month or longer | Never | Dashas come from the birth chart. Planet positions are geocentric. Houses come from the natal chart. Place changes nothing. |
| A month or longer, user mentions several places | Never, and say why | "Being in LA and then Bogotá doesn't change June's reading." |
| A single day | Only when `location_sensitive: true` | Default to the home zone and say so in one line |
| A specific time of day | Always | The event ascendant needs latitude and longitude |

"Home zone" is the device's current time zone (`viewerTimeZone()`, already used at
`Dashboard.tsx:338`). It is the best guess for where someone lives. The birth zone is not: plenty
of people live far from where they were born. The model always names the zone it used, so a
wrong guess is visible and easy to correct.

#### The location check for a single day

For a single day, `get_timing` asks the engine for the Moon's sign, nakshatra and tithi at the
two ends of that calendar day as seen anywhere on Earth: 00:00 at UTC+14 and 24:00 at UTC−12.
That is a 50-hour window.

The Moon and Sun both move forward in sidereal longitude and never go retrograde, so the
Moon–Sun angle only grows. If the sign, nakshatra and tithi are the same at both ends, they are
the same everywhere that day. If any differ, the result says `location_sensitive: true` and the
model asks where. The Moon covers about 28° in 50 hours, less than one sign and less than one
full tithi cycle, so comparing the ends can't miss a change and come back to the same value.

This is astrology, so it lives in Python (project rule 2: no astrology in TypeScript). A new
engine function, `compute_moon_window(day)`, does the whole check and returns
`{ location_sensitive, at_start, at_end }`. It reuses `get_nakshatra_info`
(`backend/src/almamesh/calculations.py:521`); tithi is new there. The browser reaches it
through a new worker request, `computeMoonWindow`, next to `computePredictive`
(`frontend/packages/browser/src/pyodide/chartWorker.ts:494`). It runs in well under a second
and goes through the CPython/Pyodide parity gate like every other entry.

When the place is known and the day is still sensitive, the result gives the values at that
place's local start and end of day, for example "Moon in Taurus at the start of the day,
Gemini by the end". Exact change times are out of scope for v1.

#### `resolve_place`

A new tool. It turns typed text into a place, offline only.

| | |
| --- | --- |
| Input | `{ "query": "Bogotá" }` |
| Engine | `searchCitiesOffline` (`frontend/apps/web/src/lib/geo/cityLookup.ts:186`): the bundled `cities.min.json` plus tz-lookup |
| Never | `searchCities` (cityLookup.ts:224), which tries the Open-Meteo geocoder first (`onlineGeocoder.ts`) |
| One match | `{ "status": "found", "place": { "label": "Bogotá, Colombia", "timezone": "America/Bogota" } }` |
| Several | `{ "status": "ambiguous", "candidates": [label + timezone, up to 5] }`. The model asks which. |
| None | `{ "status": "not_found" }`. The model asks for the nearest larger city. |

The model only ever sees the typed text, the label and the IANA zone. Coordinates stay in the
tool closure, keyed by a short opaque `place_ref`, and are used only for single-day and
time-of-day reads. A chat-typed city never leaves the device.

#### Split periods

`get_timing` accepts an optional `segments: [{ start, end, place_ref }]` instead of
`start`/`end`. The tool merges the segments into one period for dashas and slow transits,
since place doesn't change them. Only single-day reads use a segment's place. This lets the
model pass "first half LA, then Bogotá" through without having to argue with the tool.

### Part 3: the button and pinned threads

#### The button and the sheet

"⏳ Time travel" sits beside the chat input in `ChatPanel`
(`frontend/apps/web/src/components/features/chat/ChatPanel.tsx`, input at line 266). Both
Dashboard (`Dashboard.tsx:1220`) and MeshEdge (`MeshEdge.tsx:553`) mount chat through
`FloatingChatPanel`, so one change covers both.

The sheet:

| Field | Shown | Default |
| --- | --- | --- |
| When? | Always. Tabs: Day / Month / Year | Month, current month |
| Where? | Day tab only | Home zone, with a "change" link that opens the offline city search |
| Go | Always | Opens a new thread pinned to the period |

#### The pinned thread

- Banner at the top: "⏳ June 2026 · answers are about this period · Change · Back to today".
  "Change" reopens the sheet and updates this thread's pin. "Back to today" opens the last
  normal thread, or a new one.
- Thread list: ⏳ badge and the title "Time travel · June 2026" (`ChatSearch.tsx` builds labels
  at line 37).
- `get_timing` defaults to the pinned period when called without dates. The model can still
  pass other dates to compare.
- `get_current_datetime` (`chatAgentTools.ts:97`) returns the real today as now, plus
  `pinned_period: { start, end }` and `relative: "past" | "future" | "contains_today"`, worked
  out in the chart zone. The prompt tells the model to match its tense to `relative`.
- Starter questions follow `relative`. Past: "Why did this time feel hard?", "What was this
  period teaching me?". Future: "What should I prepare for?", "Which months look strongest?".
  Contains today: the current starters.
- The first question on a new period shows "Working out the sky for June 2026… (about 30 s)"
  while the engine runs.

#### Stale answers and the daily re-anchor

`useChatThread` binds each answer to `chartSnapshotIdentity(chartId)`
(`frontend/apps/web/src/hooks/useChatThread.ts:223`, checked at lines 297 and 327). For pinned
threads the identity becomes `snapshot_id + as_of key`. If the user changes the pin mid-answer,
the late answer is dropped, the same as a chart change today.

`ChatPanel` blocks sending while the chart re-anchors to a new day
(`useChartReanchorPending`, `ChatPanel.tsx:89`). A pinned thread doesn't depend on today, so it
skips that wait.

`ChatStreamInput` (`useChatThread.ts:43`) gains `asOf?: ChatThreadAsOf`, so the page's stream
function knows the pin.

## Data and storage

`ChatThread` (`frontend/packages/shared-types/src/chat.ts:20`) gains one optional field:

```ts
export interface ChatThreadAsOf {
  readonly start: string;             // YYYY-MM-DD
  readonly end: string;               // YYYY-MM-DD, inclusive
  readonly granularity: 'day' | 'month' | 'year';
  readonly place?: {                  // only for a Day pin with a chosen place
    readonly label: string;           // "Bogotá, Colombia"
    readonly timezone: string;        // IANA
    readonly latitude: number;
    readonly longitude: number;
  };
}

export interface ChatThread {
  // ...existing fields
  as_of?: ChatThreadAsOf;
}
```

| Change | Where |
| --- | --- |
| Chat store version 2 → 3 | `CHAT_PERSIST_VERSION`, `frontend/packages/store/src/chat.ts:30` |
| Migration keeps v2 threads as-is (no `as_of` = normal thread); drops a malformed `as_of` from the thread, keeping the thread | `migrateChatPersistedState`, chat.ts:50 |
| Import accepts chat store v3 | `PORTABLE_STORE_MAX_VERSIONS['almamesh-chat-history']`, `frontend/packages/store/src/portableState.ts:109` |
| Import validates `as_of` shape; a malformed one rejects the backup | thread checks, portableState.ts:1021 |

The chat store already persists to the canonical SQLite store through its existing storage
adapter (chat.ts:360). `as_of` rides along. Nothing new goes into IndexedDB or localStorage.

An older build opening a v3 backup already refuses with "This backup was made by a newer
version of AlmaMesh" (`frontend/packages/store/src/backup.ts:231`).

The period-sky LRU is memory only. It holds recomputable engine output, not user data, so it
is not persisted and not exported.

## Privacy

The privacy promise doesn't change: no birth details leave the device, and only sanitized
chart facts reach the model.

| What | Crosses to the model? | Guard |
| --- | --- | --- |
| Period `start`/`end` | Yes, the model chose them from the user's own words | Echoed as-is |
| Dates inside results (dasha boundaries, transit events) | Month precision only | `sanitize.ts` allowlist rebuild |
| The birth date | No. "Before birth" refusals don't include it, and *whether* a call is refused never depends on the birth month or day | Refusal message is a constant; refusal boundary is 1 January of the birth year (`endsBeforeBirthYear`) |
| Birth month/day via which rows appear | No. A row starting at birth counts as starting on 1 January of the LOCAL birth year (the refusal's year), and a birth-year period carries one constant note: "The first period row begins during the year of birth; months before birth don't apply." | `selectDashasForPeriod(dashas, period, birthYear)` |
| Birth month/day via a birth-year sky | No. The engine computes a period sky against the real birth instant, so its running maha/antar lords (transits `fusion`, domains, strength) flip at birth. Any sky section for a period starting on or before 31 Dec of the birth year is withheld: dashas only, constant note "Planet timing for the year of birth isn't available; showing periods only." The engine is not called. | `startsInOrBeforeBirthYear` in `get_timing` |
| The transit cutoff note's time of day | Yes, to the minute in UTC (e.g. "until 2028-12-31 12:00 UTC"). It does not narrow the birth date. The instant is the period's start + N × 30.4375 days, derived from the period the user asked about, never from birth data. Event dates stay month precision. | `restrictTransitsToPeriod` builds the window end from the period start and `window_months` only |
| Birth month via the first maha's length | No. On every row that starts at birth (first maha, its first antar, a current period or pratyantar starting at birth) `duration_years` is the birth balance; with the month-precision end it gives the birth month. It is omitted, not rounded (a rounded balance still narrows the month within the year). | `sanitize.ts` `lengthOf` |
| The first maha's start month (= birth month) | No, even when a period falls inside the first maha | `selectDashasForPeriod` withholds it |
| Typed city text | Already in the user's message | n/a |
| Place coordinates | No. Model sees label + IANA zone only | `place_ref` indirection |
| Place lookup network calls | None. Offline list only | `resolve_place` imports `searchCitiesOffline` only |

The dasha tree today crosses only for non-past periods so that birth-adjacent dates never leak
(sanitize.ts:11-14). With a period basis, "past" is measured from the period start. A period
early in life could put the first maha in range. Its start is the birth date, so
`selectDashasForPeriod` always reports that row's start as `"birth"`, never a month.

A refusal is itself a side channel. If "March 1990 refused / April 1990 answered" were possible,
the model (or anyone reading the transcript) could bisect the birth day in about 13 calls. So the
refusal boundary is the birth **year**, which month-precision dasha boundaries already reveal:
only a period that ends before 1 January of the birth year is refused. Every period that ends in
or after the birth year is answered the same way whatever the birth month and day. No rows are
invented for before birth, and nothing in the result says why rows are missing. For the same
reason the rows that start at birth are treated as starting on 1 January of the birth year, so
their presence in a birth-year period is not an oracle either. The tool receives only the birth
year; the birth day never enters the tool path.

## Performance

| Step | Cost |
| --- | --- |
| Dashas for any period | Instant. Pure date selection, no engine |
| Transits, domains, strength for a new period | About 30 s under Pyodide (`frontend/packages/store/src/predictive.ts:131`) |
| Same period again | Instant from the LRU |
| Location check for a day | Under a second |
| `resolve_place` | Under 100 ms once the city list is loaded |

The Pyodide worker is serial. A period compute queues behind any Life Atlas compute already
running. On a cold start that can mean 30 s waiting plus 30 s computing.

The timing tool's timeout is 60 s today (`chatAgentTools.ts:154`, and
`CURRENT_CONTEXT_TIMEOUT_MS` in `apps/web/src/lib/currentPlanetaryContext.ts:27`). For period
computes it goes to 150 s. That covers one queued compute plus one of its own, and stays under
the worker's own predictive limit of 180 s (`DEFAULT_PREDICTIVE_REQUEST_TIMEOUT_MS`,
`frontend/packages/browser/src/pyodide/chartEngineClient.ts:37`). The status line says
"about a minute" when it knows a compute is queued ahead.

Low-end devices. Each cached result holds the full predictive payload in memory. The LRU size
comes from the device tier (`frontend/packages/browser/src/deviceTier.ts:34`), as a new
`DevicePolicy.periodSkyCacheSize`: `full` 5, `lite` 3, `minimal` 1. Period computes never start
while another period compute runs. The tool waits for the first to finish.

## Error handling

| Failure | What the user sees | What the model gets |
| --- | --- | --- |
| Bad or reversed dates | Nothing directly. The model retries or asks | Tool error with the reason |
| Before the birth year | "That's before you were born. Pick a later period." | Refusal, no birth date; boundary is 1 January of the birth year |
| Over 2 years, or past 2052 | Answer covers dashas, says why transits are missing | Dashas + note |
| Engine not ready or failed | "I couldn't work out the sky for June 2026 on this device. Dasha answers still work." | `{ available: false, reason: "engine_unavailable" }` |
| Engine timeout (150 s) | Same as above, plus "Try again in a moment." | `{ available: false, reason: "timeout" }` |
| Birth data incomplete (no zone) | Existing "complete birth data" message | Existing error |
| Place not found | Model asks for a nearby larger city | `status: "not_found"` |
| Place ambiguous | Model lists the candidates and asks | `status: "ambiguous"` |
| User changes the pin mid-answer | The old answer is dropped | n/a |
| Malformed `as_of` in a backup | Import refuses with the row and field named | n/a |

## Testing

TDD throughout: write the failing test, watch it fail for the right reason, then make it pass.
Every guard gets a mutation run: break the source on purpose, show the test going red, and put
that red run in the PR.

### Unit and integration tests

| Guard | Test | Mutation that must turn it red |
| --- | --- | --- |
| Omitted dates mean today | `get_timing` with no dates returns today's period and `basis: "today"` | Default `start` to the chart reference date |
| Period echo | Every result has `period.start`/`end` equal to the resolved input | Drop the echo |
| Bad dates rejected | `2026-02-30`, `2026-6-1`, reversed range → tool error | Remove the reversed check |
| Before birth refused, birth date hidden | Refusal text contains no `YYYY-MM` of the birth | Interpolate the birth date into the message |
| No birth-day oracle | Every section (dashas, transits, domains, strength), every month of 1989–1991 and every day of March 1990 give identical results for births 1990-03-17 and 1990-11-02, with a period engine whose lords flip at birth | Refuse by comparing `start` with the birth day; overlap the birth row from its exact day; compute a birth-year sky |
| Local birth year | A birth at 1990-12-31 20:00 PST reads June 1990 like a mid-year 1990 birth | Clamp the birth row to the UTC year of its instant |
| First-maha balance withheld | Two births in one year with the same later tree sanitize to identical dashas | Pass `duration_years` through on birth rows |
| 2-year cap | 25-month span returns dashas only plus note | Change the cap to `>=` 3 years |
| 2052 cap | A 2053 day returns dashas only | Remove the ephemeris check |
| Fast planets dropped for multi-day | Month period has no Moon/Sun/Mercury/Venus | Keep all grahas |
| Events filtered to the period | Timeline events outside the period are dropped | Return the full 12-month timeline |
| Dashas re-picked by date | A period across an antar change lists both antars | Return `current_antar` as stored |
| Pratyantar note | Period outside the current antar → note | Return `pratyantar_sequence` anyway |
| First-maha start withheld | Period in the first maha shows `"birth"`, not a month | Pass `start_month` through |
| `covered_events` honest | Before Inc B, Mars ingress is not listed as covered | Hard-code all grahas as covered |
| Today's slot untouched | After a period compute, `usePredictiveStore` `requestKey` is unchanged | Route period computes through `ensurePredictive` |
| Store reuse | Period starting today reads the store, no engine call | Always call the engine |
| LRU bound | Sixth period evicts the oldest (tier `full`) | Unbounded map |
| Router skips dated questions | "transits in June 2019" does not pre-run today | Drop `mentionsExplicitPeriod` |
| Pinned router | Pinned thread pre-runs the pin, never today | Pre-run today |
| Prompt label | Period basis renders "as of 1–30 June 2026 (the period asked about)" | Render "today" |
| Location check | Day with a Moon sign change inside the 50-hour window → `location_sensitive: true`; a quiet day → false | Compare only one end |
| Offline place lookup | `resolve_place` makes zero `fetch` calls (spy) | Call `searchCities` |
| No coordinates to the model | `resolve_place` result has no number fields | Include latitude |
| Tense | `relative` is past / future / contains_today at the boundaries (today = start, today = end) | Use `<` for `<=` |
| Stale guard | Changing the pin mid-stream drops the late answer | Key on `snapshot_id` only |
| Re-anchor skip | Pinned thread can send while re-anchoring | Keep the wait |
| Store migration | v2 blob → v3 with threads intact; malformed `as_of` dropped | Return v2 shape unchanged |
| Import validation | Malformed `as_of` rejects the backup | Skip validation |

Privacy egress: extend `frontend/packages/llm/src/__tests__/egress.test.ts` with a fixture
born 2000-03-15 asking about 2000-06. The serialized tool results and prompt must not contain
`2000-03`. Mutation: pass the first maha's `start_month` through.

Engine (Inc B and C) is Python. New producers get pytest coverage in `backend/`, and the
CPython/Pyodide byte-parity gate (`node scripts/verify-browser-parity.mjs`, run in
browserJourneys) must stay green.

### End-to-end journeys

A new Playwright suite, `frontend/apps/web/e2e/time-travel.spec.ts` with
`playwright.time-travel.config.ts`, modelled on `playwright.time-handling.config.ts`. The model
is mocked with `page.route` the way `e2e/chat.grounding.spec.ts` does, so the run is
deterministic. The real in-browser engine runs.

| Journey | Asserts |
| --- | --- |
| Typed "June 2019" in Dashboard chat | Tool called with 2019-06-01..30; answer shows the echoed period; Life Atlas `requestKey` unchanged after |
| Button → Year 2027 on MeshEdge | Thread titled "Time travel · 2027"; ⏳ badge; banner; future starters; no "Where?" field |
| Day pin with a place | "Where?" shows; city search makes no network request (`page.on('request')`); `location_sensitive` path asks |
| Clean console | No errors during each journey |

Wire it into the browserJourneys lane (`dagger/src/index.ts:481`) as
`TIME_TRAVEL_E2E_BASE_URL=http://127.0.0.1:4199 bun run test:e2e:time-travel --project=chromium`,
and add the script to `frontend/apps/web/package.json`.

### Export and import round trip

Extend `frontend/apps/web/e2e/portable-invariants.spec.ts` (run in the browserChromium lane,
`dagger/src/index.ts:477`): create a pinned thread with a Day pin and a place, export, restore
in a fresh browser context, and check the thread's `as_of` matches field for field and the
banner shows. Mutation: strip `as_of` in the export path and watch it fail.

### i18n

All new strings go in the `chat` namespace for en, es and pt
(`frontend/apps/web/src/locales/{en,es,pt}`). The existing `chat.parity.test.ts` catches a
missing key. Period labels ("June 2026", "1–30 June 2026") come from `Intl.DateTimeFormat` in
the UI language, not hand-built strings. `mentionsExplicitPeriod` covers month names in all
three languages, with accents folded the way `requiresCurrentPlanetaryContext` already does.

## Increments

Each increment is one PR, one tested release, northstar-graded before merge.

**Inc A: dates in the timing tool.** Rename to `get_timing` with `start`/`end`; validation
rules; `selectDashasForPeriod`; period basis in `sanitize.ts` and `facts.ts`; `periodSky.ts`
with the in-memory LRU; router change; shared `buildChatToolset`; 150 s timeout. Claim it
touches: "only sanitized facts reach the model". Journey 1 works end to end, with Jupiter and
Saturn events only.

**Inc B: fuller slow-planet events.** Engine timeline adds Mars and Rahu/Ketu sign changes and
`STATION` events for Jupiter, Saturn and Mars. `compute_predictive_contexts` gains a keyword
`window_months` (default 12) so a 13–24 month period is one compute. `covered_events` widens.
Claim: CPython/Pyodide parity.

**Inc C: places.** `resolve_place`, `computeMoonWindow`, `location_sensitive`, `segments`,
event-time reads with a place. Claim: "a chat-typed city never leaves the device". Journey 3
works.

**Inc D: button and pinned threads.** Sheet, banner, badge, starters by tense, date tool's
`pinned_period`/`relative`, chat store v3, stale guard, re-anchor skip, import/export of
`as_of`. Claim: "export/import carries everything". Journey 2 works.

A and D are the user-visible core. B and C can ship in either order after A.

## Out of scope for v1

- Side-by-side comparison of two periods in the UI. The model can still compare in text.
- A timeline scrubber.
- A PDF of a time-travel reading.
- Exact times when the Moon changes sign or nakshatra during a day.
- Persisting period computes across reloads.

## Open questions

1. **Decided (Harish, 2026-10-08): unify on the viewer (device) zone.** Dashboard keyed "today"
   on the viewer's zone and MeshEdge on the birth zone. `buildChatToolset` now reads today with
   `viewerTimeZone()` for both pages, and neither page passes a zone. Why the viewer zone: it is
   the zone the footer, report cover, PDF and prompt `as_of` already print in (#274), and the
   home-zone default for places (Part 2) is the same zone. Inc A carries this as a task, with a
   test that pins both pages to the same "today" for a chart whose birth zone and the device
   zone fall on different calendar days.
2. LRU sizes by tier (5 / 3 / 1) are a starting guess. Inc A should measure the payload size
   on a throttled profile and adjust.
