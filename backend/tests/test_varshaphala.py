"""Deterministic unit tests for Tajaka Varshaphala (Annual Solar Return)."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from almamesh.calculations import AyanamsaType, calculate_sidereal_context
from almamesh.constants.astrology import ZODIAC_SIGNS, PlanetName
from almamesh.edge.chart_runtime import compute_varshaphala_payload
from almamesh.varshaphala import compute_varshaphala
from almamesh.varshaphala.engine import is_day_varsha_chart
from almamesh.varshaphala.yogas import detect_tajaka_yogas

BIRTH_UTC = datetime(1990, 5, 15, 6, 30, tzinfo=UTC)
LAT = 28.6139
LON = 77.2090
REF_UTC = datetime(2026, 8, 1, 0, 0, tzinfo=UTC)


def test_varshaphala_solar_return_matches_natal_sun_precisely() -> None:
    """Sidereal Sun at solar_return_utc matches natal Sun to < 0.001 degrees."""
    result = compute_varshaphala(BIRTH_UTC, LAT, LON, 2026, reference_date=REF_UTC)

    diff = abs(((result.return_sun_longitude - result.natal_sun_longitude + 180.0) % 360.0) - 180.0)
    assert diff < 0.001
    assert result.completed_years == 36
    assert result.solar_return_utc.year == 2026
    assert result.next_solar_return_utc.year == 2027
    year_days = (result.next_solar_return_utc - result.solar_return_utc).total_seconds() / 86400.0
    assert 365.2 < year_days < 365.35


def test_varshaphala_muntha_advances_one_sign_per_completed_year() -> None:
    """Muntha progresses exactly (natal_lagna + completed_years) % 12."""
    r2026 = compute_varshaphala(BIRTH_UTC, LAT, LON, 2026, reference_date=REF_UTC)
    r2027 = compute_varshaphala(BIRTH_UTC, LAT, LON, 2027, reference_date=REF_UTC)

    idx_2026 = ZODIAC_SIGNS.index(r2026.muntha.sign.value)
    idx_2027 = ZODIAC_SIGNS.index(r2027.muntha.sign.value)
    assert (idx_2026 + 1) % 12 == idx_2027
    assert 1 <= r2026.muntha.house_from_varsha_lagna <= 12


def test_varshaphala_panchavargiya_and_varshesha_bounds() -> None:
    """All 7 classical planets have 0..20 Panchavargiya Bala and Varshesha is a candidate."""
    result = compute_varshaphala(BIRTH_UTC, LAT, LON, 2026, reference_date=REF_UTC)

    assert len(result.panchavargiya_bala) == 7
    for bala in result.panchavargiya_bala.values():
        assert 0.0 <= bala.total <= 20.0
    candidate_grahas = {c.graha for c in result.varshesha_candidates}
    assert result.varshesha in candidate_grahas


def test_varshaphala_mudda_dasha_tiles_exact_solar_year() -> None:
    """9 Mudda Dasha periods tile [solar_return_utc, next_solar_return_utc] with one active."""
    result = compute_varshaphala(BIRTH_UTC, LAT, LON, 2026, reference_date=REF_UTC)

    assert len(result.mudda_dasha) == 9
    assert result.mudda_dasha[0].start_utc == result.solar_return_utc
    assert result.mudda_dasha[-1].end_utc == result.next_solar_return_utc
    for prev, nxt in zip(result.mudda_dasha, result.mudda_dasha[1:], strict=False):
        assert prev.end_utc == nxt.start_utc
    assert sum(1 for p in result.mudda_dasha if p.is_current) == 1


def test_varshaphala_supports_custom_ayanamsa_and_wire_payload() -> None:
    """Wire entrypoint is deterministic and honors non-Lahiri ayanamsas."""
    payload = {
        "datetime_utc": BIRTH_UTC.isoformat(),
        "latitude": LAT,
        "longitude": LON,
        "target_year": 2026,
        "reference_date": REF_UTC.isoformat(),
        "ayanamsa_type": AyanamsaType.KP.value,
    }
    first = compute_varshaphala_payload(payload)
    second = compute_varshaphala_payload(payload)
    assert first == second
    assert first["ayanamsa_type"] == "KP"


def test_varshaphala_rejects_invalid_target_year() -> None:
    """Fail-closed when target_year precedes birth year or exceeds 2051."""
    with pytest.raises(ValueError, match="target_year"):
        compute_varshaphala(BIRTH_UTC, LAT, LON, 1989, reference_date=REF_UTC)
    with pytest.raises(ValueError, match="target_year"):
        compute_varshaphala(BIRTH_UTC, LAT, LON, 2052, reference_date=REF_UTC)


def test_varshaphala_2051_succeeds_for_december_birthday() -> None:
    """Target year 2051 (with next solar return in late Dec 2052) stays inside DE421."""
    dec_birth = datetime(1990, 12, 30, 12, 0, tzinfo=UTC)
    result = compute_varshaphala(
        dec_birth, LAT, LON, 2051, reference_date=datetime(2052, 6, 1, tzinfo=UTC)
    )
    assert result.target_year == 2051
    assert result.next_solar_return_utc.year == 2052


def test_is_day_varsha_chart_handles_same_sign_morning_and_evening() -> None:
    """Horizon arc classifies morning Sun in H1 as day and post-sunset Sun in H7 as night."""
    # Morning just after sunrise: Lagna 15 deg Aries, Sun 10 deg Aries (above eastern horizon).
    assert is_day_varsha_chart(15.0, 10.0) is True
    # Pre-sunrise in H1: Lagna 15 deg Aries, Sun 20 deg Aries (below eastern horizon).
    assert is_day_varsha_chart(15.0, 20.0) is False
    # Post-sunset in H7: Lagna 15 deg (Desc 195 deg), Sun 190 deg (below western horizon).
    assert is_day_varsha_chart(15.0, 190.0) is False
    # Pre-sunset in H7: Lagna 15 deg (Desc 195 deg), Sun 196 deg (above western horizon).
    assert is_day_varsha_chart(15.0, 196.0) is True


def test_tajaka_yogas_handle_cross_cusp_partile_and_retrograde() -> None:
    """Cross-sign conjunctions, exact 0.0 deg partile, and retrograde Vakra Ithasala all work."""
    base = calculate_sidereal_context(BIRTH_UTC, LAT, LON, reference_date=REF_UTC)
    planets = dict(base.planets)
    # Cross-sign Bhavishyat Ithasala: Moon 29.5 Aries (+13) applying to Sun 0.5 Taurus (+1).
    planets[PlanetName.MOON] = planets[PlanetName.MOON].model_copy(
        update={"longitude": 29.5, "sign_degrees": 29.5, "speed": 13.0, "is_retrograde": False}
    )
    planets[PlanetName.SUN] = planets[PlanetName.SUN].model_copy(
        update={"longitude": 30.5, "sign_degrees": 0.5, "speed": 1.0, "is_retrograde": False}
    )
    # Exact 0.0 deg partile Purna Ithasala: Venus and Mars both at 120.0.
    planets[PlanetName.VENUS] = planets[PlanetName.VENUS].model_copy(
        update={"longitude": 120.0, "sign_degrees": 0.0, "speed": 1.2, "is_retrograde": False}
    )
    planets[PlanetName.MARS] = planets[PlanetName.MARS].model_copy(
        update={"longitude": 120.0, "sign_degrees": 0.0, "speed": 0.6, "is_retrograde": False}
    )
    # Retrograde Vakra Ithasala: Mercury Rx 212.0 (-1.0) applying backward to Jupiter 210.0 (+0.1).
    planets[PlanetName.MERCURY] = planets[PlanetName.MERCURY].model_copy(
        update={"longitude": 212.0, "sign_degrees": 2.0, "speed": -1.0, "is_retrograde": True}
    )
    planets[PlanetName.JUPITER] = planets[PlanetName.JUPITER].model_copy(
        update={"longitude": 210.0, "sign_degrees": 0.0, "speed": 0.1, "is_retrograde": False}
    )
    patched = base.model_copy(update={"planets": planets})
    yogas = {(y.faster_planet, y.slower_planet): y for y in detect_tajaka_yogas(patched)}

    moon_sun = yogas[(PlanetName.MOON, PlanetName.SUN)]
    assert moon_sun.name == "Ithasala"
    assert moon_sun.aspect_type == "conjunction"
    assert moon_sun.orb_degrees == 1.0

    venus_mars = yogas[(PlanetName.VENUS, PlanetName.MARS)]
    assert venus_mars.name == "Ithasala"
    assert venus_mars.orb_degrees == 0.0
    assert venus_mars.deep_orb is True

    merc_jup = yogas[(PlanetName.MERCURY, PlanetName.JUPITER)]
    assert merc_jup.name == "Ithasala"
    assert merc_jup.orb_degrees == 2.0
