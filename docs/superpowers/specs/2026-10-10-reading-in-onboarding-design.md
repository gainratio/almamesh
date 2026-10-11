# Your reading, right after your chart

Status: approved. Section 1 (the onboarding flow) and Section 2 (the report structure) are
approved; the owner answered "yes to all" on PR #325 and the eight open questions are resolved
at the end of this document. Written against `main` at `821bd6e8` on 2026-10-10.

## TL;DR

Today the AI reading is something you find later, in Settings. Most people never do. And the
reading they get is short: a few paragraphs per area, with the timing split off into a separate
panel.

This spec does two things.

1. **The reading becomes the next step after the chart.** When the chart is saved, onboarding
   asks "Unlock your reading" (only if no AI is set up), using the same AI setup panel Settings
   uses. Then "Your reading" shows what the report contains, which model will write it, and a
   rough cost. Nothing is sent until the person taps **Get my reading**. "Skip" and "Go to
   dashboard" are always there.
2. **The reading becomes a real report.** Five chapters: Overview, Your current period, The
   year ahead, Life areas (all seven), and Remedies and guidance. Every date, strength band and
   timing window comes from the engine and is drawn by the app. The model writes the prose
   around them. On the default model it costs the person roughly 5 to 9 US cents on their own
   OpenRouter account. AlmaMesh charges nothing.

No payments, no credits, no accounts. Bring-your-own key stays. "Free forever" stands.

It ships in four PRs:

| PR | What ships | User sees |
| --- | --- | --- |
| 1 | One shared `AiSetupPanel`, used by Settings | Nothing changes in Settings |
| 2 | Report sections in `@almamesh/llm`: current period, year ahead, life-area outlook; date guard | Nothing yet (library only) |
| 3 | Store v7, streaming hook, dashboard `ReadingReport` | Dashboard "Get reading" produces the full report |
| 4 | `/onboarding/reading` route: unlock step, your-reading step, rectify hand-off, cost line | The reading is the step after the chart |

## Why

Two pieces of user feedback:

1. "Make the AI reading the step right after the chart, not a setting."
2. "Make it a longer, structured report (life areas, current dasha, the year ahead) that feels
   worth paying for."

The owner's answer to the second one is not to charge. The person already pays their AI
provider a few cents. The report should feel worth those cents, and worth the minute it takes
to set up a key.

What the code does today:

- Onboarding ends at `handleGenerateChart` (`apps/web/src/pages/Onboarding.tsx:374`). It waits
  for `waitForChartSaved` (`:462`) and then goes to `/dashboard`, or to `/rectify/:profileId`
  when the birth time is unknown (`:466`). There is no AI step.
- The generating screen shows an "interpretation" step for 15 seconds
  (`GENERATION_STEPS`, `:96-102`). No interpretation runs. That line is not true and this spec
  removes it.
- AI setup lives in Settings → AI (`pages/settings/AiSettings.tsx`), which renders
  `AiModelSettings` → `LlmModelSettings` (690 lines). It has no way to tell a caller "the user
  just connected".
- The reading is generated only from the dashboard button (`pages/Dashboard.tsx:458`), with
  `intent: 'user-request'`. That rule stays exactly as it is.
- The engine already computes far more than the reading uses. `computePredictive` returns
  per-domain forecasts with strength bands, key planets and dated windows for seven life areas,
  plus gochara, Sade Sati, slow transits, and a 12-month event timeline
  (`backend/src/almamesh/predictive.py`, default `window_months = 12`). Today only the two short
  timeline sections (`upcoming_periods`, `current_sky`) see any of it, and the seven life-area
  guidances are natal-only by design.

So the data for a much better report is already on the device. What's missing is a place in the
flow, and sections that use the data.

## Section 1: the onboarding flow (approved)

### The journey

| # | Screen | Shown when | What happens | Network |
| --- | --- | --- | --- | --- |
| 1 | Generating | Always | As now. The fake "interpretation" step is removed. | None (engine is local) |
| 1b | Rectify | Birth time unknown | As now. Its exits go to step 2 instead of `/dashboard` when it was entered from onboarding. | None |
| 2 | **Unlock your reading** | No AI configured | The shared `AiSetupPanel`. Two lines of copy (below). "Skip for now" goes to the dashboard. A successful key test moves to step 3. | Only the key test the user taps, to the provider they chose |
| 3 | **Your reading** | AI configured (or just connected) | Report outline, model name, rough cost (OpenRouter only), balance if known. **Get my reading** is the explicit action. Sections stream in. "Go to dashboard" always visible. | Price lookup to OpenRouter only. Completions only after the tap. |
| 4 | Dashboard | Always | Shows the saved report. A run still in progress keeps going and lands there. | None new |

