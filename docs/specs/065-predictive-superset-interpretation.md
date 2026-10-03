# Spec 065: Predictive-Superset Interpretation & Chat

**Status:** Superseded by the manual natal/timeline split (2026-09-21)
**Created:** 2026-07-09
**Priority:** P1 HIGH
**Dependencies:** Spec 062 (robust rectifier + grounded LLM), the predictive pipeline (transits/vargas/strength/domains), Spec 063 (AI tiers)

## Goal

> Historical design note: this draft proposed automatic paid enrichment when
> predictive facts became ready. The shipped contract deliberately supersedes
> that behavior. Natal interpretation and the date-sensitive current timeline
> are independent persisted artifacts, each generated only by its own explicit
> user action. Dashboard mount, reload, deployment, and day rollover make zero
> LLM requests. The timeline waits for exact-day deterministic facts; an engine
> failure never falls through to a paid natal-only timeline request.

Make the AI **life-chart interpretation** (and chat) genuinely predictive and differentiated by feeding the LLM the **full predictive superset** the engine already computes — current transits/Gochara, three-level dasha timing, Sade Sati, dasha-transit fusion, Shadbala/Ashtakavarga strength, and per-life-domain dated forecast windows — and making those aspects **salient** in the prompt and on screen. Today the reading reads generic because the predictive data is never present when the reading is generated. This is real user feedback ("too generic, not predictive; chat is a little better").

---

## Current State

The plumbing to pass predictive context to the LLM **already exists and works** — it just never has data at generation time. Verified by investigation (three parallel code audits):

1. **Timing race (primary root cause).** The natal reading auto-fires the instant the chart loads (`Dashboard.tsx:386-424`), with **no dependency on predictive readiness**. The predictive layer doesn't start until `AUTO_KICKOFF_DELAY_MS = 2500`ms after engine-ready (`usePredictiveLayer.ts:58`) and then takes ~30s on the single serial Pyodide worker. So `withRawPredictive` (`useStreamingInterpretation.ts:147-157`) **fail-opens to natal-only** (`status !== 'ready'` → returns the chart unchanged). The reading is built with zero transits / Sade Sati / fusion / vargas / strength / domain forecasts. And it is **one-shot** (`autoGenerationTriggeredRef`), so nothing regenerates when predictive lands ~30s later.
2. **Weak prompt leverage even when predictive is present.** The predictive block is appended only when non-empty and gated behind a *permissive* `PREDICTIVE_CONTEXT_EXCEPTION` ("You MAY cite…", `structured-interpretation.ts:530-539`). Only 1 of 6 sections (`upcoming_periods`) is timing-shaped, and the base `SYSTEM_PROMPT` even asserts *"there is NO … transit data in this chart"* (`structured-interpretation.ts:140`).
3. **No predictive/"current sky" section is rendered** in the dashboard reading (`DashboardInterpretation.tsx:137-143` renders natal-shaped fields + `upcoming_periods`, which draws on the natal dasha tree, not `transit_context`/`domains_context`).
4. **Chat is not actually richer** in predictive — it composes the *same* `buildPredictiveFactsBlock`. It merely *feels* better because it layers the finished reading + history + RAG on top. So the readiness fix helps chat too.

The predictive store **is persisted** (`@almamesh/store` `predictive.ts`, canonical OPFS SQLite row `almamesh-predictive`, v3 persists raw `rawContexts`), idempotent per `profileKey@referenceInstant`, so once computed it survives reloads, travels in an AlmaMesh backup, and is cheap to reuse. IndexedDB is migration-only for older installations and is deleted after the SQLite write is verified.

---

## Requirements

