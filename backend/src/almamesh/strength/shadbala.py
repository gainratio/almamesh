"""Shadbala orchestrator — assembles the six-fold strength per graha (BPHS).

Sums Sthana + Dig + Kala + Cheshta + Naisargika + Drik into total Virupas and
Rupas (/60), and compares against the classical required minimum per planet. The
Sun's Cheshtabala is its Ayanabala and the Moon's is its Pakshabala (BPHS
substitution); the five star-planets use the rigorous speed-driven Cheshtabala.
"""

from __future__ import annotations

from types import MappingProxyType
from typing import TYPE_CHECKING, Final

from almamesh.calculations import SkyfieldAstronomy
from almamesh.constants.astrology import PlanetName
from almamesh.schemas.strength import (
    SHADBALA_PLANETS,
    VIRUPAS_PER_RUPA,
    BalaValue,
    KalaBala,
    PlanetShadbala,
    ShadbalaContext,
    SthanaBala,
)
from almamesh.strength.cheshta import CITATION as _CHESHTA_CITATION
from almamesh.strength.cheshta import cheshtabala
from almamesh.strength.digbala import digbala_virupas
from almamesh.strength.drik import drikbala
from almamesh.strength.kala import compute_kala
from almamesh.strength.naisargika import naisargikabala
from almamesh.strength.sthana import sthanabala
from almamesh.strength.sunrise import SunWindow, sun_window

if TYPE_CHECKING:
    from datetime import datetime, timedelta

    from almamesh.schemas.astrology import SiderealContext

# Classical required minimum Shadbala in Rupas (BPHS, Shadbala Adhyaya).
REQUIRED_RUPAS: Final[MappingProxyType[PlanetName, float]] = MappingProxyType(
    {p: v for p, v in zip(SHADBALA_PLANETS, (6.5, 6.0, 5.0, 7.0, 6.5, 5.5, 5.0), strict=True)}
)


def _cheshta_for(planet: PlanetName, natal: SiderealContext, kala: KalaBala) -> BalaValue:
    """Cheshtabala: rigorous for taras; Sun->Ayanabala, Moon->Pakshabala (BPHS)."""
    if planet == PlanetName.SUN:
        return BalaValue(virupas=kala.ayana.virupas, citation=_CHESHTA_CITATION)
    if planet == PlanetName.MOON:
        return BalaValue(virupas=kala.paksha.virupas, citation=_CHESHTA_CITATION)
    return cheshtabala(planet, natal.planets[planet])


def _planet_shadbala(
    astro: SkyfieldAstronomy,
    natal: SiderealContext,
    planet: PlanetName,
    birth_utc: datetime,
    lat: float,
    lon: float,
    window: SunWindow,
) -> PlanetShadbala:
    """The full six-fold strength for one graha."""
    pos = natal.planets[planet]
    sthana = sthanabala(planet, pos)
    dig = digbala_virupas(planet, pos.longitude, natal.lagna.longitude)
    kala, _ = compute_kala(astro, natal, planet, birth_utc, lat, lon, window)
    cheshta = _cheshta_for(planet, natal, kala)
    naisargika = naisargikabala(planet)
    drik = drikbala(planet, natal)
    total = (
        sthana.total_virupas
        + dig.virupas
        + kala.total_virupas
        + cheshta.virupas
        + naisargika.virupas
        + drik.virupas
    )
    return _assemble(planet, sthana, dig, kala, cheshta, naisargika, drik, total)


def _assemble(  # noqa: PLR0913 - one typed field per Shadbala component
    planet: PlanetName,
    sthana: SthanaBala,
    dig: BalaValue,
    kala: KalaBala,
    cheshta: BalaValue,
    naisargika: BalaValue,
    drik: BalaValue,
    total: float,
) -> PlanetShadbala:
    """Bind the six components into the typed PlanetShadbala record."""
    rupas = total / VIRUPAS_PER_RUPA
    required = REQUIRED_RUPAS[planet]
    return PlanetShadbala(
        planet=planet,
        sthana=sthana,
        dig=dig,
        kala=kala,
        cheshta=cheshta,
        naisargika=naisargika,
        drik=drik,
        total_virupas=total,
        total_rupas=rupas,
        required_rupas=required,
        meets_minimum=rupas >= required,
    )


def compute_shadbala(
    natal: SiderealContext,
    birth_utc: datetime,
    lat: float,
    lon: float,
    *,
    civil_offset: timedelta,
) -> ShadbalaContext:
    """Shadbala for the seven grahas (rigorous Kalabala via true civil sunrise).

    ``civil_offset`` is the birthplace's civil UTC offset at birth; the Vedic
    weekday lords are read off the civil date of each day-opening sunrise.
    """
    astro = SkyfieldAstronomy()
    window = sun_window(astro, birth_utc, lat, lon, civil_offset=civil_offset)
    planets = {
        p: _planet_shadbala(astro, natal, p, birth_utc, lat, lon, window) for p in SHADBALA_PLANETS
    }
    return ShadbalaContext(planets=planets)
