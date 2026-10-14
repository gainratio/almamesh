"""Degree-level transit contacts over natal points: exact hits and in-orb spells.

A contact is a transiting graha within ``orb`` degrees of a fixed natal longitude
(conjunction only). Both the exact hits (gap = 0) and the in-orb spells
(|gap| - orb = 0 at the edges) are found with the shared retrograde-aware root-finder
in ``transits/ingress.py``, so a graha that stations and turns back over a point is
counted on every pass. ``ContactBook`` answers "which grahas touched which points in
this month" for one native, scanning each calendar year once and caching it.

Fixed constants, not fitted: the 1 degree orb and the scan steps are pre-registered in
docs/superpowers/specs/2026-10-14-retrodiction-eval-design.md, amendment (d).
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Final, TypeAlias

from almamesh.constants.astrology import PlanetName
from almamesh.transits.ingress import find_brackets, find_crossings, refine_bracket
from almamesh.transits.positions import transit_longitude

if TYPE_CHECKING:
    from almamesh.calculations import SkyfieldAstronomy
    from almamesh.schemas.astrology import SiderealContext

LongitudeFn: TypeAlias = Callable[[datetime], float]
Contact: TypeAlias = tuple[PlanetName, str]  # (transiting graha, natal point name)

EXACT_ORB_DEG: Final[float] = 1.0
LAGNA_POINT: Final[str] = "lagna"
# Mars moves up to ~0.8 deg/day, so a 1 degree orb lasts >= 2.5 days on a direct pass;
# the slow grahas and the mean nodes move <= 0.25 deg/day (>= 8 days in orb).
_STEP_DAYS: Final[Mapping[PlanetName, float]] = {PlanetName.MARS: 2.0}
_SLOW_STEP_DAYS: Final[float] = 5.0
# Numerical contact tolerance (degrees), as in slow_hits: rejects the opposition seam.
_HIT_TOLERANCE_DEG: Final[float] = 1e-6
MOVERS: Final[tuple[PlanetName, ...]] = (
    PlanetName.SATURN,
    PlanetName.JUPITER,
    PlanetName.RAHU,
    PlanetName.KETU,
    PlanetName.MARS,
)


@dataclass(frozen=True)
class Spell:
    """One stretch of time a graha stays within orb of a point (clipped to the scan)."""

    start: datetime
    end: datetime


def gap(longitude: float, point: float) -> float:
    """Circular gap in [-180, 180): zero at conjunction, discontinuous at opposition."""
    return (longitude - point + 180.0) % 360.0 - 180.0


def step_days(graha: PlanetName) -> float:
    """The scan step for a mover (fixed, see the module docstring)."""
    return _STEP_DAYS.get(graha, _SLOW_STEP_DAYS)


def exact_hits(
    lon: LongitudeFn, point: float, start: datetime, end: datetime, step: float
) -> list[datetime]:
    """Every instant the mover is exactly on ``point`` (each retrograde re-hit included)."""

    def f(when: datetime) -> float:
        return gap(lon(when), point)

    return [t for t in find_crossings(f, start, end, step) if abs(f(t)) <= _HIT_TOLERANCE_DEG]


def _orb_fn(lon: LongitudeFn, point: float, orb: float) -> Callable[[datetime], float]:
    """Negative inside the orb, zero on its edges."""

    def f(when: datetime) -> float:
        return abs(gap(lon(when), point)) - orb

    return f


def _spells(inside: bool, edges: list[datetime], start: datetime, end: datetime) -> list[Spell]:
    """Pair entry/exit edges into spells, opening at ``start`` or closing at ``end``."""
    bounds = ([start] if inside else []) + edges
    if len(bounds) % 2:
        bounds.append(end)
    return [Spell(a, b) for a, b in zip(bounds[::2], bounds[1::2], strict=True)]


def orb_spells(
    lon: LongitudeFn, point: float, start: datetime, end: datetime, orb: float, step: float
) -> list[Spell]:
    """The in-orb spells in [start, end]: every entry and exit is a refined root."""
    f = _orb_fn(lon, point, orb)
    return _spells(f(start) < 0.0, find_crossings(f, start, end, step), start, end)


def _next_month(when: datetime) -> datetime:
    return datetime(when.year + when.month // 12, when.month % 12 + 1, 1, tzinfo=UTC)


def _month_edge(f: Callable[[datetime], float], lo: datetime, hi: datetime) -> datetime:
    """The root if a month boundary splits the bracket, else its midpoint (same month)."""
    return refine_bracket(f, lo, hi) if _next_month(lo) < hi else lo + (hi - lo) / 2


def month_spells(
    lon: LongitudeFn, point: float, start: datetime, end: datetime, orb: float, step: float
) -> list[Spell]:
    """``orb_spells`` at month resolution: each edge falls in the same month as the root.

    Only a bracket that a month boundary splits is refined; any other edge lies in the
    bracket's one month either way, so which months a spell touches is unchanged.
    """
    f = _orb_fn(lon, point, orb)
    edges = [_month_edge(f, lo, hi) for lo, hi in find_brackets(f, start, end, step)]
    return _spells(f(start) < 0.0, edges, start, end)


def _cached(fn: LongitudeFn) -> LongitudeFn:
    """Memoise a longitude by instant: every point's scan shares one sample grid."""
    memo: dict[datetime, float] = {}

    def lon(when: datetime) -> float:
        if when not in memo:
            memo[when] = fn(when)
        return memo[when]

    return lon


