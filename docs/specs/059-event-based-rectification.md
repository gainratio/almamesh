# Event-based birth-time rectification — design spec

**Lifecycle:** SHIPPED
**Status:** Shipped 2026-06-27. Approved design dated 2026-06-26; branch
`feat/rectification-authority`. Phase 2 of
rectification-as-authority. Phase 1 (engine cusp fields + honest as-recorded/rectified UX) already
shipped at `0fdc3d9`.

**Shipped:** 2026-06-27. All 4 slices landed: contract+store+entry UI; cusp engine+results+confirm;
window/unknown-time mode; optional LLM accelerator (`structureLifeEvents` + `RECTIFICATION_FENCE`).
Gates green: backend pytest, parity 14/14, frontend typecheck + Vitest. Live-validated end-to-end
for both cusp and unknown-time modes on synthetic natives. The `/rectify/:profileId` wizard is
reachable from 3 CTAs (onboarding, ProfileSettings, dashboard cusp callout); confirm routes through
the existing birth-info-changed→regenerate pipeline. The e2e spec (`wizard-phase2.spec.ts`) is a
manually-run live gate (same pattern as `verify-*.mjs`), not wired to CI.

## TL;DR

A `/rectify` wizard. The user enters **dated, categorized** life events. The **Python engine** scores
candidate rising signs against them using the ascendant-dependent signals that actually discriminate
(dasha-lord ↔ house-lordship match + transit-to-house at the event date). The result is an **honest
ranking whose primary evidence is the candidate comparison, qualitative band, margin, and per-event
ledger**. A calibrated aggregate percentage may summarize the margin once the evidence gate is met,
but it must carry provenance and its supporting ledger and must never be framed as the probability
that a birth time is correct. The human confirms; the chosen time becomes the working authority
through the existing Phase-1 regenerate pipeline. Two modes in one wizard: **cusp** (2 candidate
signs) and **window / unknown-time** (rank the plausible rising signs).

## Context & trigger

Two reports for the same birth (30 Mar 1973, recorded 05:45, Vadodara) diverged **only** on the Lagna,
because the two times straddle the Aquarius/Pisces ascendant cusp (recorded 05:45 → Aquarius 28.82°,
~4 min from the boundary; rectified ~06:00 → Pisces 3.8°). Whole-sign houses then rotate one sign,
cascading the whole interpretation. The engine is byte-identical and correct — there is no bug. The
external Bayesian "Pisces 57%" was a coin-flip with false precision. The product principle (owner's,
standing): recorded times are unreliable, **event-based rectification is the legitimate way to find the
true ascendant, the rectified time is the working authority, both times are always shown, and
confidence must be shown honestly** — a near-tie is a labeled hypothesis, never a verdict.

## Goals

- Let a user resolve their rising sign from **dated life events**, on-device, deterministically.
- Cover both the **near-cusp 2-candidate** case (closes the original trigger) and the
  **unknown / rough time** case (today a dead-end that silently defaults to 12:00).
- Make the rectified time the **working authority** on human confirmation, with **both times always
  shown** (reuse the Phase-1 pipeline).
- Be **structurally honest**: qualitative bands, per-event evidence, a margin, and an explicit
  epistemic note. The evidence vector stays primary; an evidence-gated calibrated aggregate
  percentage may summarize top-vs-runner-up separation, never the probability a time is correct.

## Non-goals

- No exact-minute claim. Events resolve the rising **sign** (house rotation), not the birth minute.
- No LLM computation of astrology. The LLM, if used at all, only structures free text into reviewable
  rows. The deterministic engine computes everything.
- No automatic application. Rectification is always **human-confirmed** ("rectify to choose", never
  "we found your true time").
- No server. On-device, local-first, zero-egress by default (LLM assist is opt-in).

## The honesty spine (fixed constraints — not trade-offs)

1. **Sign, not minute.** Output is "your rising sign is most consistent with X" + a *representative*
   time. The UI states minute-level precision is not resolvable from events.
2. **Evidence vector before summary.** Result = ranked candidates + qualitative band
   (`near_tie` / `leans` / `consistent`) + the margin between the top two + a per-event evidence table
   + the honesty line. A calibrated aggregate percentage is allowed only above the min-evidence gate,
   with its event-validated provenance and supporting/opposing ledger visible; opaque false precision
   and probability language remain forbidden.
3. **Min-evidence gate.** Below a threshold of *discriminating* events, the wizard refuses to rank and
   says so, rather than fabricating confidence.
4. **Engine computes; LLM only optionally structures.** The privacy boundary is the structured form —
   the engine sees only `{date, category}`. LLM assist is opt-in, behind the existing cloud fence, with
   the typed output (name-free by construction) as the boundary.
