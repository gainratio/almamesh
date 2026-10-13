"""The reading's own bounds inside the run's transit window.

A run computes a 12- or 24-month window, but a reading is about one period: a
day, a month, a year. ``bounded_transits`` cuts the timeline to
[reference day, reading_end] so every span, segment, theme and sandhi is the
period's own. The full window stays in ``transit_context`` for the timing tool.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, time, timedelta
from typing import TYPE_CHECKING

from almamesh.reading.common import utc_date

if TYPE_CHECKING:
    from almamesh.schemas.transits import TransitContext, TransitTimeline


def _day_start(day: date) -> datetime:
    """UTC midnight at the start of ``day``."""
    return datetime.combine(day, time(), tzinfo=UTC)


def checked_reading_end(timeline: TransitTimeline, reading_end: date) -> date:
    """``reading_end`` (inclusive), refused before the reference day or past the window."""
    if reading_end < utc_date(timeline.window_start):
        raise ValueError("invalid reading_end: before the reference day")
    if _day_start(reading_end) >= timeline.window_end:
        raise ValueError("invalid reading_end: past the window end")
    return reading_end


def reading_close(timeline: TransitTimeline, reading_end: date | None) -> datetime:
    """The reading's exclusive end: midnight after its last day, never past the window.

    Absent ``reading_end`` means the reference day only (a Day reading of today).
    """
    last = utc_date(timeline.window_start)
    if reading_end is not None:
        last = checked_reading_end(timeline, reading_end)
    return min(_day_start(last) + timedelta(days=1), timeline.window_end)


def bounded_transits(transits: TransitContext, reading_end: date | None) -> TransitContext:
    """The transit context with its timeline cut to the reading's bounds."""
    timeline = transits.timeline
    close = reading_close(timeline, reading_end)
    events = [event for event in timeline.events if event.date < close]
    cut = timeline.model_copy(update={"window_end": close, "events": events})
    return transits.model_copy(update={"timeline": cut})


def reading_end_from_wire(value: object) -> date | None:
    """The reading's inclusive last day from a wire value; absent means the reference day.

    Shared by the CPython edge runtime and the Pyodide worker glue so both
    refuse the same inputs: anything but an ISO ``YYYY-MM-DD`` string.
    """
    if value is None:
        return None
    if not isinstance(value, str) or len(value) != len("YYYY-MM-DD"):
        raise ValueError("invalid reading_end: must be an ISO date (YYYY-MM-DD)")
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise ValueError("invalid reading_end: must be an ISO date (YYYY-MM-DD)") from exc


__all__ = ["bounded_transits", "checked_reading_end", "reading_close", "reading_end_from_wire"]
