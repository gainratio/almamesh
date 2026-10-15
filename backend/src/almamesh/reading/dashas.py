"""The dasha part of the reading: clipped spans, sookshma, sandhi and the Yogini maha."""

from __future__ import annotations

from typing import TYPE_CHECKING

from almamesh.dasha.yogini import compute_yogini_periods, yogini_antars
from almamesh.reading.classical import span_relation, with_parents
from almamesh.reading.common import utc_date
from almamesh.schemas.reading import DashaLevel, DashaSpan, Sandhi, Sookshma, YoginiSpan

if TYPE_CHECKING:
    from datetime import datetime

    from almamesh.dasha.models import YoginiPeriod
    from almamesh.reading.classical import ChartLords
    from almamesh.schemas.astrology import DashaPeriod, SiderealContext

_SOOKSHMA_DEPTH = 4


def _clipped(
    row: tuple[DashaLevel, DashaPeriod, DashaPeriod | None],
    window: tuple[datetime, datetime],
    lords: ChartLords,
) -> DashaSpan:
    """One span clipped to [start, end), as UTC dates, with its placement from its parent."""
    level, period, parent = row
    placed = span_relation(lords, period, parent)
    return DashaSpan(
        level=level,
        lord=period.lord,
        start=utc_date(max(period.start_date, window[0])),
        end=utc_date(min(period.end_date, window[1])),
        from_parent=None if placed is None else placed[0],
        relation=None if placed is None else placed[1],
    )


def dasha_spans(
    spans: dict[DashaLevel, list[DashaPeriod]],
    window: tuple[datetime, datetime],
    lords: ChartLords,
) -> list[DashaSpan]:
    """Every maha/antar/pratyantar span in the window, clipped; sub-day slivers dropped."""
    rows = [_clipped(row, window, lords) for row in with_parents(spans)]
    return [row for row in rows if row.start < row.end]


def sookshma(chain: list[DashaPeriod], lords: ChartLords) -> Sookshma | None:
    """The sookshma of an active chain (maha, antar, pratyantar, sookshma), unclipped."""
    if len(chain) < _SOOKSHMA_DEPTH:
        return None
    pratyantar, level4 = chain[_SOOKSHMA_DEPTH - 2], chain[_SOOKSHMA_DEPTH - 1]
    house, relation = lords.relation(pratyantar.lord, level4.lord)
    return Sookshma(
        lord=level4.lord,
        start=utc_date(level4.start_date),
        end=utc_date(level4.end_date),
        from_parent=house,
        relation=relation,
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


def _yogini_at(periods: list[YoginiPeriod], instant: datetime) -> YoginiPeriod | None:
    return next((p for p in periods if p.start_date <= instant < p.end_date), None)


def _yogini_row(period: YoginiPeriod | None) -> YoginiSpan | None:
    if period is None:
        return None
    return YoginiSpan(
        name=period.yogini_name.lower(),
        lord=period.lord,
        start=utc_date(period.start_date),
        end=utc_date(period.end_date),
    )


def yogini_spans(
    natal: SiderealContext, instant: datetime
) -> tuple[YoginiSpan | None, YoginiSpan | None]:
    """The Yogini maha and antar running at ``instant`` (arithmetic over the natal Moon)."""
    mahas = natal.dashas.maha_dasha_sequence
    maha = _yogini_at(
        compute_yogini_periods(natal, mahas[0].start_date, mahas[-1].end_date), instant
    )
    antar = None if maha is None else _yogini_at(yogini_antars(maha), instant)
    return _yogini_row(maha), _yogini_row(antar)


def yogini_span(natal: SiderealContext, instant: datetime) -> YoginiSpan | None:
    """The Yogini maha running at ``instant``."""
    return yogini_spans(natal, instant)[0]


__all__ = ["dasha_spans", "sandhi", "sookshma", "yogini_span", "yogini_spans"]
