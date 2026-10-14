"""Ranking, hit, base-rate, p-value and interval maths of the retrodiction eval."""

from __future__ import annotations

import pytest

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
