"""The DEV scorecard: does one indicator family lift its life areas, beyond the calendar?

Per life area and k: the engine without the family (BASELINE) and with it (+FAMILY), the
ratio of their hit rates with a bootstrap CI over natives, the same two rows on a
chart-swapped run, Holm and BH over the +FAMILY p-values, and two run-level controls (a
planted family must reach N/k; shifted months must stay at chance). Aggregates only: no
native id, date or place reaches the output.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass
from typing import TYPE_CHECKING, Final

import numpy as np
from pydantic import BaseModel

from almamesh.retrodiction.controls import PLANTED, chart_swap, planted, shift_months
from almamesh.retrodiction.events import RetrodictionInputError
from almamesh.retrodiction.harness import EventScores, Exclusion, Summary, combined, summarize
from almamesh.retrodiction.mapping import preregistration_digest
from almamesh.retrodiction.placebo_run import V1
from almamesh.retrodiction.report import score_file
from almamesh.retrodiction.stats import (
    FFT_P_FLOOR,
    benjamini_hochberg,
    fractional_hit,
    holm,
)

if TYPE_CHECKING:
    from collections.abc import Collection, Mapping, Sequence

    from almamesh.retrodiction.events import EventsFile

ALL_AREAS: Final[str] = "all areas"
# The family this scorecard measures (technique #1, amendment d).
ADDED_FAMILY: Final[str] = "exact_transits"
_RESAMPLES: Final[int] = 2000
_PLANTED_TOLERANCE: Final[float] = 1e-6
# The planted p must sit at the null's resolution: below 1e-20 on the direct path, at the
# FFT path's floor (1e-12, amendment b) for large sets. Amendment (e).
_PLANTED_MAX_P: Final[float] = FFT_P_FLOOR


class Ratio(BaseModel):
    """+FAMILY hit rate over BASELINE hit rate, with a 95% bootstrap CI over natives."""

    value: float | None
    low: float | None
    high: float | None


class SwapRow(BaseModel):
    """The same area and k scored on chart-swapped natives (the calendar control)."""

    n: int
    baseline: Summary
    added: Summary


class AreaRow(BaseModel):
    """One life area at one k: real and chart-swapped, without and with the family."""

    area: str
    k: int
    n: int
    baseline: Summary
    added: Summary
    ratio: Ratio
    swap: SwapRow | None = None


class Corrections(BaseModel):
    """Which +FAMILY (area, k) cells survive Holm and BH at alpha 0.05."""

    tests: int
    raw: list[tuple[str, int]]
    holm: list[tuple[str, int]]
    bh: list[tuple[str, int]]


class ControlVerdicts(BaseModel):
    """The run is void unless both controls behave."""

    planted_ok: bool
    shuffled_ok: bool


def _hits(events: Sequence[EventScores], names: Collection[str], k: int) -> list[float]:
    return [fractional_hit(combined(e, names), e.index, k) for e in events]


def _by_native(events: Sequence[EventScores], hits: list[float]) -> np.ndarray:
    sums: dict[str, float] = defaultdict(float)
    for e, h in zip(events, hits, strict=True):
        sums[e.subject] += h
    return np.array(list(sums.values()))


def hit_ratio(
    events: Sequence[EventScores],
    base: Collection[str],
    added: Collection[str],
    k: int,
    seed: int,
) -> Ratio:
    """Ratio of hit sums, bootstrap over natives; undefined when BASELINE never hits."""
    num = _by_native(events, _hits(events, added, k))
    den = _by_native(events, _hits(events, base, k))
    if den.sum() == 0:
        return Ratio(value=None, low=None, high=None)
    picks = np.random.default_rng(seed).integers(0, len(den), size=(_RESAMPLES, len(den)))
    tops, bottoms = num[picks].sum(axis=1), den[picks].sum(axis=1)
    ratios = np.divide(tops, bottoms, out=np.full(_RESAMPLES, np.nan), where=bottoms > 0)
    low, high = np.nanpercentile(ratios, [2.5, 97.5])
    return Ratio(value=float(num.sum() / den.sum()), low=float(low), high=float(high))


def _grouped(events: Sequence[EventScores]) -> dict[str, list[EventScores]]:
    groups: dict[str, list[EventScores]] = defaultdict(list)
    for e in events:
        groups[e.area].append(e)
    return {ALL_AREAS: list(events)} | dict(sorted(groups.items()))


def _swap_row(
    swap: Sequence[EventScores], base: frozenset[str], added: frozenset[str], k: int
) -> SwapRow | None:
    if not swap:
        return None
    return SwapRow(n=len(swap), baseline=summarize(swap, base, k), added=summarize(swap, added, k))


def area_rows(
    events: Sequence[EventScores],
    base: frozenset[str],
    added: frozenset[str],
    ks: Sequence[int],
    seed: int,
    swap: Sequence[EventScores] = (),
) -> list[AreaRow]:
    """One row per area (plus all areas) per k."""
    swaps = _grouped(swap)
    return [
        AreaRow(
            area=area,
            k=k,
            n=len(group),
            baseline=summarize(group, base, k),
            added=summarize(group, added, k),
            ratio=hit_ratio(group, base, added, k, seed),
            swap=_swap_row(swaps.get(area, []), base, added, k),
        )
        for area, group in _grouped(events).items()
        for k in ks
    ]


def _kept(cells: list[tuple[str, int]], flags: list[bool]) -> list[tuple[str, int]]:
    return [c for c, keep in zip(cells, flags, strict=True) if keep]


def corrected(pvalues: Mapping[tuple[str, int], float], alpha: float = 0.05) -> Corrections:
    """Holm and BH over one family of (area, k) p-values."""
    cells, values = list(pvalues), list(pvalues.values())
    return Corrections(
        tests=len(cells),
        raw=_kept(cells, [p < alpha for p in values]),
        holm=_kept(cells, holm(values, alpha)),
        bh=_kept(cells, benjamini_hochberg(values, alpha)),
    )


def control_verdicts(
    planted_lift: float, planted_p: float, shuffled_ci: tuple[float, float], n: int, k: int
) -> ControlVerdicts:
    """Planted must reach N/k with p at the null's floor; the shifted CI must include 1."""
    ceiling = n / k
    return ControlVerdicts(
        planted_ok=abs(planted_lift - ceiling) <= _PLANTED_TOLERANCE * ceiling
        and planted_p <= _PLANTED_MAX_P,
        shuffled_ok=shuffled_ci[0] <= 1.0 <= shuffled_ci[1],
    )


