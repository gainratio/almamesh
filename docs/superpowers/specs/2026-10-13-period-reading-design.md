# Period reading: one elaborate, citable tool for today and time travel (Phase 1)

Status: approved by Harish 2026-10-13. Branch `claude/time-travel-threads` (local only).

## TL;DR

Today and time-travel answers are vague because the model is not given the Vedic facts it would
need to be specific, and the prompt then forbids it from saying anything it was not given. Phase 1
fixes both halves: the engine computes one compact **period reading** (dashas down to pratyantar,
the running lords with their lordships, the slow-planet sky per segment with Moon-based tags, and
per-domain themes with plain agreement flags), and the chat gets it through one registered tool,
`get_period_reading`. The prompt then asks the model to be specific and cite those facts.

Definition of done (Harish): "AI chat has a lot of context via tools and we are as predictive as
possible given the limits of Vedic astrology."

1. Every calculable signal for the period reaches the model through registered, visible tools,
   not prompt text.
2. Answers are as specific as Vedic astrology honestly allows: life areas and houses, lords and
   their lordships, dated windows inside the period, strength and confidence, every claim backed
   by a cited engine factor. The model still never names a concrete event.

## Why answers are vague today (audit, verified against the code)

1. **Missing facts.** A trip's `get_natal_summary` (`tripContext.ts natalSummary`) drops
   lordships, yogakaraka, combustion, the D9 and the yoga basis. Today's chat gets these through
   `packages/llm/src/facts.ts`. Trips also filter out `get_chart_facts` (`chatToolset.ts`).
2. **The fence has nothing to cite.** `prompt.ts` DERIVED-FACT FENCE forbids lordships and yogas
   that are not explicitly present, so the model cannot say "Saturn, your 12th lord".
3. **Hedging lines.** `prompt.ts` ("dasha periods beyond those stated do not exist"), the
   `PERIOD_RULES`, `PRATYANTAR_NOTE` (`period-dashas.ts`), `timingTool.ts covered_events`, and
   `Dashboard.tsx` "Do not guess life events" all push the model toward generic text.
4. **One instant for a whole period.** Domains and strength are measured once, at `period.start`.
   A year has dasha changes, ingresses and stations inside it; none of them split the reading.

Parser bugs found in the same audit:

- `timingQuestion.ts MONTH_NAMES` has full month names only, so "Sep 2019" widens to all of 2019.
  That breaks the file's own "never widen" rule.
- The question-period override in `chatToolset.ts prepare()` builds `questionPin` without the
  trip's place, so it falls back to the birth place.

