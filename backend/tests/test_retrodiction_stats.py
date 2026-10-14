"""Ranking, hit, base-rate, p-value and interval maths of the retrodiction eval."""

from __future__ import annotations

import math
import random
import time

import pytest

from almamesh.retrodiction import stats
from almamesh.retrodiction.stats import (
    base_rate,
    fractional_hit,
    null_hit_values,
    permutation_pvalue,
    wilson_interval,
)


def test_event_month_strictly_in_top_k_is_a_full_hit() -> None:
    scores = [0.0, 3.0, 1.0, 2.0, 0.5]
    assert fractional_hit(scores, 1, 3) == 1.0
    assert fractional_hit(scores, 3, 3) == 1.0
    assert fractional_hit(scores, 2, 3) == 1.0


def test_event_month_below_top_k_is_a_miss() -> None:
    scores = [0.0, 3.0, 1.0, 2.0, 0.5]
    assert fractional_hit(scores, 4, 3) == 0.0
    assert fractional_hit(scores, 0, 3) == 0.0


def test_ties_share_the_remaining_top_k_slots() -> None:
    # One month strictly above, four tied for 2nd: 2 slots left for 4 tied months.
    scores = [5.0, 1.0, 1.0, 1.0, 1.0, 0.0]
    assert fractional_hit(scores, 2, 3) == pytest.approx(0.5)


def test_flat_scores_earn_exactly_the_base_rate() -> None:
    scores = [2.0] * 73
    assert fractional_hit(scores, 10, 3) == pytest.approx(3 / 73)


@pytest.mark.parametrize(
    "scores", [[1.0, 1.0, 0.0, 2.0, 2.0, 2.0, 0.5], [0.0] * 7, [7, 6, 5, 4, 3, 2, 1]]
)
def test_hits_over_every_month_sum_to_k(scores: list[float]) -> None:
    assert sum(null_hit_values(scores, 3)) == pytest.approx(3.0)


def test_base_rate_is_k_over_n() -> None:
    assert base_rate(3, 73) == pytest.approx(0.0410958904)
    assert base_rate(6, 73) == pytest.approx(0.0821917808)


def test_base_rate_refuses_k_not_below_n() -> None:
    with pytest.raises(ValueError, match="k must be"):
        base_rate(73, 73)


def test_untied_null_matches_the_binomial_tail() -> None:
    # 10 events, 10-month windows, k=1, no ties: Binomial(10, 0.1); P(X >= 3) = 0.0701908264.
    one_hot = [1.0] + [0.0] * 9
    assert permutation_pvalue([one_hot] * 10, 3.0) == pytest.approx(0.0701908264)


def test_observing_nothing_has_p_one() -> None:
    assert permutation_pvalue([[1.0, 0.0, 0.0]] * 4, 0.0) == pytest.approx(1.0)


def test_pvalue_refuses_an_empty_event_list() -> None:
    with pytest.raises(ValueError, match="no events"):
        permutation_pvalue([], 0.0)


def test_wilson_interval_for_five_of_ten() -> None:
    low, high = wilson_interval(5.0, 10)
    assert low == pytest.approx(0.2365931, abs=1e-6)
    assert high == pytest.approx(0.7634069, abs=1e-6)


def test_wilson_interval_refuses_zero_events() -> None:
    with pytest.raises(ValueError, match="n must be"):
        wilson_interval(0.0, 0)


def _direct_pvalue(null_values: list[list[float]], observed: float) -> float:
    """The pre-registered definition, convolved one event at a time (small inputs only)."""
    grid = 10_000
    dist = [1.0]
    for values in null_values:
        ticks = [math.ceil(v * grid - 1e-6) for v in values]
        out = [0.0] * (len(dist) + max(ticks))
        for t in ticks:
            for i, p in enumerate(dist):
                out[t + i] += p / len(values)
        dist = out
    return min(1.0, sum(dist[math.floor(observed * grid + 1e-6) :]))


def _random_window(rng: random.Random, months: int, k: int) -> list[float]:
    """Hits of a window whose scores have random ties (so values are fractional)."""
    scores = [float(rng.randint(0, 4)) for _ in range(months)]
    return null_hit_values(scores, k)


@pytest.mark.parametrize(("seed", "fft"), [(1, False), (2, False), (1, True), (2, True), (3, True)])
def test_the_pvalue_equals_the_one_event_at_a_time_convolution(
    seed: int, fft: bool, monkeypatch: pytest.MonkeyPatch
) -> None:
    if fft:  # force the grouped-FFT path on a set small enough to check by hand
        monkeypatch.setattr(stats, "_DIRECT_WORK", 0)
    rng = random.Random(seed)
    windows = [_random_window(rng, 9, 2) for _ in range(6)] * 2  # repeats are grouped
    for observed in (0.0, 1.5, 2.25, 4.0, 9.0):
        expected = _direct_pvalue(windows, observed)
        floor = stats.FFT_P_FLOOR if fft else 0.0
        assert permutation_pvalue(windows, observed) == pytest.approx(
            max(expected, floor), abs=1e-12
        )


def test_the_fft_path_floors_a_tiny_pvalue(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(stats, "_DIRECT_WORK", 0)
    one_hot = [1.0] + [0.0] * 9
    # Exact P(all 20 hit) = 1e-20; the FFT path reports the floor, never less.
    assert permutation_pvalue([one_hot] * 20, 20.0) == stats.FFT_P_FLOOR


def test_a_large_null_is_computed_in_seconds() -> None:
    # 3000 events over 73-month windows: one event at a time this takes minutes.
    rng = random.Random(20261014)
    windows = [_random_window(rng, 73, 3) for _ in range(40)] * 75
    start = time.perf_counter()
    p_value = permutation_pvalue(windows, 3000 * 3 / 73)
    assert time.perf_counter() - start < 15.0
    assert 0.3 < p_value < 0.7  # the null mean is observed: p near one half
