"""Hit, base-rate, exact-null p-value and Wilson-interval maths for the retrodiction eval.

Hits are fractional so ties are honest: a month tied with others for the last top-k
slots earns the exact probability that uniform tie-breaking puts it inside. Summed
over every month of a window that is exactly ``k``, so the base rate is ``k / N``
whatever the score distribution, flat or saturated.
"""

from __future__ import annotations

import math
from collections import Counter
from typing import TYPE_CHECKING, Final

import numpy as np

if TYPE_CHECKING:
    from collections.abc import Sequence

    from numpy.typing import NDArray

_Z95: Final[float] = 1.959963984540054
_GRID: Final[int] = 10_000
_SLACK: Final[float] = 1e-6


def fractional_hit(scores: Sequence[float], index: int, k: int) -> float:
    """P(month ``index`` is in the top ``k``) under uniform tie-breaking."""
    score = scores[index]
    greater = sum(1 for s in scores if s > score)
    equal = sum(1 for s in scores if s == score)
    return min(1.0, max(0.0, (k - greater) / equal))


def null_hit_values(scores: Sequence[float], k: int) -> list[float]:
    """The hit each month of the window would earn if it were the event month."""
    return [fractional_hit(scores, i, k) for i in range(len(scores))]


def base_rate(k: int, n: int) -> float:
    """Chance of a top-``k`` hit for a uniformly placed event month among ``n``."""
    if not 0 < k < n:
        raise ValueError(f"k must be in 1..{n - 1}, got {k}")
    return k / n


def _ticks(value: float, *, up: bool) -> int:
    """``value`` on the hit grid, rounded up (null values) or down (the observed sum)."""
    scaled = value * _GRID
    return math.ceil(scaled - _SLACK) if up else math.floor(scaled + _SLACK)


def _convolve(dist: NDArray[np.float64], values: Sequence[float]) -> NDArray[np.float64]:
    """Add one event whose hit is uniform over ``values`` to the sum distribution."""
    pmf = Counter(_ticks(v, up=True) for v in values)
    out = np.zeros(len(dist) + max(pmf), dtype=np.float64)
    for shift, count in pmf.items():
        out[shift : shift + len(dist)] += dist * (count / len(values))
    return out


def permutation_pvalue(null_values: Sequence[Sequence[float]], observed: float) -> float:
    """One-sided P(null sum of hits >= observed), enumerating every event month exactly.

    Hits live on a 1e-4 grid: null values round up and the observed sum rounds down,
    so the p-value is never understated. 0/1 hits are exact (the binomial tail).
    """
    if not null_values:
        raise ValueError("no events to test")
    dist = np.ones(1, dtype=np.float64)
    for values in null_values:
        dist = _convolve(dist, values)
    return float(min(1.0, dist[_ticks(observed, up=False) :].sum()))


def wilson_interval(hits: float, n: int, z: float = _Z95) -> tuple[float, float]:
    """95% Wilson score interval for a (possibly fractional) hit count out of ``n``."""
    if n <= 0:
        raise ValueError(f"n must be positive, got {n}")
    rate, z2 = hits / n, z * z
    centre = (rate + z2 / (2 * n)) / (1 + z2 / n)
    half = z * math.sqrt(rate * (1 - rate) / n + z2 / (4 * n * n)) / (1 + z2 / n)
    return max(0.0, centre - half), min(1.0, centre + half)


__all__ = [
    "base_rate",
    "fractional_hit",
    "null_hit_values",
    "permutation_pvalue",
    "wilson_interval",
]
