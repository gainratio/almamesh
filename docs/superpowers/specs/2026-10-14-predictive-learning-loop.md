# Predictive learning loop: from one retrodiction run to a lasting scorecard

Status: draft 2026-10-14. Builds on `2026-10-14-retrodiction-eval-design.md` (amendments a-c).
Branch `feat/retrodiction-eval` (local). Licence-gated: measure-only until astro.com answers.

## TL;DR

1. The Astro-Databank (ADB) eval becomes a per-PR engine scorecard, run locally, aggregates in the PR.
2. Natives are split once (seeded, digest-pinned) into a dev half and a held-out half scored only at release.
3. Missing techniques arrive one family per PR, each with a written hypothesis; a technique ships only
   if its held-out lift beats the engine without it, CI excluding 1 after Holm, per life area.
4. Confidence labels come from a measured reliability table; areas with no lift read as reflection.
5. Until astro.com says tuning is allowed we only measure; if lift stays flat we say so and stay reflective.

## Why

The first real run found nothing. Full set: 12,265 events, k=3 lift 0.96 [0.88, 1.05], p=0.82.
3,000-native sample: 2,926 events, lift 0.90 [0.75, 1.09], p=0.88. No cell of 60 survives Holm or BH.
The app still labels readings "high confidence" when three techniques agree, which is a count, not
evidence. One run is a snapshot. A loop makes every engine change answer "did this help, by how
much, and could we have fooled ourselves?" It also tells users plainly which areas are untested.

## 1. Scorecard on every engine PR

- **Trigger.** Any PR touching `dasha/`, `transits/`, `reading/`, `domains/`, `vargas/`,
  `strength/` or `retrodiction/`.
- **Where.** On Harish's machine or a self-hosted private runner that holds the export outside git.
  Never GitHub-hosted or public CI: licence §5 keeps the raw data confidential.
- **What.** `almamesh-eval scorecard` scores a fixed, seeded dev subsample (sized to finish in
  about 30 min at 14 workers) and prints a markdown block: per area n, lift at k=3 and 6 with 95%
  CI, p, the ablation rows, plus engine tree SHA, split digest, mapping digest, export digest.
- **In the PR.** The block is pasted into the PR body. A cheap public check (no data) fails an
  engine-touching PR whose block is missing or whose engine SHA isn't the PR head.
- **Prove the guard can fail (northstar).** Every scorecard runs two controls and is void if
  either misbehaves: a planted family that peeks at the event month (lift must be near N/k,
  p < 1e-20) and a shuffled-months null (lift CI must include 1). A technique PR also shows one
  mutation: the new family's score forced constant, and its area lift returning to the
  `without:` row. A PR that claims no engine change must produce identical report bytes.

## 2. Development and held-out split

- **One-time split, by native, never by event** (a native's events stay together, so no
  leakage). 50/50 with `random.Random(20261015)` over the kept post-1900 natives in file order.
- **Recorded by digest.** SHA-256 over the export digest, seed and both sorted ADB id lists.
  The digest is pinned in a test; the id lists live beside the export, outside git.
- **Dev set.** Explore, debug, and (only once the licence allows it) tune. Every run is logged.
- **Held-out set.** Scored only for a release candidate, logged as a "look" in
  `docs/eval/holdout-ledger.md` (date, engine SHA, digests, aggregates). At most two looks per
  technique family, ever. The full-set baseline above already saw these natives once, in
  aggregate, before any tuning; the ledger records that as look zero.
- **Promotion rule.** Per life area, on identical held-out events, compare the engine with and
  without the new family. It ships for that area only if (a) the ratio of hit rates has a 95% CI
  above 1 (bootstrap over natives) after Holm across every area tested in that release, (b) the
  area's own lift CI excludes 1, and (c) it beats the chart-swap control (§8). Areas that fail
  keep the family off. Areas with fewer than 300 held-out events are measure-only.

## 3. Technique roadmap (one indicator family per PR)