### Must Have
- **Predictive data is present in the interpretation at generation time.** Implement **enrich-when-ready**: the reading paints fast (natal, as today), then auto-regenerates composing the **full predictive superset** the moment `usePredictiveStore` reaches `ready` — once, never downgrading.
- **Provenance tracks predictive-awareness** so the upgrade fires exactly once and a predictive-aware reading is never replaced by a natal-only one.
- **The prompt makes predictive salient**: when predictive is present, remove the "no transit data" contradiction, and upgrade the predictive instruction from *permissive* to **required** (ground claims in the current windows; name the running dasha stack, current transits by house from Lagna and Moon, Sade Sati phase, and month-precision domain windows).
- **A dedicated, prominently-rendered predictive section** ("What's active now & next") in the dashboard reading and the report, fed by the full predictive facts.
- **Chat carries the same superset** (readiness fix + confirm the predictive facts block is not truncated).
- **Honesty fence preserved** (calculation-integrity mandate): engine values verbatim, month-precision only, `approximated`/band = convention surfaced, no invented daily precision, LLM never fabricates.
- **A quiet UX affordance** during the upgrade ("deepening with your current timing…") so the visible refinement reads as intentional, not a flicker/bug.
- Full **en/es/pt** i18n parity for any new copy.

### Should Have
- If predictive is **already `ready`** at first generation (e.g. same-day reload, or AI configured after predictive finished), generate the predictive-aware reading in the **first** pass (no second call).
- A small "Enriched with your current timing" caption on a predictive-aware reading (mirrors the existing provenance caption).

### Out of Scope
- Changing the engine / predictive math (byte-parity contract unchanged).
- Sending all 16 full varga charts off-device (summaries only — vargottama/shadvarga/vimshopaka — continue to leave; full charts stay on-device).
- Threading the mesh edge into dashboard chat (capability exists but is a separate concern).
- Rectification, mesh, or predictive-page UI changes beyond the reading.
- Daily/degree-level precision (violates the honesty fence).

---

## Technical Design

### 1. Timing — enrich-when-ready (the root fix)

**Provenance flag.** Extend the reading provenance (`@almamesh/llm` `provenance.ts` `ReadingProvenance`) with `predictiveAware: boolean` (was the full predictive superset composed into this reading?). The interpretation store entry already carries provenance; stamp it from whether `withRawPredictive` actually merged contexts.

**Trigger.** In `Dashboard.tsx` (or a small dedicated hook it mounts), add a second, one-shot effect:
- Reads `usePredictiveStore().status` and the current interpretation entry.
- Fires **once** when: `status === 'ready'` AND a `complete` reading exists AND that reading's provenance `predictiveAware !== true` AND AI is configured AND not currently streaming.
- Calls the existing regenerate path (`handleRegenerateReading`-equivalent) so the reading re-streams composing predictive. Guard with its own ref so it fires at most once per mount and never loops.

**First-pass shortcut (Should Have).** The auto-generate effect (`Dashboard.tsx:386-424`) additionally checks predictive `status`; if already `ready`, the first pass is predictive-aware and the upgrade effect never fires.

**withRawPredictive** (`useStreamingInterpretation.ts:147-157`) is unchanged — it already merges `rawContexts` when `ready`. It becomes the single source of the `predictiveAware` stamp.

### 2. Prompt salience (`structured-interpretation.ts`)

- **System prompt is predictive-conditional.** When the predictive block is present, the "DASHA HONESTY … there is NO … transit data" clause is replaced by an affirmative capability statement: the model HAS current transits, the running dasha stack, Sade Sati, strength, and per-domain dated forecasts, and MUST use them. When absent, the existing natal-only honesty clause stands (so a natal-only first paint is still honest).
- **`PREDICTIVE_CONTEXT_EXCEPTION` → required.** Rewrite from "You MAY cite" to a directive: ground every forward-looking or life-area claim in the engine's current windows; name the running dasha lords (maha/antar/pratyantar), current transits by house (from Lagna and Moon), Sade Sati phase + rough end, and cite month-precision windows verbatim. Keep the honesty guardrails (month-precision, no invented dailies, bands = convention).
- **Section tasks** (`SECTION_TASKS`): reshape `guidance1`, `guidance2`, `remedial`, and `upcoming_periods` so that **when predictive is present** they demand the domain's `current_emphasis` (active dasha significator, under-Sade-Sati, transit severity) and next `upcoming_windows`, plus the dasha-transit `fusion`. Natal-only behavior is preserved when the block is absent.

