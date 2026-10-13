"""Panchang at the reference instant from the gochara Sun and Moon longitudes.

tithi = Moon-Sun elongation / 12 deg (1..30); karana = elongation / 6 deg (60
half-tithis: Kimstughna, 8 x the 7 movable karanas, Shakuni, Chatushpada,
Naga); nitya yoga = (Sun + Moon) / (360/27). vara is the UTC weekday of the
instant: there is no sunrise correction for the viewer's place.
"""

from __future__ import annotations

from datetime import UTC
from typing import TYPE_CHECKING, Final

from almamesh.constants.astrology import PlanetName
from almamesh.schemas.reading import Panchang

if TYPE_CHECKING:
    from datetime import datetime

    from almamesh.schemas.transits import GocharaContext

_FOURTEEN: Final[tuple[str, ...]] = (
    "Pratipada", "Dwitiya", "Tritiya", "Chaturthi", "Panchami", "Shashthi", "Saptami",
    "Ashtami", "Navami", "Dashami", "Ekadashi", "Dwadashi", "Trayodashi", "Chaturdashi",
)  # fmt: skip
_TITHIS: Final[tuple[str, ...]] = (*_FOURTEEN, "Purnima", *_FOURTEEN, "Amavasya")
_MOVABLE: Final[tuple[str, ...]] = (
    "Bava", "Balava", "Kaulava", "Taitila", "Gara", "Vanija", "Vishti",
)  # fmt: skip
_KARANAS: Final[tuple[str, ...]] = (
    "Kimstughna",
    *(_MOVABLE[i % 7] for i in range(56)),
    "Shakuni",
    "Chatushpada",
    "Naga",
)
_YOGAS: Final[tuple[str, ...]] = (
    "Vishkambha", "Priti", "Ayushman", "Saubhagya", "Shobhana", "Atiganda", "Sukarma",
    "Dhriti", "Shula", "Ganda", "Vriddhi", "Dhruva", "Vyaghata", "Harshana", "Vajra",
    "Siddhi", "Vyatipata", "Variyan", "Parigha", "Shiva", "Siddha", "Sadhya", "Shubha",
    "Shukla", "Brahma", "Indra", "Vaidhriti",
)  # fmt: skip
_VARAS: Final[tuple[str, ...]] = (
    "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
)  # fmt: skip
_TITHI_DEG: Final[float] = 12.0
_KARANA_DEG: Final[float] = 6.0
_YOGA_DEG: Final[float] = 360.0 / 27.0
_WAXING_TITHIS: Final[int] = 15


def panchang_at(
    instant: datetime, *, sun_longitude: float, moon_longitude: float, moon_nakshatra: str
) -> Panchang:
    """The panchang limbs from sidereal Sun/Moon longitudes at ``instant``."""
    elongation = (moon_longitude - sun_longitude) % 360.0
    tithi = int(elongation // _TITHI_DEG) + 1
    return Panchang(
        instant=instant,
        tithi=tithi,
        tithi_name=_TITHIS[tithi - 1],
        paksha="shukla" if tithi <= _WAXING_TITHIS else "krishna",
        nakshatra=moon_nakshatra,
        karana=_KARANAS[int(elongation // _KARANA_DEG)],
        yoga=_YOGAS[int(((sun_longitude + moon_longitude) % 360.0) // _YOGA_DEG)],
        vara=_VARAS[instant.astimezone(UTC).weekday()],
    )


def panchang_from(gochara: GocharaContext) -> Panchang:
    """The panchang at the gochara instant (the run's reference instant)."""
    sun = gochara.placements[PlanetName.SUN]
    moon = gochara.placements[PlanetName.MOON]
    return panchang_at(
        gochara.instant,
        sun_longitude=sun.longitude,
        moon_longitude=moon.longitude,
        moon_nakshatra=moon.nakshatra,
    )


__all__ = ["panchang_at", "panchang_from"]
