# Retrodiction results: Astro-Databank, first real run (2026-10-14)

Aggregates only. Licence §5 keeps the raw export confidential, so this note carries no names,
ids, birth data or per-event rows. The per-event reports stay private under
`~/.almamesh/retrodiction/adb/`. Design and amendments (a)-(c), all committed before the runs
they govern: `2026-10-14-retrodiction-eval-design.md`.

## TL;DR

**No predictive lift.** The event month lands in its window's top 3 slightly *less* often than
chance. Overall lift at k=3 is 0.90 [0.75, 1.08] (p = 0.89) on the 3,000-native sample and
0.96 [0.88, 1.05] (p = 0.82) on the full set of 12,265 events. No per-category or ablation cell
survives Holm or Benjamini-Hochberg in any run. The obstacles-domain engine change does not
change this: its own month score, used as a new indicator, ranks legal and accident months at
chance (lift 1.02 [0.65, 1.60]).

## What was run

| item | value |
|---|---|
| export | 82,382 entries; 12,529 natives kept (Rodden AA/A, a known time, at least one mapped event) |
| pre-1900 natives | **2,408 excluded** (5,205 events, any precision; the amendment's 5,215 used a cutoff one day later). The engine's Lahiri table starts 1900-01-01 and fails closed |
| full set | 12,265 rankable events (month or day precision) from 6,885 natives |
| headline sample | 3,000 natives, `--seed 20261014` (amendment b): 2,926 rankable events, **2,922 in the paired before/after** (4 dropped under amendment c) |
| config | window ±36 months (N = 73), k = 3, 6, mapping digest `2ae6e16d…` (before) / `295dcb9a…` (after, +1 family) |
| runtime | BASELINE sample 10 min (4 processes); BASELINE full 40 min (4 processes, mostly the FFT p-values); AFTER 2 h 08 min (15 processes, 75k CPU-s: one full app predictive run per disputes month) |

Chance is k/N exactly for every event (ties split exactly): 4.1% at k=3, 8.2% at k=6.

## Before / after (same 2,922 events)

BEFORE = the seven v1 families. AFTER = feat/obstacles-domain merged, plus one new family,
`engine_obstacles`: the shipped period reading's obstacles-theme strength for the month, scored
on the disputes target only. The merge does not touch any v1 family's inputs. The check is
exact: AFTER's `without:engine_obstacles` equals BEFORE `all` to the last digit (hits 108.2956
and 224.859, same p), and 13 of 15 categories are byte-identical.

| set | k | hits / n | rate | lift [95% CI] | p |
|---|---|---|---|---|---|
| BEFORE, all families | 3 | 108.3 / 2922 | 3.7% | 0.90 [0.75, 1.08] | 0.89 |
| AFTER, all families | 3 | 109.8 / 2922 | 3.8% | 0.91 [0.76, 1.10] | 0.86 |
| BEFORE, all families | 6 | 224.9 / 2922 | 7.7% | 0.94 [0.83, 1.06] | 0.87 |
| AFTER, all families | 6 | 223.2 / 2922 | 7.6% | 0.93 [0.82, 1.05] | 0.89 |
| full set (different sample), BEFORE | 3 | 486.0 / 12265 | 4.0% | 0.96 [0.88, 1.05] | 0.82 |
| full set (different sample), BEFORE | 6 | 978.1 / 12265 | 8.0% | 0.97 [0.91, 1.03] | 0.85 |

## Per category (sample, BEFORE → AFTER)

Only `legal` and `accident` can change (the new family scores 0 elsewhere). "> 0" is the share
of window months scoring above zero; "top tie" is the share of a window tied at its maximum
(saturation control). The full-set k=3 lift is a different, larger sample.

| category | n | k=3 rate | k=3 lift [CI] | p | k=6 rate | k=6 lift | p | > 0 | top tie | full-set k=3 lift (n) |
|---|---|---|---|---|---|---|---|---|---|---|
| legal | 305 | 2.7% → 3.1% | 0.66 → 0.74 [0.40, 1.38] | 0.92 → 0.84 | 7.2% → 6.4% | 0.88 → 0.78 | 0.75 → 0.88 | 100% | 3.1% → 2.0% | 1.02 (1209) |
| accident | 114 | 4.8% → 5.2% | 1.16 → 1.26 [0.58, 2.66] | 0.33 → 0.26 | 9.1% → 9.6% | 1.10 → 1.17 | 0.35 → 0.28 | 100% | 3.5% → 2.2% | 1.09 (411) |
| marriage | 939 | 4.6% | 1.12 [0.83, 1.49] | 0.21 | 8.9% | 1.08 | 0.20 | 100% | 3.0% | 1.01 (4032) |
| death_in_family | 493 | 3.4% | 0.83 [0.52, 1.31] | 0.81 | 6.9% | 0.84 | 0.88 | 100% | 3.3% | 0.95 (2091) |
| job_start | 248 | 2.5% | 0.61 [0.28, 1.28] | 0.93 | 6.2% | 0.75 | 0.90 | 100% | 2.9% | 0.90 (1020) |
| career_change | 223 | 4.0% | 0.96 [0.51, 1.80] | 0.53 | 8.0% | 0.97 | 0.54 | 97% | 2.8% | 0.79 (843) |
| health | 209 | 2.3% | 0.56 [0.23, 1.30] | 0.94 | 6.8% | 0.83 | 0.78 | 100% | 2.8% | 0.77 (854) |
| separation | 189 | 2.1% | 0.52 [0.20, 1.30] | 0.96 | 4.6% | 0.56 | 0.98 | 100% | 4.6% | 0.69 (875) |
| job_loss | 63 | 5.3% | 1.28 [0.46, 3.36] | 0.28 | 8.8% | 1.07 | 0.41 | 100% | 3.0% | 1.28 (256) |
| relationship_start | 46 | 4.3% | 1.06 [0.29, 3.54] | 0.44 | 7.5% | 0.91 | 0.55 | 99% | 2.7% | 1.56 (197) |
| education | 25 | 6.0% | 1.46 [0.34, 5.43] | 0.28 | 8.0% | 0.97 | 0.53 | 100% | 3.4% | 1.16 (95) |
| financial_gain | 24 | 10.4% | 2.53 [0.80, 6.93] | 0.074 | 15.6% | 1.90 | 0.10 | 99% | 2.5% | 2.13 (115) |
| relocation | 21 | 5.6% | 1.37 [0.27, 5.81] | 0.30 | 11.7% | 1.42 | 0.27 | 100% | 2.5% | 1.12 (144) |
| financial_loss | 12 | 3.6% | 0.87 [0.08, 7.14] | 0.45 | 15.5% | 1.88 | 0.22 | 100% | 4.1% | 0.70 (64) |
| birth_of_child | 11 | 0.0% | 0.00 [0.00, 6.30] | 1 | 0.0% | 0.00 | 1 | 98% | 2.7% | 0.76 (59) |

