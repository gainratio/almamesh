"""Centre-month hits (eager and lazily resolved) and the placebo centres of amendment (f)."""

from __future__ import annotations

import random

import pytest

from almamesh.retrodiction.centre import centre_hits, lazy_centre_hits
from almamesh.retrodiction.controls import PLACEBOS, placebo_centres
from almamesh.retrodiction.engine import add_months
from almamesh.retrodiction.stats import fractional_hit

KS = (3, 6)


def test_should_give_the_fractional_hit_of_the_centre_for_every_k() -> None:
    series = [0.0, 1.0, 1.0, 1.0, 2.0, 0.0, 1.0]
    assert centre_hits(series, 3, KS) == {3: fractional_hit(series, 3, 3), 6: 1.0}


def _random_window(rng: random.Random) -> tuple[list[float], list[float]]:
    base = [rng.choice((0.0, 0.5, 1.0, 1.5, 2.0, 3.0)) for _ in range(73)]
    extra = [rng.choice((0.0, 0.0, 0.25, 0.5, 0.75, 1.0)) for _ in range(73)]
    return base, extra


@pytest.mark.parametrize("seed", range(300))
def test_should_match_full_evaluation_when_the_extra_family_is_resolved_lazily(seed: int) -> None:
    # Given a v1 sum and an expensive family in [0, 1] (ties included)
    rng = random.Random(seed)
    base, extra = _random_window(rng)
    full = [round(b + e, 9) for b, e in zip(base, extra, strict=True)]
    # When resolved lazily, Then every k's centre hit equals the fully evaluated one
    assert lazy_centre_hits(base, 36, KS, extra.__getitem__) == centre_hits(full, 36, KS)


def test_should_not_evaluate_months_already_decided_by_the_cheap_sum() -> None:
    # Given six months whose v1 sum alone beats the centre's best case
    base = [0.0] * 73
    for month in range(6):
        base[month] = 5.0
    asked: list[int] = []

    def extra(month: int) -> float:
        asked.append(month)
        return 0.5

    # When / Then the centre misses at every k and only the centre was evaluated
    assert lazy_centre_hits(base, 36, KS, extra) == {3: 0.0, 6: 0.0}
    assert asked == [36]


def test_should_stop_evaluating_once_k_months_beat_the_centre() -> None:
    # Given every month ambiguous by the cheap sum and the first ones evaluated beating it
    base = [1.0] * 73
    asked: list[int] = []

    def extra(month: int) -> float:
        asked.append(month)
        return 0.0 if month == 36 else 1.0

    assert lazy_centre_hits(base, 36, KS, extra) == {3: 0.0, 6: 0.0}
    assert len(asked) == 1 + max(KS)


def test_should_refuse_an_extra_score_outside_zero_to_one() -> None:
    with pytest.raises(ValueError, match=r"\[0, 1\]"):
        lazy_centre_hits([0.0] * 73, 36, KS, lambda _: 1.5)


def _always(_: tuple[int, int]) -> bool:
    return True


def test_should_draw_the_same_placebo_centres_for_the_same_event() -> None:
    first = placebo_centres((2000, 6), "n1", 0, _always)
    assert first == placebo_centres((2000, 6), "n1", 0, _always)
    assert first != placebo_centres((2000, 6), "n1", 1, _always)
    assert len(first) == PLACEBOS == 4


def test_should_put_every_placebo_centre_73_to_146_months_away() -> None:
    for ordinal in range(50):
        for centre in placebo_centres((2000, 6), "n", ordinal, _always):
            gap = abs((centre[0] * 12 + centre[1]) - (2000 * 12 + 6))
            assert 73 <= gap <= 146


def test_should_flip_a_placebo_that_leaves_the_range_and_drop_it_if_both_sides_do() -> None:
    month = (2000, 6)

    def after_only(centre: tuple[int, int]) -> bool:
        return centre > month

    def nowhere(_: tuple[int, int]) -> bool:
        return False

    assert all(c > month for c in placebo_centres(month, "n", 0, after_only))
    assert len(placebo_centres(month, "n", 0, after_only)) == PLACEBOS
    assert placebo_centres(month, "n", 0, nowhere) == []


def test_should_keep_both_signs_when_both_sides_fit() -> None:
    centres = [c for i in range(20) for c in placebo_centres((2000, 6), "n", i, _always)]
    assert any(c < (2000, 6) for c in centres)
    assert any(c > add_months((2000, 6), 72) for c in centres)
