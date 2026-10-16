"""Vimshottari depth for ANY date: maha/antar/pratyantar spans and the sookshma.

Pure arithmetic over the natal maha sequence (no ephemeris). Every level is its
parent's ACTUAL span split in DASHA_YEARS/120 proportions, the sequence starting
at the parent lord: the same ``subdivide_period`` the natal antar tree uses, so
an antar here is byte-identical to its ``MahaDashaPeriod.antar_sequence`` row.
Unlike ``pratyantar_sequence`` (the current antar only), these cover any window.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Final

from almamesh.calculations import subdivide_period
from almamesh.schemas.reading import DashaLevel

if TYPE_CHECKING:
    from collections.abc import Sequence
    from datetime import datetime

    from almamesh.schemas.astrology import DashaPeriod


_SPAN_LEVELS: Final[tuple[DashaLevel, ...]] = (
    DashaLevel.MAHA,
    DashaLevel.ANTAR,
    DashaLevel.PRATYANTAR,
)
_CHAIN_DEPTH: Final[int] = 4


def _overlapping(
    periods: Sequence[DashaPeriod], start: datetime, end: datetime
) -> list[DashaPeriod]:
    """The periods that share time with the half-open window [start, end)."""
    return [p for p in periods if p.start_date < end and p.end_date > start]


def level_spans(
    mahas: Sequence[DashaPeriod], start: datetime, end: datetime
) -> dict[DashaLevel, list[DashaPeriod]]:
    """True (unclipped) maha, antar and pratyantar spans covering [start, end).

    Each level's list is chronological and contiguous: the rows tile the window.
    """
    spans: dict[DashaLevel, list[DashaPeriod]] = {}
    rows = _overlapping(mahas, start, end)
    for level in _SPAN_LEVELS:
        spans[level] = rows
        rows = [sub for row in rows for sub in _overlapping(subdivide_period(row), start, end)]
    return spans


def _containing(periods: Sequence[DashaPeriod], instant: datetime) -> DashaPeriod | None:
    """The period whose half-open span holds ``instant``, else None."""
    return next((p for p in periods if p.start_date <= instant < p.end_date), None)


def active_chain(mahas: Sequence[DashaPeriod], instant: datetime) -> list[DashaPeriod]:
    """The maha, antar, pratyantar and sookshma running at ``instant``.

    Shorter than four only when ``instant`` falls outside the maha sequence.
    """
    chain: list[DashaPeriod] = []
    candidates: Sequence[DashaPeriod] = mahas
    while len(chain) < _CHAIN_DEPTH:
        hit = _containing(candidates, instant)
        if hit is None:
            break
        chain.append(hit)
        candidates = subdivide_period(hit)
    return chain


__all__ = ["DashaLevel", "active_chain", "level_spans"]