The two lines on step 2 (en; es and pt in the same PR):

- "Your reading is a full report: who you are, the period you're in now, the year ahead month by
  month, and all seven life areas."
- "Your key stays on this device. It is sent only to the AI provider you choose, never to us."

The cost line on step 3:

- "About 6¢ on your OpenRouter account. AlmaMesh charges nothing." The number comes from the
  estimate below. Free models show "Free on this model". Local endpoints show no cost line.

### Where it lives: a route, not an onboarding step

The reading screens are a new route, `/onboarding/reading`, page
`apps/web/src/pages/OnboardingReading.tsx`, not new values of `OnboardingStep`.

Why: the unknown-time path leaves `Onboarding.tsx` for `/rectify/:profileId`, and `reset()`
clears the onboarding draft before it navigates (`:465`). A route can be reached from both
places, survives a reload, and keeps `Onboarding.tsx` (already 1,197 lines) from growing.

The hand-off uses React Router navigation state, not a new store (SQLite is the only system of
record; this is a navigation hint, not data):

```ts
// Onboarding.tsx, replacing :466
const next = '/onboarding/reading';
navigate(data.timeConfidence === 'unknown' ? `/rectify/${profileId}` : next,
         { state: { from: 'onboarding', next } });

// Rectify.tsx :282 and :397 — honour the hint, else the dashboard as now
navigate(location.state?.next ?? '/dashboard');
```

`OnboardingReading` guards its own entry:

| Condition on entry | Result |
| --- | --- |
| No saved chart | Redirect to `/onboarding` |
| A complete report already stored for this chart | Redirect to `/dashboard` |
| AI not configured (`describeLlmStatus().configured === false`) | Show step 2 |
| AI configured | Show step 3 |

The predictive compute (`usePredictiveLayer({ auto: true })`, about 30 s under Pyodide, fully
local) starts when the route mounts, so the timing data is usually ready by the time the person
has read the outline.

### Edge cases

| Case | Behaviour |
| --- | --- |
| Birth time unknown | Rectify first (as now), then step 2 or 3. Skipping rectify also goes on to step 2/3. |
| Key test fails (bad key, bad model, unreachable) | The panel shows the provider's reason (existing `testProviderConnection` messages). "Try again" and "Skip for now" both visible. |
| 402 out of credit, at key test or mid-report | Same message the dashboard shows today for `errorKind: 'credits'`, plus "Retry" and "Go to dashboard". Sections already written are kept. |
| Any other mid-report failure | Failed sections are marked, the rest are kept (existing per-section degrade). "Retry failed sections" and "Go to dashboard". |
| Predictive data still computing when tapped | Natal chapters start at once. Timing chapters show "Waiting for your timing data" and start when it's ready. That queued start is part of the same tap, the same way the dashboard already queues `timelineRegenerationQueued`. |
| Predictive compute fails | Timing chapters do not run (existing fail-closed rule in `currentTimelineInputState`, no paid call on natal-only data). The page says so and offers "Go to dashboard". |
| Person leaves mid-stream | The run continues in the hook (as on the dashboard today) and the dashboard shows progress. |
| Chart regenerated later (Settings, Rectify from dashboard) | Does not open onboarding. Those flows navigate without `state.next`. |
| Local endpoint (Ollama) | Same steps 2 and 3. No price lookup, no cost line, lite prompts (Section 2). |
| Returning user who already has a chart | `/onboarding` still redirects them away as today, so they never see these steps. |

### One shared AI setup panel

`LlmModelSettings.tsx` becomes `components/features/ai/AiSetupPanel.tsx`. It is the only AI setup
UI in the app. `AiModelSettings.tsx` is deleted; `AiSettings.tsx` renders the panel inside its
card.

New props (all optional, so Settings needs none):

| Prop | Settings | Onboarding | Why |
| --- | --- | --- | --- |
| `onConnected?(status)` | unset | go to step 3 | Fires only after `testProviderConnection` resolves AND `flushSettings` has written to SQLite. Never on save alone. |
| `showOffChoice` | `true` | `false` | Onboarding's "off" is the "Skip for now" button outside the panel. |
| `intro?: ReactNode` | unset | the two lines above | Copy differs per surface; the panel stays one component. |

The panel keeps every existing guard: the OpenRouter-only credits and catalog reads, the
probe-race guard (`probeGen`), and the remote-Replace refresh.

## Section 2: the report structure (proposal for review)

### Principle: the engine draws the facts, the model writes the prose

