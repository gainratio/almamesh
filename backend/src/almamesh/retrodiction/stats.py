"""Hit, base-rate, exact-null p-value and Wilson-interval maths for the retrodiction eval.

Hits are fractional so ties are honest: a month tied with others for the last top-k
slots earns the exact probability that uniform tie-breaking puts it inside. Summed
over every month of a window that is exactly ``k``, so the base rate is ``k / N``
whatever the score distribution, flat or saturated.
"""

from __future__ import annotations

import heapq
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
_DIRECT_WORK: Final[int] = 200_000_000
FFT_P_FLOOR: Final[float] = 1e-12


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


Pmf = tuple[tuple[int, float], ...]


def _event_pmf(values: Sequence[float]) -> Pmf:
    """One event's null hit distribution on the grid: (tick, probability) pairs."""
    counts = Counter(_ticks(v, up=True) for v in values)
    return tuple(sorted((tick, count / len(values)) for tick, count in counts.items()))


def _fft_size(length: int) -> int:
    """The power of two at or above ``length`` (no circular wrap-around)."""
    return 1 << (length - 1).bit_length()


def _power(pmf: Pmf, times: int) -> NDArray[np.float64]:
    """The sum of ``times`` independent events sharing ``pmf``, via one FFT."""
    length = pmf[-1][0] * times + 1
    size = _fft_size(length)
    base = np.zeros(size, dtype=np.float64)
    for tick, prob in pmf:
        base[tick] += prob
    spectrum = np.fft.rfft(base) ** times
    return np.clip(np.fft.irfft(spectrum, size)[:length], 0.0, None)


def _convolve(a: NDArray[np.float64], b: NDArray[np.float64]) -> NDArray[np.float64]:
    """The distribution of the sum of two independent parts (FFT, no wrap-around)."""
    length = len(a) + len(b) - 1
    size = _fft_size(length)
    product = np.fft.rfft(a, size) * np.fft.rfft(b, size)
    return np.clip(np.fft.irfft(product, size)[:length], 0.0, None)


def _sum_distribution(parts: list[NDArray[np.float64]]) -> NDArray[np.float64]:
    """Convolve every part, always the two shortest first (Huffman order)."""
    heap = [(len(part), i, part) for i, part in enumerate(parts)]
    heapq.heapify(heap)
    serial = len(heap)
    while len(heap) > 1:
        _, _, a = heapq.heappop(heap)
        _, _, b = heapq.heappop(heap)
        merged = _convolve(a, b)
        heapq.heappush(heap, (len(merged), serial, merged))
        serial += 1
    return heap[0][2]


def _direct(pmfs: list[Pmf]) -> NDArray[np.float64]:
    """Convolve one event at a time: exact to float rounding, cheap for small sets."""
    dist = np.ones(1, dtype=np.float64)
    for pmf in pmfs:
        out = np.zeros(len(dist) + pmf[-1][0], dtype=np.float64)
        for shift, prob in pmf:
            out[shift : shift + len(dist)] += dist * prob
        dist = out
    return dist


def _fft(pmfs: list[Pmf]) -> NDArray[np.float64]:
    """Group identical events, one FFT power per group, then convolve the groups."""
    return _sum_distribution([_power(pmf, times) for pmf, times in Counter(pmfs).items()])


def _is_small(pmfs: list[Pmf]) -> bool:
    return len(pmfs) * sum(pmf[-1][0] for pmf in pmfs) <= _DIRECT_WORK


def permutation_pvalue(null_values: Sequence[Sequence[float]], observed: float) -> float:
    """One-sided P(null sum of hits >= observed), enumerating every event month exactly.

    Hits live on a 1e-4 grid: null values round up and the observed sum rounds down,
    so the p-value is never understated. 0/1 hits are exact (the binomial tail).
    Small sets convolve one event at a time. Large sets (thousands of events, where
    that takes hours) group identical events and convolve by FFT: the same null to
    ~1e-15, so their p-value is floored at ``FFT_P_FLOOR`` rather than reading noise.
    """
    if not null_values:
        raise ValueError("no events to test")
    pmfs = [_event_pmf(values) for values in null_values]
    small = _is_small(pmfs)
    dist = _direct(pmfs) if small else _fft(pmfs)
    p_value = float(min(1.0, dist[_ticks(observed, up=False) :].sum()))
    return p_value if small else max(p_value, FFT_P_FLOOR)


def wilson_interval(hits: float, n: int, z: float = _Z95) -> tuple[float, float]:
    """95% Wilson score interval for a (possibly fractional) hit count out of ``n``."""
    if n <= 0:
        raise ValueError(f"n must be positive, got {n}")
    rate, z2 = hits / n, z * z
    centre = (rate + z2 / (2 * n)) / (1 + z2 / n)
    half = z * math.sqrt(rate * (1 - rate) / n + z2 / (4 * n * n)) / (1 + z2 / n)
    return max(0.0, centre - half), min(1.0, centre + half)


__all__ = [
    "FFT_P_FLOOR",
    "base_rate",
    "fractional_hit",
    "null_hit_values",
    "permutation_pvalue",
    "wilson_interval",
]
