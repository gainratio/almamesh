"""Amendment (f): lift against placebo windows at the same position, so no centre bias.

The k/N base rate assumes the event month is uniform in its window, but it is always the
centre, and a step-function family ties more months with the centre than with an edge. Here
each event's centre hit is compared with the centre hits of placebo windows (same native,
same target, centred 73-146 months away). Under a stationary null every centre earns the
same expected hit, so the lift is 1 whatever the family's tie structure.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from typing import TYPE_CHECKING, Final

import numpy as np
from pydantic import BaseModel

from almamesh.retrodiction.stats import base_rate, permutation_pvalue, wilson_interval

if TYPE_CHECKING:
    from collections.abc import Mapping, Sequence

    from numpy.typing import NDArray

HitKey = tuple[str, int]  # (family set name, k)
_RESAMPLES: Final[int] = 2000
_SWAP_MARK: Final[str] = "~"


@dataclass(frozen=True)
class EventHits:
    """One event's centre hit per (family set, k): its own window and its placebo windows."""

    subject: str
    ordinal: int  # the event's position in its native's event list
    area: str
    real: Mapping[HitKey, float]
    placebos: tuple[Mapping[HitKey, float], ...]


class Interval(BaseModel):
    """A ratio with its 95% bootstrap CI over natives; all None when undefined."""

    value: float | None
    low: float | None
    high: float | None

    def includes_one(self) -> bool:
        """True when the CI is defined and contains 1."""
        return self.low is not None and self.high is not None and self.low <= 1.0 <= self.high


class OldLift(BaseModel):
    """The secondary k/N lift with its Wilson interval (amendment f2)."""

    lift: float
    low: float
    high: float

    @classmethod
    def of(cls, hits: Sequence[float], k: int, months: int) -> OldLift:
        """Hit rate over k/N, Wilson interval divided by k/N."""
        chance = base_rate(k, months)
        low, high = wilson_interval(sum(hits), len(hits))
        return cls(lift=sum(hits) / len(hits) / chance, low=low / chance, high=high / chance)

    def includes_one(self) -> bool:
        """True when the Wilson-based CI contains 1."""
        return self.low <= 1.0 <= self.high


class PlaceboSummary(BaseModel):
    """The primary statistic for one family set, area and k, with the old lift beside it."""

    n: int
    hits: float
    placebo_hits: float
    lift: float | None
    low: float | None
    high: float | None
    p: float
    old: OldLift


class ShiftedControl(BaseModel):
    """Placebo 1 plays the event (amendment f3): both metrics, and which one fails."""

    n: int
    placebo: Interval
    old: OldLift
    fails: bool
    old_fails: bool


class SwapComparison(BaseModel):
    """Real over chart-swapped centre hits, event by event (amendment f4)."""

    n: int
    ratio: float | None
    low: float | None
    high: float | None
    swap_old_lift: float | None


@dataclass(frozen=True)
class _Paired:
    """Per event: its native, the observed hit and the calibrating placebo hits."""

    natives: list[str]
    observed: list[float]
    calibrators: list[list[float]]

    def add(self, native: str, observed: float, calibrators: list[float]) -> None:
        self.natives.append(native)
        self.observed.append(observed)
        self.calibrators.append(calibrators)


def _per_native(natives: Sequence[str], values: Sequence[float]) -> NDArray[np.float64]:
    sums: dict[str, float] = defaultdict(float)
    for native, value in zip(natives, values, strict=True):
        sums[native] += value
    return np.array(list(sums.values()), dtype=np.float64)


def bootstrap_ratio(num: NDArray[np.float64], den: NDArray[np.float64], seed: int) -> Interval:
    """Σnum / Σden with a percentile CI, resampling natives (paired rows)."""
    if len(den) == 0 or den.sum() == 0:
        return Interval(value=None, low=None, high=None)
    picks = np.random.default_rng(seed).integers(0, len(den), size=(_RESAMPLES, len(den)))
    tops, bottoms = num[picks].sum(axis=1), den[picks].sum(axis=1)
    ratios = np.divide(tops, bottoms, out=np.full(_RESAMPLES, np.nan), where=bottoms > 0)
    low, high = np.nanpercentile(ratios, [2.5, 97.5])
    return Interval(value=float(num.sum() / den.sum()), low=float(low), high=float(high))


