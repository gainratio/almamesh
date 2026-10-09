"""Every sign change of a graha, in its real direction.

This is the one producer for every planet that ingresses on the timeline
(Jupiter, Saturn, Mars, Rahu, Ketu): each cusp crossing is an event with the
real from_sign -> to_sign, so a retrograde exit shows before the re-entry and
one planet never "enters" the same sign twice in a row. Jupiter, Saturn and
Mars retrograde back across cusps; the nodes always move backward. Ketu is
Rahu + 180 deg: its events are Rahu's, mirrored, at the same instant."""

from __future__ import annotations

from datetime import timedelta
from typing import TYPE_CHECKING, Final

from almamesh.constants.astrology import ZODIAC_SIGNS, PlanetName, ZodiacSign
from almamesh.schemas.transits import TimelineEvent, TransitEventKind, TransitSeverity
from almamesh.transits.ingress import find_crossings
from almamesh.transits.natal import sign_index
from almamesh.transits.timeline_ingress import cusp_gap, graha_lon_fn

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator
    from datetime import datetime

    from almamesh.calculations import SkyfieldAstronomy

_STEP_DAYS: Final[float] = 5.0  # all these grahas move under 1 deg/day: one change per step at most
_SIGN_WIDTH: Final[float] = 30.0


def _steps(start: datetime, end: datetime) -> Iterator[tuple[datetime, datetime]]:
    """Adjacent coarse samples covering [start, end]."""
    step = timedelta(days=_STEP_DAYS)
    lo = start
    while lo < end:
        hi = min(lo + step, end)
        yield lo, hi
        lo = hi


def _cusp_between(from_idx: int, to_idx: int) -> float | None:
    """The cusp two adjacent signs share, whichever way the graha moved; else None."""
    if to_idx == (from_idx + 1) % 12:
        return to_idx * _SIGN_WIDTH
    if from_idx == (to_idx + 1) % 12:
        return from_idx * _SIGN_WIDTH
    return None


def _event(graha: PlanetName, when: datetime, from_idx: int, to_idx: int) -> TimelineEvent:
    """One sign-change event with a stable `<graha>.ingress.<sign>` descriptor."""
    entered = ZodiacSign(ZODIAC_SIGNS[to_idx])
    return TimelineEvent(
        date=when,
        kind=TransitEventKind.SIGN_INGRESS,
        graha=graha,
        from_sign=ZodiacSign(ZODIAC_SIGNS[from_idx]),
        to_sign=entered,
        severity=TransitSeverity.NEUTRAL,
        descriptor=f"{graha.value}.ingress.{entered.value.lower()}",
    )


def _changes_in(
    lon_fn: Callable[[datetime], float], graha: PlanetName, lo: datetime, hi: datetime
) -> list[TimelineEvent]:
    """The sign change inside one coarse step, refined to the cusp instant."""
    from_idx, to_idx = sign_index(lon_fn(lo)), sign_index(lon_fn(hi))
    cusp = None if from_idx == to_idx else _cusp_between(from_idx, to_idx)
    if cusp is None:
        return []
    crossings = find_crossings(cusp_gap(lon_fn, cusp), lo, hi, _STEP_DAYS)
    return [_event(graha, when, from_idx, to_idx) for when in crossings]


def sign_change_events(
    astro: SkyfieldAstronomy, graha: PlanetName, start: datetime, end: datetime
) -> list[TimelineEvent]:
    """Every sign change of `graha` in [start, end], chronological."""
    lon_fn = graha_lon_fn(astro, graha)
    events: list[TimelineEvent] = []
    for lo, hi in _steps(start, end):
        events += _changes_in(lon_fn, graha, lo, hi)
    return events


def _opposite(sign: str | None) -> int:
    """The sign index six signs away (Ketu's sign for a Rahu sign)."""
    return (ZODIAC_SIGNS.index(str(sign)) + 6) % 12


def node_sign_change_events(
    astro: SkyfieldAstronomy, start: datetime, end: datetime
) -> list[TimelineEvent]:
    """Rahu's sign changes, then Ketu's mirror of each (same instant)."""
    rahu = sign_change_events(astro, PlanetName.RAHU, start, end)
    ketu = [
        _event(PlanetName.KETU, e.date, _opposite(e.from_sign), _opposite(e.to_sign)) for e in rahu
    ]
    return rahu + ketu