Ranked by expected value over effort. The bottleneck is month resolution: today's families are
sign-level and change every 1 to 2.5 years, so within ±36 months they barely discriminate.

| # | family | effort | hypothesis (written before any run) |
|---|---|---|---|
| 1 | exact transits: Saturn, Jupiter, Rahu/Ketu, Mars within a fixed orb of a natal significator or the running dasha lord | M | degree contacts lift career and relationships above sign-level transits |
| 2 | Ashtakavarga bindus as a transit weight (exists) | S | a Jupiter/Saturn transit through a high-bindu sign lifts career and finances; low-bindu lifts losses |
| 3 | D10 for career, D30 for disputes and health (exist) | S | running lords tied to D10 10th / D30 malefics lift those areas only |
| 4 | eclipses on natal Sun, Moon, lagna and their lords | M | an eclipse within orb lifts relocation, separation and health in its month |
| 5 | Chara dasha in readings (exists in `dasha/chara.py`) | M | Jaimini sign periods lift relationships and career independently of Vimshottari |
| 6 | Varshaphal with Muntha | L | the year's Muntha house lifts the matching area in that solar year |
| 7 | argala on target houses | S | natal, not timed; tested as a modifier of family 1, expected small |

Each PR adds one `IndicatorFamily`, a dated amendment holding its hypothesis, score formula and
fixed constants (orbs included), then the dev scorecard. Orbs and weights are classical values
from the cited text, never fitted, while the licence question is open.

Technique #1's hypothesis, formula and constants are fixed in the eval spec's amendment (d).

## 3b. A small interpretable model per life area (after the first techniques land)

Added 2026-10-14 (amendment d). Licence-gated: see the last bullet.

- **When.** After the first roadmap families have their own DEV scorecards, so the model has
  real engine features to weigh. Not before: a model over sign-level features alone would
  only re-weigh what already shows no lift.
- **What.** One logistic regression per life area, nothing deeper. Rows are the months of
  each DEV event window (the event month is 1, the other 72 are 0); features are the engine's
  per-family month scores (exactly the `IndicatorFamily` columns the harness already
  computes), standardised on DEV. L2 penalty with a fixed strength chosen before the fit, no
  search over it, no interaction terms. Because each window has exactly one positive, the fit
  is stratified by event (conditional logistic regression is the exact form; plain logistic
  with per-window centring is the accepted approximation, chosen in the model PR's
  amendment).
- **Library.** Neither scikit-learn nor statsmodels is in `uv.lock` today. The model PR adds
  **scikit-learn** (`LogisticRegression`) as an eval-only optional extra, never a runtime
  dependency of the engine wheel; statsmodels only if coefficient standard errors are needed
  and sklearn cannot give them. The shipped engine never imports either.
- **Evaluation, once.** Fit on DEV, then score HELD-OUT a single time as a logged look, with
  the same rules as a family: per area, the month score is the model's linear predictor, the
  lift and its CI, Holm across areas, the ratio against the engine without the model, and the
  chart-swap control (the model must beat its own chart-swapped score). It ships for an area
  only if it passes §2's promotion rule; otherwise that area keeps the unweighted sum.
