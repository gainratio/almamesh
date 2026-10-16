"""Amendment (f): the placebo-calibrated lift has no centre bias; the k/N lift does.

Synthetic natives carry a step-function score (the shape of a dasha or yogini family). Each
event sits at the centre of its ±36 window, as in the real eval, and its placebo windows are
centred 73-146 months away on the same series, as amendment (f1) draws them.
"""

from __future__ import annotations

import random

import pytest

from almamesh.retrodiction.placebo import (
    EventHits,
    placebo_summary,
    shifted_control,
    swap_comparison,
)
from almamesh.retrodiction.stats import fractional_hit

HALF = 36
MONTHS = 2 * HALF + 1
KS = (3, 6)
SET = "step"
SEED = 20261015


def _step_series(rng: random.Random, length: int) -> list[float]:
    """Piecewise-constant levels with random block lengths: a dasha-like family."""
    series: list[float] = []
    while len(series) < length:
        series += [rng.choice((0.0, 0.5, 1.0))] * rng.randint(6, 40)
    return series[:length]


def _hits(series: list[float], centre: int) -> dict[tuple[str, int], float]:
    window = series[centre - HALF : centre + HALF + 1]
    return {(SET, k): fractional_hit(window, HALF, k) for k in KS}


def _native(rng: random.Random, name: str, bump: float) -> EventHits:
    series = _step_series(rng, 420)
    centre = rng.randint(HALF + 146, 420 - HALF - 147)
    series[centre] += bump
    offsets = [rng.choice((-1, 1)) * rng.randint(73, 146) for _ in range(4)]
    placebos = tuple(_hits(series, centre + o) for o in offsets)
    return EventHits(name, 0, "career", _hits(series, centre), placebos)


def _natives(count: int, bump: float = 0.0, seed: int = 7) -> list[EventHits]:
    rng = random.Random(seed)
    return [_native(rng, f"n{i}", bump if i % 3 == 0 else 0.0) for i in range(count)]


@pytest.fixture(scope="module")
def null_events() -> list[EventHits]:
    return _natives(12000)


def test_should_bias_the_old_k_over_n_lift_below_one_on_a_pure_step_series(
    null_events: list[EventHits],
) -> None:
    # Given no event signal at all, When scored the old way, Then the centre is penalised
    summary = placebo_summary(null_events, SET, 3, MONTHS, SEED)
    assert 0.80 < summary.old.lift < 0.95
    assert summary.old.high < 1.0


@pytest.mark.parametrize("k", KS)
def test_should_give_placebo_calibrated_lift_near_one_on_a_pure_step_series(
    null_events: list[EventHits], k: int
) -> None:
    summary = placebo_summary(null_events, SET, k, MONTHS, SEED)
    assert summary.lift is not None
    assert summary.low is not None
    assert summary.high is not None
    assert abs(summary.lift - 1.0) < 0.08
    assert summary.low <= 1.0 <= summary.high
    assert summary.p > 0.05


def test_should_still_find_a_planted_signal_with_the_placebo_lift() -> None:
    # Given a third of the event months lifted above every level, Then lift >> 1 and p tiny
    summary = placebo_summary(_natives(1500, bump=2.0), SET, 3, MONTHS, SEED)
    assert summary.lift is not None
    assert summary.lift > 3.0
    assert summary.low is not None
    assert summary.low > 2.0
    assert summary.p < 1e-9


def test_should_fail_a_biased_family_on_the_old_shifted_control_but_not_the_new(
    null_events: list[EventHits],
) -> None:
    control = shifted_control(null_events, SET, 3, MONTHS, SEED)
    assert control.old_fails
    assert not control.fails
    assert control.old.lift < 0.95


def test_should_fail_the_new_shifted_control_when_placebo_one_is_systematically_high() -> None:
    # Given a family whose first placebo always wins the top slot, the control must fail
    events = [
        EventHits(f"n{i}", 0, "career", {(SET, 3): 0.0}, ({(SET, 3): 1.0}, {(SET, 3): 0.04}))
        for i in range(200)
    ]
    assert shifted_control(events, SET, 3, MONTHS, SEED).fails


def test_should_leave_the_lift_undefined_when_no_placebo_ever_hits() -> None:
    events = [EventHits("a", 0, "career", {(SET, 3): 1.0}, ({(SET, 3): 0.0},))]
    summary = placebo_summary(events, SET, 3, MONTHS, SEED)
    assert summary.lift is None
    assert summary.low is None


def test_should_refuse_a_summary_without_events() -> None:
    with pytest.raises(ValueError, match="no events"):
        placebo_summary([], SET, 3, MONTHS, SEED)


def test_should_pass_the_shifted_control_whatever_the_real_window_scores() -> None:
    # Given a real signal at every event month and flat placebos, the control reads placebos only
    flat = {(SET, 3): 0.5}
    events = [
        EventHits(f"n{i}", 0, "career", {(SET, 3): 1.0}, (flat, flat, flat)) for i in range(50)
    ]
    control = shifted_control(events, SET, 3, MONTHS, SEED)
    assert not control.fails
    assert control.placebo.value == pytest.approx(1.0)


def test_should_refuse_a_shifted_control_without_two_placebos() -> None:
    lone = EventHits("a", 0, "career", {(SET, 3): 1.0}, ({(SET, 3): 0.5},))
    with pytest.raises(ValueError, match="two placebo windows"):
        shifted_control([lone], SET, 3, MONTHS, SEED)


def test_should_count_only_events_with_a_placebo() -> None:
    lone = EventHits("a", 0, "career", {(SET, 3): 1.0}, ())
    kept = EventHits("b", 0, "career", {(SET, 3): 1.0}, ({(SET, 3): 0.5},))
    summary = placebo_summary([lone, kept], SET, 3, MONTHS, SEED)
    assert summary.n == 1
    assert summary.hits == 1.0
    assert summary.placebo_hits == 0.5


def test_should_compare_real_and_swapped_centre_hits_event_by_event() -> None:
    # Given 30 natives whose real centre hits twice as often as the swapped chart's centre
    real = [EventHits(f"n{i}", j, "career", {(SET, 3): 0.5}, ()) for i in range(30) for j in (0, 1)]
    swap = [EventHits(f"n{i}~m{i}", 0, "career", {(SET, 3): 0.25}, ()) for i in range(30)]
    comparison = swap_comparison(real, swap, SET, 3, MONTHS, SEED)
    # Then only the events scored both ways count (ordinal 0), and the ratio is 2
    assert comparison.n == 30
    assert comparison.ratio == pytest.approx(2.0)
    assert comparison.low == pytest.approx(2.0)
    assert comparison.swap_old_lift == pytest.approx(0.25 / (3 / MONTHS))


def test_should_leave_the_swap_ratio_undefined_when_the_swap_never_hits() -> None:
    real = [EventHits("n", 0, "career", {(SET, 3): 1.0}, ())]
    swap = [EventHits("n~m", 0, "career", {(SET, 3): 0.0}, ())]
    assert swap_comparison(real, swap, SET, 3, MONTHS, SEED).ratio is None


def test_should_report_an_empty_swap_comparison_when_nothing_pairs() -> None:
    real = [EventHits("n", 0, "career", {(SET, 3): 1.0}, ())]
    comparison = swap_comparison(real, [], SET, 3, MONTHS, SEED)
    assert comparison.n == 0
    assert comparison.ratio is None