Engine bug: `dasha/vimshottari.py find_active_vimshottari` returns the wrong pratyantar when the
computed window clips an antar (the pratyantar arithmetic starts at the clipped start, not the
antar's true start). Separately, `pratyantar_sequence` (`calculations.py`) only covers the current
antar, although the pratyantar for any date is plain arithmetic.

## Design

### Where the reading is computed

In the Python engine, inside the existing `compute_predictive` run, as a fifth context
`period_reading` on `PredictiveContexts`. It reads only what that run already computed (natal
context, transit timeline and gochara, vargas, strength, domains). **No extra ephemeris calls.**
The CPython and Pyodide paths stay byte-identical (the parity gate covers the new key).

Why Python: the Vedic rules (lordships, functional nature, pratyantar arithmetic, ashtakavarga,
Sade Sati) already live there and are tested there. TypeScript only clips, joins and caps.

The run covers `[reference_instant, reference_instant + window_months)`. The TypeScript tool clips
it to the thread's period. Sookshma and panchang are computed for the reference day only (a Day
trip's day, or today).

### Wire shape (`period_reading`, Python → browser)

```jsonc
{
  "window": {"start": "2019-05-01", "end": "2019-06-01"},
  "natal_lords": {                       // natal-only: all 9 grahas, stored once per profile
    "saturn": {"rules": [11, 12], "house": 5, "sign": "taurus", "dignity": "friendly",
               "combust": false, "retro": false, "functional": "malefic",
               "d9_sign": "leo", "d10_sign": "aries", "vargottama": false,
               "yogas": ["Sasa Yoga"]}          // natal yogas whose planets_involved include this graha
  },
  "dasha_spans": [                       // maha/antar/pratyantar spans covering the window, clipped
    {"level": "maha", "lord": "saturn", "start": "...", "end": "..."},
    {"level": "antar", "lord": "mercury", "start": "...", "end": "..."},
    {"level": "pratyantar", "lord": "venus", "start": "...", "end": "..."}
  ],
  "sookshma": {"lord": "moon", "start": "...", "end": "..."},   // reference day only
  "sandhi": {"level": "antar", "date": "..."} | null,           // a maha/antar change in the window
  "yogini": {"name": "sankata", "lord": "rahu", "start": "...", "end": "..."},
  "segments": [                          // window split at antar/pratyantar changes and slow ingresses
    {"start": "...", "end": "...", "maha": "saturn", "antar": "mercury", "pratyantar": "venus",
     "events": ["saturn.station.direct"]}          // timeline descriptors inside the segment
  ],
  "sky": [                               // Jupiter, Saturn, Rahu, Ketu sign spans from the timeline
    {"graha": "saturn", "start": "...", "end": "...", "sign": "sagittarius", "retro": true,
     "from_moon": 12, "from_lagna": 9, "sav": 28, "bav": 4,
     "tags": ["sade_sati_phase_1"]}      // also kantaka_shani, ashtama_shani, jupiter_from_moon_N
  ],
  "transit_lords": {                     // each running lord's gochara at the reference instant
    "venus": {"sign": "aries", "from_moon": 4, "from_lagna": 1, "sav": 30, "bav": 5, "retro": false}
  },
  "double_transit": [7, 10],             // houses from lagna aspected/occupied by both Jupiter and Saturn
  "themes": [                            // up to 6 domains, strongest agreement first
    {"domain": "career", "houses": [10], "direction": "supportive|mixed|challenging",
     "strength": "strong|moderate|weak", "strength_pct": 62,
     "confidence": "high|medium|low",
     "agreement": {"vimshottari": true, "yogini": false, "transit": true},
     "factors": ["Mercury (antar) rules the 10th", "Jupiter transits the 10th from the Moon"],
     "windows": [{"date": "...", "descriptor": "career.dasha.pratyantar.venus", "severity": "supportive"}]}
  ],
  "panchang": {"instant": "...", "tithi": 7, "tithi_name": "Saptami", "paksha": "shukla",
               "nakshatra": "Pushya", "karana": "Vanija", "yoga": "Siddhi", "vara": "Wednesday"},
  "rules": ["functional nature by lagna (BPHS): ...", "confidence = count of agreeing techniques: ..."]
}
```

Rules the engine states (so the fence can allow citing them):

- **Functional nature** by lagna lordship, deterministic: `yogakaraka` if `is_yogakaraka`;
  the lagna lord is `benefic`; a lord of a trikona (5, 9) is `benefic`; a lord of 3, 6, 8 or 11
  that rules no trikona is `malefic`; a lord of 2 or 7 that rules no trikona is `maraka`;
  otherwise `neutral`.
- **Agreement** is a plain boolean per technique, never a fused score (the scoring heuristics in
  `dasha/scoring.py` stay quarantined): `vimshottari` = a running maha/antar/pratyantar lord is a
  lord of a domain house or the domain's karaka; `yogini` = the Yogini maha's planet is one of
  those; `transit` = Jupiter or Saturn occupies a domain house from the lagna or the Moon in some
  segment.
- **Confidence** is a stated counting rule: 3 agreeing techniques = high, 2 = medium, 0–1 = low.
- **Direction** reads the engine's own severities: the domain's `transit_severity` plus the
  severities of its windows inside the window; all supportive = supportive, all challenging =
  challenging, otherwise mixed.
- Every `factors[]` string is generated from an engine fact (a lordship, a placement, a tag, a
  window). Never free text.

Chara dasha is left out (the engine's version is simplified).

### The tool (`get_period_reading`, browser → model)

Registered in the shared toolkit next to `get_timing`. Bound to the thread: a trip's period and
place, or today = `[today, today]` at the viewer's place. No arguments. The tool:

1. loads the period's contexts through the existing period-sky queue (one `compute_predictive`
   run, cached on the period_sky row), or today's contexts through the existing today loader;
2. clips segments, dasha spans, sky spans and theme windows to the period; for a Day period keeps
   the segment containing the day plus the next change point;
3. joins `natal_lords` for the running lords only, into `lords[]`:
   `{lord, level: ["maha"|"antar"|"pratyantar"|"sookshma"], rules, natal: {house, sign, dignity,
   combust}, functional, d9_sign, d10_sign, yogas, transit: {...}}`;
4. adds `period` (start, end, granularity, label, tense) and `place` (label, time zone);
5. returns `{period, place, dashas, lords, segments, sky, double_transit, themes, panchang?}`,
   target under 4 KB, asserted for a Year trip.

Storage: natal-only data (`varga_context_full`, `strength_context`, `period_reading.natal_lords`)
is stored once per profile in the derived database, not in every period_sky row. The period row
keeps the period-only parts (transits, domains, receipts, the rest of `period_reading`). Lookup
joins them, so callers still see one `CachedPredictiveContexts`. Same ACID session, epoch fence and
tier row caps as today.

### Drill-down: `get_period_detail({section, key?})`

The reading stays compact. Detail is a second tool in the same toolkit, bound to the same period
and place. Sections: `lord` (key = a graha: its full natal and transit context and every segment
it runs), `segment` (key = segment start date: that segment's sky and events), `bindus` (key = a
graha or `sav`: the ashtakavarga row per sign), `panchang` (a Day period), `dashas` (all spans in
the period, down to sookshma for a Day). It returns a deterministic digest: the facts plus the
cited factor strings, never raw engine tables. Same 4 KB target.

### Context budget for the agentic loop (`packages/llm` agent loop)

The risk is the multi-round tool loop inside one answer. Rules:

1. **Per-turn token budget.** Derived from the model's `context_length` (the OpenRouter catalog
   the model picker already fetches; a configured value for custom endpoints); the turn may use at
   most ~50% of it across all rounds. Unknown model: a conservative default (8k context). The
   existing 8,192-char per-result cap stays. Token counts are estimated deterministically from
   characters (≈4 chars/token, rounded up), then reconciled with the provider's `usage` when it
   reports one.
