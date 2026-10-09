"""The Vedic day (vara) starts at LOCAL sunrise and takes the LOCAL weekday.

THE BUG: ``vara_lord`` read ``sunrise.weekday()`` off the sunrise as a UTC
datetime. East of roughly 90 degrees E, local sunrise falls on the PREVIOUS UTC
calendar day (Sydney's 05:50 AEDT sunrise is 18:50 UTC the day before), so every
birth in Australia, New Zealand and Japan got the weekday lord of the day
before — and the hora lord, which starts from the weekday lord, was wrong too.

These tests pin the rule end-to-end through ``compute_shadbala``:
  * the weekday lord is the lord of the LOCAL civil date of the sunrise;
  * a birth after local midnight but before sunrise belongs to the previous day;
  * the first hora after sunrise is ruled by the weekday lord.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta, timezone

import pytest

from almamesh.calculations import SkyfieldAstronomy, calculate_sidereal_context
from almamesh.constants.astrology import PlanetName
from almamesh.schemas.strength import ShadbalaContext
from almamesh.strength.shadbala import compute_shadbala
from almamesh.strength.sunrise import sun_window

_REFERENCE = datetime(2025, 1, 1, tzinfo=UTC)

_SYDNEY = (-33.8688, 151.2093, timezone(timedelta(hours=11)))  # AEDT in January
_AUCKLAND = (-36.8485, 174.7633, timezone(timedelta(hours=13)))  # NZDT in January
_BENGALURU = (12.9716, 77.5946, timezone(timedelta(hours=5, minutes=30)))
_LOS_ANGELES = (34.0522, -118.2437, timezone(timedelta(hours=-8)))

# 2024-01-10 is a Wednesday (Mercury); 2024-01-09 a Tuesday (Mars).
_WED, _TUE = PlanetName.MERCURY, PlanetName.MARS


def _shadbala(local: datetime, lat: float, lon: float) -> ShadbalaContext:
    natal = calculate_sidereal_context(local, lat, lon, reference_date=_REFERENCE)
    return compute_shadbala(natal, local.astimezone(UTC), lat, lon)


def _awarded(ctx: ShadbalaContext, part: str) -> PlanetName:
    """The single graha that received this time-lord award."""
    winners = [p for p, row in ctx.planets.items() if getattr(row.kala, part).virupas > 0]
    assert len(winners) == 1, winners
    return winners[0]


@pytest.mark.parametrize(
    ("label", "place", "clock", "expected"),
    [
        ("Sydney mid-morning", _SYDNEY, (10, 0), _WED),
        ("Sydney just after midnight, before sunrise", _SYDNEY, (0, 30), _TUE),
        ("Auckland morning", _AUCKLAND, (9, 0), _WED),
        ("Bengaluru before sunrise (control)", _BENGALURU, (5, 0), _TUE),
        ("Los Angeles evening (control)", _LOS_ANGELES, (20, 0), _WED),
    ],
)
def test_should_take_weekday_lord_from_local_sunrise_day_when_birth_is_anywhere(
    label: str,
    place: tuple[float, float, timezone],
    clock: tuple[int, int],
    expected: PlanetName,
) -> None:
    # Given a local birth on 2024-01-10
    lat, lon, tz = place
    local = datetime(2024, 1, 10, clock[0], clock[1], tzinfo=tz)
    # When Shadbala is computed / Then Varabala goes to that sunrise-day's lord
    assert _awarded(_shadbala(local, lat, lon), "vara") == expected, label


def _local_sunrise(lat: float, lon: float, tz: timezone) -> datetime:
    """The civil sunrise of 2024-01-10 at the place, as an aware UTC datetime."""
    noon = datetime(2024, 1, 10, 12, 0, tzinfo=tz).astimezone(UTC)
    return sun_window(SkyfieldAstronomy(), noon, lat, lon).sunrise


def test_should_split_vedic_day_at_local_sunrise_when_birth_straddles_it() -> None:
    # Given the Sydney sunrise of 2024-01-10
    lat, lon, tz = _SYDNEY
    sunrise = _local_sunrise(lat, lon, tz)
    assert sunrise.astimezone(tz).date().isoformat() == "2024-01-10"
    # When births fall two minutes either side of it
    before = _shadbala(sunrise - timedelta(minutes=2), lat, lon)
    after = _shadbala(sunrise + timedelta(minutes=2), lat, lon)
    # Then the earlier belongs to Tuesday, the later to Wednesday
    assert _awarded(before, "vara") == _TUE
    assert _awarded(after, "vara") == _WED


def test_should_rule_first_hora_by_weekday_lord_when_birth_follows_local_sunrise() -> None:
    # Given the Sydney sunrise of 2024-01-10
    lat, lon, tz = _SYDNEY
    sunrise = _local_sunrise(lat, lon, tz)
    # When the birth is five minutes after it
    ctx = _shadbala(sunrise + timedelta(minutes=5), lat, lon)
    # Then the first hora is Wednesday's lord
    assert _awarded(ctx, "hora") == _WED


def test_should_reckon_month_lord_on_local_calendar_when_epoch_crosses_utc_midnight() -> None:
    """Masa epoch = local sunrise - 30.4375 days, read on the LOCAL calendar.

    New York 1990-01-15: local sunrise ~07:24 local mean time, so the epoch is
    1989-12-15 ~20:54 local (a Friday -> Venus). Read in UTC the same instant is
    1989-12-16 01:50, a Saturday -> Saturn: the UTC reading names the wrong day.
    """
    # Given a New York noon birth
    lat, lon = 40.7128, -74.006
    local = datetime(1990, 1, 15, 12, 0, tzinfo=timezone(timedelta(hours=-5)))
    # When Shadbala is computed / Then Masabala goes to Friday's lord
    assert _awarded(_shadbala(local, lat, lon), "masa") == PlanetName.VENUS
