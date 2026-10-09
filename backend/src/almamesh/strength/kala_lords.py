"""Time-lord Kalabala sub-balas: Abda, Masa, Vara, Hora (BPHS).

The lord of the year (Abda) gets 15 Virupas, of the month (Masa) 30, of the
weekday (Vara) 45, and of the birth hora (Hora) 60. Vara and Hora are computed
rigorously from the true sunrise; Abda and Masa follow the classical rule that
the year-lord is the weekday-lord of the solar-year start and the month-lord the
weekday-lord of the solar-month start, both reckoned in whole 360.25-day years /
30.4375-day months from the weekday axis. (BPHS, Shadbala Adhyaya, Kalabala.)
"""

from __future__ import annotations

from datetime import timedelta
from typing import TYPE_CHECKING, Final

from almamesh.constants.astrology import PlanetName
from almamesh.schemas.strength import BalaValue

if TYPE_CHECKING:
    from datetime import datetime

_ABDA_V: Final[float] = 15.0
_MASA_V: Final[float] = 30.0
_VARA_V: Final[float] = 45.0
_HORA_V: Final[float] = 60.0

_C_ABDA: Final[str] = "BPHS Kalabala — Abdabala (year-lord, 15 Virupas)."
_C_MASA: Final[str] = "BPHS Kalabala — Masabala (month-lord, 30 Virupas)."
_C_VARA: Final[str] = "BPHS Kalabala — Varabala (weekday-lord, 45 Virupas)."
_C_HORA: Final[str] = "BPHS Kalabala — Horabala (hora-lord from sunrise, 60 Virupas)."

# Weekday lord, index 0 = Sunday (Python weekday() Mon=0 is remapped below).
_WEEKDAY_LORDS: Final[tuple[PlanetName, ...]] = (
    PlanetName.SUN,
    PlanetName.MOON,
    PlanetName.MARS,
    PlanetName.MERCURY,
    PlanetName.JUPITER,
    PlanetName.VENUS,
    PlanetName.SATURN,
)
# Chaldean hora order (descending speed) repeated through the day.
_HORA_ORDER: Final[tuple[PlanetName, ...]] = (
    PlanetName.SATURN,
    PlanetName.JUPITER,
    PlanetName.MARS,
    PlanetName.SUN,
    PlanetName.VENUS,
    PlanetName.MERCURY,
    PlanetName.MOON,
)
_HOURS_PER_DAY: Final[int] = 24
_AVG_YEAR_DAYS: Final[float] = 365.25
_AVG_MONTH_DAYS: Final[float] = 30.4375


def _weekday_index(sunrise: datetime) -> int:
    """0=Sunday..6=Saturn for the Vedic day, which begins at sunrise.

    ``sunrise`` must be the LOCAL sunrise (``SunWindow.local_sunrise``): the
    weekday is the birthplace's calendar day, never the UTC one.
    """
    return (sunrise.weekday() + 1) % 7


def vara_lord(sunrise: datetime) -> PlanetName:
    """Weekday lord of the birth day (the day starts at sunrise)."""
    return _WEEKDAY_LORDS[_weekday_index(sunrise)]


def hora_lord(sunrise: datetime, birth_utc: datetime) -> PlanetName:
    """Lord of the hora (sunrise-anchored hour) containing the birth instant."""
    hours = int((birth_utc - sunrise).total_seconds() // 3600) % _HOURS_PER_DAY
    start = _HORA_ORDER.index(vara_lord(sunrise))  # first hora = weekday lord
    return _HORA_ORDER[(start + hours) % len(_HORA_ORDER)]


def _epoch_weekday_lord(sunrise: datetime, period_days: float, multiple: int) -> PlanetName:
    """Weekday lord ``multiple`` whole periods before the birth-day sunrise."""
    epoch = sunrise - timedelta(days=period_days * multiple)
    return _WEEKDAY_LORDS[(epoch.weekday() + 1) % 7]


def abda_lord(sunrise: datetime) -> PlanetName:
    """Year-lord: weekday lord of the solar-year axis (BPHS Abda rule)."""
    return _epoch_weekday_lord(sunrise, _AVG_YEAR_DAYS, 1)


def masa_lord(sunrise: datetime) -> PlanetName:
    """Month-lord: weekday lord of the solar-month axis (BPHS Masa rule)."""
    return _epoch_weekday_lord(sunrise, _AVG_MONTH_DAYS, 1)


def _award(planet: PlanetName, lord: PlanetName, value: float, citation: str) -> BalaValue:
    """Award ``value`` Virupas iff the graha rules this time period."""
    return BalaValue(virupas=value if planet == lord else 0.0, citation=citation)


def abdabala(planet: PlanetName, sunrise: datetime) -> BalaValue:
    """Abdabala (year-lord strength)."""
    return _award(planet, abda_lord(sunrise), _ABDA_V, _C_ABDA)


def masabala(planet: PlanetName, sunrise: datetime) -> BalaValue:
    """Masabala (month-lord strength)."""
    return _award(planet, masa_lord(sunrise), _MASA_V, _C_MASA)


def varabala(planet: PlanetName, sunrise: datetime) -> BalaValue:
    """Varabala (weekday-lord strength)."""
    return _award(planet, vara_lord(sunrise), _VARA_V, _C_VARA)


def horabala(planet: PlanetName, sunrise: datetime, birth_utc: datetime) -> BalaValue:
    """Horabala (hora-lord strength)."""
    return _award(planet, hora_lord(sunrise, birth_utc), _HORA_V, _C_HORA)
