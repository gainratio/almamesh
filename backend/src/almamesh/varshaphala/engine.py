"""Tajaka Varshaphala (Annual Solar Return) orchestration and wire validator."""

from __future__ import annotations

import math
from collections.abc import Mapping
from datetime import datetime

from almamesh.calculations import (
    AyanamsaType,
    SkyfieldAstronomy,
    _to_utc,
    astronomy_scope,
    calculate_sidereal_context,
    validate_coordinates,
)
from almamesh.constants.astrology import SIGN_LORDS, ZODIAC_SIGNS, PlanetName, ZodiacSign
from almamesh.schemas.astrology import SiderealContext
from almamesh.schemas.varshaphala import MunthaInfo, VarshaphalaContext
from almamesh.varshaphala.mudda import compute_mudda_dasha
from almamesh.varshaphala.panchavargiya import compute_panchavargiya_bala, determine_varshesha
from almamesh.varshaphala.solar_return import find_solar_return_utc
from almamesh.varshaphala.yogas import detect_tajaka_yogas

# DE421 covers through 2053-10-09; capping Varshaphala target_year at 2051 ensures
# next_solar_return_utc (target_year + 1 = 2052) stays safely within ephemeris bounds
# for every birthday (including Dec 31 + 3d bracket).
MAX_VARSHAPHALA_YEAR = 2051


def is_day_varsha_chart(lagna_longitude: float, sun_longitude: float) -> bool:
    """True when the Sun is above the eastern-western horizon arc (0 < lagna - sun < 180)."""
    return 0.0 < ((lagna_longitude - sun_longitude) % 360.0) < 180.0


def _compute_muntha(
    natal: SiderealContext, varsha_chart: SiderealContext, completed_years: int
) -> MunthaInfo:
    """Compute progressed annual ascendant (Muntha) sign, lord, and Varsha house."""
    natal_lagna_idx = ZODIAC_SIGNS.index(natal.lagna.sign.value)
    varsha_lagna_idx = ZODIAC_SIGNS.index(varsha_chart.lagna.sign.value)
    muntha_idx = (natal_lagna_idx + completed_years) % 12
    muntha_sign = ZodiacSign(ZODIAC_SIGNS[muntha_idx])
    return MunthaInfo(
        sign=muntha_sign,
        sign_lord=SIGN_LORDS[muntha_sign],
        house_from_varsha_lagna=((muntha_idx - varsha_lagna_idx) % 12) + 1,
        natal_lagna_sign=natal.lagna.sign,
        completed_years=completed_years,
    )


def compute_varshaphala(
    birth_dt: datetime,
    latitude: float,
    longitude: float,
    target_year: int,
    *,
    reference_date: datetime,
    ayanamsa_type: AyanamsaType = AyanamsaType.LAHIRI,
    astronomy: SkyfieldAstronomy | None = None,
) -> VarshaphalaContext:
    """Compute a full deterministic Tajaka Varshaphala for `target_year`."""
    validate_coordinates(latitude, longitude)
    birth_utc = _to_utc(birth_dt)
    ref_utc = _to_utc(reference_date)
    if target_year > MAX_VARSHAPHALA_YEAR:
        raise ValueError(
            f"target_year must be <= {MAX_VARSHAPHALA_YEAR} for full solar year bounds"
        )
    completed_years = target_year - birth_utc.year

    with astronomy_scope(astronomy) as astro:
        natal = calculate_sidereal_context(
            birth_utc,
            latitude,
            longitude,
            ayanamsa_type=ayanamsa_type,
            reference_date=ref_utc,
            astronomy=astro,
        )
        natal_sun_lon = natal.planets[PlanetName.SUN].longitude
        sr_utc = find_solar_return_utc(astro, birth_utc, natal_sun_lon, target_year, ayanamsa_type)
        next_sr_utc = find_solar_return_utc(
            astro, birth_utc, natal_sun_lon, target_year + 1, ayanamsa_type
        )
        varsha_chart = calculate_sidereal_context(
            sr_utc,
            latitude,
            longitude,
            ayanamsa_type=ayanamsa_type,
            reference_date=ref_utc,
            astronomy=astro,
        )

    is_day = is_day_varsha_chart(
        varsha_chart.lagna.longitude, varsha_chart.planets[PlanetName.SUN].longitude
    )
    muntha = _compute_muntha(natal, varsha_chart, completed_years)
    strengths = compute_panchavargiya_bala(varsha_chart)
    varshesha, candidates = determine_varshesha(
        natal, varsha_chart, muntha.sign_lord, is_day, strengths
    )
    mudda = compute_mudda_dasha(
        natal.planets[PlanetName.MOON].longitude, completed_years, sr_utc, next_sr_utc, ref_utc
    )
    return VarshaphalaContext(
        target_year=target_year,
        completed_years=completed_years,
        solar_return_utc=sr_utc,
        next_solar_return_utc=next_sr_utc,
        ayanamsa_type=ayanamsa_type.value,
        ayanamsa_value=varsha_chart.ayanamsa_value,
        natal_sun_longitude=natal_sun_lon,
        return_sun_longitude=varsha_chart.planets[PlanetName.SUN].longitude,
        is_day_chart=is_day,
        varsha_chart=varsha_chart,
        muntha=muntha,
        varshesha=varshesha,
        varshesha_candidates=candidates,
        panchavargiya_bala=strengths,
        mudda_dasha=mudda,
        tajaka_yogas=detect_tajaka_yogas(varsha_chart),
    )


def _wire_float(value: object, field: str) -> float:
    """Parse one finite wire number, rejecting booleans and nulls."""
    if isinstance(value, bool) or not isinstance(value, str | int | float):
        raise ValueError(f"invalid numeric field: {field}")
    parsed = float(value)
    if not math.isfinite(parsed):
        raise ValueError(f"invalid numeric field: {field}")
    return parsed


def _wire_int(value: object, field: str) -> int:
    """Parse one integer wire field, rejecting booleans and floats."""
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"invalid integer field: {field}")
    return value


def _wire_ayanamsa(value: object) -> AyanamsaType:
    """Parse optional ayanamsa_type wire field, defaulting to LAHIRI."""
    if value is None:
        return AyanamsaType.LAHIRI
    if not isinstance(value, str):
        raise ValueError("invalid ayanamsa_type: expected string")
    return AyanamsaType(value)


def varshaphala_from_wire(payload: Mapping[str, object]) -> VarshaphalaContext:
    """Validate snake_case wire payload and compute VarshaphalaContext."""
    return compute_varshaphala(
        datetime.fromisoformat(str(payload["datetime_utc"])),
        _wire_float(payload["latitude"], "latitude"),
        _wire_float(payload["longitude"], "longitude"),
        _wire_int(payload["target_year"], "target_year"),
        reference_date=datetime.fromisoformat(str(payload["reference_date"])),
        ayanamsa_type=_wire_ayanamsa(payload.get("ayanamsa_type")),
    )
