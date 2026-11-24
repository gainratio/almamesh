"""Shared longitude helpers for the timeline's sign-change scan."""

from __future__ import annotations

from functools import cache
from typing import TYPE_CHECKING

from almamesh.calculations import AyanamsaType, NodeType
from almamesh.transits.positions import transit_longitude

if TYPE_CHECKING:
    from collections.abc import Callable
    from datetime import datetime

    from almamesh.calculations import SkyfieldAstronomy
    from almamesh.constants.astrology import PlanetName


def graha_lon_fn(
    astro: SkyfieldAstronomy,
    graha: PlanetName,
    ayanamsa_type: AyanamsaType = AyanamsaType.LAHIRI,
    node_type: NodeType = NodeType.MEAN,
) -> Callable[[datetime], float]:
    """Bound sidereal-longitude function for the graha under `ayanamsa_type`."""

    @cache
    def lon(when: datetime) -> float:
        return transit_longitude(astro, graha, when, ayanamsa_type, node_type)

    return lon


def cusp_gap(lon_fn: Callable[[datetime], float], cusp: float) -> Callable[[datetime], float]:
    """Seam-unwrapped distance of the graha from a sign cusp."""
    return lambda when: (lon_fn(when) - cusp + 180.0) % 360.0 - 180.0