Every date, band, planet, window and quarter boundary is rendered by the app straight from the
engine output. The model writes sentences around them. If the model drops or garbles a date, the
date on screen is still right. If the model invents a date, a deterministic check removes it
(see "The date guard").

### The five chapters

| Chapter | Built from | New or existing | Calls | Lifecycle |
| --- | --- | --- | --- | --- |
| 1. Overview | `core` + `yoga` sections | Existing, longer targets | 2 | Natal (stable) |
| 2. Your current period | new `current_period` section | Replaces `upcoming_periods` | 1 | Timeline (refreshable) |
| 3. The year ahead | new `year_ahead` section | Replaces `current_sky` | 1 | Timeline |
| 4. Life areas (7) | natal `guidance1` + `guidance2` and new `life_outlook_1` + `life_outlook_2` | Extends | 2 + 2 | Natal half + timeline half |
| 5. Remedies and guidance | `remedial` + a "this year's focus" line from `year_ahead` | Existing, longer | 1 | Natal |

Total: 9 calls (today: 7). The natal/timeline split from store v6 stays. Natal prose never
mentions dates; timeline prose is the only place dates appear. That rule
(`TIMING OWNERSHIP`, `structured-interpretation.ts`) is kept exactly. Life areas are the one
chapter that shows both: the enduring natal reading of the area, then "This year" below it.

### Chapter by chapter

Target lengths are words per voice (layman and technical each). The current full prompt asks for
"2-4 substantive paragraphs per persona field" (`modeHint`, `structured-interpretation.ts:616`)
but nothing measures what comes back. PR 2 records a baseline first (see PR 2).

#### 1. Overview

| | |
| --- | --- |
| Input | Sanitized natal chart without dashas or predictive (as now). Lagna, Moon, planets with dignity/nakshatra, houses, yoga list with grade and `strength_factors`. |
| Output | Unchanged schema: `summary` Persona; `strengths`, `challenges`, `life_themes` as `TitledPersona[]` (3 each); `integrated_yoga_narrative` Persona. |
| Target | Summary 120-160. Each titled item 60-90. Yoga narrative 250-350. Chapter total about 900-1,200. |
| Engine-drawn | Lagna sign, Moon sign and nakshatra, top three yogas with grade chips. |
| Lite | Unchanged lite tasks (`CORE_TASK_LITE`, `YOGA_TASK_LITE`): 2-sentence summary, 2-3 items, 1-2 sentences each. About 250 words. |

#### 2. Your current period

| | |
| --- | --- |
| Input | `dashas` (current maha, antar, pratyantar with month windows; current maha's `antar_sequence`; next maha row), `transits.fusion` (maha/antar lord's transit house from Moon and Lagna, reinforcing/afflicting, severity), and the natal facts for each lord (sign, house, dignity, `houses_ruled`, yogakaraka/combust/retrograde, yogas it is in). Nothing else from the predictive block. |
| Output | `{ maha: Persona, antar: Persona, activates: TitledPersona[] (2-3, by house/domain), next_change: Persona }` |
| Target | maha 150-200, antar 120-160, activates 60-90 each, next_change 100-140. About 550-700. |
| Engine-drawn | Maha and antar lords with month windows, months remaining, the next change month and the lord that follows, as a small timeline bar. |
| Lite | `{ maha, antar, next_change }` only, 1-2 sentences each. About 120 words. |

This replaces `upcoming_periods`. "What comes next" is `next_change`; the remaining antars of this
maha are drawn by the app from `antar_sequence` (they don't need prose each).

#### 3. The year ahead

| | |
| --- | --- |
| Input | The four quarters, computed by the app from the as-of month (e.g. 2026-10..12, 2027-01..03, ...). For each quarter, the engine events that fall in it: dasha changes from `antar_sequence`, `transits.timeline` events, `slow_hits`, and Sade Sati phase/`until_month`. All at month precision. |
| Output | `{ headline: Persona, quarters: [ { key: "Q1", layman, technical } x4 ], focus: Persona }` |
| Target | headline 100-140, each quarter 160-220, focus 60-90. About 800-1,100. |
| Engine-drawn | Quarter titles ("Oct-Dec 2026"), and under each one the list of its events with month and severity, straight from the engine. |
| Lite | headline plus one or two sentences per quarter, no `focus`. About 200 words. |

Quarters, not months. Twelve monthly blocks of prose would be repetitive in the quiet months and
cost three times the output. The month-level detail is still on screen: it's the engine's event
list under each quarter. `focus` feeds chapter 5 ("this year's focus").

The quarter keys are fixed by the app and sent in the prompt. The parser rejects any quarter key
it did not send.

#### 4. Life areas

Seven cards, in this order: career, finances, relationships, family, health, education,
spiritual. Each card has three parts.

| Part | Source |
| --- | --- |
| Strength chip and key planet | Engine: `domains_context` band (strong/moderate/weak), key graha, `key_graha_meets_minimum`, SAV bindus. The chip links to the existing strength receipt and assay explanation (`domain_strength_assays`). No model text. |
| "Your nature in this area" | Existing natal guidance: `career_guidance`, `finances_guidance`, `relationship_guidance`, `health_guidance`, `education_guidance`, `spiritual_guidance`. Target raised to 120-160 words. |
| "This year" | New `life_outlook_1` (career, finances, relationships, family) and `life_outlook_2` (health, education, spiritual). One Persona per domain plus `lean_into` and `watch_for` one-liners. Target 120-160 words. |
| Timing windows | Engine: each domain's `windows` (month, source dasha/transit, kind, severity, descriptor) as a list. No model text. |

`life_outlook_*` input is each domain's `SanitizedDomainForecast` (band, key graha, dasha
significator flags, matched dasha lords, Sade Sati, transit severity, windows) plus the natal
house-lord facts for that domain's houses. It does not get the full transit block.

