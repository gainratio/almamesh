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

### Amendment 2026-10-14: Astro-Databank import (pre-registered before any ADB run)

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
