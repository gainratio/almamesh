"""Indicator families: each scores one month for one target in [0, 1].

A family is one class with a ``name`` and a pure ``score(natal, month, target)``. The
harness sums whatever is in ``FAMILIES`` and ablates them by name, so a new
calculation plugs in as one more class here with no harness change.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from functools import partial
from typing import TYPE_CHECKING, ClassVar, Final, Protocol

from almamesh.constants.astrology import PlanetName
from almamesh.domains.ashtakavarga_signals import BinduTable, ashtakavarga_score, transit_movers
from almamesh.domains.exact_signals import SLOW_MOVERS, contact_score
from almamesh.domains.varga_signals import VargaKey, varga_score
from almamesh.reading.classical import Area, ChartLords, vimshottari_score
from almamesh.transits.aspects import drishti_offsets
from almamesh.transits.exact import LAGNA_POINT
from almamesh.transits.natal import whole_sign_house

if TYPE_CHECKING:
    from collections.abc import Callable, Mapping
    from datetime import datetime


@dataclass(frozen=True)
class Target:
    """What an event category points at: houses from the lagna and natural karakas."""

    houses: frozenset[int]
    karakas: frozenset[PlanetName]


@dataclass(frozen=True)
class NatalFrame:
    """The natal facts the families read: lagna and Moon signs, lordships, occupancy.

    ``bindus`` is the natal Ashtakavarga and ``varga_keys`` each varga target's key houses
    and significators; the engine always sets both. A hand-built frame without them has
    nothing to read, so ``ashtakavarga_transits`` and ``varga_lords`` score 0 there.
    ``lords`` is the chart and its Shadbala for the classical dasha rules; the engine sets it
    unless the native's Shadbala cannot be computed, and ``classical_dasha`` scores 0 without.
    """

    lagna_idx: int
    moon_idx: int
    rulers: Mapping[PlanetName, frozenset[int]]
    occupied: Mapping[PlanetName, int]
    bindus: BinduTable | None = None
    varga_keys: Mapping[Target, VargaKey] = field(default_factory=dict)
    lords: ChartLords | None = None

    def signifies(self, graha: PlanetName, target: Target) -> bool:
        """The graha rules a target house or is a target karaka."""
        return graha in target.karakas or bool(self.rulers[graha] & target.houses)

    def relevant_points(self, target: Target) -> frozenset[str]:
        """Natal points that signify the target: lords, occupants, karakas, lagna for the 1st.

        The engine's ``significator_grahas`` rule (domains/significators.py) on a target.
        """
        grahas = {g.value for g in self.rulers if self._significator(g, target)}
        return frozenset(grahas | ({LAGNA_POINT} if 1 in target.houses else set()))

    def _significator(self, graha: PlanetName, target: Target) -> bool:
        return self.signifies(graha, target) or self.occupied[graha] in target.houses

    def in_target(self, sign_idx: int, target: Target) -> bool:
        """A transit sign is a target house counted from the lagna or the Moon."""
        houses = {
            whole_sign_house(sign_idx, self.lagna_idx),
            whole_sign_house(sign_idx, self.moon_idx),
        }
        return bool(houses & target.houses)


def _no_activation() -> float:
    return 0.0


@dataclass(frozen=True)
class MonthSky:
    """One month: running lords per level, the Yogini lord, slow signs, exact contacts.

    ``obstacles`` is the engine's own obstacles-theme activation for the month (0..1),
    computed lazily: it costs a full predictive run, so only the disputes target asks.
    ``window`` is the calendar month, [1st 00:00 UTC, next 1st 00:00 UTC).
    """

    running: tuple[frozenset[PlanetName], ...]  # maha, antar, pratyantar
    yogini_lord: PlanetName | None
    signs: Mapping[PlanetName, int]  # sign index at mid-month
    # (mover, natal point) pairs within the exact-transit orb at some instant of the month
    contacts: frozenset[tuple[PlanetName, str]] = frozenset()
    obstacles: Callable[[], float] = _no_activation
    window: tuple[datetime, datetime] | None = None


class IndicatorFamily(Protocol):
    """One ablation unit."""

    name: ClassVar[str]

    def score(self, natal: NatalFrame, month: MonthSky, target: Target) -> float: ...


def _share(flags: list[bool]) -> float:
    return sum(flags) / len(flags)


class VimshottariLords:
    """Share of maha/antar/pratyantar levels whose running lord signifies the target."""

    name: ClassVar[str] = "vimshottari_lords"

    def score(self, natal: NatalFrame, month: MonthSky, target: Target) -> float:
        return _share([any(natal.signifies(g, target) for g in lv) for lv in month.running])


class VimshottariOccupants:
    """Share of levels whose running lord sits natally in a target house."""

    name: ClassVar[str] = "vimshottari_occupants"

    def score(self, natal: NatalFrame, month: MonthSky, target: Target) -> float:
        return _share([any(natal.occupied[g] in target.houses for g in lv) for lv in month.running])


class Yogini:
    """1 when the running Yogini maha lord signifies the target."""

    name: ClassVar[str] = "yogini"

    def score(self, natal: NatalFrame, month: MonthSky, target: Target) -> float:
        lord = month.yogini_lord
        return float(lord is not None and natal.signifies(lord, target))


@dataclass(frozen=True)
class _TransitShare:
    """Share of ``grahas`` transiting a target house from the lagna or the Moon."""

    grahas: tuple[PlanetName, ...]

    def score(self, natal: NatalFrame, month: MonthSky, target: Target) -> float:
        return _share([natal.in_target(month.signs[g], target) for g in self.grahas])


class TransitJupiterSaturn(_TransitShare):
    """The shipped themes' transit rule."""

    name: ClassVar[str] = "transit_jupiter_saturn"

    def __init__(self) -> None:
        super().__init__((PlanetName.JUPITER, PlanetName.SATURN))