Family has no natal guidance today. Ruling 5 adds a natal `family_guidance` field to `guidance1`
(no new call). Readings stored before that field existed show the engine part and "This year"
only on the family card.

`life_evolution_guidance` (from `guidance2`) moves to chapter 5 as "Your long arc".

Lite: one call per outlook group as in full, but each domain is a single 1-2 sentence Persona and
no `lean_into`/`watch_for`. The engine part of every card is identical in lite, so a small model
still gives a useful card.

#### 5. Remedies and guidance

| | |
| --- | --- |
| Input | As now (natal only). |
| Output | Existing `remedial_measures` Persona; target 300-400. Plus `life_evolution_guidance` (moved from chapter 4) and the `focus` Persona from `year_ahead`. |
| Lite | As now. |

### Whole-report numbers

| | Today | Proposed (full) | Proposed (lite) |
| --- | --- | --- | --- |
| Calls | 7 | 9 | 9 |
| Words per voice (target) | not measured | about 4,000-5,000 | about 1,000 |
| Engine-drawn facts | yoga grades | + dasha bar, quarter events, 7 strength chips, 7 window lists | same as full |

### Cost and latency on the cheapest model

Live OpenRouter catalog on 2026-10-10: `deepseek/deepseek-v4.1-flash` (the default,
`config.ts:193`) is $0.30 per million input tokens and $1.20 per million output tokens.
`deepseek/deepseek-v4-pro` is $0.24 / $0.48. Re-checked at 7:44 AM PT the same day: flash
$0.30 / $1.20, v4-pro $0.228 / $0.456 (see ruling 3).

Rough estimate (to be replaced by measured numbers in PR 2):

| | Input tokens | Output tokens | Cost on v4.1-flash |
| --- | --- | --- | --- |
| Today (7 calls) | about 45k (system ~1.9k + task ~1k + chart ≤4k each) | about 17k | about 3.5¢ |
| Proposed (9 calls) | about 65k (timeline calls carry a sliced predictive block) | about 28k | about 5.5¢ |
| Proposed, heavy reasoning | about 65k | about 55k | about 9¢ |

So the report costs the person roughly 5 to 9 cents. That is what the cost line shows, rounded.

Latency: sections run in parallel, so the slowest section sets the time. The 2026-10-01 timeline
benchmark finished in 49-65 s on v4.1-flash. `year_ahead` is the longest output (about 2.5-3k
tokens both voices). Budget: **P90 under 150 s** for the whole report, measured in the real spec.
If `year_ahead` alone blows it, split it into two calls (Q1-Q2, Q3-Q4); the schema already
allows that because quarters are keyed.

Local endpoints run lite prompts. Ollama usually serves one request at a time, so nine calls run
one after another. That is slow but free; the page shows per-section progress the whole time.
Per ruling 7, lite keeps all nine calls and runs the two `life_outlook` calls last.

Per ruling 4, every report section sends `reasoning.max_tokens = 6,000` on OpenRouter, so the
high end of the estimate is bounded: input + the full visible budget + 9 × 6,000 reasoning
tokens. On flash that worst case is about 11¢ (visible output at the targets +30 %, every section
using its whole reasoning budget); typical runs stay in the 5-9¢ range above. The cost line shows
the computed range, so it never understates the worst case.

### The cost estimate

New pure function in `@almamesh/llm`, `estimateReadingCost(messages, pricing, outputBudget)`:

