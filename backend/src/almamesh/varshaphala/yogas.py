"""Tajaka Yoga detection (Ithasala & Easarpha) with classical Deeptamsha orbs.

Evaluates true ecliptic angular separation against the five classical Tajaka
aspects (0°, 60°, 90°, 120°, 180°) so cross-sign cusp conjunctions (Bhavishyat
Ithasala) and exact 0.0° partile aspects (Purna Ithasala) are captured, and uses
real planetary daily speeds to handle retrograde motion (Vakra Ithasala).
"""

from __future__ import annotations

from typing import Literal

from almamesh.constants.astrology import PlanetName
from almamesh.schemas.astrology import PlanetPosition, SiderealContext
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

# Exact ecliptic aspect angles in [0, 360) and their classical Tajaka type.
_ASPECT_ANGLES: tuple[tuple[float, AspectType], ...] = (
    (0.0, "conjunction"),
    (60.0, "sextile"),
    (90.0, "square"),
    (120.0, "trine"),
    (180.0, "opposition"),
    (240.0, "trine"),
    (270.0, "square"),
    (300.0, "sextile"),
)


def _signed_mod_360(delta: float) -> float:
    """Wrap an angle difference into (-180, +180] degrees."""
    return ((delta + 180.0) % 360.0) - 180.0


def _closest_aspect(
    fast_lon: float, slow_lon: float, max_orb: float
) -> tuple[AspectType, float] | None:
    """Find the closest Tajaka aspect within `max_orb` (signed: positive = fast behind)."""
    separation = (slow_lon - fast_lon) % 360.0
    best: tuple[AspectType, float] | None = None
    for angle, kind in _ASPECT_ANGLES:
        signed_orb = _signed_mod_360(separation - angle)
        if abs(signed_orb) <= max_orb and (best is None or abs(signed_orb) < abs(best[1])):
            best = (kind, signed_orb)
    return best


def _is_applying(p_fast: PlanetPosition, p_slow: PlanetPosition, signed_orb: float) -> bool:
    """True when the two planets are closing toward exact aspect (incl. retrograde)."""
    if abs(signed_orb) < 1e-6:
        return True
    rel_speed = p_fast.speed - p_slow.speed
    return (signed_orb * rel_speed) > 0.0


def _pair_yoga(
    varsha_chart: SiderealContext, faster: PlanetName, slower: PlanetName
) -> TajakaYoga | None:
    """Evaluate one (faster, slower) planet pair for Ithasala or Easarpha."""
    p_fast = varsha_chart.planets[faster]
    p_slow = varsha_chart.planets[slower]
    mean_orb = (_DEEPTAMSHA_ORB[faster] + _DEEPTAMSHA_ORB[slower]) / 2.0
    match = _closest_aspect(p_fast.longitude, p_slow.longitude, mean_orb)
    if match is None:
        return None
    aspect, signed_orb = match
    applying = _is_applying(p_fast, p_slow, signed_orb)
    return TajakaYoga(
        name="Ithasala" if applying else "Easarpha",
        kind="applying" if applying else "separating",
        faster_planet=faster,
        slower_planet=slower,
        aspect_type=aspect,
        orb_degrees=round(abs(signed_orb), 2),
        deep_orb=abs(signed_orb) <= 1.0,
    )


def detect_tajaka_yogas(varsha_chart: SiderealContext) -> list[TajakaYoga]:
    """Detect all active Ithasala and Easarpha yogas sorted by tightest orb."""
    yogas: list[TajakaYoga] = []
    for idx, faster in enumerate(_SPEED_ORDER):
        for slower in _SPEED_ORDER[idx + 1 :]:
            yoga = _pair_yoga(varsha_chart, faster, slower)
            if yoga is not None:
                yogas.append(yoga)
    return sorted(yogas, key=lambda y: (y.kind != "applying", y.orb_degrees))
