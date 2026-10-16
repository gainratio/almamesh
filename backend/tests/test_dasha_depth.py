"""Vimshottari depth arithmetic: maha/antar/pratyantar spans for ANY window and
the sookshma (level 4) at ANY instant (B2).

Each level is the parent's actual span split in DASHA_YEARS/120 proportions,
the sequence starting at the parent lord. Hand-computed values use a synthetic
6-year Sun maha of 2160 days (360-day years) so every share is exact.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from almamesh.calculations import calculate_sidereal_context
from almamesh.constants.astrology import PlanetName
from almamesh.dasha.depth import DashaLevel, active_chain, level_spans
from almamesh.schemas.astrology import DashaPeriod, SiderealContext

_T0 = datetime(2000, 1, 1, tzinfo=UTC)
_SUN_MAHA = DashaPeriod(
    lord=PlanetName.SUN, start_date=_T0, end_date=_T0 + timedelta(days=2160), duration_years=6
)
_US = timedelta(microseconds=2)


def _close(a: datetime, b: datetime) -> bool:
    return abs(a - b) <= _US


@pytest.fixture(scope="module")
def delhi() -> SiderealContext:
    birth = datetime(1990, 1, 15, 12, tzinfo=UTC)
    ref = datetime(2019, 5, 1, tzinfo=UTC)
    return calculate_sidereal_context(birth, 28.6139, 77.209, reference_date=ref)


def test_sookshma_hand_computed_sun_sun_sun() -> None:
    """Sun AD = 108 d, Sun PD = 5.4 d, Sun SD = 0.27 d = 6 h 28.8 min."""
    chain = active_chain([_SUN_MAHA], _T0 + timedelta(hours=6))
    assert [p.lord for p in chain] == [PlanetName.SUN] * 4
    assert _close(chain[1].end_date, _T0 + timedelta(days=108))
    assert _close(chain[2].end_date, _T0 + timedelta(days=5.4))
    assert _close(chain[3].end_date, _T0 + timedelta(hours=6, minutes=28.8))


def test_sookshma_advances_to_moon_after_the_sun_share() -> None:
    """Past 6 h 28.8 min the next sookshma lord (Moon) runs for 0.45 d."""
    sookshma = active_chain([_SUN_MAHA], _T0 + timedelta(hours=7))[3]
    assert sookshma.lord == PlanetName.MOON
    assert _close(sookshma.end_date, _T0 + timedelta(hours=6, minutes=28.8) + timedelta(days=0.45))


def test_pratyantar_sequence_starts_at_the_antar_lord() -> None:
    """The Moon antar (days 108..288) opens with a Moon pratyantar of 15 days."""
    chain = active_chain([_SUN_MAHA], _T0 + timedelta(days=110))
    assert [p.lord for p in chain[:3]] == [PlanetName.SUN, PlanetName.MOON, PlanetName.MOON]
    assert _close(chain[2].start_date, _T0 + timedelta(days=108))
    assert _close(chain[2].end_date, _T0 + timedelta(days=123))


def test_active_chain_is_empty_outside_the_mahas() -> None:
    assert active_chain([_SUN_MAHA], _T0 - timedelta(days=1)) == []


def test_level_spans_tile_the_window_without_gaps(delhi: SiderealContext) -> None:
    """Every level's spans are contiguous and cover the whole window."""
    start, end = datetime(2018, 3, 1, tzinfo=UTC), datetime(2021, 3, 1, tzinfo=UTC)
    spans = level_spans(delhi.dashas.maha_dasha_sequence, start, end)
    for level in (DashaLevel.MAHA, DashaLevel.ANTAR, DashaLevel.PRATYANTAR):
        rows = spans[level]
        assert rows[0].start_date <= start and rows[-1].end_date >= end, level
        for prev, curr in zip(rows, rows[1:], strict=False):
            assert prev.end_date == curr.start_date, level


def test_level_spans_match_the_engine_antar_tree(delhi: SiderealContext) -> None:
    """The antar spans are byte-identical to the maha row's antar_sequence."""
    maha = delhi.dashas.maha_dasha_sequence[4]
    spans = level_spans(delhi.dashas.maha_dasha_sequence, maha.start_date, maha.end_date)
    assert spans[DashaLevel.ANTAR] == maha.antar_sequence


def test_may_2019_is_rahu_rahu_venus(delhi: SiderealContext) -> None:
    """The existing e2e pin: DELHI_BIRTH in May 2019 runs Rahu maha, Rahu antar."""
    chain = active_chain(delhi.dashas.maha_dasha_sequence, datetime(2019, 5, 1, tzinfo=UTC))
    assert [p.lord for p in chain[:3]] == [PlanetName.RAHU, PlanetName.RAHU, PlanetName.VENUS]


def test_pratyantar_for_any_date_matches_the_engine_current_leg() -> None:
    """A date in a DIFFERENT antar resolves the same PD the natal engine reports."""
    birth, ref = datetime(1990, 1, 15, 12, tzinfo=UTC), datetime(2025, 8, 20, tzinfo=UTC)
    natal = calculate_sidereal_context(birth, 28.6139, 77.209, reference_date=ref)
    chain = active_chain(natal.dashas.maha_dasha_sequence, ref)
    assert chain[2] == natal.dashas.current_pratyantar