- **Input** is exact enough: the app builds the nine message arrays before anything is sent and
  counts them with the existing `estimateTokens` (chars/4).
- **Output** is a per-section budget table derived from the targets above (words × 1.35 tokens ×
  2 voices) plus a reasoning allowance. Shown as a range, low to high.
- **Pricing** comes from `pricing.prompt` / `pricing.completion` on the OpenRouter `/models` row
  for the configured model. `fetchOpenRouterModels` (`client.ts:359`) already reads that
  endpoint and is already fail-closed to OpenRouter; it gains an optional `pricing` field.
- No price, unknown model, or a non-OpenRouter cloud endpoint: no cost line. Never a made-up
  number.

If the OpenRouter balance is known (`fetchOpenRouterCredits`, already used in Settings), step 3
always shows it next to the cost line. If it is below the high end of the estimate, step 3 also
warns before the tap (ruling 8).

### The date guard

The prompt rules on month precision are good but they are only prompt rules. This adds a
deterministic check that can fail.

`validateTimelineDates(sectionJson, allowedMonths)` runs after parse on the three timeline
sections (`current_period`, `year_ahead`, `life_outlook_*`). `allowedMonths` is the set of every
month the engine put in that section's input. Any `YYYY-MM` (or `YYYY-MM-DD`) in the prose that
isn't in the set:

- a day-precision date: the sentence is removed (day precision must never reach the screen);
- a month not in the set: the sentence is removed.

Removals are counted and stored on the entry (`dateGuardRemovals`), so a model that keeps
inventing dates is visible in tests and in diagnostics. This sits next to the existing layman
jargon guard (`asLayman`), which already removes sentences the same way.

### Replace or extend?

| Today | After |
| --- | --- |
| Natal: core, yoga, guidance1, guidance2, remedial | Same five keys, same schemas, longer targets. Extended. |
| Timeline: upcoming_periods, current_sky | Replaced by current_period, year_ahead, life_outlook_1, life_outlook_2. |
| Dashboard button "Get reading" | Same button, now produces the full report. |
| Dashboard "Refresh timeline" | Same button, refreshes chapters 2, 3 and the "This year" half of chapter 4. |

### Storage and migration

Stored in the existing SQLite-backed interpretation store, per `chartId`
(`packages/store/src/interpretation.ts`). Version 6 → 7.

| Field | Change |
| --- | --- |
| `CurrentTimelineEntry.content` | Becomes a union: `{ shape: 'v1', upcoming_periods, current_sky }` (what v6 stored) or `{ shape: 'v2', current_period, year_ahead, life_outlook }`. |
| `CurrentTimelineEntry.asOfMonth` | New. The month the year ahead counts from. Shown on screen ("The year ahead from Oct 2026"). |
| `CurrentTimelineEntry.dateGuardRemovals` | New, optional count. |
| `ChartInterpretationEntry.interpretation` | Unchanged shape. |
| `provenance` | Unchanged (`engine`, `model`, `baseUrl`, `predictiveAware`). Gains `promptSet: 'report-v2'` so a v2 report generated with older prompts can be told apart. |
| `inputProvenance.predictiveRequestKey` | Unchanged; required non-null for a v2 timeline (fail closed, as now). |

Migration v6 → v7 tags every existing timeline `content` as `shape: 'v1'`. No data is rewritten,
no text is dropped, nothing is regenerated. The dashboard renders `v1` with the existing
`DashboardCurrentTimeline` and shows "Get the full year ahead", which is a user action like any
other. Export/import carries the new fields through the existing portable state round trip.

### How the dashboard renders it

New `components/features/dashboard/ReadingReport.tsx` replaces the arrangement of
`DashboardInterpretation` + `DashboardCurrentTimeline`:

- A short contents list: the five chapters, each with its status (written, writing, failed,
  waiting for timing data).
- Chapter 1 open by default. Chapters 2-5 are the existing in-place collapsibles
  (`CollapsibleSection`), closed by default, so the page stays scannable on a phone.
- The For You / For Astrologer toggle drives every chapter at the render boundary, as now
  (`personaText`). No new model call.
- Caption under the title: "Written by deepseek/deepseek-v4.1-flash on 10 Oct 2026. Year ahead
  from Oct 2026."
- A legacy report (v6 natal + v1 timeline) renders as today, plus the "Get the full year ahead"
  button.
- It computes no astrology and makes no model call. The onboarding step 3 reuses the same
  component to show sections as they stream.

The PDF report is out of scope for this spec; it is a later PR 5 (ruling 2).

## Privacy and the hard rules