5. **Determinism + parity + PII.** Pin `reference_date` and the dasha year-convention; the
   Pyodide==CPython parity gate covers the new entry; golden fixtures use the **synthetic Bengaluru cusp
   native only** — never the owner's real birth data. TDD + 3-way i18n (en/es/pt) throughout.

## Architecture

### 1. Engine scorer — `backend/src/almamesh/rectification/` + `edge/chart_runtime.py::compute_rectification`

The discrimination physics (confirmed against the engine): dasha *timing* is Moon-driven and therefore
ascendant-invariant, but **whether a dated period is "about" marriage / career / children depends on
house lordships, which rotate when the ascendant flips a sign.** Transit-to-house at the event date
rotates too. These are the signals that distinguish Aquarius-rising from Pisces-rising for the same day.

Per candidate ascendant, reusing **one warm `SkyfieldAstronomy`** (not a DE421 reload per candidate):

1. Resolve the active dasha lords (MD / AD / PD) at each event date from the natal Vimshottari tree
   (`VimshottariDashaData`; timing is ascendant-invariant).
2. Map the event category → classical house(s) over the existing `EventType` enum
   (`backend/src/almamesh/constants/astrology.py:51`): e.g. MARRIAGE/ENGAGEMENT → 7; CHILDBIRTH → 5;
   CAREER_CHANGE/PROMOTION/JOB_LOSS/BUSINESS_START → 10 (with 2/11 for gains); RELOCATION → 4/12;
   PROPERTY_PURCHASE → 4; HEALTH_ISSUE/SURGERY → 6 (8 for surgery); HIGHER_STUDIES → 4/5/9;
   LITIGATION → 6; WINDFALL → 2/11; EXPENSE_SHOCK → 12. (Exact map finalized in the scorer with
   citations; this is the seed.)
3. **Discriminator (primary):** does an active dasha lord rule or occupy the category's house(s) in
   *this candidate chart*? House lordship rotates with the ascendant, so the same active lord scores
   differently per candidate. (The forward logic already exists in
   `backend/src/almamesh/dasha/vimshottari.py` `_extract_vim_*_signals`, reading
   `context.houses[h].sign_lord`; we reuse the *signal-extraction* idea but write a clean **inverse**
   scorer and do **not** import the quarantined heuristic `dasha/scoring.py`.)
