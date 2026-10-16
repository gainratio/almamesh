"""Yogini antardashas: eight proportional antars inside each Yogini maha.

Reference: Princess Diana, 1961-07-01 18:45 UT, Sandringham (Rodden AA), the chart
``test_dasha_birth_balance.py`` already uses. PyJHora 4.8.7 (Lahiri, run locally as an
oracle only) dates her Yogini mahas Pingala (Sun) to 1962-03-29 ~18:00 UT and Bhramari
(Mars) from 1965-03-29 12:26 UT, and orders the Pingala antars Sun, Jupiter, Mars,
Mercury, Saturn, Venus, Rahu, Moon. PyJHora splits a maha into eight EQUAL antars; the
standard split is proportional (antar = maha years x antar years / 36), so the lengths
below are hand-computed from that formula on the engine's 365.25-day year, not PyJHora's.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from almamesh.calculations import calculate_sidereal_context
from almamesh.constants.astrology import PlanetName
from almamesh.dasha.yogini import compute_yogini_periods, yogini_antars
from almamesh.schemas.astrology import SiderealContext

_BIRTH = datetime(1961, 7, 1, 18, 45, tzinfo=UTC)
_HOUR = timedelta(hours=1)


@pytest.fixture(scope="module")
def diana() -> SiderealContext:
    return calculate_sidereal_context(_BIRTH, 52.8311, 0.5054, reference_date=_BIRTH)


def _mahas(natal: SiderealContext):
    mahas = natal.dashas.maha_dasha_sequence
    return compute_yogini_periods(natal, mahas[0].start_date, mahas[-1].end_date)


def _utc(text: str) -> datetime:
    return datetime.fromisoformat(text).replace(tzinfo=UTC)


def test_maha_boundaries_match_pyjhora(diana: SiderealContext) -> None:
    # Given Diana's Yogini mahas
    mahas = _mahas(diana)
    # Then Pingala ends and Bhramari starts within an hour of PyJHora (Lahiri)
    assert mahas[0].yogini_name == "Pingala"
    assert abs(mahas[0].end_date - _utc("1962-03-29T18:00")) < _HOUR
    assert abs(mahas[2].start_date - _utc("1965-03-29T12:26")) < _HOUR


def test_antar_order_starts_from_the_maha_yogini_like_pyjhora(diana: SiderealContext) -> None:
    # Given the second (full) maha, Dhanya (Jupiter)
    dhanya = _mahas(diana)[1]
    # When it is split into antars
    antars = yogini_antars(dhanya)
    # Then the order is the Yogini cycle starting at Dhanya
    assert [a.lord for a in antars] == [
        PlanetName.JUPITER,
        PlanetName.MARS,
        PlanetName.MERCURY,
        PlanetName.SATURN,
        PlanetName.VENUS,
        PlanetName.RAHU,
        PlanetName.MOON,
        PlanetName.SUN,
    ]


def test_antars_are_proportional_and_tile_the_maha(diana: SiderealContext) -> None:
    # Given the full Dhanya (Jupiter, 3 y) maha from 1962-03-29 18:22:19 UT
    dhanya = _mahas(diana)[1]
    antars = yogini_antars(dhanya)
    # Then Dhanya in Dhanya lasts 3 x 3 / 36 = 0.25 y = 91.3125 days (hand-computed)
    assert antars[0].start_date == dhanya.start_date
    assert abs(antars[0].end_date - _utc("1962-06-29T01:52:19")) < timedelta(seconds=1)
    assert antars[0].duration_years == pytest.approx(0.25)
    # And Mangala in Dhanya is 3 x 1 / 36 y; the eight tile the maha exactly
    assert antars[6].duration_years == pytest.approx(3 / 36)
    assert antars[-1].end_date == dhanya.end_date
    assert all(a.end_date == b.start_date for a, b in zip(antars, antars[1:], strict=False))


def test_birth_maha_antars_run_from_the_virtual_start(diana: SiderealContext) -> None:
    # Given the birth maha Pingala (2 y), already running at birth
    pingala = _mahas(diana)[0]
    # When it is split into antars
    antars = yogini_antars(pingala)
    # Then the antars are dated from the virtual start 1962-03-29 18:22:19 - 2 y
    # (= 1960-03-29 06:22:19): Siddha (Venus) runs at birth until 1961-09-28 03:22:19
    assert [a.lord for a in antars] == [PlanetName.VENUS, PlanetName.RAHU, PlanetName.MOON]
    assert antars[0].start_date == _BIRTH
    assert abs(antars[0].end_date - _utc("1961-09-28T03:22:19")) < timedelta(seconds=1)
    assert abs(antars[1].end_date - _utc("1962-03-09T11:22:19")) < timedelta(seconds=1)
    assert antars[-1].end_date == pingala.end_date