def astro_movers(astro: SkyfieldAstronomy) -> dict[PlanetName, LongitudeFn]:
    """Cached sidereal longitude functions (Lahiri, mean nodes) for every mover."""

    def mover(graha: PlanetName) -> LongitudeFn:
        return _cached(lambda when: transit_longitude(astro, graha, when))

    return {graha: mover(graha) for graha in MOVERS}


def natal_points(natal: SiderealContext) -> dict[str, float]:
    """The nine natal grahas' sidereal longitudes and the lagna's, by name."""
    points = {graha.value: pos.longitude for graha, pos in natal.planets.items()}
    return points | {LAGNA_POINT: natal.lagna.longitude}


_YearSpells: TypeAlias = dict[Contact, list[Spell]]


class ContactBook:
    """Which movers were within orb of which natal points, month by month, for one native."""

    def __init__(
        self,
        movers: Mapping[PlanetName, LongitudeFn],
        points: Mapping[str, float],
        orb: float = EXACT_ORB_DEG,
    ) -> None:
        self._movers = movers
        self._points = points
        self._orb = orb
        self._years: dict[int, _YearSpells] = {}

    def month(self, start: datetime, end: datetime) -> frozenset[Contact]:
        """Contacts in force at any instant of [start, end), which lies in one year."""
        if end > datetime(start.year + 1, 1, 1, tzinfo=UTC):
            raise ValueError("a month must lie within one calendar year")
        spells = self._year(start.year)
        return frozenset(c for c, found in spells.items() if _overlaps(found, start, end))

    def _year(self, year: int) -> _YearSpells:
        if year not in self._years:
            self._years[year] = self._scan(year)
        return self._years[year]

    def _scan(self, year: int) -> _YearSpells:
        start, end = datetime(year, 1, 1, tzinfo=UTC), datetime(year + 1, 1, 1, tzinfo=UTC)
        return {
            (graha, name): month_spells(lon, point, start, end, self._orb, step_days(graha))
            for graha, lon in self._movers.items()
            for name, point in self._points.items()
        }


def _overlaps(spells: list[Spell], start: datetime, end: datetime) -> bool:
    return any(s.start < end and s.end >= start for s in spells)


__all__ = [
    "EXACT_ORB_DEG",
    "LAGNA_POINT",
    "MOVERS",
    "Contact",
    "ContactBook",
    "LongitudeFn",
    "Spell",
    "astro_movers",
    "exact_hits",
    "gap",
    "month_spells",
    "natal_points",
    "orb_spells",
    "step_days",
]
