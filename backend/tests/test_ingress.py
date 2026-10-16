"""Retrograde-aware bisection root-finder for transit ingress/conjunction/return.

The make-or-break property (spec section 3.2/3.6): when a slow graha retrogrades
across a target it can cross up to 3 times; the canonical boundary is the LAST
sticking forward crossing, not the first.
"""

from __future__ import annotations

from datetime import UTC, datetime

from almamesh.transits.ingress import (
    find_brackets,
    find_crossings,
    find_last_crossing,
    refine_bracket,
)


def _line(slope: float, intercept: float, t0: datetime):
    """A deterministic synthetic f(t): linear in days from t0 (no astronomy)."""

    def f(when: datetime) -> float:
        days = (when - t0).total_seconds() / 86400.0
        return slope * days + intercept

    return f


def test_should_find_single_crossing_when_monotone() -> None:
    # Given a monotone increasing function crossing zero at day 10
    t0 = datetime(2026, 1, 1, tzinfo=UTC)
    end = datetime(2026, 3, 1, tzinfo=UTC)
    f = _line(slope=1.0, intercept=-10.0, t0=t0)
    # When we bracket+bisect for the zero crossing
    crossings = find_crossings(f, t0, end, step_days=5.0)
    # Then exactly one crossing is found, near day 10
    assert len(crossings) == 1
    found_day = (crossings[0] - t0).total_seconds() / 86400.0
    assert abs(found_day - 10.0) < 1e-3


def test_should_take_last_crossing_when_target_crossed_three_times() -> None:
    # Given a function that crosses the target three times (retrograde loop):
    # rises through 0 (day ~5), falls back through 0 (day ~15), rises again (~25)
    t0 = datetime(2026, 1, 1, tzinfo=UTC)
    end = datetime(2026, 3, 1, tzinfo=UTC)

    def f(when: datetime) -> float:
        d = (when - t0).total_seconds() / 86400.0
        # cubic-ish: roots at 5, 15, 25
        return (d - 5.0) * (d - 15.0) * (d - 25.0)

    # When all crossings are enumerated
    crossings = find_crossings(f, t0, end, step_days=2.0)
    # Then there are three, and the LAST is the sticking boundary (~day 25)
    assert len(crossings) == 3
    last = find_last_crossing(f, t0, end, step_days=2.0)
    assert last is not None
    last_day = (last - t0).total_seconds() / 86400.0
    assert abs(last_day - 25.0) < 1e-2


def test_should_return_none_when_no_crossing() -> None:
    # Given a function that never reaches the target in the window
    t0 = datetime(2026, 1, 1, tzinfo=UTC)
    end = datetime(2026, 2, 1, tzinfo=UTC)
    f = _line(slope=1.0, intercept=100.0, t0=t0)  # always positive
    # When we search
    last = find_last_crossing(f, t0, end, step_days=5.0)
    # Then nothing is found
    assert last is None


def test_should_be_deterministic_when_called_twice() -> None:
    # Given the same monotone function and window
    t0 = datetime(2026, 1, 1, tzinfo=UTC)
    end = datetime(2026, 3, 1, tzinfo=UTC)
    f = _line(slope=0.3, intercept=-3.0, t0=t0)
    # When bisected twice
    a = find_last_crossing(f, t0, end, step_days=5.0)
    b = find_last_crossing(f, t0, end, step_days=5.0)
    # Then the result is byte-identical (fixed step/tol/iterations)
    assert a == b


def test_should_expose_the_coarse_brackets_find_crossings_refines() -> None:
    # Given a line crossing zero at day 10, sampled every 4 days
    t0 = datetime(2026, 1, 1, tzinfo=UTC)
    f = _line(slope=1.0, intercept=-10.0, t0=t0)
    end = datetime(2026, 3, 1, tzinfo=UTC)
    # When
    brackets = find_brackets(f, t0, end, step_days=4.0)
    # Then one bracket, days 8-12, and refining it gives find_crossings' root
    assert brackets == [(datetime(2026, 1, 9, tzinfo=UTC), datetime(2026, 1, 13, tzinfo=UTC))]
    assert refine_bracket(f, *brackets[0]) == find_crossings(f, t0, end, step_days=4.0)[0]
