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
| Astro-Databank (astro.com) | yes, Rodden-rated | yes | **Not usable free.** Terms forbid spidering ("may only be accessed by human readers"); data may be reused non-commercially, text is copyrighted. The only bulk path is the paid research export (200 CHF/yr, `adbexport/adb_license.pdf`). Harish's call: it costs money. If bought, publish ADB ids + aggregates only, never raw rows. |
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
- **Reporting.** `almamesh-eval adb-summary` prints counts only. Published output is ADB ids
  and aggregates only, never rows (licence §5).

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
```