class TransitMars(_TransitShare):
    """Mars over a target house (the engine drops Mars windows today)."""

    name: ClassVar[str] = "transit_mars"

    def __init__(self) -> None:
        super().__init__((PlanetName.MARS,))


class TransitNodes(_TransitShare):
    """Rahu and Ketu over target houses."""

    name: ClassVar[str] = "transit_nodes"

    def __init__(self) -> None:
        super().__init__((PlanetName.RAHU, PlanetName.KETU))


def _touched(graha: PlanetName, sign_idx: int, lagna_idx: int) -> set[int]:
    """Houses from the lagna the graha occupies or aspects (graha drishti)."""
    offsets = drishti_offsets(graha) | {1}
    return {whole_sign_house((sign_idx + off - 1) % 12, lagna_idx) for off in offsets}


class DoubleTransit:
    """1 when Jupiter and Saturn both occupy or aspect a target house from the lagna."""

    name: ClassVar[str] = "double_transit"

    def score(self, natal: NatalFrame, month: MonthSky, target: Target) -> float:
        both = _touched(PlanetName.JUPITER, month.signs[PlanetName.JUPITER], natal.lagna_idx)
        both &= _touched(PlanetName.SATURN, month.signs[PlanetName.SATURN], natal.lagna_idx)
        return float(bool(both & target.houses))


class ExactTransits:
    """Technique #1 (amendment d): degree contacts on target significators.

    Slow movers (Mars too when Mars is a target karaka, i.e. disputes) within the 1 degree
    orb of a relevant natal point: 0.5, plus 0.5 if that point is a running maha or antar
    lord. The engine's ``domains.exact_signals.contact_score`` is the single rule.
    """

    name: ClassVar[str] = "exact_transits"

    def score(self, natal: NatalFrame, month: MonthSky, target: Target) -> float:
        movers = SLOW_MOVERS | (target.karakas & {PlanetName.MARS})
        lords = frozenset(g.value for level in month.running[:2] for g in level)
        return contact_score(month.contacts, movers, natal.relevant_points(target), lords)


def _maha_antar(month: MonthSky) -> frozenset[PlanetName]:
    """Every maha or antar lord running at some time in the month."""
    return frozenset().union(*month.running[:2])


class AshtakavargaTransits:
    """Technique #3 (amendment g2): strong-bindu transits over a target house.

    Movers are Jupiter, Saturn and any running maha or antar lord with a BAV; an on-target
    mover scores 0.5 for SAV >= 28 plus 0.5 for its own BAV >= 4; the month takes the
    strongest. The engine's ``domains.ashtakavarga_signals.ashtakavarga_score`` is the rule.
    """

    name: ClassVar[str] = "ashtakavarga_transits"

    def score(self, natal: NatalFrame, month: MonthSky, target: Target) -> float:
        if natal.bindus is None:
            return 0.0
        movers = transit_movers(_maha_antar(month))
        on_target = partial(natal.in_target, target=target)
        return ashtakavarga_score(natal.bindus, month.signs, movers, on_target)


