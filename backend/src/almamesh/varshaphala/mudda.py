"""Annual Vimshottari Mudda Dasha for Tajaka Varshaphala."""

from __future__ import annotations

from datetime import datetime, timedelta

from almamesh.constants.astrology import DASHA_SEQUENCE, DASHA_YEARS
from almamesh.schemas.varshaphala import MuddaDashaPeriod

_TOTAL_VIMSHOTTARI_YEARS = 120.0
_NAKSHATRA_SPAN_DEG = 360.0 / 27.0


def _starting_sequence_index(natal_moon_lon: float, completed_years: int) -> int:
    """Index in DASHA_SEQUENCE for the solar year's starting Mudda lord.

    Classical formula: ((Janma Nakshatra #1..27 + completed_years - 2) % 9) from Sun=1,
    which algebraically equals (janma_nakshatra_idx_0_based + completed_years) % 9
    in DASHA_SEQUENCE (Ketu=0, Venus=1, Sun=2, ...).
    """
    nakshatra_idx = int((natal_moon_lon % 360.0) / _NAKSHATRA_SPAN_DEG)
    return (nakshatra_idx + completed_years) % len(DASHA_SEQUENCE)


def compute_mudda_dasha(
    natal_moon_lon: float,
    completed_years: int,
    solar_return_utc: datetime,
    next_solar_return_utc: datetime,
    reference_date: datetime,
) -> list[MuddaDashaPeriod]:
    """Scale the 9 Vimshottari lords across [solar_return_utc, next_solar_return_utc]."""
    year_days = (next_solar_return_utc - solar_return_utc).total_seconds() / 86400.0
    start_idx = _starting_sequence_index(natal_moon_lon, completed_years)
    cursor = solar_return_utc
    periods: list[MuddaDashaPeriod] = []

    for offset in range(len(DASHA_SEQUENCE)):
        lord = DASHA_SEQUENCE[(start_idx + offset) % len(DASHA_SEQUENCE)]
        days = year_days * (DASHA_YEARS[lord] / _TOTAL_VIMSHOTTARI_YEARS)
        end = (
            next_solar_return_utc
            if offset == len(DASHA_SEQUENCE) - 1
            else cursor + timedelta(days=days)
        )
        is_current = cursor <= reference_date < end
        periods.append(
            MuddaDashaPeriod(
                lord=lord,
                start_utc=cursor,
                end_utc=end,
                duration_days=round(days, 2),
                is_current=is_current,
            )
        )
        cursor = end

    return periods