| Rule | How this design keeps it | Test that proves it can fail |
| --- | --- | --- |
| Paid calls only after an explicit UI action (`intent: 'user-request'`) | Step 3 mounts with zero completion requests. Only the **Get my reading** handler calls `streamInterpretation` and `streamCurrentTimeline`. | Mutation: call it from a `useEffect` → unit test (fetch spy, zero calls before click) goes red; e2e network log goes red. |
| Key stays on the device, goes only to the chosen provider | Panel unchanged. Price lookup goes through `fetchOpenRouterModels`, which refuses non-OpenRouter hosts. | Mutation: drop the OpenRouter host check → existing `client.test.ts` red; new e2e with a local endpoint asserts zero requests to `openrouter.ai`. |
| LLM input is PII-redacted, month precision | Same `sanitize.ts` path. New sections take slices of the already-sanitized object, never raw engine output. | Existing sanitize tests plus a new one: v2 prompts contain no `YYYY-MM-DD`. |
| No date invented by the model reaches the screen | Date guard above. | Mutation: return the input unchanged from `validateTimelineDates` → test with an injected fake month goes red. |
| Free forever | Copy says the provider charges, AlmaMesh doesn't. No payment code. | i18n test pins the cost-line strings in en/es/pt. |
| Honest AI disclosure (planet positions and period dates can reveal the birth date) | The panel's existing cloud disclosure (`tiers.cloud_body`, testid `tier-cloud-honesty`) is shown on step 2 too, not only in Settings. Step 3 repeats one line of it above the button. | Component test: the disclosure renders in the onboarding variant; mutation hiding it goes red. |

## PRs

Order: PR 1 and PR 2 are independent and can run in parallel. PR 3 needs PR 2. PR 4 needs PR 1
and PR 3.

Every PR follows the same discipline:

- **TDD.** Failing test first, watched failing for the right reason, then the smallest change.
- **Mutation red run.** Break the property the PR claims (listed per PR), show the test going
  red in the PR description, restore.
- **Live end-to-end.** `bun run build && bun run preview`, then drive the changed journey in
  desktop Chromium and in the iPhone 15 WebKit profile (`e2e/webkitProfile.ts`). Attach
  screenshots of each screen touched and the console log (must be clean) for both.
- **Gate.** `make gate` green locally and in CI, including the memory-budget lane.
- **Northstar.** Grade A against the named claim before merge.
- `frontend-quality` skill run on every change.

### PR 1: one shared AI setup panel

Claim touched: "Your key stays on this device and goes only to the provider you choose."
(Unchanged; the PR must prove it stays true.)

| Change | Files |
| --- | --- |
| Move `LlmModelSettings` to `components/features/ai/AiSetupPanel.tsx`; add `onConnected`, `showOffChoice`, `intro` | `components/features/ai/AiSetupPanel.tsx`, its tests (moved) |
| Delete `AiModelSettings.tsx`; `AiSettings.tsx` renders the panel | `pages/settings/AiSettings.tsx` |

Acceptance:

- Settings → AI looks and behaves exactly as before (screenshot diff, both profiles).
- `onConnected` fires once after a successful probe and SQLite flush, never on a failed probe,
  never when a newer save superseded the probe.
- The e2e `ai-settings.spec.ts` passes unchanged.

Red runs:

| Mutation | Test that goes red |
| --- | --- |
| Fire `onConnected` before `testProviderConnection` resolves | `AiSetupPanel.test.tsx` "does not report connected on a failed probe" |
| Fire it before `flushSettings` resolves | "reports connected only after the settings are durable" |
| Skip the `probeGen` check | existing probe-race test |

### PR 2: report sections in `@almamesh/llm`

Claim touched: "Readings use month precision only, and every date comes from the engine."

| Change | Files |
| --- | --- |
| Baseline: record word counts and `usage.cost` per section from the existing real specs (`openrouterUsage.ts`) and put the table in the PR | `e2e/interpretation.real.spec.ts`, `e2e/timeline.real.spec.ts` |
| New section keys `current_period`, `year_ahead`, `life_outlook_1`, `life_outlook_2`; full and lite tasks; parsers | `structured-interpretation.ts` |
| Per-section input slices of the sanitized predictive object | `structured-interpretation.ts`, `predictive-facts.ts` |
| App-computed quarters from the as-of month | new `quarters.ts` |
| `validateTimelineDates` | new `date-guard.ts` |
| `estimateReadingCost`; `pricing` on `OpenRouterModel` | new `cost-estimate.ts`, `client.ts` |
| Longer targets in `modeHint` and the natal tasks | `structured-interpretation.ts` |

Acceptance:

