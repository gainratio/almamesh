"""The dasha part of the reading: clipped spans, sookshma, sandhi and the Yogini maha."""

from __future__ import annotations

from typing import TYPE_CHECKING

from almamesh.dasha.yogini import compute_yogini_periods
from almamesh.reading.common import utc_date
from almamesh.schemas.reading import DashaLevel, DashaSpan, Sandhi, Sookshma, YoginiSpan

if TYPE_CHECKING:
    from datetime import datetime

    from almamesh.schemas.astrology import DashaPeriod, SiderealContext

_SOOKSHMA_DEPTH = 4


def _clipped(level: DashaLevel, period: DashaPeriod, start: datetime, end: datetime) -> DashaSpan:
    """One span clipped to [start, end), as UTC dates."""
    return DashaSpan(
        level=level,
        lord=period.lord,
        start=utc_date(max(period.start_date, start)),
        end=utc_date(min(period.end_date, end)),
    )


def dasha_spans(
    spans: dict[DashaLevel, list[DashaPeriod]], start: datetime, end: datetime
) -> list[DashaSpan]:
    """Every maha/antar/pratyantar span in the window, clipped; sub-day slivers dropped."""
    rows = [_clipped(level, p, start, end) for level, periods in spans.items() for p in periods]
    return [row for row in rows if row.start < row.end]


def sookshma(chain: list[DashaPeriod]) -> Sookshma | None:
    """The sookshma of an active chain (maha, antar, pratyantar, sookshma), unclipped."""
    if len(chain) < _SOOKSHMA_DEPTH:
        return None
    level4 = chain[_SOOKSHMA_DEPTH - 1]
    return Sookshma(
        lord=level4.lord, start=utc_date(level4.start_date), end=utc_date(level4.end_date)
    )


def _starts_inside(periods: list[DashaPeriod], start: datetime, end: datetime) -> list[datetime]:
    """Start instants strictly inside the window."""
    return [p.start_date for p in periods if start < p.start_date < end]


def sandhi(
    spans: dict[DashaLevel, list[DashaPeriod]], start: datetime, end: datetime
) -> Sandhi | None:
    """The first maha change in the window, else the first antar change, else None."""
    for level in (DashaLevel.MAHA, DashaLevel.ANTAR):
        changes = _starts_inside(spans[level], start, end)
        if changes:
            return Sandhi(level=level, date=utc_date(changes[0]))
    return None


def yogini_span(natal: SiderealContext, instant: datetime) -> YoginiSpan | None:
    """The Yogini maha running at ``instant`` (pure arithmetic over the natal Moon)."""
    mahas = natal.dashas.maha_dasha_sequence
    periods = compute_yogini_periods(natal, mahas[0].start_date, mahas[-1].end_date)
    hit = next((p for p in periods if p.start_date <= instant < p.end_date), None)
    if hit is None:
        return None
    return YoginiSpan(
        name=hit.yogini_name.lower(),
        lord=hit.lord,
        start=utc_date(hit.start_date),
        end=utc_date(hit.end_date),
    )


__all__ = ["dasha_spans", "sandhi", "sookshma", "yogini_span"]
