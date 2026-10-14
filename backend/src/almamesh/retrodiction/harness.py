"""Score each event's window once per family, then summarise any family subset.

Per-family month scores are computed once; ablation only re-sums them, so leaving a
family out or running it alone costs no extra engine work.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from pydantic import BaseModel

from almamesh.constants.astrology import PlanetName
from almamesh.domains.exact_signals import SLOW_MOVERS
from almamesh.retrodiction.engine import add_months
from almamesh.retrodiction.indicators import FAMILIES, SHIPPED_FAMILIES
from almamesh.retrodiction.mapping import MAPPING
from almamesh.retrodiction.stats import (
    base_rate,
    fractional_hit,
    null_hit_values,
    permutation_pvalue,
    wilson_interval,
)

if TYPE_CHECKING:
    from collections.abc import Collection, Mapping, Sequence

    from almamesh.retrodiction.engine import SubjectEngine, YearMonth
    from almamesh.retrodiction.events import EventCategory, LifeEvent
    from almamesh.retrodiction.indicators import IndicatorFamily, Target

_DIGITS = 9


@dataclass(frozen=True)
class EventScores:
    """One event's window: per-family month scores and where the event month sits."""

    subject: str
    category: EventCategory
    month: YearMonth
    area: str
    families: Mapping[str, tuple[float, ...]]
    index: int


@dataclass(frozen=True)
class Exclusion:
    """An event that could not be ranked, and why."""

    subject: str
    category: EventCategory
    date: str
    reason: str


class Summary(BaseModel):
    """Hit rate, base rate, lift with a 95% interval, and the exact one-sided p-value."""

    n: int
    hits: float
    rate: float
    base_rate: float
    lift: float
    lift_low: float
    lift_high: float
    p_value: float

    @classmethod
    def of(cls, hits: float, n: int, base: float, p_value: float) -> Summary:
        """Rate, lift and the Wilson-based lift interval from a hit count."""
        low, high = wilson_interval(hits, n)
        rate = hits / n
        return cls(
            n=n,
            hits=hits,
            rate=rate,
            base_rate=base,
            lift=rate / base,
            lift_low=low / base,
            lift_high=high / base,
            p_value=p_value,
        )


class Saturation(BaseModel):
    """How much a target scores by construction, whatever the month."""

    mean_score: float
    share_nonzero: float
    top_tie_share: float


def combined(scores: EventScores, names: Collection[str]) -> list[float]:
    """The month scores summed over the named families (rounded so ties are exact)."""
    columns = [scores.families[n] for n in names]
    return [round(sum(month), _DIGITS) for month in zip(*columns, strict=True)]


def movers_for(events: Sequence[LifeEvent]) -> frozenset[PlanetName]:
    """The exact-transit movers a native's targets read: Mars only for a Mars-karaka target."""
    karakas = frozenset(k for e in events for k in MAPPING[e.category].target.karakas)
    return SLOW_MOVERS | (karakas & {PlanetName.MARS})


def _window_months(month: YearMonth, window: int) -> list[YearMonth]:
    return [add_months(month, d) for d in range(-window, window + 1)]


def _family_series(
    engine: SubjectEngine, family: IndicatorFamily, months: list[YearMonth], target: Target
) -> tuple[float, ...]:
    return tuple(family.score(engine.frame, engine.month(m), target) for m in months)


def _exclusion(subject: str, event: LifeEvent, reason: str) -> Exclusion:
    return Exclusion(subject, event.category, event.date, reason)


def score_event(
    engine: SubjectEngine, subject: str, event: LifeEvent, window: int
) -> EventScores | Exclusion:
    """Every family's score for every month of the event's window, or why not."""
    month = event.month
    if month is None:
        return _exclusion(subject, event, "precision coarser than a month")
    months = _window_months(month, window)
    if not (engine.covers(months[0]) and engine.covers(months[-1])):
        return _exclusion(subject, event, "window reaches before birth or past the ephemeris")
    mapped = MAPPING[event.category]
    families = {f.name: _family_series(engine, f, months, mapped.target) for f in FAMILIES}
    return EventScores(subject, event.category, month, mapped.area, families, window)


def summarize(events: Sequence[EventScores], names: Collection[str], k: int) -> Summary:
    """Hit rate against the exact permutation null for one family subset and k."""
    if not events:
        raise ValueError("no events to summarise")
    series = [combined(e, names) for e in events]
    hits = sum(fractional_hit(s, e.index, k) for s, e in zip(series, events, strict=True))
    p_value = permutation_pvalue([null_hit_values(s, k) for s in series], hits)
    return Summary.of(hits, len(events), base_rate(k, len(series[0])), p_value)


def saturation(events: Sequence[EventScores], names: Collection[str]) -> Saturation:
    """Mean month score, share of months above zero, share tied at each window's top."""
    series = [combined(e, names) for e in events]
    months = [v for s in series for v in s]
    ties = [s.count(max(s)) / len(s) for s in series]
    return Saturation(
        mean_score=sum(months) / len(months),
        share_nonzero=_share_above(months, 0.0),
        top_tie_share=sum(ties) / len(ties),
    )


def _share_above(values: list[float], floor: float) -> float:
    return sum(1 for v in values if v > floor) / len(values)


def ablation_variants() -> dict[str, frozenset[str]]:
    """All families, the shipped four, each family off, and each family alone."""
    names = frozenset(f.name for f in FAMILIES)
    variants = {"all": names, "shipped_only": SHIPPED_FAMILIES}
    variants |= {f"without:{n}": names - {n} for n in sorted(names)}
    variants |= {f"only:{n}": frozenset({n}) for n in sorted(names)}
    return variants


__all__ = [
    "EventScores",
    "Exclusion",
    "Saturation",
    "Summary",
    "ablation_variants",
    "combined",
    "movers_for",
    "saturation",
    "score_event",
    "summarize",
]