- Snapshot tests for every new prompt, full and lite, in en/es/pt.
- Parsers reject unknown quarter keys and unknown domains.
- `estimateReadingCost` returns no number when pricing is missing.
- Real spec (nightly, `OPENROUTER_API_KEY`): a full report on the default model finishes with P90
  under 150 s over 3 runs; actual `usage.cost` is inside the estimated range; word counts are
  within the targets ±30 %. Numbers in the PR.
- No live UI change, so the live e2e for this PR is the real spec plus the existing dashboard
  journey still green in both profiles.

Red runs:

| Mutation | Test that goes red |
| --- | --- |
| `validateTimelineDates` returns its input | `date-guard.test.ts` "removes a month the engine did not supply" |
| Let a `YYYY-MM-DD` through | "removes day-precision dates" |
| Pass the full predictive block to `life_outlook_1` | input-slice test asserting only domain forecasts are present |
| Hard-code a price when pricing is absent | `cost-estimate.test.ts` "no price, no number" |

### PR 3: store v7, hook, dashboard report

Claim touched: "Your reading is saved on this device and survives reloads, export and import."

| Change | Files |
| --- | --- |
| Persist version 7, `shape` union, `asOfMonth`, `dateGuardRemovals`, `promptSet` | `packages/store/src/interpretation.ts` |
| Hook runs the 4 timeline sections; one user action starts natal now and timeline when predictive is ready | `hooks/useStreamingInterpretation.ts` |
| `ReadingReport` component; dashboard mounts it | `components/features/dashboard/ReadingReport.tsx`, `pages/Dashboard.tsx` |
| en/es/pt strings | `locales/*/dashboard.json` |

Acceptance:

- A v6 store with a v1 timeline hydrates to v7 byte-for-byte equal content, renders as before,
  and shows "Get the full year ahead".
- Export → wipe → import round trip of a v2 report is identical (extend
  `portable-invariants.spec.ts`).
- Dashboard shows all five chapters with engine-drawn dates, bands and windows, in both voices.
- Live, both profiles: generate a report from the dashboard with a real key, reload, see the
  same report. Screenshots of each chapter open. Clean console.

Red runs:

| Mutation | Test that goes red |
| --- | --- |
| Migration drops `current_sky` | `interpretation.migration.test.ts` "v6 timeline survives as shape v1" |
| Render a band from model text instead of `domains_context` | `ReadingReport.test.tsx` "strength chip comes from the engine" |
| Start the timeline run on a natal-only chart when predictive is pending | existing fail-closed test plus new "queued, not sent" test |

### PR 4: onboarding reading route

Claims touched: "Paid AI calls happen only after you ask." and "AlmaMesh is free forever."

| Change | Files |
| --- | --- |
| `/onboarding/reading` route and page with the unlock and your-reading steps | `App.tsx`, `pages/OnboardingReading.tsx` |
| Onboarding and Rectify hand-off via navigation state | `pages/Onboarding.tsx`, `pages/Rectify.tsx` |
| Remove the cosmetic "interpretation" generating step | `pages/Onboarding.tsx` |
| Cost line, balance warning, outline, progress | `pages/OnboardingReading.tsx`, `locales/*/onboarding.json` |

Acceptance:

- Fresh profile, known time, no AI: chart → unlock → connect → your reading → tap → sections
  stream → dashboard shows the report.
- Fresh profile, unknown time: chart → rectify → unlock → ... → dashboard.
- Skip on unlock lands on the dashboard; the dashboard "Get reading" button still works later.
- Bad key, and a 402 (mocked in the hooked lane, real in the nightly lane with an empty key),
  each show retry and skip; neither traps the user.
- Local endpoint: no cost line, zero requests to `openrouter.ai` during the whole journey.
- Regenerating the chart from Settings never opens `/onboarding/reading`.
- Zero completion requests from mounting step 3 until the tap (network log in the e2e).
- Memory-budget lane stays green with the predictive compute starting on this route.

Red runs:

| Mutation | Test that goes red |
| --- | --- |
| Auto-start the reading on mount | `OnboardingReading.test.tsx` "sends nothing until Get my reading"; e2e network assertion |
| Rectify ignores `state.next` | `rectification.spec.ts` unknown-time journey |
| Fetch prices for a local endpoint | e2e "local endpoint never contacts OpenRouter" |
| Hide "Go to dashboard" while streaming | "dashboard link is always available" |

Live evidence for this PR, both desktop Chromium and the iPhone 15 WebKit profile:

| Screen | Screenshot | Console |
| --- | --- | --- |
| Generating (no fake step) | required | clean |
| Unlock your reading | required | clean |
| Key test failure | required | clean |
| Your reading, before tap (outline, model, cost) | required | clean |
| Your reading, streaming | required | clean |
| Dashboard with the report | required | clean |

## Open questions: resolved

The owner approved PR #325 with "yes to all" (take the recommended answer for each) and asked
for "more info in the structured report", so where a question traded length or depth against
cost, the ruling leans richer as long as it stays inside the cost range and the P90 < 150 s
budget. The plan is `docs/superpowers/plans/2026-10-10-reading-in-onboarding.md`.

1. **Replace `upcoming_periods` and `current_sky`?**
   Ruling: replace them with `current_period` and `year_ahead`, and keep stored v6 timelines
   readable as `shape: 'v1'`, because the new sections cover the same ground with engine-drawn
   dates and two extra overlapping calls would add cost and repeat prose; if this is wrong it
   costs one small PR to add the two old section keys back beside the new ones (about +1¢ and
   +2 calls per report), with no data loss since v1 content is never rewritten.
2. **PDF report.**
   Ruling: not in these four PRs; the five-chapter PDF is a separate PR 5 after PR 3 ships,
   because it touches the maximal-report gate and the page planner, which need their own
   Poppler and browser-download evidence; if this is wrong it costs a release where the web
   report is richer than the PDF (the PDF keeps today's sections, nothing breaks).
3. **Default model.**
   Ruling: the product default stays `deepseek/deepseek-v4.1-flash`; real-model e2e checks use
   `E2E_REAL_MODEL` (`deepseek/deepseek-v4-pro`), and PR 2's real spec measures P90 on both,
   because the live OpenRouter catalog at 7:44 AM PT on 2026-10-10 lists v4-pro at $0.228 /
   $0.456 per million input/output tokens against flash at $0.30 / $1.20 (pro is cheaper, so
   it is the right test model under the cheapest-model rule for e2e), but pro took 111-170 s on
   the 2026-10-01 timeline benchmark that flash finished in 49-65 s, so pro as the default
   would likely break the P90 < 150 s budget on the step where waiting matters most; if this
   is wrong it costs each user about 2.5¢ more per report than necessary (about 5.5¢ vs 3¢ at
   the typical estimate), and the fix is the one-line `RECOMMENDED_CLOUD_MODEL` change once
   PR 2's measured P90 on pro is under 150 s.
4. **Reasoning cap.**
   Ruling: yes, report sections send `reasoning.max_tokens = 6,000`
   (`REPORT_SECTION_REASONING_MAX_TOKENS`, OpenRouter only, never a cap on visible output),
   because measured runs use about 5k reasoning tokens per section, so 6k leaves normal
   thinking untouched while giving the cost line a hard, computable high end (the existing 12k
   runaway cap stays for other callers); if this is wrong it costs somewhat thinner prose on a
   section that needed more thinking, which PR 2's word-count check (targets ±30 %) catches,
   and the fix is one constant.
5. **Family.**
   Ruling: add a natal `family_guidance` field (120-160 words per voice) to the existing
   `guidance1` section rather than a new call, because the owner asked for richer content and
   a field in an existing call adds about 400 output tokens (about 0.05¢) and no latency, while
   leaving family as the only card without a natal reading would look like a gap; if this is
   wrong it costs a slightly longer `guidance1` output and one optional field that old stored
   readings lack (their family card shows engine data plus "This year", as originally
   proposed).
6. **Quarters or months.**
   Ruling: quarters, with the engine's month-level event list drawn under each quarter,
   because twelve monthly prose blocks repeat themselves in quiet months and triple the
   longest section's output (and its latency), while the month detail is still on screen from
   the engine; if this is wrong it costs a calendar-style rewrite of `year_ahead`'s schema
   later, which the keyed quarter schema makes local to one section and one card.
7. **Lite on slow local models.**
   Ruling: keep all nine calls in lite, including both `life_outlook` calls, but run the two
   `life_outlook` calls last; every card shows its engine part immediately and each section
   renders as it lands, because the owner asked for more content and local models are free,
   so the only cost is waiting, and the person can leave to the dashboard at any time while
   the run continues; if this is wrong it costs a few extra minutes of sequential local
   generation before the "This year" halves fill in.
8. **Balance warning.**
   Ruling: when the OpenRouter balance is known, step 3 always shows it next to the cost line,
   and adds a warning only when it is below the high end of the estimate, because the owner
   asked for more information and the balance is already read in Settings through the same
   OpenRouter-only path; if this is wrong it costs one line of screen space and one keyed
   credits read to OpenRouter (never to any other host) when step 3 opens.