### 3. Dedicated predictive section

- Add an `InterpretationSectionKey` value, e.g. `current_sky`, with its own `SECTION_TASK` fed by the transits + Sade Sati + fusion + domain-window facts. Add it to `ALL_SECTIONS` and to `INTERPRETATION_SECTIONS` (the progress checklist, `useStreamingInterpretation.ts:49-55`, which currently also omits `upcoming_periods` — fix both).
- The section is only meaningful when predictive is present; when absent it yields empty and is not rendered (graceful for the natal-only first paint).
- Render it prominently in `DashboardInterpretation.tsx` (near the top of the reading, above or alongside the core narrative) and in the report layer (`buildGuidanceSections` neighbours / report selectors), using the same progressive-disclosure grammar.

### 4. Chat

- The readiness fix carries chat automatically (`Dashboard.tsx` `askLocalLlm` already composes `withRawPredictive`). Confirm `buildChartFactsBlock` / `buildPredictiveFactsBlock` are not truncated under `CLOUD_CHAT_BUDGET` (they are not: `includeRawPredictive: true`, `promptTokens: null`).
- No new chat parameters required.

### 5. Data contract touched

```
Python compute_predictive_contexts (unchanged)
  → @almamesh/browser pyodide/predictive.ts (unchanged)
  → @almamesh/store usePredictiveStore.rawContexts (unchanged; already persisted v2)
  → withRawPredictive merges onto chart  (unchanged; now also stamps predictiveAware)
  → @almamesh/llm sanitizeChartForLlm + buildPredictiveFactsBlock (unchanged emit surface)
  → structured-interpretation prompt   (CHANGED: salient/required + new current_sky section)
  → InterpretationSectionKey / provenance (CHANGED: + current_sky, + predictiveAware)
  → DashboardInterpretation + report    (CHANGED: render current_sky)
```

No engine, bundle, or byte-parity changes.

---

## Files to Create/Modify

| File | Changes |
|------|---------|
| `frontend/packages/llm/src/provenance.ts` | Add `predictiveAware: boolean` to `ReadingProvenance` (+ `configProvenance` stamps it) |
| `frontend/packages/llm/src/structured-interpretation.ts` | Predictive-conditional system prompt; `PREDICTIVE_CONTEXT_EXCEPTION` permissive→required; reshape guidance/remedial/upcoming tasks; add `current_sky` section key + task + `ALL_SECTIONS` |
| `frontend/packages/llm/src/index.ts` | Export any new types (`InterpretationSectionKey` already exported) |
| `frontend/apps/web/src/hooks/useStreamingInterpretation.ts` | Stamp `predictiveAware` from `withRawPredictive`; add `current_sky` to `INTERPRETATION_SECTIONS` (+ `upcoming_periods` fix) |
| `frontend/apps/web/src/pages/Dashboard.tsx` | Enrich-when-ready effect (one-shot, gated on predictive `ready` + `!predictiveAware`); first-pass predictive-ready shortcut; upgrade affordance |
| `frontend/apps/web/src/components/features/dashboard/DashboardInterpretation.tsx` | Render the `current_sky` predictive section; upgrade caption |
| `frontend/apps/web/src/lib/reportSelectors.ts` + report layer | Surface `current_sky` in the web/PDF report |
| `frontend/apps/web/src/locales/{en,es,pt}/*.json` | New copy: section title/labels, "deepening with your current timing…", enriched caption |
| Test files (each touched module) | **NEW/updated** unit tests (TDD, red first) |

---

## Implementation Phases

### Phase 1: Provenance + prompt salience (llm package, TDD)
- Red tests: `configProvenance` includes `predictiveAware`; the section builder, **when predictive is present**, (a) omits the "no transit data" clause, (b) emits the *required* directive, (c) includes the `current_sky` section; **when absent**, behaves exactly as today (natal-only, honest).
- Implement prompt changes + `current_sky` section + provenance field.
- Test: `cd frontend/packages/llm && bun run test`.