class VargaLords:
    """Technique #4 (amendment g3): dasha lords and slow transits tied to the area's varga.

    Career reads D10 (10th), relationships D9 (7th), disputes D30 (6th, 8th, 12th): 0.5 when
    a running maha or antar lord is a varga significator, plus 0.5 when Jupiter or Saturn
    transits a key-house sign. Every other target scores 0. The engine's
    ``domains.varga_signals.varga_score`` is the rule.
    """

    name: ClassVar[str] = "varga_lords"

    def score(self, natal: NatalFrame, month: MonthSky, target: Target) -> float:
        key = natal.varga_keys.get(target)
        if key is None:
            return 0.0
        return varga_score(key, _maha_antar(month), month.signs)


class ClassicalDasha:
    """Family #5 (amendment h2): the classical graded Vimshottari score of the month.

    The engine's R7 score (``reading.classical.vimshottari_score``, the one the period
    reading shows) over the calendar month for the target's houses and karakas, / 100.
    Continuous, never thresholded; tone and Yogini are not read.
    """

    name: ClassVar[str] = "classical_dasha"

    def score(self, natal: NatalFrame, month: MonthSky, target: Target) -> float:
        if natal.lords is None or month.window is None:
            return 0.0
        area = Area(houses=target.houses, karakas=target.karakas)
        return vimshottari_score(natal.lords, area, *month.window) / 100


# The harness-computed disputes target (legal, accident); see mapping._DISPUTES.
DISPUTES_TARGET: Final[Target] = Target(
    houses=frozenset({6, 8, 12}),
    karakas=frozenset({PlanetName.SATURN, PlanetName.RAHU, PlanetName.MARS}),
)


class EngineObstacles:
    """The engine's obstacles-domain activation, for the disputes target only.

    Amendment 2026-10-14 (b): the shipped period reading's obstacles theme
    strength (agreeing techniques plus a dated window, 0-100%) divided by 100.
    Every other target scores 0, so its ranking is unchanged.
    """

    name: ClassVar[str] = "engine_obstacles"

    def score(self, natal: NatalFrame, month: MonthSky, target: Target) -> float:
        return month.obstacles() if target == DISPUTES_TARGET else 0.0


FAMILIES: Final[tuple[IndicatorFamily, ...]] = (
    VimshottariLords(),
    VimshottariOccupants(),
    Yogini(),
    TransitJupiterSaturn(),
    DoubleTransit(),
    TransitMars(),
    TransitNodes(),
    ExactTransits(),
    AshtakavargaTransits(),
    VargaLords(),
    ClassicalDasha(),
)
# Amendment (f5): scored only by the +OBSTACLES run, lazily (a full predictive run per month),
# so it stays out of FAMILIES and out of the pre-registration digest of the v1 + exact set.
ENGINE_OBSTACLES: Final[EngineObstacles] = EngineObstacles()
SHIPPED_FAMILIES: Final[frozenset[str]] = frozenset(
    {"vimshottari_lords", "yogini", "transit_jupiter_saturn", "double_transit"}
)
# Every graha a family reads by sign at mid-month (Ketu is Rahu + 6); the Sun, Mercury and
# Venus are Ashtakavarga movers when they run as maha or antar lord (amendment g2).
SKY_GRAHAS: Final[tuple[PlanetName, ...]] = (
    PlanetName.JUPITER,
    PlanetName.SATURN,
    PlanetName.MARS,
    PlanetName.RAHU,
    PlanetName.SUN,
    PlanetName.MERCURY,
    PlanetName.VENUS,
)


def family_scores(natal: NatalFrame, month: MonthSky, target: Target) -> dict[str, float]:
    """Every family's score for one month and target."""
    return {f.name: f.score(natal, month, target) for f in FAMILIES}


__all__ = [
    "DISPUTES_TARGET",
    "ENGINE_OBSTACLES",
    "FAMILIES",
    "SHIPPED_FAMILIES",
    "SKY_GRAHAS",
    "IndicatorFamily",
    "MonthSky",
    "NatalFrame",
    "Target",
    "family_scores",
]
