"""Unit tests for BPHS D60 Shashtiamsa and DivisionalChart detail (D1..D60)."""

from __future__ import annotations

import math

import pytest

from almamesh.constants.astrology import PlanetName, ZodiacSign
from almamesh.edge.chart_runtime import compute_varga_detail_payload
from almamesh.schemas.vargas import DivisionalChart
from almamesh.vargas.detail import (
    VargaPlanetInput,
    compute_varga_detail,
    varga_detail_from_wire,
)
from almamesh.vargas.shashtiamsa import _SHASHTIAMSA_TABLE, shashtiamsa_amsa


def test_shashtiamsa_table_has_sixty_bphs_entries_and_reverses_on_even_signs() -> None:
    assert len(_SHASHTIAMSA_TABLE) == 60
    saumya = sum(1 for _name, nature in _SHASHTIAMSA_TABLE if nature == "saumya")
    krura = sum(1 for _name, nature in _SHASHTIAMSA_TABLE if nature == "krura")
    assert (saumya, krura) == (33, 27)
    # Aries (odd sign 0): 0.1° -> 1st Ghora (krura); 29.8° -> 60th Chandrarekha (saumya).
    assert shashtiamsa_amsa(0.1) == shashtiamsa_amsa(360.1)
    assert (shashtiamsa_amsa(0.1).number, shashtiamsa_amsa(0.1).name) == (1, "Ghora")
    assert shashtiamsa_amsa(0.1).nature == "krura"
    assert (shashtiamsa_amsa(29.8).number, shashtiamsa_amsa(29.8).name) == (60, "Chandrarekha")
    # Taurus (even sign 1): 0.1° in Taurus (30.1°) -> 60th Chandrarekha; 59.8° -> 1st Ghora.
    assert (shashtiamsa_amsa(30.1).number, shashtiamsa_amsa(30.1).name) == (60, "Chandrarekha")
    assert (shashtiamsa_amsa(59.8).number, shashtiamsa_amsa(59.8).name) == (1, "Ghora")


def test_d9_and_d10_houses_dignities_and_vargottama() -> None:
    planets = {
        PlanetName.SUN: VargaPlanetInput(
            longitude=1.0
        ),  # Aries D1 & Aries D9 -> exalted + vargottama
        PlanetName.MOON: VargaPlanetInput(longitude=35.0),  # Taurus 5° -> Aquarius D9
        PlanetName.MARS: VargaPlanetInput(
            longitude=100.0, is_combust=True
        ),  # Cancer 10° -> Libra D9
        PlanetName.SATURN: VargaPlanetInput(longitude=2.0),  # Aries 2° -> Aries D9 (debilitated)
        PlanetName.JUPITER: VargaPlanetInput(longitude=241.0),  # Sagittarius 1° -> Aries D9
        PlanetName.MERCURY: VargaPlanetInput(longitude=61.0),  # Gemini 1° -> Libra D9
        PlanetName.VENUS: VargaPlanetInput(
            longitude=181.0
        ),  # Libra 1° -> Libra D9 (own + vargottama)
        PlanetName.RAHU: VargaPlanetInput(longitude=120.5),
        PlanetName.KETU: VargaPlanetInput(longitude=300.5),
    }
    d9 = compute_varga_detail(DivisionalChart.D9, lagna_longitude=1.5, planets=planets)
    assert d9.chart == "D9"
    assert d9.lagna_sign == ZodiacSign.ARIES
    assert d9.lagna_sign_lord == PlanetName.MARS
    assert d9.lagna_vargottama is True
    assert d9.lagna_shashtiamsa is None
    assert d9.sensitivity.nominal_window_minutes == pytest.approx(13.33, abs=0.01)
    assert d9.sensitivity.high_time_sensitivity is False

    sun = d9.placements[PlanetName.SUN]
    assert (sun.sign, sun.house, sun.dignity, sun.vargottama, sun.same_sign_as_d1) == (
        "Aries",
        1,
        "exalted",
        True,
        True,
    )
    saturn = d9.placements[PlanetName.SATURN]
    assert (saturn.sign, saturn.house, saturn.dignity) == ("Aries", 1, "debilitated")
    venus = d9.placements[PlanetName.VENUS]
    assert (venus.sign, venus.house, venus.dignity, venus.vargottama) == ("Libra", 7, "own", True)
    assert d9.placements[PlanetName.MARS].is_combust is True
    assert d9.placements[PlanetName.RAHU].dignity == "neutral"

    d10 = compute_varga_detail(DivisionalChart.D10, lagna_longitude=31.0, planets=planets)
    assert d10.lagna_sign == ZodiacSign.CAPRICORN  # Taurus (even) 1° -> 9th from Taurus = Capricorn
    assert d10.sensitivity.nominal_window_minutes == 12.0


