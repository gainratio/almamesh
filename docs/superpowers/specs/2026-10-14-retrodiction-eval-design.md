# Retrodiction eval: does a period reading flag the right life area in the right month?

Status: pre-registered 2026-10-14, before any real run. Branch `feat/retrodiction-eval` (local).

## TL;DR

Users will test time travel on months they remember. This eval turns "it's predictive" into one
honest number per life area. For each dated life event we score every month in a fixed window
around it with the engine's own calculations, rank the event month, and ask how often it lands in
the top k compared with chance. Then we switch indicator families off one at a time to see which
calculations carry signal. No LLM, fully deterministic, personal data never enters the repo.
Code: `backend/src/almamesh/retrodiction/`; CLI `almamesh-eval` (quickstart at the end).

## Event file
Template: `examples/retrodiction/events.example.yaml`. Keys: `kind` (personal by default, public,
synthetic), `label`, `source` (required for public), `subjects[]` with `birth: {datetime,
latitude, longitude}` (datetime WITH its UTC offset; the app's backup is an encrypted SQLite
bundle, so you type these) and `events[]: {category, date, precision, place}`. `date` is
`YYYY-MM-DD`, `YYYY-MM` or `YYYY` and must match `precision` (day | month | year); year events are
listed as excluded. `place` is recorded but scores are sign-level and geocentric, so it has no
effect. Refusals (exit 2, one line, nothing written): bad YAML, unknown category, date/precision
mismatch, naive birth datetime, missing birth, empty events, bad `--k`, and a `personal` file (or
its report directory) inside any git working tree.

## Method (engine-level, deterministic)

1. Window = event month ±36 (N = 73). A window before birth or past 2052 is excluded and listed.
2. Each family scores each month for the event's **target** (houses + karakas) in [0, 1]; the
   month score is the plain sum.
3. **Hit.** The event month's rank among the N months. With ties, the hit is the exact
   probability of top-k membership under uniform tie-breaking: `clip((k − greater) / equal, 0, 1)`.
   Summed over all N months this is exactly k, so the **base rate is exactly k/N** for every
   chart, however flat or saturated its scores. k ∈ {3, 6}.
4. **p-value.** Null: the event month is uniform in its window. The null sum of hits is the
   convolution of every event's N possible hits (a full-enumeration permutation test, no RNG) on a
   1e-4 grid, null values rounded up and the observed sum down, so p is never understated (0/1 hits
   give the exact binomial tail). One-sided p = P(null sum ≥ observed).
5. **Lift.** rate = hits / n; lift = rate / (k/N); 95% Wilson interval on the rate (fractional
   hits allowed) divided by k/N. Overall and per category, misses included.
6. **Saturation control.** Targets whose significators cover most grahas score high in every
   month. Within-window ranking neutralises that (flat scores tie and earn exactly k/N); the report
   still shows per category the mean month score, the share of months above zero, and the share
   of each window tied at its top, so a "flags everything" target is visible.
7. **Ablation.** Per-family scores are computed once and re-summed: each family off, each alone,
   and `shipped_only`. A family is one class implementing `IndicatorFamily.score(natal, month,
   target) -> float` in `FAMILIES`; it becomes an ablation unit with no harness change.

Primary outcome: overall lift at k = 3, ±36, all families. Per-category and ablation p-values are
exploratory (uncorrected for multiple comparisons).

## Indicator families (frozen v1)

Running lords overlap the month; transit signs are read on the 15th, 12:00 UTC; whole-sign houses.

| family | score | in shipped themes? |
|---|---|---|
| `vimshottari_lords` | share of the 3 levels whose running lord rules a target house or is a target karaka | yes |
| `vimshottari_occupants` | share of the 3 levels whose running lord sits natally in a target house | no (engine ignores occupants) |
| `yogini` | 1 if the running Yogini maha lord rules a target house or is a karaka | yes |
| `transit_jupiter_saturn` | share of {Jupiter, Saturn} in a target house from the lagna or the Moon | yes |
| `double_transit` | 1 if Jupiter and Saturn both occupy or aspect a target house from the lagna | yes |
| `transit_mars` | 1 if Mars is in a target house from the lagna or the Moon | no (engine drops Mars windows) |
| `transit_nodes` | share of {Rahu, Ketu} in a target house from the lagna or the Moon | no |

## Category → target mapping (a hypothesis, frozen)

Classical Parashari significations (BPHS bhava karakatva). The table is itself a hypothesis: a
null result can mean the mapping is wrong, not only the technique.

| category | houses | karakas | engine area |
|---|---|---|---|
| career_change | 10 | Sun, Saturn, Mercury | career |
| job_start | 10, 6, 11 | Sun, Saturn, Mercury | career |
| job_loss | 10, 8, 12 | Saturn, Rahu | career |
| legal | 6, 8, 12 (disputes) | Saturn, Rahu, Mars | none yet (disputes area pending) |
| relationship_start | 7, 5 | Venus | relationships |
| marriage | 7, 2, 11 | Venus, Jupiter | relationships |
| separation | 7, 6, 8, 12 | Venus, Saturn, Rahu | relationships |
| relocation | 4, 12, 3, 9 | Moon, Rahu | none |
| health | 1, 6, 8 | Sun | health |
| accident | 6, 8, 12 (disputes) | Saturn, Rahu, Mars | none yet (disputes area pending) |
| birth_of_child | 5, 9 | Jupiter | family |
| death_in_family | 2, 7, 8, 12 | Saturn | family |
| financial_gain | 2, 11 | Jupiter | finances |
| financial_loss | 12, 8 | Saturn, Rahu | finances |
| education | 4, 5, 9 | Mercury, Jupiter | education |

`legal` and `accident` use the harness-computed disputes target so there is a baseline before the
engine gains a disputes area; that change is then measured as a before/after on the same events.

## Guardrails against fooling ourselves
- **Frozen before results.** Mapping, families, window ±36 and k 3,6 hash to digest `2ae6e16d…`
  (full literal pinned in `tests/test_retrodiction_mapping.py`; a change goes red and needs a dated
  amendment here). Other windows or k are labelled "NOT the pre-registered run".
- **No tuning on reported events.** Harish's events are the held-out set. A change made after
  seeing them is judged on events entered afterwards, never re-scored on the same ones.
- **Misses, nulls and exclusions are reported**, each event with its rank. Synthetic reports say
  "not evidence" in the title. Tests include a planted signal (lift N/k, p < 1e-20) and mutations.

## Datasets

1. **Personal:** `~/.almamesh/retrodiction/events.yaml`, outside every git tree. Harish's known
   cases: a 2019 job start and a 2019 legal problem; he fills in the months.
2. **Synthetic:** `examples/retrodiction/synthetic_null.yaml`, 10 fake natives, 30 events at
   uniformly random months (`random.Random(20261014)`). Harness sanity only.
3. **Public:** none is legally clean today (below).

### Licensing findings (checked 2026-10-14)

| source | timed births | dated events | verdict |
|---|---|---|---|
| Astro-Databank (astro.com) | yes, Rodden-rated | yes | **Not usable free.** Terms forbid spidering ("may only be accessed by human readers"); data may be reused non-commercially, text is copyrighted. The only bulk path is the paid research export (200 CHF/yr, `adbexport/adb_license.pdf`). Harish's call: it costs money. If bought, publish aggregates only: no ids, no raw rows (amended 2026-10-16). |
| Wikidata | **no** (0 humans with birth precision finer than a day; no time-of-birth property) | yes, CC0 (P26/P39/P108 with P580) | Usable for events only, useless alone. |
| CURA Gauquelin archive | yes | no | Not usable: "All rights reserved. Not Creative Commons!" |
| Open Gauquelin DB (OGDB) | 24.5k (75 certificate-backed) | no, but has Wikidata ids | Unclear: no data licence, derived from CURA's all-rights-reserved files. Not used. |
| VedAstro 15000-Famous-People (HF) | yes | no | Unclear: labelled MIT but carries Rodden ratings, so ADB-derived. Not used. |

