# Classical dasha rules in the period reading (2026-10-15)

Approved by Harish 2026-10-15. Branch `feat/classical-dasha` (off `claude/time-travel-threads`).

## TL;DR

Today a life area's Vimshottari "agreement" is on when ANY running maha, antar or pratyantar
lord rules one of its houses, sits in one, or is one of its karakas. With three levels of lords
and five or six significators per area, that is true in 97-100% of months
(`2026-10-14-retrodiction-results.md`), so it says nothing. A classical astrologer reads a period
more narrowly: the maha lord matters most, each sub-lord is judged from the lord above it, and a
weak or badly placed lord gives weaker or harder results.

This change makes the engine read dashas that way and say so in typed fields:

- every running lord gets a **graded weight** for each area (sits in or rules an area house = full,
  karaka only = half), scaled by its **strength** (strong / ordinary / weak from dignity, combustion
  and Shadbala), weighted by **level** (maha 3, antar 2, pratyantar 1) and by the **share of the
  window it runs**;
- the area's Vimshottari score is 0-100, and agreement fires only at **50 or more**;
- each antar is placed **from its maha** (and pratyantar from antar, sookshma from pratyantar):
  kendra/trikona = support, 6/8/12 = friction;
- **Yogini antardashas** join the Yogini maha, scored the same way;
- each area gets a **dasha tone** (supportive / mixed / challenging) from the relevant lords'
  functional nature, strength and placement from their parent lord.

It stays a reflection of what the tradition says about a period. It is not a claim that the
period will bring or brought anything, and the retrodiction eval (below) is what measures it.

## What already exists (verified 2026-10-15, not rebuilt)

| gap as briefed | state in the engine before this change |
|---|---|
| 1. occupancy | `domains/significators.significator_grahas` already counts natal occupants for the themes; only the eval's `vimshottari_lords` family ignores them. New: occupancy is part of the graded weight. |
| 4. functional nature | `reading/functional.py` (BPHS ch. 34, Laghu Parashari) already classes every lord and `NatalLord.functional` carries it. New: it feeds the tone. |
| 6. sookshma | `dasha/depth.active_chain` already goes to level 4 and `PeriodReading.sookshma` carries it. New: a PyJHora parity test, and its placement from the pratyantar. |
| 3. dignity | `NatalLord.dignity` carries only exalted / debilitated / own / neutral, plus combust and retro flags. New: a strength band that also reads friend / enemy (naisargika) and Shadbala. |

## The rules

Signs and houses are whole-sign, as everywhere in the engine. "Area houses" and "karakas" are the
domain recipe's (`domains/recipes.py`); an `activation_only` area (obstacles) counts no karakas.

### R1. Relevance of a lord to an area (occupancy + lordship + karaka)

`relevance(g, area)` = **1** if g sits natally in an area house or rules one; else **0.5** if g is
a counted karaka of the area; else **0**. Rahu and Ketu rule nothing, so they count by occupancy
(or as a karaka). Source: BPHS ch. 47 judges a dasa by where its lord sits, ch. 48 by the houses it
rules; 34.16 says the nodes give the results of the house they occupy. The half weight for a karaka-only lord is
an AlmaMesh constant: the house is the primary signification, the karaka secondary.

### R2. A sub-lord judged from its parent lord

For an antar, count whole signs from the maha lord's natal sign to the antar lord's natal sign
(1..12); the same for pratyantar from antar and sookshma from pratyantar.
**support** = 1, 4, 5, 7, 9, 10, 11 (kendra, trikona, or the 11th); **friction** = 6, 8, 12;
**neutral** = 2, 3. Source: BPHS chs. 52-60 judge each antar "with reference to the lord of the
Dasa" (e.g. 52.13-14: the Moon in the 6th, 8th or 12th from the dasa lord gives bad results;
53.61-62: Venus in a kendra, trikona or the 11th from it gives gains, in the 6th/8th/12th sorrow);
Phaladeepika XX.29 states it generally (6/8/12 from the dasanatha unhappy, the rest good). The 2nd
and 3rd are kept neutral: the 2nd is a maraka house (BPHS 44) and the texts give the 3rd mixed
readings. **Pratyantar from antar and sookshma from pratyantar is an AlmaMesh extension by
analogy:** BPHS ch. 61 judges a pratyantar by its own placement and lordship and does not state
the count from the antar lord.

### R3. Strength of a lord

