"""The period reading's stated rules, each pinned on hand-worked inputs.

Functional nature (BPHS lagna lordship), the Moon-based Saturn/Jupiter tags,
direction and confidence counting, and the panchang limbs from Sun/Moon
longitudes. These are the rules ``PeriodReading.rules`` states to the model.
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from almamesh.calculations import calculate_sidereal_context
from almamesh.constants.astrology import PlanetName
from almamesh.reading.dashas import sookshma, yogini_span
from almamesh.reading.functional import functional_nature
from almamesh.reading.panchang import panchang_at
from almamesh.reading.sky import sky_tags
from almamesh.reading.themes import confidence_for, theme_direction
from almamesh.schemas.reading import FunctionalNature
from almamesh.schemas.transits import TransitSeverity

_LEO = 4  # sign index of Leo (DELHI_BIRTH's natal Moon)
_GEMINI = 2  # sign index of Gemini (DELHI_BIRTH's lagna)


@pytest.mark.parametrize(
    ("rules", "yogakaraka", "expected"),
    [
        ([6, 11], False, FunctionalNature.MALEFIC),  # Mars for Gemini lagna
        ([8, 9], False, FunctionalNature.BENEFIC),  # a trikona lord, even with the 8th
        ([7, 10], False, FunctionalNature.MARAKA),  # 7th lord, no trikona
        ([1, 4], False, FunctionalNature.BENEFIC),  # the lagna lord
        ([1, 8], False, FunctionalNature.BENEFIC),  # lagna lord wins over the 8th
        ([2, 11], False, FunctionalNature.MALEFIC),  # 11th before the maraka rule
        ([2], False, FunctionalNature.MARAKA),
        ([4], False, FunctionalNature.NEUTRAL),  # a pure kendra lord
        ([], False, FunctionalNature.NEUTRAL),  # the nodes rule nothing
        ([4, 9], True, FunctionalNature.YOGAKARAKA),
    ],
)
def test_functional_nature(rules: list[int], yogakaraka: bool, expected: FunctionalNature) -> None:
    assert functional_nature(rules, is_yogakaraka=yogakaraka) is expected


@pytest.mark.parametrize(
    ("from_moon", "expected"),
    [
        (12, ["sade_sati_phase_1"]),
        (1, ["sade_sati_phase_2", "kantaka_shani"]),
        (2, ["sade_sati_phase_3"]),
        (4, ["kantaka_shani"]),
        (7, ["kantaka_shani"]),
        (10, ["kantaka_shani"]),
        (8, ["ashtama_shani"]),
        (5, []),
    ],
)
def test_saturn_tags_count_from_the_moon(from_moon: int, expected: list[str]) -> None:
    saturn_idx = (_LEO + from_moon - 1) % 12
    assert sky_tags(PlanetName.SATURN, saturn_idx, _LEO, _GEMINI) == expected


def test_jupiter_tag_names_its_house_from_the_moon() -> None:
    scorpio = 7
    assert sky_tags(PlanetName.JUPITER, scorpio, _LEO, _GEMINI) == ["jupiter_from_moon_4"]


def test_nodes_carry_no_tags_outside_the_dusthanas() -> None:
    """Gemini is the 11th from the Leo Moon and the 1st from the Gemini lagna."""
    assert sky_tags(PlanetName.RAHU, _GEMINI, _LEO, _GEMINI) == []


@pytest.mark.parametrize(
    ("graha", "sign_idx", "expected"),
    [
        (PlanetName.RAHU, 7, ["rahu_from_lagna_6"]),  # Scorpio: 6th from Gemini, 4th from Leo
        (PlanetName.KETU, 9, ["ketu_from_lagna_8", "ketu_from_moon_6"]),  # Capricorn
        (PlanetName.MARS, 3, ["mars_from_moon_12"]),  # Cancer: 2nd from Gemini, 12th from Leo
        (PlanetName.MARS, _LEO, ["mars_over_moon"]),  # Leo: 3rd from Gemini, the Moon's sign
        (PlanetName.MARS, _GEMINI, ["mars_over_lagna"]),  # Gemini: the lagna, 11th from Leo
        (PlanetName.MARS, 0, []),  # Aries: 11th from Gemini, 9th from Leo
    ],
)
def test_mars_and_nodes_tag_the_dusthanas_and_natal_points(
    graha: PlanetName, sign_idx: int, expected: list[str]
) -> None:
    assert sky_tags(graha, sign_idx, _LEO, _GEMINI) == expected


_S, _N, _C = TransitSeverity.SUPPORTIVE, TransitSeverity.NEUTRAL, TransitSeverity.CHALLENGING


@pytest.mark.parametrize(
    ("severities", "expected"),
    [
        ([_S, _N, _S], "supportive"),
        ([_C, _N], "challenging"),
        ([_S, _C], "mixed"),
        ([_N, _N], "mixed"),
    ],
)
def test_direction_reads_the_engine_severities(
    severities: list[TransitSeverity], expected: str
) -> None:
    assert theme_direction(severities) == expected


@pytest.mark.parametrize(
    ("agreeing", "expected"), [(3, "high"), (2, "medium"), (1, "low"), (0, "low")]
)
def test_confidence_counts_agreeing_techniques(agreeing: int, expected: str) -> None:
    assert confidence_for(agreeing) == expected


_NOON = datetime(2019, 5, 1, 12, tzinfo=UTC)  # a Wednesday


def test_panchang_waxing_eighth_tithi() -> None:
    """Elongation 84 deg: tithi 8 (Ashtami, shukla), karana 14 = Vishti, yoga 7."""
    p = panchang_at(_NOON, sun_longitude=0.0, moon_longitude=84.0, moon_nakshatra="Ardra")
    assert (p.tithi, p.tithi_name, p.paksha) == (8, "Ashtami", "shukla")
    assert (p.karana, p.yoga, p.nakshatra, p.vara) == ("Vishti", "Sukarma", "Ardra", "Wednesday")
    assert p.instant == _NOON


def test_panchang_new_moon_end_of_cycle() -> None:
    """Elongation 354 deg: tithi 30 (Amavasya, krishna), last karana Naga."""
    p = panchang_at(_NOON, sun_longitude=10.0, moon_longitude=4.0, moon_nakshatra="Ashwini")
    assert (p.tithi, p.tithi_name, p.paksha, p.karana) == (30, "Amavasya", "krishna", "Naga")
    assert p.yoga == "Priti"  # sum 14 deg: the second nitya yoga


def test_panchang_first_half_tithi_is_kimstughna() -> None:
    p = panchang_at(_NOON, sun_longitude=100.0, moon_longitude=100.5, moon_nakshatra="Pushya")
    assert (p.tithi, p.tithi_name, p.karana) == (1, "Pratipada", "Kimstughna")


def test_panchang_full_moon_and_krishna_pratipada() -> None:
    """174 deg is Purnima's second half (Bava); 181 deg is Krishna Pratipada (Balava)."""
    full = panchang_at(_NOON, sun_longitude=0.0, moon_longitude=174.0, moon_nakshatra="Chitra")
    waning = panchang_at(_NOON, sun_longitude=0.0, moon_longitude=181.0, moon_nakshatra="Chitra")
    assert (full.tithi, full.tithi_name, full.paksha, full.karana) == (
        15,
        "Purnima",
        "shukla",
        "Bava",
    )
    assert (waning.tithi, waning.tithi_name, waning.paksha) == (16, "Pratipada", "krishna")
    assert waning.karana == "Balava"


def test_no_sookshma_outside_the_maha_sequence() -> None:
    """An active chain shorter than four levels (instant outside the cycle) has none."""
    assert sookshma([]) is None


def test_no_yogini_before_birth() -> None:
    birth = datetime(1990, 1, 15, 12, tzinfo=UTC)
    natal = calculate_sidereal_context(birth, 28.6139, 77.209, reference_date=birth)
    assert yogini_span(natal, datetime(1980, 1, 1, tzinfo=UTC)) is None
