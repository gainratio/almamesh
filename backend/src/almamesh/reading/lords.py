"""The natal facts of all nine grahas: lordships, placement, varga signs, yogas."""

from __future__ import annotations

from typing import TYPE_CHECKING

from almamesh.constants.astrology import PlanetName
from almamesh.reading.common import sign_index_of, sign_key
from almamesh.reading.functional import functional_nature
from almamesh.schemas.reading import NatalLord
from almamesh.schemas.vargas import DivisionalChart

if TYPE_CHECKING:
    from almamesh.reading.classical import ChartLords
    from almamesh.schemas.astrology import SiderealContext
    from almamesh.schemas.reading import SignKey
    from almamesh.schemas.vargas import VargaContext


def _varga_sign(vargas: VargaContext, chart: DivisionalChart, graha: PlanetName) -> SignKey:
    """The graha's sign key in one divisional chart."""
    return sign_key(sign_index_of(vargas.charts[chart].placements[graha].sign))


def _yogas_of(natal: SiderealContext, graha: PlanetName) -> list[str]:
    """Names of the natal yogas that involve ``graha``, first occurrence order."""
    return list(dict.fromkeys(y.name for y in natal.yogas if graha in y.planets_involved))


def _natal_lord(
    lords: ChartLords, vargas: VargaContext, graha: PlanetName, vargottama: set[str]
) -> NatalLord:
    """One graha's natal row."""
    natal = lords.natal
    p = natal.planets[graha]
    return NatalLord(
        rules=sorted(p.houses_ruled),
        house=p.house,
        sign=sign_key(sign_index_of(p.sign)),
        dignity=str(p.dignity),
        strength=lords.strength(graha),
        combust=p.is_combust,
        retro=p.is_retrograde,
        functional=functional_nature(p.houses_ruled, is_yogakaraka=p.is_yogakaraka),
        d9_sign=_varga_sign(vargas, DivisionalChart.D9, graha),
        d10_sign=_varga_sign(vargas, DivisionalChart.D10, graha),
        vargottama=graha.value in vargottama,
        yogas=_yogas_of(natal, graha),
    )


def natal_lords(lords: ChartLords, vargas: VargaContext) -> dict[PlanetName, NatalLord]:
    """All nine grahas' natal rows, in PlanetName order."""
    vargottama = {flag.point for flag in vargas.vargottama}
    return {graha: _natal_lord(lords, vargas, graha, vargottama) for graha in PlanetName}


__all__ = ["natal_lords"]
