"""Kalabala orchestrator — the nine temporal sub-balas (BPHS).

Wires the rigorous sun window (true civil sunrise/sunset) into the day/night
sub-balas and the time-lord sub-balas, plus Ayanabala (declination) and a
clearly-flagged Yuddhabala (planetary war). Reads astronomy READ-ONLY for the
sunrise and declination; never mutates the natal chart.
"""

from __future__ import annotations

import math
from typing import TYPE_CHECKING, Final

from almamesh.constants.astrology import PlanetName
from almamesh.schemas.strength import BalaValue, KalaBala
from almamesh.strength.kala_lords import abdabala, horabala, masabala, varabala
from almamesh.strength.kala_parts import nathonnatha, pakshabala, tribhagabala
from almamesh.strength.sunrise import SunWindow

if TYPE_CHECKING:
    from datetime import datetime

    from almamesh.calculations import SkyfieldAstronomy
    from almamesh.schemas.astrology import SiderealContext

_FULL: Final[float] = 60.0
_MAX_DECL: Final[float] = 23.45
_AYANA_RANGE: Final[float] = 2.0 * _MAX_DECL  # 46.90 deg span, scaled to 60 Virupas
_OBLIQUITY: Final[float] = 23.4367  # mean obliquity (deg) at J2000, sufficient for kranti

_C_AYANA: Final[str] = "BPHS Kalabala — Ayanabala (declination-driven, 60 Virupas range)."
_C_YUDDHA: Final[str] = "BPHS Kalabala — Yuddhabala (planetary-war adjustment)."

# Grahas that gain Ayanabala in northern declination; the rest in southern.
_NORTH_STRONG: Final[frozenset[PlanetName]] = frozenset(
    {PlanetName.SUN, PlanetName.MARS, PlanetName.JUPITER, PlanetName.VENUS}
)


def _day_fraction(window: SunWindow, birth_utc: datetime) -> tuple[float, bool]:
    """(fraction of the day-or-night elapsed, is_day) for the birth instant."""
    rise, setting = window.sunrise, window.sunset
    if rise <= birth_utc < setting:
        span = (setting - rise).total_seconds()
        return ((birth_utc - rise).total_seconds() / span, True)
    span = max(1.0, (rise.timestamp() - setting.timestamp()) % 86400)
    elapsed = (birth_utc.timestamp() - setting.timestamp()) % 86400
    return (elapsed / span, False)


def _frac_from_midnight(window: SunWindow, birth_utc: datetime) -> float:
    """0 at midnight, 1 at noon — the Nathonnatha day-strength ramp."""
    day_frac, is_day = _day_fraction(window, birth_utc)
    return day_frac if is_day else 1.0 - day_frac


def _moon_phase_frac(natal: SiderealContext) -> float:
    """Bright fraction (0=new, 1=full) from Sun-Moon elongation."""
    sun = natal.planets[PlanetName.SUN].longitude
    moon = natal.planets[PlanetName.MOON].longitude
    return (1.0 - math.cos(math.radians((moon - sun) % 360.0))) / 2.0


def _declination(tropical_longitude: float) -> float:
    """Approximate declination (kranti) from tropical ecliptic longitude."""
    lam = math.radians(tropical_longitude)
    return math.degrees(math.asin(math.sin(math.radians(_OBLIQUITY)) * math.sin(lam)))


def _ayanabala(planet: PlanetName, tropical_longitude: float) -> BalaValue:
    """Declination-driven strength; northern/southern preference per graha."""
    decl = _declination(tropical_longitude)
    signed = decl if planet in _NORTH_STRONG else -decl
    if planet == PlanetName.MERCURY:
        signed = abs(decl)  # Mercury is strong in either ayana
    virupas = max(0.0, min(_FULL, _FULL * (signed + _MAX_DECL) / _AYANA_RANGE))
    return BalaValue(virupas=virupas, citation=_C_AYANA)


def _yuddhabala(planet: PlanetName) -> BalaValue:
    """Planetary-war adjustment — flagged approximate (no rigorous war model here).

    A full Yuddhabala needs the win/lose outcome of any close conjunction of two
    non-luminary grahas (within ~1 deg) and the strength transfer between them.
    We do not yet model the war outcome, so we emit 0 and flag it explicitly
    rather than silently fudging (calc-integrity).
    """
    note = "War-outcome strength transfer not modelled; 0 Virupas pending a rigorous war model."
    return BalaValue(virupas=0.0, citation=_C_YUDDHA, approximated=True, note=note)


def _tropical_longitude(natal: SiderealContext, planet: PlanetName) -> float:
    """Tropical longitude = sidereal longitude + ayanamsa (for declination)."""
    return (natal.planets[planet].longitude + natal.ayanamsa_value) % 360.0


def compute_kala(
    astro: SkyfieldAstronomy,
    natal: SiderealContext,
    planet: PlanetName,
    birth_utc: datetime,
    lat: float,
    lon: float,
    window: SunWindow,
) -> tuple[KalaBala, SunWindow]:
    """Full Kalabala for a graha; returns the bala and the (reusable) sun window.

    ``window`` is required: it carries the birthplace's civil offset, which no
    default could supply honestly.
    """
    win = window
    frac_mid = _frac_from_midnight(win, birth_utc)
    day_frac, is_day = _day_fraction(win, birth_utc)
    third = min(2, int(day_frac * 3))
    nath = nathonnatha(planet, frac_mid)
    paksha = pakshabala(planet, _moon_phase_frac(natal))
    tri = tribhagabala(planet, third, is_day)
    local_rise = win.local_sunrise  # weekday lords read the CIVIL sunrise date
    lords = (
        abdabala(planet, win.local_year_sunrise),
        masabala(planet, win.local_month_sunrise),
        varabala(planet, local_rise),
        horabala(planet, local_rise, birth_utc),
    )
    ayana = _ayanabala(planet, _tropical_longitude(natal, planet))
    yuddha = _yuddhabala(planet)
    parts = (nath, paksha, tri, *lords, ayana, yuddha)
    return (
        KalaBala(
            nathonnatha=nath,
            paksha=paksha,
            tribhaga=tri,
            abda=lords[0],
            masa=lords[1],
            vara=lords[2],
            hora=lords[3],
            ayana=ayana,
            yuddha=yuddha,
            total_virupas=sum(p.virupas for p in parts),
        ),
        win,
    )