4. **Discriminator (secondary):** at the event date, is a slow transiting graha (Jupiter/Saturn) in or
   aspecting the category's house-from-lagna? `calculate_transit_context(natal, birth_dt,
   transit_instant=<event_date>)` exposes `house_from_lagna` (ascendant-dependent). `house_from_moon`
   and Sade-Sati are ascendant-invariant and so do not help *sign* discrimination — exclude from the
   discriminating score (may still display as context).
5. **De-correlation:** cap the contribution per category and down-weight clustered same-signature
   events, so repeating one astrological signature cannot inflate confidence (the
   double-counted-correlated-events failure mode from the external analysis).
6. Aggregate per-candidate scores → rank → compute the **margin** (top − runner-up, normalized) →
   map margin to a qualitative **band**. Emit per-event evidence with machine signal keys.

### 2. Candidate generation

- **Cusp mode:** binary-search the exact sign-boundary-crossing time on the birth day (on Lagna
  longitude); the two candidates = the as-recorded sign and `lagna_adjacent_sign`, each represented by
  a time inside its arc.
- **Window / unknown mode:** coarse-to-fine. Coarse pass samples one representative time per rising
  sign across the plausible range (whole day for unknown; ±margin from `TIME_CONFIDENCE` for rough) and
  ranks signs; an optional fine pass refines the representative time within the winning sign, clearly
  labeled "sign-level, not minute-level."

### 3. Compute strategy on the single Pyodide worker

- **One** `computeRectification` round-trip — the engine sweeps candidates internally; we do **not**
  fire N `generateChart` calls from JS (no batch/cancel/priority exists at the worker; one round-trip
  with a warm ephemeris is far cheaper).
- While the wizard is open, **gate the auto-predictive job** (`usePredictiveLayer({ auto: true })`) so
  the ~35 s predictive compute doesn't block the worker; resume after.
- Two-phase call (fast coarse → optional fine) gives honest progress + a timer like the predictive one.
- Cancel-on-unmount discards results (the worker has no abort; discarding is acceptable and cannot
  corrupt the persisted chart, which only changes via the explicit confirm path).

### 4. Wizard UX — dedicated `/rectify/:profileId`

Reachable from three places that are dead-ends today:
- onboarding's unknown-time path (`needsRectification`, set in `packages/store/src/onboarding.ts` but
  never acted on),
- the ProfileSettings rectification panel (`apps/web/src/pages/settings/ProfileSettings.tsx`),
- the dashboard cusp callout (`IdentityStrip`).

Steps:
1. **Intro / honesty** — what this does and does not do; auto-detects mode (near-cusp → cusp; unknown
   / rough → window).
2. **Events entry** — structured rows: date picker + category dropdown (localized `EventType`) +
   optional **private note that never leaves the device**. Add / edit / delete rows. Optional "paste
   your story" accelerator: the LLM pre-fills reviewable rows behind the cloud opt-in + an explicit
   "this text goes to your AI endpoint" warning; the user reviews/edits before fitting. Min-events
   guidance.
3. **Fit** — runs `computeRectification`; progress + honest timer.
4. **Results** — ranked candidates with qualitative band, per-event evidence table, the margin, the
   honesty line, the recorded-time comparison (reuse `BirthTimeComparison`), the cusp caveat. **No %.**
5. **Confirm** — pick a candidate or keep the recorded time. Accept → emit `birth-info-changed` with
   the representative time → existing `useRegenerationSubscription` → `regenerateOnBirthChange` →
   rectified becomes authority, `birth_time_original` preserved. Reuse `RegenerationConfirmModal`
   sign-flip acknowledgement when the rising sign changes.

### 5. Contract changes (Python → SiderealChart-style → shared-types → store → UI)

- **Python:** new `rectification/` module; `RectificationResult / RectificationCandidate /
  EventEvidence` Pydantic models; `edge/chart_runtime.py::compute_rectification`. Reuse `EventType`.
- **`@almamesh/shared-types`:** the result types + a `LifeEventCategory` union mirroring `EventType`.
- **`@almamesh/browser`:** `pyodide/rectification.ts` + `ChartEngine.computeRectification`.
- **`@almamesh/store`:** `adapters/rectification.ts` (pure reshape) + a transient `useRectificationStore`
  (a derivation, not persisted). **Extend `lifeEvents.ts`:** `LifeEvent` gains a **required** `date` and
  `category: LifeEventCategory`, plus optional `note`; bump `LIFE_EVENTS_PERSIST_VERSION` and migrate
  the old single free-text blob → one uncategorized row flagged for the user to structure; add
  `editEvent` / `removeEvent(id)` CRUD (today only `setEvents` / `addEvent` / `clearEvents`).
- **`@almamesh/llm`:** optional `structureLifeEvents(text, language) -> { events: [{date, category,
  confidence}] }` via `chatCompletionJson` (`response_format: json_object`, wrapped object) following
  the `mesh-reading.ts` parse-with-safe-default template; a new `RECTIFICATION_FENCE` constant in
  `prompt.ts` ("rectify to choose, not we-found-your-true-time; confidence is a hypothesis, never a
  verdict; structure events only — never compute or interpret astrology"); reuse `withLanguage` i18n.

### Data models (shape, finalized in implementation)

```
# Python (Pydantic) → mirrored in @almamesh/shared-types
RectificationCandidate {
  ascendant_sign: ZodiacSign
  representative_time_local: str        # HH:MM, representative — NOT a precise claim
  lagna_longitude_deg: float
  lagna_cusp_distance_deg: float        # reuse Phase-1 field
  is_near_cusp: bool
  fit_score: float                      # raw, exposed for transparency
  supporting_events: list[EventEvidence]
}
EventEvidence {
  event_index: int
  category: EventType
  date: date
  signals: list[str]                    # machine keys, e.g. "dasha_lord_rules_7th", "jupiter_transit_7th"
  contribution: float
}
RectificationResult {
  mode: "cusp" | "window"
  candidates: list[RectificationCandidate]   # ranked, best first
  margin: float                              # normalized top − runner-up
  band: "near_tie" | "leans" | "consistent"
  discriminating_event_count: int
  recorded_time_sign: ZodiacSign | None      # what the as-recorded time yields
  honesty_note_key: str                      # i18n key, not baked prose
}