- **What ships.** Coefficients only: a small typed data file
  (`resources/area_weights.json`: area → intercept, feature name → weight, feature scaling,
  DEV n, digests of split, mapping and engine tree) inside the signed engine bundle, read
  through a Pydantic model that rejects unknown features and areas. No ADB id, row, date or
  per-native value, ever. Tests: the file parses, every feature name is a live family, an
  unknown feature is refused, and a missing file means the unweighted sum (fail closed to
  today's behaviour). The bundle's content address changes with it, so it is reviewable.
- **Licence gate.** Fitting on ADB is tuning. It waits for astro.com's written confirmation
  that tuning on the export is allowed (thread with adbdata@astro.com pending). Until then
  the model step may be built and tested on **synthetic data only** (planted-signal windows
  and the synthetic null file); no fit on DEV, no coefficients from ADB.

## 4. Confidence calibration

- **What is measured.** For each area and each engine label (agreement 0-3 and strength band),
  how much more often a recorded event falls in months with that label than in other months of
  its window. That is lift per bucket, with a Wilson CI, on the dev set; checked on held-out.
- **Lift, never a probability.** ADB records only famous, reported events, so absolute rates mean
  nothing for a user. Relative lift is what transfers.
- **Monotone.** Non-monotone buckets are pooled (pool-adjacent-violators, scikit-learn
  `IsotonicRegression`), never hand-smoothed.
- **What ships.** `calibration.json` in the signed bundle: area × bucket → lift, CI, n, and an
  `evidence` flag (`measured` only if the CI lower bound is above 1). Aggregates only, every cell
  n ≥ 30, no ADB ids or rows; a test asserts that shape. The app's confidence labels read this
  table. A missing table or area means `reflective` (fail closed).

## 5. Product honesty

The copy rule, in plain English:

> If our tests have not shown that readings for a life area beat chance, the app and the AI must
> not say or imply that something in that area will happen, is likely, or is due. They describe
> the period as themes to reflect on. Where tests did show lift, they may say "in our tests,
> periods like this matched real events more often than chance", never "will".

- **One line, once per reading,** under the area heading, not on every sentence: "Timing for this
  area hasn't beaten chance in our tests. Read it as reflection, not prediction." A link goes to a
  short methods page with the aggregate numbers.
- **AI prompt rule.** Reflective areas get no forecast verbs ("will", "expect", "likely", "due").
- **Today every area is reflective**, because nothing has beaten chance. Translated in en/es/pt.
- **Guard.** A test flips one area's flag to `measured` without table support and must go red.

## 6. Personal opt-in calibration (later phase)

Users can already record dated life events on the device (the rectification `lifeEvents` store).
Later, the same harness runs in Pyodide on their own events: "4 of your 9 events fell in the top 3
months of their window; chance is about 0.4." Nothing leaves the device. No per-user tuning:
with n near 10 it would only fit noise. It is a mirror, not a model, and comes after §1-5 ship.

## 7. Licence gating (SADBY1)

| allowed now | waits for astro.com's answer on tuning |
|---|---|
| scorecard, split, classical families with fixed constants, published aggregates, honesty copy | fitting any constant on dev, promoting a family on ADB evidence, shipping `calibration.json` |

The question went to adbdata@astro.com; no answer yet. Research use and publishing anonymized
statistics survive expiry. Raw rows never leave the machine. If the answer is no, techniques ship
on classical grounds only, every area stays reflective, and §6 becomes the only calibration path.

## 8. Risks, and what we do about them

- **Garden of forking paths.** Every dev run, mapping change and orb choice is logged with a
  count. Hypotheses are written first. Held-out looks are capped and enter the Holm family.
  The category→house mapping is itself a hypothesis; changing it is a fork and needs an amendment.
- **Overfitting.** Split by native; at most a few classical constants per family; dev wins
  never count as evidence.
- **Calendar artefacts.** Marriages cluster by season and slow planets cycle on fixed periods, so
  a family can "predict" the calendar, not the chart. Control: score each native's event months
  against a chart-swapped native born in the same year. Real lift must beat that control.
- **Dataset bias.** Celebrity-skewed and reporting-biased (marriage 8,095 vs job_loss 426);
  43.8% of events are year-only and excluded, so month-dated events favour well-documented kinds;
  Rodden AA/A only; pre-1900 births excluded (Lahiri table from 1900, DE421 from 1899-07-29).
  So results are per area, never one pooled headline, and say which population they describe.
- **Lift stays flat.** Likely, and consistent with Carlson 1985 and Dean & Kelly 2003. Stop rule:
  if the first four roadmap families promote nothing on held-out, pause the roadmap. Then we
  publish the null as aggregates on the methods page, keep every area reflective, frame time
  travel as "what the tradition says about this month", and keep the scorecard as a regression
  guard (identical bytes for no-op PRs, controls that can fail).