### Phase 2: Enrich-when-ready trigger + rendering (web app, TDD)
- Red tests: the upgrade effect fires once when predictive transitions to `ready` and the reading is not predictive-aware; does NOT fire when already predictive-aware or when no reading exists; `predictiveAware` is stamped when `withRawPredictive` merges; `DashboardInterpretation` renders the `current_sky` section when present and hides it when empty.
- Implement the effect + first-pass shortcut + section render + affordance + i18n.
- Test: `cd frontend/apps/web && bun run test:unit`.

### Phase 3: Full gate battery + live-val + northstar
- Typecheck all packages; web lint; llm + web unit; build; exit gate (incl. CHECK 7).
- Live-val (Playwright, real built app): drive onboarding→dashboard, wait for predictive to land, assert the reading **visibly refines** and now **names** a current transit / Sade Sati status / a dated domain window (regex on rendered text), with a clean console; confirm chat answers cite predictive specifics.
- **northstar → grade A**; address punch list.

---

## Success Criteria

1. A dashboard reading generated on the normal flow **contains engine-grounded predictive specifics** — the running dasha stack, at least one current transit by house, Sade Sati status, and ≥1 dated (month-precision) domain window — proven live, not just unit-mocked.
2. The reading **paints fast** (natal first paint unchanged) and then **upgrades once** to predictive-aware without a second manual action; provenance shows `predictiveAware: true`.
3. A natal-only reading (predictive not yet ready / disabled) remains **honest** (no fabricated timing) and never claims transit data it lacks.
4. Chat answers cite the same predictive superset.
5. All quality gates green; **northstar grade A**.

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Second LLM pass ~30s later feels like a flicker/bug | Explicit "deepening with your current timing…" affordance + "Enriched with your current timing" caption; the natal reading stays readable during the upgrade |
| Extra LLM cost (one more call on the user's key) | Should-Have first-pass shortcut when predictive already `ready`; only upgrade when a reading is actually predictive-unaware; never loop (one-shot ref + provenance guard) |
| Upgrade loop / thrash | Fire-once ref + `predictiveAware` provenance guard + never regenerate a predictive-aware reading |
| Model over-claims precision from the richer data | Honesty fence unchanged: month-precision only, `approximated`/band flags surfaced, required directive still forbids invented dailies; live-val asserts no day-level dates |
| Predictive never lands (user leaves dashboard before ~30s) | Reading stays the honest natal-only version; upgrade fires on a later visit once predictive is `ready` (persisted) |

---

## Quality Validation

### Required Agent Checks
**Frontend (`code-quality-frontend`):** `bun run --filter '*' typecheck` · `bun run --filter @almamesh/web lint` · llm + web unit green.
**Architecture (`architecture-advisor`):** review the enrich-when-ready control flow (one-shot, no loop) and the prompt-salience contract.

### Testing Requirements
- llm: provenance `predictiveAware`; predictive-present vs -absent prompt shape; `current_sky` section presence.
- web: upgrade effect fires exactly once on `ready`; `predictiveAware` stamping; `current_sky` render/hide.
- live-val: rendered reading names transit/Sade-Sati/domain-window specifics; clean console; chat cites predictive.

### Security / Integrity Checklist
- [ ] Honesty fence intact — month-precision, `approximated`/band surfaced, no invented dailies (calculation-integrity mandate).
- [ ] Sanitizer boundary unchanged — only the identifier-free superset leaves the device; no new PII in the prompt.
- [ ] No secrets; no new network egress beyond the existing opt-in LLM call.

### Pre-Merge Checklist
- [ ] All gates pass (typecheck, lint, unit, build, exit gate incl. CHECK 7).
- [ ] Live-val proves predictive specifics on screen + in chat.
- [ ] i18n en/es/pt parity.
- [ ] **northstar grade A.**

---

## References
- Investigation (this session): three parallel code audits mapping the interpretation prompt, the chat/sanitizer menu, and the predictive engine outputs + timing.
- `CLAUDE.md` Data Contract (predictive layer, dual-voice reading, `withRawPredictive`).
- Spec 062 (grounded LLM + honesty fence), Spec 063 (AI tiers).