Pooled disputes (legal + accident, n = 419): k=3 lift 0.80 → 0.89, k=6 0.94 → 0.89. That is
noise in both directions. The new family alone on those 419 events scores lift 1.02
[0.65, 1.60] at k=3 and 1.06 [0.78, 1.44] at k=6. Saturation is real: 97-100% of months score
above zero for every target. But top-of-window ties stay at 2-5%, so ranking still
discriminates. The null is not an artefact of flat scores.

## Ablation (which families carry signal)

None do. On the sample (BEFORE, k=3): every `only:<family>` lift is 0.85-1.00. Several sit at
or below chance with p ≈ 1, among them `only:yogini` 0.85 [0.70, 1.03] and
`only:transit_nodes` 0.89. `shipped_only` (the four the themes use) is 0.93 [0.77, 1.11].
Removing `double_transit` or `transit_jupiter_saturn` pulls the sum further below chance
(0.76, 0.85), but each alone is at chance (1.00, 0.98). That is a reshuffle of ties, not a
signal. AFTER adds `only:engine_obstacles` 1.00 overall (non-disputes events tie flat at
chance). On the full set the same pattern holds: `only:yogini` is 0.86 [0.78, 0.94] and
`only:vimshottari_lords` 0.90 [0.82, 0.99], both *below* chance.

## Multiple comparisons

The tested cells per run are per category × k, plus each ablation variant × k other than `all`:
60 for BEFORE, 64 for AFTER.

| run | cells | raw p < 0.05 | Holm survivors | BH survivors |
|---|---|---|---|---|
| BEFORE, sample (paired) | 60 | 0 | 0 | 0 |
| AFTER, sample | 64 | 0 | 0 | 0 |
| BEFORE, full set | 60 | 3 | 0 | 0 |

The three raw hits on the full set are `financial_gain` at k=3 (lift 2.13, p = 0.008) and k=6
(1.60, p = 0.027), and `relationship_start` at k=3 (1.56, p = 0.044). About 3 of 60 is what
chance alone produces. `financial_gain` is n = 115 and should be watched on held-out data, but
it is not a finding.

## Caveats

- **Events cluster within natives.** 12,265 events come from 6,885 natives, up to 39 each. The
  permutation null treats events as independent, so the p-values and CIs are somewhat too
  narrow in both directions. That makes the below-chance single-family lifts (yogini, dasha
  lords) suspect too. The one-sided pre-registered test cannot flag "below chance" anyway. A
  native-level cluster bootstrap is the next step; it was not pre-registered here.
- **The mapping is a hypothesis.** A null can mean the category → houses/karakas table is
  wrong, not only that the techniques fail. The sample is famous people (ADB), and the event
  dates are ADB's.
- The full set and the sample differ in n, so compare within a row type, not across.

## Product limitations found by this run

1. **The engine cannot chart a birth before 1900.** The Lahiri table starts 1900-01-01 and
   fails closed. That is 19% of the kept AA/A natives (2,408 of 12,529). The app has the same
   limit.
2. **The app's month reading fails for some births around 1900.** The predictive run searches
   a Sade Sati cycle that starts before DE421's first date (1899-07-29) and raises
   `EphemerisRangeError`, an error that also cannot be pickled across processes. That crashed
   the first AFTER run (amendment c). Four sampled events hit it.

## Reproduce

```bash
cd backend
# BEFORE (eval branch): the sample, then the full set
uv run almamesh-eval retrodiction --adb ~/.almamesh/retrodiction/adb/adb_export_<date>.xml \
  --window 36 --k 3,6 --sample-natives 3000 --seed 20261014 --workers 4 \
  --out ~/.almamesh/retrodiction/adb/report-baseline-sample3000
uv run almamesh-eval retrodiction --adb ~/.almamesh/retrodiction/adb/adb_export_<date>.xml \
  --window 36 --k 3,6 --workers 4
# AFTER (scratch branch eval/obstacles-ab): same flags, --workers 15, out report-after-sample3000
```
