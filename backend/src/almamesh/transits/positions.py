"""The single coherent transit-position path.

`transit_positions` bundles `_to_utc` -> `_resolve_ayanamsa` -> the unchanged
`SkyfieldAstronomy.get_planetary_positions` so every transit call site (gochara,
root-finds, fusion) resolves the ayanamsa AT the transit instant and floors sign
indices the same way the natal pipeline does. No new astronomy here.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from almamesh.calculations import (
    AyanamsaType,
    NodeType,
    _resolve_ayanamsa,
    _to_utc,
)
from almamesh.constants.astrology import PlanetName

if TYPE_CHECKING:
    from datetime import datetime

    from almamesh.calculations import SkyfieldAstronomy


def transit_positions(
    astro: SkyfieldAstronomy,
    when: datetime,
    ayanamsa_type: AyanamsaType = AyanamsaType.LAHIRI,
    node_type: NodeType = NodeType.MEAN,
) -> dict[PlanetName, dict[str, Any]]:
    """Sidereal longitudes of all grahas at `when` (ayanamsa resolved there)."""
    dt_utc = _to_utc(when)
    ayanamsa = _resolve_ayanamsa(astro, dt_utc, ayanamsa_type)
    return astro.get_planetary_positions(dt_utc, ayanamsa, node_type)


def _node_longitude(
    astro: SkyfieldAstronomy,
    graha: PlanetName,
    dt_utc: datetime,
    ayanamsa: float,
    node_type: NodeType,
) -> float:
    """Rahu/Ketu sidereal longitude: `_get_lunar_node_positions`' arithmetic, nodes only."""
    rahu_tropical = astro._node_tropical(astro.ts.from_datetime(dt_utc), node_type)
    tropical = rahu_tropical if graha is PlanetName.RAHU else (rahu_tropical + 180) % 360
    return (tropical - ayanamsa) % 360


def transit_longitude(
    astro: SkyfieldAstronomy,
    graha: PlanetName,
    when: datetime,
    ayanamsa_type: AyanamsaType = AyanamsaType.LAHIRI,
    node_type: NodeType = NodeType.MEAN,
) -> float:
    """One graha's sidereal longitude at `when` — the scalar root-finds probe.

    Standard grahas take the single-graha fast path; Rahu/Ketu take the node-only
    path (no other planets). Byte-identical to
    `transit_positions(...)[graha]['longitude']` either way.
    """
    dt_utc = _to_utc(when)
    ayanamsa = _resolve_ayanamsa(astro, dt_utc, ayanamsa_type)
    if graha in astro._STANDARD_TARGETS:
        return astro.graha_sidereal_longitude(graha, dt_utc, ayanamsa)
    return _node_longitude(astro, graha, dt_utc, ayanamsa, node_type)
