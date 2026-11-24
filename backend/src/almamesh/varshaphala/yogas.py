"""Tajaka Yoga detection (Ithasala & Easarpha) with classical Deeptamsha orbs."""

from __future__ import annotations

from typing import Literal

from almamesh.constants.astrology import ZODIAC_SIGNS, PlanetName
from almamesh.schemas.astrology import SiderealContext
from almamesh.schemas.varshaphala import TajakaYoga

# Natural speed order fastest -> slowest (mean sidereal daily motion).
_SPEED_ORDER: tuple[PlanetName, ...] = (
    PlanetName.MOON,
    PlanetName.MERCURY,
    PlanetName.VENUS,
    PlanetName.SUN,
    PlanetName.MARS,
    PlanetName.JUPITER,
    PlanetName.SATURN,
)

# Classical Tajaka Deeptamsha (orb of influence in degrees).
_DEEPTAMSHA_ORB: dict[PlanetName, float] = {
    PlanetName.SUN: 15.0,
    PlanetName.MOON: 12.0,
    PlanetName.MARS: 8.0,
    PlanetName.MERCURY: 7.0,
    PlanetName.JUPITER: 9.0,
    PlanetName.VENUS: 7.0,
    PlanetName.SATURN: 9.0,
}

AspectType = Literal["conjunction", "sextile", "square", "trine", "opposition"]

_TAJAKA_SIGN_ASPECTS: dict[int, AspectType] = {
    0: "conjunction",
    2: "sextile",
    3: "square",
    4: "trine",
    6: "opposition",
    8: "trine",
    9: "square",
    10: "sextile",
}


def _sign_aspect(sign_a: str, sign_b: str) -> AspectType | None:
    """Return the Tajaka aspect between two signs, or None if unaspected (2/6/8/12)."""
    delta = (ZODIAC_SIGNS.index(sign_b) - ZODIAC_SIGNS.index(sign_a)) % 12
    return _TAJAKA_SIGN_ASPECTS.get(delta)


def _build_yoga(
    faster: PlanetName, slower: PlanetName, aspect: AspectType, diff: float
) -> TajakaYoga:
    """Construct a typed Ithasala (applying) or Easarpha (separating) yoga."""
    applying = diff > 0.0
    return TajakaYoga(
        name="Ithasala" if applying else "Easarpha",
        kind="applying" if applying else "separating",
        faster_planet=faster,
        slower_planet=slower,
        aspect_type=aspect,
        orb_degrees=round(abs(diff), 2),
        deep_orb=abs(diff) <= 1.0,
    )


def _pair_yoga(
    varsha_chart: SiderealContext, faster: PlanetName, slower: PlanetName
) -> TajakaYoga | None:
    """Evaluate one (faster, slower) planet pair for Ithasala or Easarpha."""
    p_fast = varsha_chart.planets[faster]
    p_slow = varsha_chart.planets[slower]
    aspect = _sign_aspect(p_fast.sign.value, p_slow.sign.value)
    if aspect is None:
        return None
    mean_orb = (_DEEPTAMSHA_ORB[faster] + _DEEPTAMSHA_ORB[slower]) / 2.0
    diff = p_slow.sign_degrees - p_fast.sign_degrees
    if not (1e-6 <= abs(diff) <= mean_orb):
        return None
    return _build_yoga(faster, slower, aspect, diff)


def detect_tajaka_yogas(varsha_chart: SiderealContext) -> list[TajakaYoga]:
    """Detect all active Ithasala and Easarpha yogas sorted by tightest orb."""
    yogas: list[TajakaYoga] = []
    for idx, faster in enumerate(_SPEED_ORDER):
        for slower in _SPEED_ORDER[idx + 1 :]:
            yoga = _pair_yoga(varsha_chart, faster, slower)
            if yoga is not None:
                yogas.append(yoga)
    return sorted(yogas, key=lambda y: (y.kind != "applying", y.orb_degrees))
