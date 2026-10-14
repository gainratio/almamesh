"""Indicator families: each scores one month for one target in [0, 1].

A family is one class with a ``name`` and a pure ``score(natal, month, target)``. The
harness sums whatever is in ``FAMILIES`` and ablates them by name, so a new
calculation plugs in as one more class here with no harness change.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, ClassVar, Final, Protocol

from almamesh.constants.astrology import PlanetName
from almamesh.domains.exact_signals import SLOW_MOVERS, contact_score
from almamesh.transits.aspects import drishti_offsets
from almamesh.transits.exact import LAGNA_POINT
from almamesh.transits.natal import whole_sign_house

if TYPE_CHECKING:
    from collections.abc import Mapping


@dataclass(frozen=True)
class Target:
    """What an event category points at: houses from the lagna and natural karakas."""

    houses: frozenset[int]
    karakas: frozenset[PlanetName]


@dataclass(frozen=True)
class NatalFrame:
    """The natal facts the families read: lagna and Moon signs, lordships, occupancy."""

    lagna_idx: int
    moon_idx: int
    rulers: Mapping[PlanetName, frozenset[int]]
    occupied: Mapping[PlanetName, int]

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


@dataclass(frozen=True)
class MonthSky:
    """One month: running lords per level, the Yogini lord, slow signs, exact contacts."""

    running: tuple[frozenset[PlanetName], ...]  # maha, antar, pratyantar
    yogini_lord: PlanetName | None
    signs: Mapping[PlanetName, int]  # sign index at mid-month
    # (mover, natal point) pairs within the exact-transit orb at some instant of the month
    contacts: frozenset[tuple[PlanetName, str]] = frozenset()


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


FAMILIES: Final[tuple[IndicatorFamily, ...]] = (
    VimshottariLords(),
    VimshottariOccupants(),
    Yogini(),
    TransitJupiterSaturn(),
    DoubleTransit(),
    TransitMars(),
    TransitNodes(),
    ExactTransits(),
)
SHIPPED_FAMILIES: Final[frozenset[str]] = frozenset(
    {"vimshottari_lords", "yogini", "transit_jupiter_saturn", "double_transit"}
)
SKY_GRAHAS: Final[tuple[PlanetName, ...]] = (
    PlanetName.JUPITER,
    PlanetName.SATURN,
    PlanetName.MARS,
    PlanetName.RAHU,
)


def family_scores(natal: NatalFrame, month: MonthSky, target: Target) -> dict[str, float]:
    """Every family's score for one month and target."""
    return {f.name: f.score(natal, month, target) for f in FAMILIES}


__all__ = [
    "FAMILIES",
    "SHIPPED_FAMILIES",
    "SKY_GRAHAS",
    "IndicatorFamily",
    "MonthSky",
    "NatalFrame",
    "Target",
    "family_scores",
]
