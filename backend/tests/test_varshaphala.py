"""Deterministic unit tests for Tajaka Varshaphala (Annual Solar Return)."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from almamesh.calculations import AyanamsaType
from almamesh.constants.astrology import ZODIAC_SIGNS
from almamesh.edge.chart_runtime import compute_varshaphala_payload
from almamesh.varshaphala import compute_varshaphala

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
    """Fail-closed when target_year precedes birth year or exceeds DE421."""
    with pytest.raises(ValueError, match="target_year"):
        compute_varshaphala(BIRTH_UTC, LAT, LON, 1989, reference_date=REF_UTC)
    with pytest.raises(ValueError, match="target_year"):
        compute_varshaphala(BIRTH_UTC, LAT, LON, 2060, reference_date=REF_UTC)