So **no public set is legally clean today**; the baseline is synthetic. Prior nulls for context:
Carlson 1985 (*Nature* 318:419), Dean & Kelly 2003 (time twins).

### Amendment 2026-10-14 (a): Astro-Databank import (pre-registered before any ADB run)

Built against the free C-names sample (format and plumbing only; no result from it is
published). Code: `retrodiction/adb.py` (rules), `adb_source.py` (zip + XML), `adb_codes.py`
(the table). It applies only to an ADB set; the mapping digest `2ae6e16d…` is unchanged.

- **Input.** The licensed export as the decrypted `adb_export_*.xml` (mode 600, outside git),
  or the `adb_export_*.zip` read in place: the one `.xml` member is decrypted
  (ZipCrypto; password from `$ALMAMESH_ADB_ZIP_PASSWORD`, else the Keychain item of that
  name, never printed) and parsed as a stream.
  No plaintext reaches disk. AES zips, DTDs, a foreign root, malformed XML, an expat without
  amplification limits, and any export or report inside a git tree are refused. Licence §5 says
  the data stays confidential.
- **Natives kept.** Rodden AA or A (`rrc` 1, 2), `dtc` 1, not an event chart (`csex` e), a
  known time, a Gregorian birth date. The birth instant is the civil time at the `stmerid`
  offset (`h5w30` is zone hours, `m2e2015` is LMT meridian degrees, and an unpadded single
  digit such as `m9e5` means 05'), and it must match ADB's
  `jd_ut` within a minute. Records in `<deleted_records>` are dropped (licence §7). Every drop
  is counted by reason.
- **Events.** An event maps only if both its `evn_id` and `sevcode` label match the frozen
  table (31 types onto the 15 categories). The table digest is
  `617f06c555819a90ad24b58e37948daa7e6f4398dfda13fcda2c8623f41ef2af`, pinned in
  `tests/test_retrodiction_adb_codes.py`; changing the table needs another dated amendment.
  Unmapped codes are counted and reported by id and label. The native's own death is never
  mapped.
- **Precision.** `iday="00"` means month precision and `imonth="00"` means year precision.
  Year-precision events go through the existing rule: they are listed as excluded and never
  scored at month level. No year-granularity scoring is added. Julian-calendar and impossible
  event dates are dropped and counted.
- **Reporting.** `almamesh-eval adb-summary` prints counts only. Published output is aggregates
  only: no ids, no rows (licence §5; amended 2026-10-16 to drop ids).

### Amendment 2026-10-14 (b): the first real ADB run (pre-registered before it)

Written and committed before any scoring of the licensed export. Mapping, window ±36, k 3,6
and the seven v1 families are unchanged (digest `2ae6e16d…` on this branch).

- **Pre-1900 natives are excluded.** The engine's Lahiri ayanamsa table starts 1900-01-01 and
  fails closed before it, so a native born earlier cannot be charted at all (the first attempt
  crashed on one). In this export that is **2,408 of the 12,529 kept natives (5,215 of their
  events, any precision)**. They are listed in the report's exclusions with the reason "birth
  before 1900, outside the engine's ayanamsa table" and counted in the results note. This is a
  product limitation, not only an eval one: the app cannot chart a pre-1900 birth.
- **p-value arithmetic, same null.** One-event-at-a-time convolution is hours per cell at ~12k
  events. Large sets now group identical events and convolve by FFT. It is the same 1e-4-grid
  null to ~1e-12, and p is floored at 1e-12 so float noise can never understate it. Small sets
  keep the direct path. Tests compare both paths with a hand convolution.
- **Runtime and sample.** v1 scoring measured 0.15 s per native, so the full set (~12k events)
  takes ~25 min serial. The AFTER run below needs one full engine predictive run per disputes
  month (~2.2 s each; 95.7k native-months over the full set; 3.15 months/s measured at 14
  processes, so ~8.5 h). So the headline before/after pair runs on a **seeded random sample of
  3,000 natives** drawn from the 12,529 kept natives in file order (`--sample-natives 3000
  --seed 20261014`, `random.Random(seed).sample` over indices; pre-1900 natives drawn into it
  are excluded as above). BASELINE and AFTER use the **same sample**: same natives, events and
  config. A full-set BASELINE is reported as an extra row, labelled as a different sample.
  `--workers` changes only speed (tests assert identical report bytes).
- **AFTER = BASELINE + one new family, `engine_obstacles`.** On scratch branch
  `eval/obstacles-ab` (feat/obstacles-domain merged in). Its score is the shipped period
  reading's obstacles-theme strength for that month divided by 100: the exact predictive entry
  the app calls (reference instant the 1st 00:00 UTC, one-month window, reading ending on the
  month's last day). It scores only the disputes target (legal, accident); every other target
  gets 0, so their rankings cannot move. The merge touches none of the v1 families' inputs, so
  AFTER's `without:engine_obstacles` must equal BASELINE `all`. That check is reported. The
  existing families are not edited. Adding the family changes the digest to `295dcb9a…`, pinned
  on the scratch branch only.
- **Multiple comparisons.** The primary outcome (overall lift, k=3, all families) stays
  uncorrected. Every other cell of a run (per category × k, and each ablation variant × k
  except `all`) is one family of tests. We report the count, the raw p < 0.05 cells, and which
  survive Holm and Benjamini-Hochberg at α = 0.05.

### Amendment 2026-10-14 (c): months the engine cannot read (before the AFTER rerun)

The first AFTER run crashed after ~1.5 h and wrote no report, so no result was seen. The app's
own month reading, called for a native born in 1900, searches a Sade Sati cycle that starts
before DE421's first date (1899-07-29) and raises. The skyfield error also cannot be pickled,
so one worker's failure killed the whole pool. The app has the same limitation: its predictive
run fails for such a birth.

- **Rule.** If the engine's month reading raises an ephemeris-range error for any month of an
  event's window, AFTER excludes the event and lists it with the reason "the engine's month
  reading reaches outside the ephemeris". Only disputes events (legal, accident) can hit this,
  because only they call the reading.
- **Same events in both runs.** The headline BASELINE is rerun on the same 3,000-native sample
  with exactly those events dropped, using the same harness code from a private driver. Both
  runs then score identical events. The BASELINE already run on the full sample is reported
  too, labelled with its n.

### Amendment 2026-10-14 (d): DEV/HELD-OUT split and technique #1, exact transits

Written and committed before any scoring of either the split or the new family. Branch
`feat/exact-transits` (local). The licence still gates tuning: nothing below is fitted.

**(d1) The split is done, and from now on every exploratory run is DEV only.**
`retrodiction/split.py` implements the learning-loop spec §2: by native, 50/50 with
`random.Random(20261015)` over the charted (post-1900) natives in file order. The export
digest is SHA-256 over each kept native's id, birth instant, coordinates and events in file
order (content, not container, so the `.xml` and the `.zip` agree). The split digest is
SHA-256 over that, the seed and both sorted id lists:
`299ec3937460a109c44a125943bc8f8f77da57259c545094f43c5d7c008664ca`
(adb_export_261012_2235: 10,124 charted natives, 5,062 DEV, 5,062 HELD-OUT). It is pinned in
`ADB_SPLIT_DIGEST` and `tests/test_retrodiction_split.py`; a CI test pins the algorithm on a
synthetic file, a local test reproduces the real digest when `ALMAMESH_ADB_EXPORT` is set.
`almamesh-eval retrodiction --adb … --split dev` refuses a split that does not reproduce the
pin; `--split held-out` also needs `--release-look`. The id lists sit beside the export
(`split-299ec3937460.json`), never in git. The two earlier full-set runs saw every native in
aggregate before the split; that is held-out look zero.

**(d2) Technique #1, `exact_transits`: hypothesis, formula and constants (fixed now).**

- *Hypothesis.* Degree-level contacts of the slow grahas with the natal significators of a
  life area, strongest when the contacted graha is a running dasha lord, put the month of a
  recorded event higher in its ±36 window than the sign-level families alone do. Directional
  prediction: for **career** (career_change, job_start, job_loss) and **relationships**
  (relationship_start, marriage, separation) the k=3 hit rate with the family is above the
  rate without it. Disputes (legal, accident, where Mars joins) is secondary. The other areas
  are exploratory.
- *Movers.* Transiting Saturn, Jupiter, Rahu and Ketu (Lahiri, mean nodes: the engine's
  defaults). Mars joins only for a target that lists Mars as a karaka, which is exactly the
  disputes target (in the engine: a recipe with `mars_windows`, which is obstacles).
- *Natal points.* The nine natal grahas' sidereal longitudes and the lagna's.
- *Contact.* A mover's longitude within **1.0°** of a natal point (conjunction only, no
  aspects) at any instant of the calendar month (UTC, [1st 00:00, next 1st 00:00)). In-orb
  spells come from root-finding |gap| − orb with the shared `transits/ingress.py` finder,
  stepping 2 days for Mars and 5 days for the others, so every retrograde re-entry counts.
  A spell shorter than one step (a mover grazing the orb edge at a station) can be missed;
  that is accepted and stated, not tuned. Exact-hit dates (gap = 0) come from the same finder.
- *Relevant points for a target.* Natal grahas that rule a target house, occupy a target
  house, or are target karakas (the engine's `significator_grahas` rule; an
  `activation_only` recipe's karakas do not count), plus the lagna when house 1 is a target.
- *Score.* 0.5 if some mover contacts a relevant point in the month, plus 0.5 if a contacted
  relevant point is the running Vimshottari maha or antar lord at some time in the month.
  So 0, 0.5 or 1.
- *Why 1°.* Parashari transits are read by sign; degree contact is later practice with no
  canonical orb. 1° is the narrow end of the usual 1-3° range, chosen because the hypothesis
  is "exact contact". It is one fixed constant. If any other orb is ever run, every run is
  logged in the results with its count; none is planned.
- *Pre-1900 births* stay excluded (Lahiri table from 1900-01-01, DE421 from 1899-07-29); the
  contact scan only reads months after birth, so it never leaves the ephemeris.
- *Engine.* The same contact search and score live in the engine (`transits/exact.py`,
  `domains/exact_signals.py`) behind `ExactTransitSettings.enabled`, which defaults off: the
  shipped reading does not use the family until it passes the promotion rule on HELD-OUT.
- Adding the family changes the pre-registration digest from `2ae6e16d…` to
  `e3462748841401f07df62029d2bc8ec110d7fe29b36c2579333894f2e12e08a2`, pinned in
  `tests/test_retrodiction_mapping.py` in the same commit as the family, before any run.
  The mapping, window and k are unchanged.
- *Speed, not method.* The harness scans Mars only for natives with a disputes event (no
  other target reads it), and refines an in-orb edge only when a month boundary splits its
  coarse bracket; elsewhere the bracket's midpoint lies in the same month as the root. A
  test checks month-for-month equality with the fully refined spells on a real chart.

**(d3) The DEV run (the only run of this amendment).**

- DEV half, window ±36, k 3 and 6, all v1 families plus `exact_transits`. `--workers` ≤ 6.
  If the measured rate puts the run above 4 h, a seeded sample of 2,000 DEV natives
  (`--sample-natives 2000 --seed 20261015`) is used instead, and the results say so.
- *Comparison, per life area* (the mapping's `area` column; relocation is `none`):
  `without:exact_transits` (BASELINE = the v1 `all`) vs `all` (+EXACT) at k=3 and 6, each
  with n, lift [95% CI] and p, and the ratio of hit rates +EXACT / BASELINE with a 95%
  bootstrap CI over natives (2,000 resamples, seed 20261015).
- *Multiple comparisons.* One family: the +EXACT per-area p-values at k=3 and k=6. Holm and
  Benjamini-Hochberg at α = 0.05; the count and the survivors are reported.
- *Chart-swap control (learning-loop §8).* Every DEV native's events are re-scored on the
  chart of another DEV native born in the same UTC calendar year: within each birth year, in
  file order, native i takes the chart of native i+1 (the last takes the first's). Natives
  alone in their birth year, and windows that start before the partner's birth, drop out and
  are counted. Reported per area for BASELINE and +EXACT beside the real rows.
- *Shuffled-months null.* Every event month is moved by a seeded offset of 73 to 146 months,
  either direction (`random.Random(20261015)`), so the true month is outside the new window;
  out-of-range windows drop out. The run is void if its overall +EXACT lift CI excludes 1.
- *Planted control.* A family scoring 1 in the event month and 0 elsewhere, over the real
  DEV windows. The run is void unless its lift is N/k within rounding and p < 1e-20.
- DEV wins are not evidence (learning-loop §2). Nothing is promoted from this run.

### Amendment 2026-10-14 (e): the planted control's p-value floor (after the DEV run)

The DEV run printed VOID. The planted family was exactly at its ceiling (lift 24.33 = 73/3 at
k=3, 12.17 at k=6), but its p-value was 1e-12, not below 1e-20. That is amendment (b): a large
set takes the FFT path and its p is floored at 1e-12 by design, so "p < 1e-20" could never pass
on thousands of events. The rule was wrong, not the run. The rule is now "lift N/k and p at or
below the null's floor (1e-12)", with a regression test. No event was rescored: the verdict was
recomputed from the run's stored planted and shifted summaries, and both files are kept
(`scorecard-as-run.*` and `scorecard.*`, outside git).

### Amendment 2026-10-14 (f): a placebo-calibrated primary statistic (before any rescoring)

Written and committed before any rescoring. Mapping, window ±36, k 3 and 6, the families and the
split are unchanged.

**The defect.** The base rate k/N assumes the event month is equally likely to sit anywhere in
its window. It always sits at the centre. When a family's score is a step function (dasha,
yogini periods), the centre month's tied block lies wholly inside the window while a block near
an edge is cut off, so the centre shares its top-k slots with more tied months. With no event at
all, the centre earns less than k/N: yogini per-position hit rates at −36/−18/0/+18/+36 were
1.51/0.92/0.86/0.93/1.55 × base; shifted months with no event score 0.857 (yogini) and 0.893
(vimshottari lords), the same as the real event months (0.86/0.91); a synthetic step series with
no events gives 0.87-0.90 at the centre. The run-level shifted control passed only because it
checked the combined set. So every lift reported so far is biased low, family by family.

**(f1) Primary statistic: placebo-calibrated lift.** For every scored event, R = 4 placebo
windows of the same native, same category and target, centred at the event month plus an offset
of 73-146 months (sign and size from `random.Random(f"20261015:{native}:{event ordinal}")`, R
draws in order). If a placebo window leaves the engine's range its sign flips once; if it is
still out, that placebo is dropped. An event with no placebo left is excluded and counted. The
hit is unchanged (the fractional top-k hit of the window's centre month).
- lift = Σ event hits ÷ Σ (mean of that event's placebo hits), per family set, area and k.
- 95% CI: bootstrap over natives (2,000 resamples, seed 20261015), paired sums.
- p: one-sided exact randomization test. Under the null an event's centre is exchangeable with
  its placebos' centres, so each event's null is uniform over its R+1 centre hits; the sum's
  distribution is the same convolution as before (`permutation_pvalue`, same grid and floor).

*Why this one (≤10 lines).* Under a stationary null every window centre has the same expected
hit whatever the family's tie structure, so the ratio is 1 by construction and the bias cancels
at its source (same position), not by a model of it. Same-native placebos keep the chart, the
target and the age range; 73-146 months keeps the event month out of every placebo window. It
keeps the unit everyone already reads (a hit-rate lift). "Event score minus window mean" was
rejected: its unit is score points, not a lift, and its permutation null is still over
positions (only conservative, by an unknown amount). Cost: 1+R windows per event instead of 1.

**(f2) The old metric stays as a secondary number**: lift = hit rate ÷ k/N with its Wilson CI,
reported beside the primary for every row. Its position-permutation p is not reported any more.

**(f3) Per-family shifted-month controls.** For every single family, and for each
configuration's combined set, placebo 1 plays the event and placebos 2..R are its calibrators.
Placebo-calibrated: a family **fails** if its CI excludes 1 (k=3 or k=6, all areas). Old metric:
placebo 1's hit rate ÷ k/N with its Wilson CI, same rule; reported to document the bias. The run
is void if a configuration's combined set fails the placebo-calibrated control, or if the planted
family (1 at the event month, 0 elsewhere) does not reach lift N/k with p at the null's floor.

**(f4) Chart-swap comparison.** The same events on a same-birth-year partner's chart (amendment
d's rule). Its windows have the same centre position and calendar months, so the positional bias
cancels in real ÷ swap: the ratio of real to swapped centre hits over events scored both ways,
with a bootstrap CI over natives. The swap's old-metric lift is reported too.

**(f5) The rescore (DEV only, never HELD-OUT).** Three configurations: BASELINE (the v1 seven),
+OBSTACLES (v1 + `engine_obstacles`, brought over from `eval/obstacles-ab` 428432fc unchanged in
formula) and +EXACT (v1 + `exact_transits`). BASELINE and +EXACT come from one run over the DEV
half. `engine_obstacles` scores only the disputes target (legal, accident), so +OBSTACLES can
differ from BASELINE only there; its run scores DEV disputes events only. Its score costs a full
predictive run per month (2.5 s measured), so its centre hits are resolved lazily and exactly:
the family is in [0, 1], so a month whose v1 sum alone beats the centre, or loses to it even
with +1, needs no evaluation; the rest are evaluated (highest v1 sum first) until k months beat
the centre or none is left. A test checks equality with full evaluation. Its only-family control
is not computed (it needs every month). If a timing probe (wall-clock only, nothing read) puts the
+OBSTACLES run above 6 h at 8 workers, its R drops to 2 and the results say so. Holm and BH at
α = 0.05 per configuration over the per-area p-values at k = 3 and 6. Window, k and families are
not re-tuned. DEV wins are still not evidence; nothing goes to HELD-OUT from this rescore.
Pinned in code: `PLACEBOS = 4`, offsets 73-146, `SPLIT_SEED`.

**(f6) Months the engine cannot read (added before any rescoring, after a wall-clock probe crashed
on one).** Amendment (c) applies to the +OBSTACLES run, widened to the Lahiri table's range
(1900-2100) as well as DE421's: both are fail-closed tables the same month reading reads, and a
1901 birth's reading raises the first. With lazy resolution the rule covers the months actually
evaluated. An event whose own window hits it is excluded (reason listed); a placebo window that
hits it is dropped. Any other error still stops the run.

### Amendment 2026-10-14 (g): the relocation lead, techniques #3 and #4, the stop rule (before any scoring)

Written and committed before any code for #3 or #4 and before any run of them. Mapping, window
±36, k 3 and 6, R = 4 placebos, the split (`299ec393…`) and amendment (f)'s statistic are
unchanged. The licence still gates tuning: every constant below is classical and fixed now.

Numbering, in the order families are tested: #1 `exact_transits` (roadmap row 1, amendment d),
#2 `engine_obstacles` (the shipped obstacles theme, amendments b and f), #3
`ashtakavarga_transits` (roadmap row 2), #4 `varga_lords` (roadmap row 3).

**(g1) The relocation lead becomes one confirmatory hypothesis, not tested now.**

- *Hypothesis.* "+EXACT raises the relocation (category `relocation`, area `none`) k=3
  placebo-calibrated lift, with a chart-swap ratio above 1."
- *Test, once.* At the next HELD-OUT release look, never on DEV again and never before that
  look. Configuration +EXACT (v1 seven + `exact_transits`, orb 1°), k=3, window ±36, R = 4.
- *Decision rule, at one-sided α = 0.05.* Confirmed only if all three hold: (i) the exact
  randomization p of the +EXACT relocation k=3 placebo-calibrated lift is ≤ 0.05 after Holm
  across every test run at that look (alone, the cut is 0.05); (ii) that lift's 95% bootstrap
  CI lies above 1; (iii) the real ÷ chart-swap ratio's 95% bootstrap CI lies above 1.
- *What it can and cannot do.* Relocation has no engine area, and its HELD-OUT n is expected
  near DEV's 73, below the 300 events learning-loop §2 needs to promote anything. So even a
  confirmation promotes nothing: it would justify designing a relocation area, measured afresh.
  A failure closes the lead. Either way the look is logged in `docs/eval/holdout-ledger.md`.

**(g2) Technique #3, `ashtakavarga_transits`: hypothesis, formula and constants.**

- *Hypothesis.* A month in which a slow graha or a running dasha lord transits a sign that is a
  target house and is strong in Ashtakavarga ranks a recorded event higher in its window than
  the v1 families alone. Directional prediction: the k=3 and k=6 placebo-calibrated lift of
  +ASHTAKAVARGA is above 1 for **career** and **finances** (the roadmap's areas). Relationships
  is secondary; the other areas are exploratory. Loss categories (job_loss, financial_loss) sit
  in those areas and the formula rewards strong transits only, so they are predicted not to
  lift and dilute the area row; the roadmap's "low bindus lift losses" is not tested here.
- *Bindus.* The engine's natal Parashari Ashtakavarga (`strength/ashtakavarga.py`): each of the
  seven grahas' BAV and the SAV, per sign.
- *Movers.* Transiting Jupiter and Saturn, plus every running Vimshottari maha or antar lord at
  some time in the month that has a BAV (Sun, Mars, Mercury, Jupiter, Venus, Saturn). The Moon
  is excluded (it crosses every sign in a month, so one mid-month sign says nothing about the
  month); Rahu and Ketu are excluded (no BAV in Parashari Ashtakavarga).
- *Sign.* Each mover's sidereal sign on the 15th, 12:00 UTC (the v1 convention).
- *On target.* The sign is a target house counted from the lagna or the Moon (the v1 rule).
- *Strength* of an on-target mover m in sign s: 0.5 if SAV(s) ≥ 28, plus 0.5 if m's own
  BAV(s) ≥ 4 (classical: 28 is the SAV average, 337 / 12 ≈ 28; 4 of 8 is the BAV midpoint).
- *Score.* The largest strength among on-target movers, 0 if none. So 0, 0.5 or 1.
- *Engine.* `domains/ashtakavarga_signals.py`, one rule shared with the eval family, behind
  `AshtakavargaTransitSettings.enabled`, default off.

**(g3) Technique #4, `varga_lords`: hypothesis, formula and constants.**

- *Hypothesis.* Running dasha lords and slow transits tied to the area's divisional chart rank a
  recorded event higher in its window than the v1 families alone. Directional prediction: the
  k=3 and k=6 placebo-calibrated lift of +VARGAS is above 1 for **career** (D10),
  **relationships** (D9) and **disputes** (D30: legal, accident). The family scores 0 for every
  other target, so those areas equal BASELINE by construction.
- *Area → varga and key houses* (counted from that varga's lagna, whole-sign): career targets
  (career_change, job_start, job_loss) → D10, house 10; relationships targets
  (relationship_start, marriage, separation) → D9, house 7; the disputes target → D30, houses 6,
  8 and 12. The engine's existing `vargas/` divisions are used unchanged (D9, D10 and D30 exist).
- *Varga significators.* The lord of each key house's sign, and every one of the nine grahas
  placed in a key house in that varga.
- *Score.* 0.5 if a running Vimshottari maha or antar lord (at some time in the month) is a varga
  significator, plus 0.5 if transiting Jupiter or Saturn (sign on the 15th, 12:00 UTC) is in a
  key-house sign of that varga, read on the zodiac. So 0, 0.5 or 1.
- *Engine.* `domains/varga_signals.py` (career → D10, relationships → D9, obstacles → D30),
  one rule shared with the eval family, behind `VargaSignalSettings.enabled`, default off.

**(g4) The DEV run (the only run of #3 and #4).**

- Two placebo-scorecard runs over the DEV half, `--added ashtakavarga_transits` and `--added
  varga_lords`, each BASELINE (the v1 seven) vs BASELINE + that one family. Their BASELINE rows
  must be identical; if not, the run is void. `--workers` ≤ 6 in total.
- Per area and k: n, the placebo-calibrated lift [95% CI] and exact p for BASELINE and +FAMILY,
  the old k/N lift, and the real ÷ chart-swap ratio [95% CI]. Per-family shifted controls and
  the planted control exactly as amendment (f3); a void configuration voids its run.
- *Pre-registered tests: ten.* +ASHTAKAVARGA career and finances, +VARGAS career,
  relationships and disputes, each at k=3 and k=6: the +FAMILY placebo-calibrated p. Holm and
  Benjamini-Hochberg at α = 0.05 across these ten. The 16 per-configuration area tests are
  reported as before, exploratory.
- *What would send a family to HELD-OUT.* A pre-registered test that survives Holm across the
  ten, with its lift CI above 1 and its chart-swap ratio CI above 1. Anything less is null for
  that area on DEV. DEV wins are still not evidence.
- Adding the two families to `FAMILIES` changes the pre-registration digest from `e3462748…`.
  The new digest is pinned in `tests/test_retrodiction_mapping.py` in the commit that adds the
  families, and recorded under (g5) below, before any run.

**(g5) Digest.** `1abf88a5469c032bf3a0540392021468648dab308dfbd4db565fd89b7d581a83`
(v1 seven + `exact_transits` + `ashtakavarga_transits` + `varga_lords`), pinned in
`tests/test_retrodiction_mapping.py` by the commit "feat(eval): technique #4, varga_lords
family (amendment g3)", before any run. The intermediate digest with #3 only was
`f0c266cc91da6769b819c06bb9a873567773177b57f6951e9c5ef02f1d273a36` (commit `18c25123`); no run
used it. BASELINE in every run stays the v1 seven, named explicitly (`placebo_run.V1`).

*Table fix before any run.* Commit `bed15c00` corrected the engine's Moon BAV from Jupiter to
the BPHS places (1, 4, 7, 8, 10, 11, 12; it listed 2 for 12). This is a correctness fix, not
tuning: the row is fixed by BPHS (Raman, VedAstro and M.S. Mehta agree), it was found by a
hand-derived chart before any #3 run, and no scoring result was looked at to choose it.

**(g6) The stop rule, restated (learning-loop §8).** If families #1-#4 promote nothing, the
roadmap pauses: no family #5. We publish the null as aggregates on the methods page, keep every
area reflective, frame time travel as "what the tradition says about this month", and keep the
scorecard as a regression guard. A family that is null on DEV never reaches HELD-OUT, so it
promotes nothing. #1 and #2 are null on DEV (results below). So the rule triggers after (g4)
unless #3 or #4 sends an area to HELD-OUT under (g4)'s gate and that area then passes §2's
promotion rule there. The relocation test (g1) cannot change this verdict: it is measure-only.

### Amendment 2026-10-15 (h): family #5, `classical_dasha` (before any scoring)

Copied verbatim from `docs/superpowers/specs/2026-10-15-classical-dasha-rules.md` (branch
`feat/classical-dasha`, `32d5e33d`) and committed, with the family's code and digest, before any
run of it. Harish approved this round on 2026-10-15 as an explicit exception to the (g6) stop
rule. ADB records never enter the repo.

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

**(h7) Digest and split, recorded before any run.** Adding `classical_dasha` to `FAMILIES`
changes the pre-registration digest from `1abf88a5…` to
`b770e6c42761fef40269e319ae71225fca8bc5f2ae43f1ddb1b23f754922593d`, pinned in
`tests/test_retrodiction_mapping.py` in this commit. The split is unchanged: recomputed from the
export on 2026-10-15 it is `299ec3937460a109c44a125943bc8f8f77da57259c545094f43c5d7c008664ca`
(5,062 DEV and 5,062 HELD-OUT natives), equal to the pinned `ADB_SPLIT_DIGEST`.

**(h8) Implementation notes (added before any run; they fix how (h2)-(h5) are computed, not what).**

- *The engine function.* On the engine branch the function is
  `vimshottari_score(ChartLords(natal, shadbala), Area(houses, karakas), start, end)`: the same
  six inputs as (h2), grouped. The family passes the mapping target's houses and karakas as the
  `Area` and the calendar month as `[start, end)`, and divides the engine's integer by 100. A test
  checks that, for a synthetic native, the family equals the period reading's own
  `theme.dasha.vimshottari / 100` for every reading theme, in two months.
- *A native whose Shadbala the engine cannot compute.* Shadbala's sunrise search looks back a
  year from birth, so a birth before about 1900-07-29 leaves DE421, and a polar day or night has
  no sunrise in the lookback at all; the engine raises for both, as the app does. The +CLASSICAL
  run excludes every event of such a native from both configurations (so the comparison stays
  paired), with the reason counted, as amendments (c) and (f6) do for unreadable months. Its
  BASELINE rows can therefore differ slightly from the (f) and (g) runs'. The count is reported.
- *HELD-OUT guard in code.* `placebo-scorecard --added classical_dasha` on an ADB export is
  refused unless `--split dev`, even with `--release-look` (`cli._dev_only`, tested).
- *(h5) day-precision run.* `--day-precision-only` keeps only events whose ADB date has day
  precision; each keeps its ordinal in the native's own event list, so its placebo draws are the
  same as in the main run.
- *(h4) Holm.* Holm-adjusted p is reported beside each of the 8 raw p (step-down, monotone);
  "survives" means adjusted p ≤ 0.05. BH is reported as survives / does not.
- *(h6)* is exploratory and is not run in this round.

## Results: DEV, exact transits (technique #1), 2026-10-14

The only scoring run of amendment (d). Engine and harness at `8faa4ed7` (branch
`feat/exact-transits`); pre-registration digest `e3462748…`; split `299ec393…`, DEV half
(5,062 natives). Window ±36, k 3 and 6, orb 1° (the only orb ever run). Aggregates only. One
timing probe scored 120 DEV natives for wall-clock only (nothing summarised or read); the full
run took 74 min at 6 workers. DEV results are not evidence (learning-loop §2).

6,120 month-dated events scored (5,287 year-only excluded, 44 windows outside the engine's
range). BASELINE is `without:exact_transits` (the v1 families); +EXACT adds the family. Ratio is
+EXACT hits / BASELINE hits with a bootstrap CI over natives. Swap is the same events on a
same-birth-year partner's chart (7 natives alone in their year dropped).

| area (k=3) | n | BASELINE lift [CI] | +EXACT lift [CI], p | ratio [CI] | swap +EXACT lift [CI] |
|---|---|---|---|---|---|
| all areas | 6,120 | 0.96 [0.84, 1.08] | 1.01 [0.89, 1.13], 0.45 | 1.05 [0.96, 1.15] | 0.94 [0.83, 1.06] |
| career (hypothesis) | 1,045 | 0.95 [0.70, 1.28] | 1.04 [0.78, 1.38], 0.39 | 1.09 [0.90, 1.32] | 0.93 [0.68, 1.25] |
| relationships (hypothesis) | 2,567 | 0.96 [0.79, 1.16] | 0.99 [0.82, 1.19], 0.56 | 1.03 [0.89, 1.18] | 0.90 [0.74, 1.10] |
| disputes (secondary, Mars) | 779 | 0.89 [0.62, 1.27] | 0.88 [0.61, 1.26], 0.76 | 0.99 [0.76, 1.29] | 1.19 [0.87, 1.61] |
| family | 1,082 | 1.01 [0.76, 1.34] | 1.10 [0.84, 1.45], 0.22 | 1.09 [0.86, 1.39] | 0.92 [0.68, 1.24] |
| health | 439 | 0.74 [0.43, 1.24] | 0.66 [0.38, 1.14], 0.95 | 0.89 [0.54, 1.50] | 0.70 [0.41, 1.19] |
| finances | 94 | 1.48 [0.68, 3.13] | 1.84 [0.91, 3.59], 0.046 | 1.24 [0.75, 2.50] | 1.42 [0.64, 3.05] |
| none (relocation) | 73 | 1.18 [0.44, 3.02] | 2.12 [1.01, 4.23], 0.027 | 1.79 [0.99, 4.38] | 0.45 [0.10, 1.97] |
| education | 41 | 1.34 [0.40, 4.14] | 1.26 [0.36, 4.03], 0.31 | 0.94 [0.00, 3.00] | 2.02 [0.74, 5.04] |

At k=6 the picture is the same: all areas 0.96 → 0.98 (ratio 1.02 [0.97, 1.08]), career 0.93 →
0.97, relationships 0.98 → 1.00; finances 1.59 (p=0.044) but its chart-swap row is higher
(1.77 [1.07, 2.80]). Full tables: `scorecard.md` beside the export.

- **Multiple comparisons.** 16 tests (+EXACT, 8 areas × 2 k). Raw p < 0.05: finances k=3 and
  k=6, relocation k=3. Holm survivors: none. BH survivors: none.
- **Controls.** Planted: lift exactly N/k at both k, p at the 1e-12 floor (ok under amendment e;
  the run first printed VOID, see there). Shifted months: 0.98 [0.87, 1.11] at k=3,
  0.93 [0.85, 1.01] at k=6, both include 1 (ok). Chart swap: the real chart does not beat it in
  any area; every real CI overlaps its swap CI, and in disputes and finances the swap is higher.
- **Hypothesis (career, relationships).** Not supported. Ratios 1.09 [0.90, 1.32] and
  1.03 [0.89, 1.18] include 1; neither area's +EXACT lift CI excludes 1.
- **Verdict.** On DEV, exact transits at a 1° orb add no measurable lift in any life area once
  multiple comparisons and the chart-swap control are applied. The family stays off
  (`ExactTransitSettings.enabled = False`), nothing goes to HELD-OUT, and per learning-loop §8 it
  counts as one of the first four families toward the stop rule.

## Results: DEV rescore under amendment (f), placebo-calibrated, 2026-10-14

Code at `57161280` (includes the birth-maha dasha fix `7955a0b8`); split `299ec393…`, DEV half;
digest `e3462748…`; window ±36, k 3 and 6, R = 4 placebos. Aggregates only. DEV results are not
evidence. BASELINE and +EXACT come from one run: 6,120 events, all with 4 placebo windows (5,287
year-only and 44 out-of-range events excluded as before), swap 6,116 events (7 natives alone in
their birth year), 56 min at 8 workers.

*Synthetic check of the statistic* (`tests/test_retrodiction_placebo.py`, 12,000 step-series
natives, no events): the old k/N lift is 0.87 [0.79, 0.95] at k=3 and the placebo-calibrated lift
is 0.995 [0.97, 1.02]. With a planted bump on a third of events the placebo lift is 9.9 [9.2, 10.6].

Lift = placebo-calibrated [95% CI], p = exact randomization; old = k/N lift; swap = real ÷
chart-swapped centre hits [95% CI] (above 1 means the real chart beats a same-year partner's).

| area (k=3) | n | BASELINE lift, p | +EXACT lift, p | old B / +E | swap B / +E |
|---|---|---|---|---|---|
| all areas | 6,120 | 1.03 [0.90, 1.16], 0.33 | 1.03 [0.90, 1.18], 0.33 | 0.96 / 1.00 | 1.07 [0.91, 1.25] / 1.06 [0.90, 1.25] |
| career (hyp.) | 1,045 | 1.03 [0.74, 1.36], 0.41 | 1.07 [0.76, 1.43], 0.33 | 0.95 / 1.04 | 0.93 / 1.12 [0.77, 1.66] |
| relationships (hyp.) | 2,567 | 1.01 [0.83, 1.21], 0.47 | 0.99 [0.81, 1.19], 0.54 | 0.96 / 0.99 | 1.17 / 1.09 [0.86, 1.42] |
| disputes | 779 | 0.89 [0.60, 1.26], 0.73 | 0.89 [0.58, 1.27], 0.73 | 0.89 / 0.88 | 0.89 / 0.74 [0.47, 1.18] |
| family | 1,082 | 1.16 [0.85, 1.55], 0.16 | 1.16 [0.83, 1.54], 0.16 | 1.02 / 1.08 | 1.10 / 1.10 |
| health | 439 | 0.82 [0.42, 1.35], 0.77 | 0.64 [0.31, 1.06], 0.94 | 0.74 / 0.66 | 1.29 / 1.02 |
| finances | 94 | 1.80 [0.56, 4.18], 0.098 | 2.22 [0.86, 5.03], 0.035 | 1.48 / 1.84 | 1.07 / 1.29 [0.44, 4.58] |
| none (relocation) | 73 | 1.91 [0.56, 6.35], 0.12 | 4.56 [1.49, 12.30], 0.003 | 1.18 / 2.12 | 1.18 / 4.70 [1.25, 20.84] |
| education | 41 | 1.36 [0.19, 4.25], 0.31 | 1.21 [0.00, 4.33], 0.38 | 1.34 / 1.26 | 0.75 / 0.66 |

k=6: all areas BASELINE 0.99 [0.90, 1.09], +EXACT 1.01 [0.92, 1.11]; career 0.96 → 0.99;
relationships 1.02 → 1.03; finances +EXACT 1.72 [0.82, 3.02] p=0.044 (swap 0.90); relocation
+EXACT 2.45 [0.89, 4.91] p=0.014 (swap 1.73 [0.53, 6.00]).

- **Corrections** (16 tests per configuration). BASELINE: no raw p < 0.05. +EXACT: raw finances
  k=3 and k=6, relocation k=3 and k=6; **relocation k=3 survives Holm and BH** (p = 0.003 against
  the Holm cut of 0.05/16 = 0.0031); nothing else survives.
- **Per-family shifted controls** (placebo 1 as the event, k 3 and 6). Placebo-calibrated: every
  family and both configurations pass except `only:vimshottari_lords`, 1.06 [1.01, 1.11] at k=3
  and 1.05 [1.01, 1.10] at k=6 (marginal, the only exclusion among 10 sets; its old k/N control
  passes at 0.94). Old k/N: `only:yogini` fails, 0.86 [0.76, 0.98] and 0.87 [0.80, 0.95]: the
  centre bias the amendment removes. Planted: 73/3 and 73/6, p at the 1e-12 floor. Verdict:
  controls ok (both configurations' sets pass).
- **Reading.** With the bias removed, BASELINE is still null in every area (all CIs include 1)
  and +EXACT adds nothing in the hypothesis areas (career, relationships). The one survivor is
  relocation k=3: an exploratory area with n=73, about 3 placebo hits expected, a lift CI of
  1.5-12, not significant after correction at k=6, and its chart-swap CI barely clears 1. It is
  a lead to pre-register, not a finding. Nothing goes to HELD-OUT from this rescore.

### +OBSTACLES under amendment (f) (DEV disputes events only)

Same placebos and controls, code at `b7e290e5` (identical source to `57161280`), 70 min at 8
workers, lazy exact resolution of `engine_obstacles`. 772 disputes events scored (the 779 above
minus 7 whose month reading leaves the engine's tables, amendment f6); swap 774 events. Every
other area is BASELINE by construction (the family scores 0 there).

| disputes | n | BASELINE lift, p | +OBSTACLES lift, p | old B / +O | swap B / +O |
|---|---|---|---|---|---|
| k=3 | 772 | 0.88 [0.58, 1.26], 0.76 | 0.88 [0.56, 1.30], 0.73 | 0.88 / 0.87 | 0.87 [0.54, 1.35] / 0.84 [0.52, 1.34] |
| k=6 | 772 | 0.87 [0.64, 1.13], 0.86 | 0.90 [0.67, 1.18], 0.77 | 0.90 / 0.92 | 0.82 [0.60, 1.10] / 0.85 [0.61, 1.16] |

No raw p < 0.05, so no Holm or BH survivors. Controls: BASELINE 1.01 [0.68, 1.42] and
+OBSTACLES 0.98 [0.65, 1.40] at k=3 (both pass); planted at its ceiling. `only:engine_obstacles`
was not computed (f5). **Verdict: +OBSTACLES is null on DEV with the corrected statistic.** The
shipped obstacles theme does not put the month of a legal event or an accident higher in its
window, and the real chart does not beat a same-year partner's.

## Results: DEV, techniques #3 and #4 under amendment (g), 2026-10-14

The only scoring of amendment (g). Code at `1ae8f33e` (includes the Moon-BAV table fix
`bed15c00`); split `299ec393…`, DEV half; digest `1abf88a5…`; window ±36, k 3 and 6, R = 4.
Two runs started together at 20:14 PT, 3 workers each (6 in all), both done by 20:49 PT. Each
scored 6,120 events, all with 4 placebo windows (5,287 year-only and 44 out-of-range excluded,
as before); swap 6,116 events (7 natives alone in their birth year). Aggregates only. DEV
results are not evidence.

**BASELINE is reproduced.** The two runs' BASELINE rows are identical to each other (the g4
void check passes) and to the amendment (f) rescore's (all areas k=3 1.03 [0.90, 1.16],
p = 0.33). The v1 families do not read bindus, so the table fix cannot move them.

Lift = placebo-calibrated [95% CI], p = exact randomization; swap = real ÷ chart-swapped centre
hits [95% CI]. Pre-registered areas in bold.

| area (k=3) | n | BASELINE lift, p | +ASHTAKAVARGA lift, p | swap +A | +VARGAS lift, p | swap +V |
|---|---|---|---|---|---|---|
| all areas | 6,120 | 1.03 [0.90, 1.16], 0.33 | 0.98 [0.85, 1.11], 0.62 | 1.01 [0.87, 1.19] | 0.99 [0.86, 1.12], 0.57 | 1.04 [0.89, 1.22] |
| **career** (A, V) | 1,045 | 1.03 [0.74, 1.36], 0.41 | 0.91 [0.64, 1.23], 0.70 | 0.90 [0.60, 1.34] | 1.05 [0.79, 1.37], 0.36 | 0.99 [0.69, 1.47] |
| **relationships** (V; A secondary) | 2,567 | 1.01 [0.83, 1.21], 0.47 | 0.94 [0.76, 1.15], 0.73 | 1.03 [0.79, 1.33] | 0.92 [0.76, 1.10], 0.79 | 1.08 [0.83, 1.40] |
| **disputes** (V) | 779 | 0.89 [0.60, 1.26], 0.73 | 0.82 [0.53, 1.17], 0.85 | 0.80 [0.50, 1.23] | 0.85 [0.57, 1.21], 0.81 | 0.85 [0.52, 1.37] |
| **finances** (A) | 94 | 1.80 [0.56, 4.18], 0.098 | 1.92 [0.58, 5.02], 0.067 | 0.93 [0.28, 2.73] | = BASELINE | = BASELINE |
| family | 1,082 | 1.16 [0.85, 1.55], 0.16 | 1.11 [0.80, 1.46], 0.24 | 1.13 [0.76, 1.65] | = BASELINE | = BASELINE |
| health | 439 | 0.82 [0.42, 1.35], 0.77 | 1.06 [0.57, 1.71], 0.40 | 1.61 [0.75, 3.71] | = BASELINE | = BASELINE |
| none (relocation) | 73 | 1.91 [0.56, 6.35], 0.12 | 2.32 [0.67, 6.54], 0.062 | 1.94 [0.43, 13.05] | = BASELINE | = BASELINE |
| education | 41 | 1.36 [0.19, 4.25], 0.31 | 0.84 [0.00, 2.96], 0.59 | 0.44 [0.00, 2.00] | = BASELINE | = BASELINE |

k=6, pre-registered rows: +ASHTAKAVARGA career 0.87 [0.69, 1.09] p=0.88, finances 1.55
[0.82, 2.66] p=0.073 (swap 1.17 [0.53, 2.68]); +VARGAS career 0.99 [0.80, 1.20] p=0.54,
relationships 0.97 [0.84, 1.10] p=0.65, disputes 0.83 [0.61, 1.09] p=0.92. All areas k=6:
BASELINE 0.99, +A 0.97, +V 0.97. +VARGAS scores 0 outside career, relationships and disputes,
so those rows equal BASELINE exactly, as designed.

- **The ten pre-registered tests.** Smallest p: +ASHTAKAVARGA finances, 0.067 (k=3) and 0.073
  (k=6). No raw p < 0.05, so no Holm and no BH survivors across the ten. The 16-test
  per-configuration families: no raw p < 0.05 in BASELINE, +ASHTAKAVARGA or +VARGAS.
- **Controls.** Planted: 73/3 and 73/6, p at the 1e-12 floor, both runs. Placebo-calibrated
  shifted controls pass for both configurations and both new families alone
  (`only:ashtakavarga_transits` 1.00 [0.95, 1.04] at k=3, `only:varga_lords` 1.01 [0.96, 1.06]);
  the only failing set is again `only:vimshottari_lords` (marginal, as under f). Both runs:
  controls ok.
- **Chart swap.** No pre-registered row has a swap CI above 1; career +ASHTAKAVARGA (0.90) and
  disputes under both families (0.80, 0.85) sit below 1.
- **Hypotheses.** #3 (career and finances): not supported. Career falls (1.03 → 0.91); finances
  rises 1.80 → 1.92 on 94 events with a CI from 0.58 to 5.0 and a swap ratio of 0.93, which
  is noise, not a lead. #4 (career D10, relationships D9, disputes D30): not supported; career
  1.03 → 1.05, relationships 1.01 → 0.92, disputes 0.89 → 0.85, every CI wide across 1.
- **Verdict.** On DEV, neither Ashtakavarga transit strength nor the D10/D9/D30 lords add
  measurable lift in any pre-registered area. No area meets the (g4) gate, so nothing goes to
  HELD-OUT. Both flags stay off (`AshtakavargaTransitSettings.enabled`,
  `VargaSignalSettings.enabled`).
- **Stop rule (g6): triggered.** Families #1-#4 (exact transits, the obstacles theme,
  Ashtakavarga, vargas) have all been scored and none sends an area to HELD-OUT, so none can be
  promoted. The roadmap pauses: no family #5. Next is what §8 says: publish the null as
  aggregates on the methods page, keep every area reflective, frame time travel as "what the
  tradition says about this month", and keep the scorecard as a regression guard. The one
  pre-registered HELD-OUT test (g1, relocation under +EXACT) still runs once at the next look
  for the record. It is measure-only and cannot reverse this.
- **Side effect worth knowing.** Writing the bindus out by hand found a real engine bug: the
  Moon's BAV from Jupiter used (1,2,4,7,8,10,11) instead of BPHS (1,4,7,8,10,11,12). Totals
  were unchanged, so the old invariants could not see it. Fixed in `bed15c00` before any run.
  The strength, domains and predictive goldens and the period-reading fixtures were regenerated,
  so shipped SAV-based strengths change slightly.

## Results: baseline 2026-10-14 (SYNTHETIC, harness sanity only, not evidence)

30 random-month events, pre-registered settings. Expected: lift near 1, nothing significant.

| set (synthetic) | k | hits/n | chance | lift [95% CI] | p |
|---|---|---|---|---|---|
| all families | 3 | 1.67/30 | 4.1% | 1.35 [0.34, 4.82] | 0.31 |
| all families | 6 | 2.00/30 | 8.2% | 0.81 [0.22, 2.59] | 0.64 |
| shipped four only | 3 | 0.33/30 | 4.1% | 0.27 [0.02, 3.22] | 0.91 |

Per-category n is 2, so those rows mean nothing. One of 32 ablation cells has p < 0.05
(`only:transit_mars`, 0.04), the false positive multiple comparisons predict. Saturation is real
(every target scores above zero in 97-100% of months; disputes averages 3.7 of 7) but ties at the
window top stay at 2-5%, so ranking still discriminates. The real baseline is Harish's file.

## Later (not v1)

A sampled LLM layer (does the chat answer for the event month name the mapped area?), measured
separately; D10 and ashtakavarga families; chart-swap controls. PyJHora as an oracle is skipped:
PyPI says MIT, its licence file says AGPL-3.0, and it needs swisseph.

## Quickstart

```bash
mkdir -p ~/.almamesh/retrodiction
cp examples/retrodiction/events.example.yaml ~/.almamesh/retrodiction/events.yaml
# edit: kind: personal, your birth datetime WITH offset, coordinates, your dated events
cd backend && uv run almamesh-eval retrodiction --events ~/.almamesh/retrodiction/events.yaml --window 36 --k 3,6
# -> ~/.almamesh/retrodiction/retrodiction-report/{report.json,report.md}

# Astro-Databank: the export (.xml, or the .zip with $ALMAMESH_ADB_ZIP_PASSWORD) stays outside git
cd backend && uv run almamesh-eval adb-summary --adb ~/.almamesh/retrodiction/adb/adb_export_<date>.xml
cd backend && uv run almamesh-eval retrodiction --adb ~/.almamesh/retrodiction/adb/adb_export_<date>.xml --window 36 --k 3,6
# -> ~/.almamesh/retrodiction/adb/retrodiction-report/{report.json,report.md}

# DEV scorecard (amendment d): BASELINE vs +exact_transits per area, with the controls
cd backend && uv run almamesh-eval scorecard --adb ~/.almamesh/retrodiction/adb/adb_export_<date>.xml --split dev --workers 6
# -> ~/.almamesh/retrodiction/adb/scorecard/{scorecard.json,scorecard.md}
```

### Amendment 2026-10-16 (i): how the (g1) release look is run (written before any HELD-OUT result)

Engine: `origin/main` (cb2f1152, the shipped engine incl. exact transits) merged into
`feat/exact-transits`; backend gate green (2,084 passed, 99.04% coverage, ruff, mypy).
Harish authorised the one look on 2026-10-16. Measure only, nothing tuned.

**Command, exactly once** (same flags as the DEV run that produced the lead, no
`--day-precision-only`, family `exact_transits`, k and window as the card pre-registers):

```bash
cd backend && uv run almamesh-eval placebo-scorecard --adb ~/.almamesh/retrodiction/adb/adb_export_<date>.xml \
  --split held-out --release-look --added exact_transits --workers 8 \
  --out ~/.almamesh/retrodiction/adb/placebo-scorecard-exact_transits-heldout
```

**Stricter readings, chosen now where (g1) is ambiguous:**
1. *Holm family.* The card computes 16 tests (8 areas incl. relocation x k in {3,6}), so "every
   test run at that look" is read as all 16, not as the single hypothesis. Condition (i) needs the
   relocation k=3 p to pass the Holm step-down at one-sided 0.05 across those 16. The "alone"
   result (cut 0.05) is reported beside it but does not decide the verdict.
2. *All three conditions are required*: p, lift CI lower bound > 1, real/chart-swap ratio CI lower
   bound > 1. The relocation k=3 row of the card is the one tested; no other row can confirm.
3. *One look.* If the run crashes before writing a result, it may be re-run only after the defect
   is fixed without reading any partial HELD-OUT output; a completed run is never repeated.
   Verdict, whatever it is, is final. Nothing is tuned afterwards.
4. *Void controls.* If the card reports planted/controls not ok (VOID), the verdict is
   "not confirmed" (a failure to confirm), not a retry.
5. A pass permits only what (g1) says: designing a relocation area, measured afresh. It promotes
   nothing and is not a prediction claim. A fail closes the lead.
6. Aggregates only go in the repo; the look is logged in `docs/eval/holdout-ledger.md`.