`sign dignity`: exalted / debilitated / own from the engine's BPHS tables; otherwise the natural
(naisargika) relation of the graha to its sign lord: friend / neutral / enemy (the BPHS table
already in `strength/friendship.py`). Rahu and Ketu: neutral (no agreed Parashari dignity).

`strength` (first match wins):
1. **weak** if combust (Phaladeepika XX.30: a combust planet acts as debilitated);
2. **strong** if retrograde, Sun to Saturn (Phaladeepika XX.14: retrograde counts like exalted);
3. **strong** if exalted or own sign;
4. **weak** if debilitated;
5. **strong** if in a friend's sign and Shadbala meets its BPHS minimum (`meets_minimum`, BPHS 27);
6. **weak** if in an enemy's sign and Shadbala is below its minimum;
7. else **ordinary** (always for Rahu and Ketu: no Shadbala, always retrograde, so rule 2 skips them).

Source: BPHS 47.5-6 (a dasa lord exalted, in its own or a friend's sign gives good results;
debilitated or in an enemy's sign bad), 47.49-51 and 47.57-60 (combust or debilitated: adverse);
Phaladeepika XX.30 gives the classical extent scale (exalted full, moolatrikona 3/4, own 1/2,
friend 1/4, enemy least, debilitated nil). Multipliers on the activation: strong 1.0, ordinary
0.75, weak 0.5. These three numbers are AlmaMesh constants, not the Phaladeepika fractions: that
scale measures how GOOD the results are, which goes to the tone (R7); a weak lord still runs its
houses, so it keeps half its weight in the activation.

### R4. Functional nature (existing rule, now used)

Unchanged `reading/functional.py`: yogakaraka / benefic / malefic / maraka / neutral by lordship
from the lagna (BPHS ch. 34; Laghu Parashari Sañjñā-adhyāya). Used only in the tone (R7).

### R5. Yogini antardashas

Inside a Yogini maha of Y years, the eight antars run in Yogini order starting from the maha's own
Yogini, each `Y × y / 36` years (y = that Yogini's years: Mangala 1, Pingala 2, Dhanya 3, Bhramari
4, Bhadrika 5, Ulka 6, Siddha 7, Sankata 8). The birth maha is the tail of a full maha: its antars
are dated from the maha's virtual start before birth, as the Vimshottari birth balance is. The
proportional split is the standard one (see Sources); PyJHora 4.8.7 splits a maha into eight equal
antars instead, so it is used to check the maha boundaries and the antar order, not the lengths.

### R6. Sookshma

Level 4, each pratyantar split in Vimshottari proportions starting from its own lord (existing
`subdivide_period`). Checked against PyJHora's sookshma table on the reference chart.

### R7. Graded score, threshold and tone

For an area and the reading window `[start, end)`:

```
vimshottari = 100 × Σ_level w_level × Σ_span share(span) × relevance(lord) × strength_mult(lord) / Σ w
```

`w` = maha 3, antar 2, pratyantar 1; `share` = the fraction of the window the span covers, so the
score is the time-weighted mean of the instant score. Yogini: the same with maha 2, antar 1.
Rounded to an integer 0-100. **`agreement.vimshottari` = vimshottari ≥ 50; `agreement.yogini` =
yogini ≥ 50.** 50 means, for example, a full-strength maha lord tied to the area on its own, or an
antar and pratyantar both tied at full strength; an ordinary-strength maha alone (37.5) is not
enough. The threshold is one fixed constant, not fitted to any data.

**Tone.** Each Vimshottari span with relevance > 0 gets a valence: functional nature (+1
yogakaraka/benefic, −1 malefic/maraka, 0 neutral) + strength (+1 strong, −1 weak, 0 ordinary) +
placement from its parent (+1 support, −1 friction, 0 neutral or maha). Tone = **supportive** if
every non-zero valence is positive, **challenging** if every one is negative, else **mixed**;
`null` when no running lord is relevant.

## Wire changes (backend `schemas/reading.py`, mirrored in `frontend/.../pyodide/predictive.ts`)

- `DashaSpan.from_parent: House | None`, `DashaSpan.relation: support|friction|neutral | None`
  (None for a maha). The same two on `Sookshma`.
- New `NatalLord.strength: strong|ordinary|weak`. `NatalLord.dignity` stays the chart's own
  four-value dignity (exalted/own/neutral/debilitated): the natal reading's prompt fences dignity to
  those four words, so a second, richer `dignity` beside it would contradict the chart. The
  friend/enemy step of R3 shows only through `strength` and the stated rule.
- `YoginiSpan` for the running Yogini antar: `PeriodReading.yogini_antar`.
- `ReadingTheme.dasha: {vimshottari: 0-100, yogini: 0-100, tone: supportive|mixed|challenging|null}`.
- `READING_RULES` states R1-R7 in one line each, so a model can cite them.

The chat tools (`read_period`, `travel`) copy these by name in `apps/web/src/lib/periodReading.ts`:
spans carry `relation`, lords carry `strength`, themes carry `dasha`, `dashas.yogini_antar` joins
`yogini_maha`. The 4 KB budget drops theme `dasha` together with the agreement booleans. No UI.

## Reference checks

PyJHora 4.8.7 run locally as an oracle only (never a dependency; Lahiri set explicitly, since its
default ayanamsa is TRUE_PUSHYA), on the repo's reference chart Princess Diana, 1961-07-01 18:45
UT, Sandringham (Rodden AA; already used by `tests/test_dasha_birth_balance.py`):

| check | PyJHora | engine |
|---|---|---|
| sookshma starts in Jupiter/Saturn/Ketu and /Venus, Jan-Apr 1985 | e.g. Ketu/Rahu 1985-01-19 01:50 UT, Venus/Venus 1985-02-19 13:30 UT, Venus/Moon 1985-03-24 23:27 UT | 00:08, 11:48, 21:44 UT (within 2 h: 365.25 vs 365.2564-day year) |
| Yogini maha boundaries | Dhanya (Jupiter) 1962-03-29 ~18:00 UT, Bhramari (Mars) 1965-03-29 12:26 UT | 18:22, 12:22 UT |
| Yogini antar order in the Pingala (Sun) maha | sun, jupiter, mars, mercury, saturn, venus, rahu, moon | same |
| naisargika sign dignity (`house_strengths_of_planets`) | Mars in Leo friend, Jupiter in Capricorn debilitated, Mercury/Venus/Saturn own, Sun/Moon neutral | same after R3 |
| combust | Mercury | Mercury |
| retrograde (swisseph speed) | Mercury −0.48°/d, Jupiter, Saturn | same |

Functional nature has no PyJHora counterpart (its `marakas` lists the 2nd/7th lords and their
occupants, a different rule); it stays pinned by the hand-worked BPHS cases in
`tests/test_period_reading_rules.py`. Rahu/Ketu dignity: PyJHora uses a node table (Rahu in Leo
enemy); the engine keeps nodes neutral, a stated difference.

## Sources

From a citation pass on 2026-10-15; anything not checked against a text is marked unverified.

| rule | source (R. Santhanam BPHS numbering; verified against the archive.org OCR of vols 1-2) |
|---|---|
| R1 occupancy | BPHS ch. 47 judges a dasa by the lord's placement, ch. 48 by its lordship (48.1-8); BPHS 34.16 states it outright for the nodes (results of the house occupied). No single verse says "occupied and owned" for all grahas (not found). |
| R2 antar from maha | BPHS chs. 52-60 (antardasa effects per maha), e.g. 52.13-14, 53.61-62; Phaladeepika XX.29. Pratyantar/sookshma from parent: AlmaMesh extension (BPHS 61.2 does not state it). |
| R3 dignity, combust, retro | BPHS 47.5-6, 47.49-51, 47.57-60; Phaladeepika XX.14 (retrograde), XX.30 (extent scale; combust = debilitated); BPHS 27 (Shadbala minimums, saptavargaja dignity points). |
| R4 functional nature | BPHS 34.2-7, 34.13-15, 34.17; maraka houses BPHS 44.2-5; Phaladeepika XX.41-51 restates the Parashari lordship rules. Laghu Parashari verse numbers: unverified (no online text with verse numbers found). |
| R5 Yogini | BPHS 46.195-200 (the eight Yoginis, lords, 1..8 years, start = janma nakshatra + 3 mod 8); BPHS 51.1 (antar = maha years x antar years / cycle); proportional Yogini antars: R. Jhanji (K.N. Rao school), "An Introduction to the Yogini Dasha", table 2 (vedicastro.com/yogini1.aspx: Mangala-Mangala 10 days, Mangala-Pingala 20 days); Saravali software docs ("calculated similar to the antardasas of Vimsottari"). PyJHora splits equally: non-standard. |
| R6 sookshma | BPHS 62.1 (sookshma = pratyantar span x the graha's years / 120); effects ch. 62. |
| R7 weights, threshold | AlmaMesh constants (level 3/2/1, Yogini 2/1, karaka 0.5, strength 1/0.75/0.5, threshold 50), fixed here before any eval run; the ordering maha > antar > pratyantar follows BPHS 51-61 (each level a subdivision of the one above). |

Texts: https://archive.org/download/BPHSEnglish/ (Santhanam vols 1-2); Phaladeepika, V. Subrahmanya
Sastri 1950 (archive.org); verse cross-checks at enjoylearningsanskrit.com/scriptures/parashara.

## Retrodiction pre-registration amendment (h): `classical_dasha` (written now, NOT run)

To be copied into `2026-10-14-retrodiction-eval-design.md` on `feat/exact-transits` as amendment
(h), committed before any code for the family is run. ADB records never enter the repo.

**(h0) Why a fifth family after the stop rule.** Amendment (g6) paused the roadmap after #1-#4.
Harish approved this engine change on 2026-10-15 because the v1 Vimshottari rule is not the
classical one (it fires in 97-100% of months). This is that one exception, numbered #5. If it is
null on DEV, (g6) stands and nothing else is added.

**(h1) Hypothesis.** The classical graded Vimshottari score ranks the month of a recorded event
higher in its ±36 window than the v1 families alone. Directional: the k=3 and k=6
placebo-calibrated lift of +CLASSICAL is above 1 for **career**, **relationships**, **family** and
**health**; **disputes** is secondary; the rest exploratory.

**(h2) Family score, exactly.** For event target T (the mapping's houses and karakas, the v1
convention) and calendar month m = [1st 00:00 UT, next 1st 00:00 UT):

```
classical_dasha(natal, m, T) = engine score R7 over m / 100, in [0, 1]
```

computed by the engine function shared with the reading (`reading/classical.py`,
`vimshottari_score(natal, shadbala, houses, karakas, start, end)`), with relevance R1, strength
R3 (Shadbala from the engine's `compute_strength_context` for the native) and level/time weights
R7. Continuous, not thresholded. Tone is not used (events are both good and bad). Yogini antars
are not in this family (the v1 `yogini` family stays as it is), so one family tests one idea.

**(h3) Run.** DEV half only (split `299ec393…`), window ±36, k 3 and 6, R = 4 placebos,
amendment (f)'s placebo-calibrated statistic, chart-swap control, shifted-month and planted
controls exactly as (f3). BASELINE = the v1 seven (`placebo_run.V1`), compared with BASELINE +
`classical_dasha`. HELD-OUT is not read. Adding the family changes the pre-registration digest
from `1abf88a5…`; the new digest is pinned in `tests/test_retrodiction_mapping.py` in the commit
that adds the family, before any run, and recorded here.

**(h4) Tests and correction.** Pre-registered: the four primary areas × k ∈ {3, 6} = 8 tests,
+CLASSICAL placebo-calibrated p. **Holm** at α = 0.05 across the 8 (BH reported beside it). Gate
to HELD-OUT, as (g4): a test that survives Holm, with its lift CI above 1 and its chart-swap ratio
CI above 1. Anything less is null for that area.

**(h5) Day-precision sensitivity check (reported, not a test).** The same DEV run restricted to
events whose ADB date has day precision (month-precision events can sit in the wrong month at a
month boundary). Reported per primary area beside the main rows. It cannot rescue a null main row;
a main-row pass that vanishes on day-precision events is flagged as fragile.

**(h6) Exploratory, not tested.** A replacement configuration (v1 seven minus `vimshottari_lords`,
plus `classical_dasha`), and the share of months scoring ≥ 0.5 per target (the saturation check).

## Plan (short)

1. Spec (this file), committed.
2. `dasha/yogini.py`: `yogini_antars(maha)` (R5), PyJHora order/boundary test + hand-computed
   proportional lengths.
3. `reading/classical.py`: `sign_dignity`, `lord_strength`, `relation_from`, `relevance`,
   `vimshottari_score`, `yogini_score`, `dasha_tone` (R1-R3, R7), unit tests on hand-worked Diana
   facts; sookshma PyJHora parity test (R6).
4. Wire: `schemas/reading.py`, `reading/{dashas,lords,themes,compose,rules}.py`; regenerate the
   period-reading and predictive goldens; explain each change.
5. Frontend: types in `predictive.ts`, projection in `periodReading.ts`, stored-row validation in
   `periodSkyValidation.ts`; tests.
6. Saturation evidence: monthly firing rate old vs new on the reference charts (a test bound).
7. Red runs on two guards; full gate (`make gate` pieces: backend `poe gate`, frontend `bun run gate`).
