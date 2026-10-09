"""The Moon at a place's local start and end of a short period, and at one event.

Spec 2026-10-08 Part 2: a day-precision reading needs a place; this reports the
Moon's sign, nakshatra and tithi at that place's local start of the first day and
local end of the last day, plus the lagna sign and the Moon at an optional event
instant. The caller turns local midnights into UTC instants (no tz database here).
Lahiri sidereal, mean node, like the rest of the timeline.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import UTC, datetime, timedelta
from typing import Literal

from pydantic import BaseModel, ConfigDict

from almamesh.calculations import (
    AyanamsaType,
    SkyfieldAstronomy,
    _resolve_ayanamsa,
    get_nakshatra_info,
    validate_coordinates,
)
from almamesh.constants.astrology import PlanetName, ZodiacSign
from almamesh.transits.positions import transit_longitude

_MIN_SPAN = timedelta(hours=22)
_MAX_SPAN = timedelta(days=6, hours=2)
_FIRST_INSTANT = datetime(1900, 1, 1, tzinfo=UTC)
_LAST_INSTANT = datetime(2053, 1, 1, tzinfo=UTC)
_SIGNS = list(ZodiacSign)


class MoonMark(BaseModel):
    model_config = ConfigDict(frozen=True)
    sign: ZodiacSign
    nakshatra: str
    tithi: int
    paksha: Literal["shukla", "krishna"]


class MoonEnds(BaseModel):
    model_config = ConfigDict(frozen=True)
    at_start: MoonMark
    at_end: MoonMark


class EventPoint(BaseModel):
    model_config = ConfigDict(frozen=True)
    when: datetime
    latitude: float
    longitude: float


class EventSky(BaseModel):
    model_config = ConfigDict(frozen=True)
    lagna_sign: ZodiacSign
    moon: MoonMark


class MoonWindow(BaseModel):
    model_config = ConfigDict(frozen=True)
    at_place: MoonEnds
    event: EventSky | None = None


def tithi_number(moon_lon: float, sun_lon: float) -> int:
    """Tithi 1..30: whole 12-degree steps of the Moon-Sun angle, plus one."""
    return int(((moon_lon - sun_lon) % 360.0) // 12.0) + 1


def _sign_of(longitude: float) -> ZodiacSign:
    return _SIGNS[int((longitude % 360.0) // 30.0)]


def _moon_mark(astro: SkyfieldAstronomy, when: datetime) -> MoonMark:
    moon = transit_longitude(astro, PlanetName.MOON, when)
    tithi = tithi_number(moon, transit_longitude(astro, PlanetName.SUN, when))
    nakshatra, _pada, _lord = get_nakshatra_info(moon)
    return MoonMark(
        sign=_sign_of(moon),
        nakshatra=nakshatra,
        tithi=tithi,
        paksha="shukla" if tithi <= 15 else "krishna",
    )


def _checked_bounds(start: datetime, end: datetime) -> None:
    if not _MIN_SPAN <= end - start <= _MAX_SPAN:
        raise ValueError("invalid place bounds: must span 1 to 6 local days, start before end")


def _event_sky(
    astro: SkyfieldAstronomy, start: datetime, end: datetime, event: EventPoint
) -> EventSky:
    if not start <= event.when <= end:
        raise ValueError("invalid event: the instant is outside the place bounds")
    try:
        validate_coordinates(event.latitude, event.longitude)
    except (TypeError, ValueError) as error:
        raise ValueError("invalid event: coordinates out of range") from error
    ayanamsa = _resolve_ayanamsa(astro, event.when, AyanamsaType.LAHIRI)
    lagna = astro.calculate_lagna(event.when, event.latitude, event.longitude, ayanamsa)
    return EventSky(lagna_sign=_sign_of(lagna), moon=_moon_mark(astro, event.when))


def compute_moon_window(
    start: datetime,
    end: datetime,
    *,
    event: EventPoint | None = None,
    astronomy: SkyfieldAstronomy | None = None,
) -> MoonWindow:
    """The Moon at ``start`` and ``end`` (a place's local bounds), and optionally at one event."""
    _checked_bounds(start, end)
    astro = astronomy if astronomy is not None else SkyfieldAstronomy()
    ends = MoonEnds(at_start=_moon_mark(astro, start), at_end=_moon_mark(astro, end))
    return MoonWindow(
        at_place=ends, event=None if event is None else _event_sky(astro, start, end, event)
    )


def _wire_instant(value: object, field: str) -> datetime:
    if not isinstance(value, str):
        raise ValueError(f"invalid {field}: must be an ISO 8601 UTC instant")
    when = datetime.fromisoformat(value)
    if when.utcoffset() != timedelta(0):
        raise ValueError(f"invalid {field}: must be a UTC instant")
    if not _FIRST_INSTANT <= when < _LAST_INSTANT:
        raise ValueError(f"invalid {field}: outside the on-device ephemeris (1900..2052)")
    return when


def _wire_number(value: object, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise ValueError(f"invalid {field}: must be a number")
    return float(value)


def _wire_event(value: object) -> EventPoint | None:
    if value is None:
        return None
    if not isinstance(value, Mapping):
        raise ValueError("invalid event: must be an object")
    return EventPoint(
        when=_wire_instant(value.get("datetime_utc"), "event datetime_utc"),
        latitude=_wire_number(value.get("latitude"), "event latitude"),
        longitude=_wire_number(value.get("longitude"), "event longitude"),
    )


def moon_window_from_wire(payload: Mapping[str, object]) -> MoonWindow:
    """Shared by the CPython edge runtime and the Pyodide glue so both refuse the same inputs."""
    return compute_moon_window(
        _wire_instant(payload.get("place_start_utc"), "place_start_utc"),
        _wire_instant(payload.get("place_end_utc"), "place_end_utc"),
        event=_wire_event(payload.get("event")),
    )