# Frontend store (canonical OPFS SQLite row, per profile) — extended
LifeEvent { id: string; date: string; category: LifeEventCategory; note?: string; createdAt: string }
```

### 6. Error handling

- Engine failure → retryable in-app, never a dead-end (engine-recovery invariant; reuse `reboot()` /
  `whenReady()`).
- Too few discriminating events → honest "can't distinguish — add more dated events or rely on your
  recorded time."
- LLM assist failure / opt-out → manual entry remains fully functional (LLM is strictly optional).
- Near-tie → both candidates + the recorded time shown; labeled hypothesis.
- Unmount / cancel → discard transient results; the persisted chart is untouched.

### 7. Test plan (TDD, per slice)

- **Backend:** golden-fixture rectification on the synthetic Bengaluru cusp native — synthetic events
  that *should* discriminate one sign → assert the right sign + band; non-discriminating events →
  assert `near_tie`; assert the min-events gate. Determinism with pinned `reference_date`. Pyodide==
  CPython parity for `compute_rectification`.
- **Scorer units:** category→house map, dasha-lord match, transit corroboration, de-correlation cap,
  margin→band mapping, min-events gate.
- **Frontend:** `lifeEvents` migration + CRUD; adapter reshape; wizard component tests **asserting no
  "%" is rendered and the honesty note + recorded time are present**; engine-retry test.
- **i18n:** 3-way key parity for all new keys + the `verify-i18n` live check.
- **Live end-to-end** (project Playwright Chromium, production build — module Workers need it): enter
  events → fit → honest ranked result → confirm → rectified chart authoritative with both times +
  clean console; plus the unhappy paths (engine slow/fail → recover; too-few-events).
- **PII:** grep every agent diff before commit; synthetic fixtures only.

## Reuse map (anchors for implementers)

- Ascendant math + cusp fields: `backend/src/almamesh/calculations.py` (`_cusp_proximity` ~:493,
  `calculate_sidereal_context` ~:668), `schemas/astrology.py:84-89`.
- Forward signal-extraction to mirror (do NOT import scoring): `dasha/vimshottari.py`
  `_extract_vim_*_signals`; event taxonomy `constants/astrology.py:51`.
- Transit-at-date: `transits/__init__.py:46` `calculate_transit_context(..., transit_instant=...)`.
- Engine entry pattern to mirror: `edge/chart_runtime.py` (`compute_predictive`, `compute_mesh`).
- Live preview primitive: `apps/web/src/hooks/useLagnaPreview.ts`.
- Authority pipeline: `packages/store/src/regenerate.ts` (`regenerateOnBirthChange`),
  `packages/store/src/events.ts` (`birth-info-changed`), `hooks/useRegenerationSubscription.ts`.
- Reusable UI: `BirthTimeComparison.tsx`, `RegenerationConfirmModal.tsx`,
  `lib/rectification.ts` (`rectificationDeltaFromClocks`), `lib/lagnaCusp.ts` (`cuspInfo`).
- Events store to extend: `packages/store/src/lifeEvents.ts`.
- Time confidence: `packages/constants/src/astrology.ts:90` (`TIME_CONFIDENCE`).
- LLM structuring reuse: `packages/llm/src/client.ts:106` (`chatCompletionJson`),
  `mesh-reading.ts` (parse-with-safe-default template), `prompt.ts` (fence constants).
- i18n catalogs + gates: `apps/web/src/locales/{en,es,pt}/*`, `*.parity.test.ts`,
  `scripts/verify-i18n.mjs`.

## Build slices

1. **Contract + store + entry UI:** shared-types result/category types; extend `lifeEvents` (date +
   category required, note, migration, CRUD); structured event-entry UI (no fit yet).
2. **Engine scorer + cusp mode + results + confirm:** the inverse scorer, cusp-candidate generation,
   `compute_rectification`, browser/store wiring, results UI with honest bands, confirm → authority.
   *Closes the original two-reports trigger.*
3. **Window / unknown-time sweep:** coarse-to-fine candidate generation + progress + two-phase compute
   + the auto-predictive gating.
4. **Optional LLM assist:** `structureLifeEvents` + `RECTIFICATION_FENCE` + the "paste your story"
   accelerator behind the cloud opt-in.

i18n (3-way), tests, and live validation ride each slice.

## Risks / open questions (resolve during implementation)

- **Category→house map fidelity.** Seed above; finalize with classical citations in the scorer and a
  unit test per category. Keep it conservative; prefer fewer, well-grounded houses per category.
- **Band thresholds.** `near_tie` vs `leans` vs `consistent` cutoffs on the normalized margin are a
  calibration choice; pick defensible defaults, expose as named constants, and bias toward calling
  `near_tie` (under-claiming is the safe failure).
- **Compute time for the full-day window sweep** on Pyodide. Coarse pass is one chart per sign (≤12);
  acceptable. Validate real wall-clock in the live gate; if too slow, cap signs by plausibility.
- **Min-events threshold.** Start at ≥3 discriminating events to leave `near_tie`; tune with fixtures.