def test_d30_unequal_trimsamsa_bounds_for_odd_and_even_signs() -> None:
    # Odd sign Aries at 11° falls in [10°, 18°] (width 8° = 32 min; margins 1° and 7° -> 4.0 min).
    odd = compute_varga_detail(DivisionalChart.D30, lagna_longitude=11.0, planets={})
    assert odd.sensitivity.nominal_window_minutes == 32.0
    assert (odd.sensitivity.margin_prev_deg, odd.sensitivity.margin_next_deg) == (1.0, 7.0)
    assert odd.sensitivity.approx_minutes_to_cusp == 4.0
    assert odd.sensitivity.high_time_sensitivity is False

    # Even sign Taurus at 41.2° (11.2° Taurus) falls in [5°, 12°] (width 7° = 28 min).
    even = compute_varga_detail(DivisionalChart.D30, lagna_longitude=41.2, planets={})
    assert even.sensitivity.nominal_window_minutes == 28.0
    assert even.sensitivity.margin_next_deg == pytest.approx(0.8, abs=1e-4)
    assert even.sensitivity.approx_minutes_to_cusp == pytest.approx(3.2, abs=1e-2)
    assert even.sensitivity.high_time_sensitivity is True


def test_d60_populates_shashtiamsa_and_flags_narrow_window_sensitivity() -> None:
    payload = {
        "chart": "D60",
        "lagna_longitude": 0.25,
        "planets": {
            "sun": {"longitude": 30.25, "is_combust": False},
            "moon": {"longitude": 14.75},
        },
    }
    detail = varga_detail_from_wire(payload)
    assert detail.lagna_shashtiamsa is not None
    assert (detail.lagna_shashtiamsa.number, detail.lagna_shashtiamsa.name) == (1, "Ghora")
    assert detail.sensitivity.nominal_window_minutes == 2.0
    assert detail.sensitivity.high_time_sensitivity is True
    sun_amsa = detail.placements[PlanetName.SUN].shashtiamsa
    assert sun_amsa is not None and sun_amsa.name == "Chandrarekha"
    dumped = compute_varga_detail_payload(payload)
    assert dumped["chart"] == "D60"
    assert dumped["lagna_shashtiamsa"] == {"number": 1, "name": "Ghora", "nature": "krura"}


@pytest.mark.parametrize(
    ("payload", "match"),
    [
        ({"chart": 9, "lagna_longitude": 10.0, "planets": {}}, "invalid chart"),
        ({"chart": "D99", "lagna_longitude": 10.0, "planets": {}}, "invalid chart"),
        ({"chart": "D9", "lagna_longitude": True, "planets": {}}, "lagna_longitude"),
        ({"chart": "D9", "lagna_longitude": math.nan, "planets": {}}, "lagna_longitude"),
        ({"chart": "D9", "lagna_longitude": 10.0, "planets": []}, "invalid planets"),
        (
            {"chart": "D9", "lagna_longitude": 10.0, "planets": {"pluto": {"longitude": 1.0}}},
            "planet",
        ),
        ({"chart": "D9", "lagna_longitude": 10.0, "planets": {"sun": "bad"}}, "planets entry"),
        (
            {"chart": "D9", "lagna_longitude": 10.0, "planets": {"sun": {"longitude": math.inf}}},
            "longitude",
        ),
        (
            {
                "chart": "D9",
                "lagna_longitude": 10.0,
                "planets": {"sun": {"longitude": 1.0, "is_combust": "yes"}},
            },
            "is_combust",
        ),
    ],
)
def test_wire_rejects_invalid_varga_detail_payloads(payload: dict[str, object], match: str) -> None:
    with pytest.raises(ValueError, match=match):
        varga_detail_from_wire(payload)
