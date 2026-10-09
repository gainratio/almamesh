"""Slow-graha (Jupiter/Saturn) sign-ingress events for the timeline.

A sign ingress is a forward cusp crossing; we emit each sticking ingress in the
window with a stable `<graha>.ingress.<sign>` descriptor."""

from __future__ import annotations

from datetime import timedelta
from functools import cache
from typing import TYPE_CHECKING, Final

from almamesh.calculations import AyanamsaType, NodeType
from almamesh.constants.astrology import ZODIAC_SIGNS, PlanetName, ZodiacSign
from almamesh.schemas.transits import TimelineEvent, TransitEventKind, TransitSeverity
from almamesh.transits.ingress import find_crossings
from almamesh.transits.natal import sign_index
from almamesh.transits.positions import transit_longitude

if TYPE_CHECKING:
    from collections.abc import Callable
    from datetime import datetime

    from almamesh.calculations import SkyfieldAstronomy

_STEP_DAYS: Final[float] = 5.0
_SIGN_WIDTH: Final[float] = 30.0
_STICK_DAYS: Final[float] = 30.0  # Jupiter/Saturn settle within a month of ingress


def graha_lon_fn(astro: SkyfieldAstronomy, graha: PlanetName) -> Callable[[datetime], float]:
    """Bound sidereal-longitude function for the graha (Lahiri, mean node)."""

    @cache
    def lon(when: datetime) -> float:
        return transit_longitude(astro, graha, when, AyanamsaType.LAHIRI, NodeType.MEAN)

    return lon


def cusp_gap(lon_fn: Callable[[datetime], float], cusp: float) -> Callable[[datetime], float]:
    """Seam-unwrapped distance of the graha from a sign cusp."""
    return lambda when: (lon_fn(when) - cusp + 180.0) % 360.0 - 180.0


def _entered_sign(lon_fn: Callable[[datetime], float], when: datetime) -> int:
    """The sign Saturn/Jupiter occupies just after a crossing (the entered sign)."""
    return sign_index(lon_fn(when + timedelta(hours=12)))


def _ingress_event(graha: PlanetName, when: datetime, sign_idx: int) -> TimelineEvent:
    """One sign-ingress timeline event with a stable descriptor."""
    entered = ZodiacSign(ZODIAC_SIGNS[sign_idx])
    vacated = ZodiacSign(ZODIAC_SIGNS[(sign_idx - 1) % 12])
    return TimelineEvent(
        date=when,
        kind=TransitEventKind.SIGN_INGRESS,
        graha=graha,
        from_sign=vacated,
        to_sign=entered,
        severity=TransitSeverity.NEUTRAL,
        descriptor=f"{graha.value}.ingress.{entered.value.lower()}",
    )


def slow_graha_ingress_events(
    astro: SkyfieldAstronomy, graha: PlanetName, start: datetime, end: datetime
) -> list[TimelineEvent]:
    """Every sticking sign ingress of `graha` within [start, end]."""
    lon_fn = graha_lon_fn(astro, graha)
    events: list[TimelineEvent] = []
    for sign_idx in range(12):
        gap = cusp_gap(lon_fn, sign_idx * _SIGN_WIDTH)
        for when in find_crossings(gap, start, end, _STEP_DAYS):
            if (
                _entered_sign(lon_fn, when) == sign_idx
                and gap(when + timedelta(days=_STICK_DAYS)) >= 0.0
            ):
                events.append(_ingress_event(graha, when, sign_idx))
    return events
