"""Ashtakavarga (Parashari) — the load-bearing classical invariants.

These tests pin the canonical Bhinnashtakavarga totals and the SAV grand total.
If the bindu tables ever stop reproducing them, the TABLES are wrong — never the
test (BPHS / Jagannatha Hora are the authority here).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from almamesh.calculations import calculate_sidereal_context
from almamesh.constants.astrology import PlanetName, ZodiacSign
from almamesh.strength.ashtakavarga import compute_ashtakavarga
from almamesh.strength.bindu_tables import BINDU_CONTRIBUTORS, BINDU_TABLES

_IST = timezone(timedelta(hours=5, minutes=30))
# Synthetic reference native (Bengaluru, fictional birth). The SAV grand total is
# 337 for every chart; this fixture's BAV totals are pinned as a regression lock.
_REFERENCE = datetime(1988, 8, 8, 6, 44, tzinfo=_IST)
_REFERENCE_LAT, _REFERENCE_LON = 12.9716, 77.5946

_BAV_TOTALS = {
    PlanetName.SUN: 48,
    PlanetName.MOON: 49,
    PlanetName.MARS: 39,
    PlanetName.MERCURY: 54,
    PlanetName.JUPITER: 56,
    PlanetName.VENUS: 52,
    PlanetName.SATURN: 39,
}


@pytest.fixture(scope="module")
def reference_ashtakavarga():  # noqa: ANN201 - pytest fixture
    # Given the reference native's natal chart (pinned instant + place)
    natal = calculate_sidereal_context(_REFERENCE, _REFERENCE_LAT, _REFERENCE_LON)
    # When Ashtakavarga is computed
    return compute_ashtakavarga(natal)


@pytest.mark.parametrize(("planet", "expected"), list(_BAV_TOTALS.items()))
def test_should_match_canonical_bav_total_when_tables_are_correct(
    reference_ashtakavarga, planet: PlanetName, expected: int
) -> None:
    # Then each planet's BAV total equals its chart-invariant classical value
    assert reference_ashtakavarga.bhinna[planet].total == expected


def test_should_have_sav_grand_total_337_when_summing_all_bavs(reference_ashtakavarga) -> None:
    # Then the SAV grand total is the canonical 337 for every chart
    assert reference_ashtakavarga.sarva.total == 337


def test_should_have_sav_equal_elementwise_sum_of_seven_bavs(reference_ashtakavarga) -> None:
    # Given the seven BAVs
    bhinna = reference_ashtakavarga.bhinna
    # When each sign's SAV is compared to the sum of the seven BAVs there
    for sign in ZodiacSign:
        per_planet = sum(bhinna[p].bindus[sign] for p in _BAV_TOTALS)
        # Then they are elementwise equal
        assert reference_ashtakavarga.sarva.bindus[sign] == per_planet


def test_should_keep_every_bav_house_bindu_between_0_and_8(reference_ashtakavarga) -> None:
    # Then no sign can hold more bindus than the 8 contributors (7 grahas + Lagna)
    for chart in reference_ashtakavarga.bhinna.values():
        for count in chart.bindus.values():
            assert 0 <= count <= 8


def test_should_define_eight_contributors_for_every_planet_table() -> None:
    # Given the canonical tables
    # Then each of the 7 subject planets has all 8 contributors enumerated
    for planet in _BAV_TOTALS:
        assert set(BINDU_TABLES[planet]) == set(BINDU_CONTRIBUTORS)


def test_should_be_deterministic_when_recomputed(reference_ashtakavarga) -> None:
    # Given a fresh recomputation of the same chart
    natal = calculate_sidereal_context(_REFERENCE, _REFERENCE_LAT, _REFERENCE_LON)
    again = compute_ashtakavarga(natal)
    # Then the SAV is byte-identical (deterministic engine)
    assert again.model_dump() == reference_ashtakavarga.model_dump()


# --- Moon BAV from Jupiter (BPHS) ------------------------------------------------------
# BPHS gives the Moon's benefic places from Jupiter as {1,4,7,8,10,11,12} (confirmed in
# B.V. Raman, VedAstro and M.S. Mehta). A table listing (1,2,4,7,8,10,11) has the same count
# of seven, so the per-planet totals and the 337 above cannot see the swap of 12 for 2.
_BPHS_MOON_FROM_JUPITER = (1, 4, 7, 8, 10, 11, 12)
# Indira Gandhi, 19 Nov 1917, 23:11 IST, Allahabad 25.45N 81.85E (Rodden AA): Cancer lagna,
# Moon in Capricorn, Jupiter in Taurus. Aries is 12th from Jupiter, Gemini 2nd.
_INDIRA = datetime(1917, 11, 19, 23, 11, tzinfo=_IST)
_ARIES, _GEMINI = ZodiacSign.ARIES, ZodiacSign.GEMINI


def test_should_list_bphs_moon_places_from_jupiter() -> None:
    # Given the canonical tables
    # Then the Moon's places from Jupiter are the BPHS row
    assert BINDU_TABLES[PlanetName.MOON][PlanetName.JUPITER] == _BPHS_MOON_FROM_JUPITER


def test_should_match_hand_derived_moon_bav_and_sav_when_chart_is_indira_gandhi() -> None:
    # Given Indira Gandhi's natal chart
    natal = calculate_sidereal_context(_INDIRA, 25.45, 81.85, reference_date=_INDIRA)
    # When Ashtakavarga is computed
    av = compute_ashtakavarga(natal)
    # Then Moon BAV Aries is 5 (Jupiter's 12th counts), SAV Aries 33 and SAV Gemini 24
    observed = (
        av.bhinna[PlanetName.MOON].bindus[_ARIES],
        av.sarva.bindus[_ARIES],
        av.sarva.bindus[_GEMINI],
    )
    assert observed == (5, 33, 24)