2. **In-turn compaction (budget-driven).** Results stay in full while the next request fits the
   turn budget. Only when it would not do consumed results (already read by an earlier model call)
   go out as one compact "facts gathered" note each (the result's deterministic one-line summary,
   the same text the collapsed tool row shows, plus its key cited factors), oldest round first.
   So a 1M-context model answers from the full reading and an 8k model degrades gracefully.
   (Revised 2026-10-13 after the P1 acceptance drive: unconditional compaction left a 1M-context
   model answering from one-line notes.)
3. **History compaction.** In a thread's history, past turns' tool results appear only as those
   one-line summaries. Results are deterministic and cached, so re-calling is cheap.
4. **In-turn dedupe.** A repeated identical successful call in the same turn returns
   `unchanged; see the earlier result <toolCallId>` instead of the payload. An identical retry of
   a failed call still gets its error back.
5. **Stable prefix.** System prompt, then tool schemas in a fixed order, before anything that
   changes per turn (helps provider prompt caching).
6. **Bounds.** The round cap stays; parallel tool calls per round are bounded. When the budget is
   exhausted the loop makes one final round with tools off that answers with what it has and
   says what it could not check. Never a truncated mid-loop failure.
7. **Telemetry.** Per-round `prompt_tokens`/`completion_tokens` (provider usage when present,
   the estimate otherwise) recorded on the transcript and dev diagnostics only. Not sent anywhere.
8. **Proof.** A mock-LLM stress e2e drives max rounds plus detail calls and asserts the per-turn
   total stays under budget for a 1M-context and an 8k-context model; an 8k model still answers.

### Prompt

- Today and trips both list `get_period_reading` as a required grounding tool. The existing
  "required until it succeeds" loop stays. Today's `preRunToday` + VERIFIED block
  (`Dashboard.tsx`) is replaced by this tool.
- The hedging lines are rewritten. Kept: a chart cannot name the event; no invented facts; cite
  factors. Added: be specific. Name the houses and life areas, the running lords and their
  lordships ("Saturn, your 12th lord"), the tags (Sade Sati phase, Kantaka Shani), the strength and
  confidence, and the dated change points inside the period.
- The DERIVED-FACT FENCE stays. It now has the facts to cite: anything in the reading is
  "explicitly present".

### Privacy and size

- No raw birth date, time or coordinates in any request (asserted on the request body).
- The reading for a Year trip is under 4 KB, and the agent's sanitize step keeps it well-formed.

## Acceptance

- `bun run gate` (frontend) and `uv run poe gate` (backend) green.
- `time-travel*` and `*threads*` Playwright specs green on chromium and iphone-webkit.
- A real-LLM drive on a production preview (own port, never 4173) with `~openai/gpt-sol-latest`
  and `deepseek-v4-pro`, fresh profile: trips May 2019 Singapore, "Sep 2019" asked inside that
  trip, Jan 2027 SF, and a today question. Pass = no error tool rows, `get_period_reading` called,
  and each answer names the running maha/antar/pratyantar, at least one lordship ("X rules your
  Nth"), a Moon-based transit tag where one applies (Capricorn Moon in 2019: Saturn in
  Sagittarius = Sade Sati phase 1), the trip place, at least one dated window inside the period,
  and a confidence level.
- CPU time for one reading on CPython, plus a Pyodide estimate.
- Per-round token numbers for the first trip turn and a 6-turn thread, both under budget.

## Out of scope (Phase 1)

Chara dasha; fused technique scores; new ephemeris calls per segment; recomputing domain strength
per segment (strength is natal; per-segment change comes from dashas and the sky).
