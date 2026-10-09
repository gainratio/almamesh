"""Retrograde and direct stations of Jupiter, Saturn and Mars for the timeline.

A station is the instant the engine's own `is_retrograde` flag flips: the
graha's one-day forward motion in tropical-of-date longitude (the `speed`
`get_planetary_positions` derives the flag from) crosses zero. The station's
sign is the Lahiri sidereal sign at that instant. The mean node never stations,
so Rahu/Ketu have none."""

from __future__ import annotations

from datetime import timedelta
from functools import cache
from typing import TYPE_CHECKING, Final

from almamesh.constants.astrology import ZODIAC_SIGNS, PlanetName, ZodiacSign
from almamesh.schemas.transits import (
    StationDirection,
    TimelineEvent,
    TransitEventKind,
    TransitSeverity,
)
from almamesh.transits.ingress import find_crossings
from almamesh.transits.natal import sign_index
from almamesh.transits.positions import transit_longitude

if TYPE_CHECKING:
    from collections.abc import Callable
    from datetime import datetime

    from almamesh.calculations import SkyfieldAstronomy

_STEP_DAYS: Final[float] = 5.0  # stations of these grahas are 60+ days apart
_ONE_DAY: Final[timedelta] = timedelta(days=1)
_HOUR: Final[timedelta] = timedelta(hours=1)


def _motion_fn(astro: SkyfieldAstronomy, graha: PlanetName) -> Callable[[datetime], float]:
    """Degrees moved over the next day, tropical of date (ayanamsa 0)."""

    @cache
    def tropical(when: datetime) -> float:
        return astro.graha_sidereal_longitude(graha, when, 0.0)

    return lambda when: (tropical(when + _ONE_DAY) - tropical(when) + 180.0) % 360.0 - 180.0


def _direction(motion: Callable[[datetime], float], when: datetime) -> StationDirection:
    """Retrograde when the graha moves backward just after the station."""
    return StationDirection.RETROGRADE if motion(when + _HOUR) < 0.0 else StationDirection.DIRECT


def _station_event(
    astro: SkyfieldAstronomy, graha: PlanetName, when: datetime, direction: StationDirection
) -> TimelineEvent:
    """One station event with a stable descriptor."""
    sign = ZodiacSign(ZODIAC_SIGNS[sign_index(transit_longitude(astro, graha, when))])
    return TimelineEvent(
        date=when,
        kind=TransitEventKind.STATION,
        graha=graha,
        station_direction=direction,
        station_sign=sign,
        severity=TransitSeverity.NEUTRAL,
        descriptor=f"{graha.value}.station.{direction.value}",
    )


def station_events(
    astro: SkyfieldAstronomy, graha: PlanetName, start: datetime, end: datetime
) -> list[TimelineEvent]:
    """Every station of `graha` within [start, end], chronological."""
    motion = _motion_fn(astro, graha)
    return [
        _station_event(astro, graha, when, _direction(motion, when))
        for when in find_crossings(motion, start, end, _STEP_DAYS)
    ]