def _calibrated(paired: _Paired, seed: int) -> Interval:
    means = [sum(c) / len(c) for c in paired.calibrators]
    num = _per_native(paired.natives, paired.observed)
    return bootstrap_ratio(num, _per_native(paired.natives, means), seed)


def _pair_row(e: EventHits, key: HitKey, shifted: bool) -> tuple[float, list[float]]:
    """The observed hit (own window, or placebo 1 when shifted) and the rest's hits."""
    windows = [e.real, *e.placebos][int(shifted) :]
    return windows[0][key], [w[key] for w in windows[1:]]


def _paired(events: Sequence[EventHits], key: HitKey, *, shifted: bool = False) -> _Paired:
    paired = _Paired([], [], [])
    for e in events:
        if len(e.placebos) > int(shifted):
            paired.add(e.subject, *_pair_row(e, key, shifted))
    return paired


def placebo_summary(
    events: Sequence[EventHits], name: str, k: int, months: int, seed: int
) -> PlaceboSummary:
    """Lift = Σ event hits / Σ mean placebo hits; exact randomization p (amendment f1)."""
    paired = _paired(events, (name, k))
    if not paired.observed:
        raise ValueError("no events with a placebo window to summarise")
    ratio = _calibrated(paired, seed)
    nulls = [[o, *c] for o, c in zip(paired.observed, paired.calibrators, strict=True)]
    return PlaceboSummary(
        n=len(paired.observed),
        hits=sum(paired.observed),
        placebo_hits=sum(sum(c) / len(c) for c in paired.calibrators),
        lift=ratio.value,
        low=ratio.low,
        high=ratio.high,
        p=permutation_pvalue(nulls, sum(paired.observed)),
        old=OldLift.of(paired.observed, k, months),
    )


def shifted_control(
    events: Sequence[EventHits], name: str, k: int, months: int, seed: int
) -> ShiftedControl:
    """Placebo 1 as the event, placebos 2..R as calibrators: lift must include 1."""
    paired = _paired(events, (name, k), shifted=True)
    if not paired.observed:
        raise ValueError("no events with two placebo windows for the shifted control")
    interval, old = _calibrated(paired, seed), OldLift.of(paired.observed, k, months)
    return ShiftedControl(
        n=len(paired.observed),
        placebo=interval,
        old=old,
        fails=not interval.includes_one(),
        old_fails=not old.includes_one(),
    )


def _root(subject: str) -> str:
    return subject.split(_SWAP_MARK, 1)[0]


def swap_comparison(
    real: Sequence[EventHits],
    swap: Sequence[EventHits],
    name: str,
    k: int,
    months: int,
    seed: int,
) -> SwapComparison:
    """Σ real centre hits / Σ swapped centre hits over events scored both ways."""
    key = (name, k)
    paired = _swap_pairs(real, swap, key)
    num = _per_native(paired.natives, paired.observed)
    swapped = [c[0] for c in paired.calibrators]
    ratio = bootstrap_ratio(num, _per_native(paired.natives, swapped), seed)
    old = OldLift.of(swapped, k, months).lift if swapped else None
    return SwapComparison(
        n=len(swapped), ratio=ratio.value, low=ratio.low, high=ratio.high, swap_old_lift=old
    )


def _swap_pairs(real: Sequence[EventHits], swap: Sequence[EventHits], key: HitKey) -> _Paired:
    """Each real event with its chart-swapped twin's centre hit as the one calibrator."""
    swapped = {(_root(e.subject), e.ordinal): e.real[key] for e in swap}
    paired = _Paired([], [], [])
    for e in real:
        twin = swapped.get((e.subject, e.ordinal))
        if twin is not None:
            paired.add(e.subject, e.real[key], [twin])
    return paired


__all__ = [
    "EventHits",
    "HitKey",
    "Interval",
    "OldLift",
    "PlaceboSummary",
    "ShiftedControl",
    "SwapComparison",
    "bootstrap_ratio",
    "placebo_summary",
    "shifted_control",
    "swap_comparison",
]