class Scorecard(BaseModel):
    """The whole DEV scorecard for one added family."""

    label: str
    added_family: str
    families: list[str]
    preregistration_digest: str
    window: int
    ks: list[int]
    events_scored: int
    exclusions: dict[str, int]
    swap_natives_dropped: int
    swap_exclusions: dict[str, int]
    rows: list[AreaRow]
    corrections: Corrections
    shuffled: dict[str, Summary]
    planted: dict[str, Summary]
    verdicts: ControlVerdicts


def _reasons(excluded: Sequence[Exclusion]) -> dict[str, int]:
    return dict(sorted(Counter(x.reason for x in excluded).items()))


def _family_pvalues(rows: Sequence[AreaRow]) -> dict[tuple[str, int], float]:
    return {(r.area, r.k): r.added.p_value for r in rows if r.area != ALL_AREAS}


def _verdicts(planted_rows: dict[str, Summary], shuffled: dict[str, Summary]) -> ControlVerdicts:
    k = min(planted_rows, key=int)
    first = planted_rows[k]
    months = round(1 / first.base_rate * int(k))
    shuffled_ci = (shuffled[k].lift_low, shuffled[k].lift_high)
    return control_verdicts(first.lift, first.p_value, shuffled_ci, months, int(k))


@dataclass(frozen=True)
class _Runs:
    """The three scored passes: real, chart-swapped, months shifted out of their windows."""

    real: list[EventScores]
    excluded: list[Exclusion]
    swap: list[EventScores]
    swap_excluded: list[Exclusion]
    swap_dropped: int
    shifted: list[EventScores]


def _score(events_file: EventsFile, window: int, workers: int, seed: int) -> _Runs:
    real, excluded = score_file(events_file, window, workers)
    swap_file, dropped = chart_swap(events_file)
    swap, swap_excluded = score_file(swap_file, window, workers)
    shifted, _ = score_file(shift_months(events_file, seed), window, workers)
    return _Runs(real, excluded, swap, swap_excluded, dropped, shifted)


def _by_k(
    events: Sequence[EventScores], names: Collection[str], ks: Sequence[int]
) -> dict[str, Summary]:
    return {str(k): summarize(events, names, k) for k in ks}


def _assemble(runs: _Runs, label: str, window: int, ks: Sequence[int], seed: int) -> Scorecard:
    base = V1
    added = V1 | {ADDED_FAMILY}
    rows = area_rows(runs.real, base, added, ks, seed, runs.swap)
    planted_rows = _by_k(planted(runs.real), {PLANTED}, ks)
    shuffled = _by_k(runs.shifted, added, ks)
    return Scorecard(
        label=label,
        added_family=ADDED_FAMILY,
        families=sorted(added),
        preregistration_digest=preregistration_digest(window, tuple(ks)),
        window=window,
        ks=list(ks),
        events_scored=len(runs.real),
        exclusions=_reasons(runs.excluded),
        swap_natives_dropped=runs.swap_dropped,
        swap_exclusions=_reasons(runs.swap_excluded),
        rows=rows,
        corrections=corrected(_family_pvalues(rows)),
        shuffled=shuffled,
        planted=planted_rows,
        verdicts=_verdicts(planted_rows, shuffled),
    )


def build_scorecard(
    events_file: EventsFile, window: int, ks: Sequence[int], workers: int, seed: int
) -> Scorecard:
    """Score the file three ways (real, chart-swap, shifted months) and summarise."""
    runs = _score(events_file, window, workers, seed)
    if not runs.real:
        raise RetrodictionInputError("no event could be ranked (see exclusions)")
    return _assemble(runs, events_file.label, window, ks, seed)


__all__ = [
    "ADDED_FAMILY",
    "ALL_AREAS",
    "AreaRow",
    "ControlVerdicts",
    "Corrections",
    "Ratio",
    "Scorecard",
    "SwapRow",
    "area_rows",
    "build_scorecard",
    "control_verdicts",
    "corrected",
    "hit_ratio",
]
