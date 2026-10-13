"""Window segments: split at antar/pratyantar changes and slow-graha sign ingresses.

A segment's lords are read at its first instant; every timeline event lands in
the segment whose day range holds it, so stations, Mars ingresses, Sade Sati
phases and dasha handovers are all listed as "YYYY-MM-DD descriptor" (UTC day
first, then the stable descriptor), so each change point can be cited by date.
"""

from __future__ import annotations

from bisect import bisect_right
from typing import TYPE_CHECKING

from almamesh.dasha.depth import active_chain
from almamesh.reading.common import one_per_day, span_bounds, utc_date
from almamesh.reading.sky import SKY_GRAHAS
from almamesh.schemas.reading import DashaLevel, ReadingSegment
from almamesh.schemas.transits import TransitEventKind

if TYPE_CHECKING:
    from collections.abc import Sequence
    from datetime import date, datetime

    from almamesh.schemas.astrology import DashaPeriod
    from almamesh.schemas.transits import TimelineEvent, TransitTimeline


def _is_slow_ingress(event: TimelineEvent) -> bool:
    """A Jupiter/Saturn/Rahu/Ketu sign ingress."""
    return event.kind == TransitEventKind.SIGN_INGRESS and event.graha in SKY_GRAHAS


def _change_instants(
    spans: dict[DashaLevel, list[DashaPeriod]], timeline: TransitTimeline
) -> list[datetime]:
    """Antar/pratyantar starts and slow-graha ingresses, unfiltered."""
    levels = (DashaLevel.ANTAR, DashaLevel.PRATYANTAR)
    dasha = [p.start_date for level in levels for p in spans[level]]
    return dasha + [e.date for e in filter(_is_slow_ingress, timeline.events)]


def _cuts(
    spans: dict[DashaLevel, list[DashaPeriod]], timeline: TransitTimeline
) -> list[tuple[date, datetime]]:
    """The window start plus every change inside it, one cut per UTC day."""
    start, end = timeline.window_start, timeline.window_end
    inside = [when for when in _change_instants(spans, timeline) if start < when < end]
    return one_per_day(((when, when) for when in (start, *inside)), end)


def _place(days: list[date], events: Sequence[TimelineEvent]) -> list[list[str]]:
    """Each event as "YYYY-MM-DD descriptor", in the segment starting on or before its UTC day."""
    placed: list[list[str]] = [[] for _ in days]
    for event in events:
        day = utc_date(event.date)
        placed[max(bisect_right(days, day) - 1, 0)].append(f"{day.isoformat()} {event.descriptor}")
    return placed


def _segment(
    mahas: Sequence[DashaPeriod], cut: datetime, bounds: tuple[date, date], events: list[str]
) -> ReadingSegment:
    """One segment with the lords running at its first instant."""
    maha, antar, pratyantar = (p.lord for p in active_chain(mahas, cut)[:3])
    return ReadingSegment(
        start=bounds[0], end=bounds[1], maha=maha, antar=antar, pratyantar=pratyantar, events=events
    )


def reading_segments(
    mahas: Sequence[DashaPeriod],
    spans: dict[DashaLevel, list[DashaPeriod]],
    timeline: TransitTimeline,
) -> list[ReadingSegment]:
    """The window's segments, tiling [window_start, window_end) by UTC day."""
    days = _cuts(spans, timeline)
    starts = [day for day, _ in days]
    placed = _place(starts, timeline.events)
    bounds = span_bounds(starts, timeline.window_end)
    return [
        _segment(mahas, cut, pair, events)
        for pair, (_, cut), events in zip(bounds, days, placed, strict=True)
    ]


__all__ = ["reading_segments"]
