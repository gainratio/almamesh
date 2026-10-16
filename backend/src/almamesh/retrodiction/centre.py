"""Centre-month hits for amendment (f), with an exact lazy path for an expensive family.

The placebo-calibrated statistic only ever needs the hit of a window's centre month. For a
family that costs a full predictive run per month (``engine_obstacles``, in [0, 1]), most
months are decided by the cheap v1 sum alone: a month whose v1 sum already beats the centre
beats it whatever the family adds, and one that loses even with +1 loses. Only the rest are
evaluated, highest v1 sum first, until max(k) months beat the centre or none is left. The
result is identical to evaluating every month (tests compare both).
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from typing import TYPE_CHECKING, Final

from almamesh.retrodiction.stats import fractional_hit

if TYPE_CHECKING:
    from collections.abc import Callable, Sequence

_DIGITS: Final[int] = 9  # the harness rounds month sums to 9 digits so ties are exact
_CEILING: Final[float] = 1.0


def centre_hits(series: Sequence[float], index: int, ks: Sequence[int]) -> dict[int, float]:
    """The fractional top-k hit of month ``index`` for every k."""
    return {k: fractional_hit(series, index, k) for k in ks}


def _checked(value: float) -> float:
    if not 0.0 <= value <= _CEILING:
        raise ValueError(f"a lazily resolved family must score in [0, 1], got {value}")
    return value


def _total(base: Sequence[float], extra: Callable[[int], float], month: int) -> float:
    return round(base[month] + _checked(extra(month)), _DIGITS)


@dataclass
class _Tally:
    """Months beating the centre, and months tied with it (the centre included)."""

    greater: int
    equal: int = 1

    def add(self, value: float, centre: float) -> None:
        self.greater += value > centre
        self.equal += value == centre

    def hits(self, ks: Sequence[int]) -> dict[int, float]:
        return {k: min(1.0, max(0.0, (k - self.greater) / self.equal)) for k in ks}


def _side(base: float, centre: float) -> str:
    """Where a month falls against the centre before its expensive family is known."""
    if round(base, _DIGITS) > centre:
        return "above"
    return "below" if round(base + _CEILING, _DIGITS) < centre else "open"


def _undecided(base: Sequence[float], index: int, centre: float) -> tuple[int, list[int]]:
    """How many months beat the centre whatever the family adds, and those still open."""
    sides: dict[str, list[int]] = defaultdict(list)
    for month, value in enumerate(base):
        sides[_side(value, centre)].append(month)
    open_ = [month for month in sides["open"] if month != index]
    return len(sides["above"]), sorted(open_, key=lambda month: (-base[month], month))


def lazy_centre_hits(
    base: Sequence[float], index: int, ks: Sequence[int], extra: Callable[[int], float]
) -> dict[int, float]:
    """Centre hits of ``round(base + extra, 9)``, calling ``extra`` only where it matters."""
    centre = _total(base, extra, index)
    greater, open_ = _undecided(base, index, centre)
    tally = _Tally(greater)
    for month in open_:
        if tally.greater >= max(ks):
            break
        tally.add(_total(base, extra, month), centre)
    return tally.hits(ks)


__all__ = ["centre_hits", "lazy_centre_hits"]
