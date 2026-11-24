"""Exact sidereal Solar Return root-finder for Tajaka Varshaphala."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from almamesh.calculations import AyanamsaType, SkyfieldAstronomy, _resolve_ayanamsa, _to_utc
from almamesh.constants.astrology import PlanetName

SIDEREAL_YEAR_DAYS = 365.256363
_BRACKET_HALF_DAYS = 3.0
# 6 days / 2^38 < 2 milliseconds (~8e-8 deg Sun motion), avoiding zero-timedelta stalls.
_BISECT_ITERATIONS = 38
_MIN_EPHEMERIS_YEAR = 1900
_MAX_EPHEMERIS_YEAR = 2052


def _signed_angle_diff(current_lon: float, target_lon: float) -> float:
    """Signed angular separation (current - target) in (-180, +180] degrees."""
    return ((current_lon - target_lon + 180.0) % 360.0) - 180.0


def _sun_delta(
    astro: SkyfieldAstronomy,
    when: datetime,
    natal_sun_lon: float,
    ayanamsa_type: AyanamsaType,
) -> float:
    """Signed sidereal Sun offset from natal Sun longitude at `when`."""
    ayanamsa = _resolve_ayanamsa(astro, when, ayanamsa_type)
    sun_lon = astro.graha_sidereal_longitude(PlanetName.SUN, when, ayanamsa)
    return _signed_angle_diff(sun_lon, natal_sun_lon)


def _validate_target_year(birth_utc: datetime, target_year: int) -> int:
    """Ensure target_year is valid and stays inside DE421 coverage."""
    if target_year < birth_utc.year:
        raise ValueError("target_year must be >= birth year")
    if target_year < _MIN_EPHEMERIS_YEAR or target_year > _MAX_EPHEMERIS_YEAR:
        raise ValueError(
            f"target_year must be between {_MIN_EPHEMERIS_YEAR} and {_MAX_EPHEMERIS_YEAR}"
        )
    return target_year - birth_utc.year


def _same_sign(a: float, b: float) -> bool:
    """True when both residuals share the same sign (non-positive or positive)."""
    return (a <= 0.0) == (b <= 0.0)


def _bracket(
    astro: SkyfieldAstronomy,
    estimate: datetime,
    natal_sun_lon: float,
    ayanamsa_type: AyanamsaType,
) -> tuple[datetime, datetime, float]:
    """Build and verify an opposite-sign solar-return bracket around `estimate`."""
    lo = estimate - timedelta(days=_BRACKET_HALF_DAYS)
    hi = estimate + timedelta(days=_BRACKET_HALF_DAYS)
    f_lo = _sun_delta(astro, lo, natal_sun_lon, ayanamsa_type)
    f_hi = _sun_delta(astro, hi, natal_sun_lon, ayanamsa_type)
    if _same_sign(f_lo, f_hi):
        raise ValueError("solar return root is not bracketed within +/- 3 days of estimate")
    return lo, hi, f_lo


def find_solar_return_utc(
    astro: SkyfieldAstronomy,
    birth_dt: datetime,
    natal_sun_lon: float,
    target_year: int,
    ayanamsa_type: AyanamsaType = AyanamsaType.LAHIRI,
) -> datetime:
    """Find the exact UTC instant when sidereal Sun returns to `natal_sun_lon`."""
    birth_utc = _to_utc(birth_dt)
    completed = _validate_target_year(birth_utc, target_year)
    if completed == 0:
        return birth_utc

    estimate = birth_utc + timedelta(days=completed * SIDEREAL_YEAR_DAYS)
    lo, hi, f_lo = _bracket(astro, estimate, natal_sun_lon, ayanamsa_type)

    for _ in range(_BISECT_ITERATIONS):
        mid = lo + (hi - lo) / 2
        f_mid = _sun_delta(astro, mid, natal_sun_lon, ayanamsa_type)
        if _same_sign(f_lo, f_mid):
            lo, f_lo = mid, f_mid
        else:
            hi = mid

    return lo.astimezone(UTC)
