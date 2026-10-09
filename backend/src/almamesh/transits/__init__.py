"""Phase-1 predictive transit (gochara) engine — orchestration over the natal
sidereal pipeline. See backend/docs/predictive-engine-plan.md.

`calculate_transit_context(natal, birth_dt, transit_instant)` is the public
entrypoint. It composes gochara + Sade Sati + slow hits + dasha fusion + a 12-
month timeline against an already-computed natal `SiderealContext`. The natal
chart is NOT mutated — transits are a separate context, keeping the natal golden
and CPython<->Pyodide parity byte-stable. `transit_instant=None` -> now(UTC); all
fixtures pin it for reproducibility (the only `now()` is here, at the top)."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import TYPE_CHECKING

from almamesh.calculations import AyanamsaType, NodeType, SkyfieldAstronomy, _to_utc
from almamesh.constants.astrology import PlanetName
from almamesh.schemas.transits import SlowTransitHit, TransitContext
from almamesh.transits.fusion import build_fusion
from almamesh.transits.gochara import build_gochara_context
from almamesh.transits.natal import natal_moon_index
from almamesh.transits.sade_sati import build_sade_sati_context
from almamesh.transits.slow_hits import next_conjunction, next_saturn_return
from almamesh.transits.timeline import build_timeline

if TYPE_CHECKING:
    from almamesh.schemas.astrology import SiderealContext

__all__ = ["calculate_transit_context"]


def _slow_hits(
    astro: SkyfieldAstronomy, natal: SiderealContext, instant: datetime
) -> list[SlowTransitHit]:
    """The headline Jupiter/Saturn hits over Moon/Lagna plus the Saturn return."""
    moon = natal.planets[PlanetName.MOON].longitude
    lagna = natal.lagna.longitude
    candidates = [
        next_conjunction(astro, PlanetName.JUPITER, moon, "moon", instant),
        next_conjunction(astro, PlanetName.SATURN, lagna, "lagna", instant),
        next_saturn_return(astro, natal.planets[PlanetName.SATURN].longitude, instant),
    ]
    return [hit for hit in candidates if hit is not None]


def calculate_transit_context(
    natal: SiderealContext,
    birth_dt: datetime,
    transit_instant: datetime | None = None,
    window_months: int = 12,
    ayanamsa_type: AyanamsaType = AyanamsaType.LAHIRI,
    node_type: NodeType = NodeType.MEAN,
) -> TransitContext:
    """Compute the full Phase-1 transit context for a natal chart + instant."""
    instant = _to_utc(transit_instant if transit_instant is not None else datetime.now(UTC))
    astro = SkyfieldAstronomy()
    moon_idx = natal_moon_index(natal)
    return TransitContext(
        instant=instant,
        gochara=build_gochara_context(astro, natal, instant, ayanamsa_type, node_type),
        sade_sati=build_sade_sati_context(astro, moon_idx, instant),
        slow_hits=_slow_hits(astro, natal, instant),
        fusion=build_fusion(astro, natal, birth_dt, instant, ayanamsa_type, node_type),
        timeline=build_timeline(astro, natal, birth_dt, instant, window_months),
    )
