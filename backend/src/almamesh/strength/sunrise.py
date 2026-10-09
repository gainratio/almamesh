"""True civil sunrise/sunset bracketing the birth instant (Skyfield almanac).

Kalabala needs the real local sunrise and sunset at the birthplace, not a proxy.
We use Skyfield's ``almanac.sunrise_sunset`` over the DE421 ephemeris (the same
bytes the natal pipeline loads) so the result is deterministic and offline. This
module only READS astronomy — it never touches the natal pipeline.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Any, Final

from skyfield import almanac
from skyfield.api import wgs84

if TYPE_CHECKING:
    from almamesh.calculations import SkyfieldAstronomy

_LOOKBACK_HOURS: Final[int] = 30  # a full day of slack to bracket the prior sunrise
_AVG_YEAR_DAYS: Final[float] = 365.25  # BPHS Abda axis: one mean year back
_AVG_MONTH_DAYS: Final[float] = 30.4375  # BPHS Masa axis: one mean month back


@dataclass(frozen=True)
class SunWindow:
    """The sunrises the Kalabala time lords hang on, plus the birth-day sunset.

    Every instant is UTC. ``civil_offset`` is the birthplace's civil UTC offset
    at birth: a Vedic weekday is the CIVIL calendar date of the sunrise that
    opened the day, so the UTC date (wrong east of ~90 deg E) and the local
    mean solar date (wrong in the date-line zones, Samoa/Tonga/Kiribati, whose
    civil day runs ~24 h ahead of solar time) both name the wrong day.
    ``year_sunrise`` / ``month_sunrise`` open the Vedic days that contain the
    Abda / Masa epochs (birth-day sunrise minus one mean year / month).
    """

    sunrise: datetime
    sunset: datetime
    civil_offset: timedelta
    year_sunrise: datetime
    month_sunrise: datetime

    def _civil(self, instant: datetime) -> datetime:
        return instant.astimezone(timezone(self.civil_offset))

    @property
    def local_sunrise(self) -> datetime:
        """The birth-day sunrise on the birthplace's civil clock (aware)."""
        return self._civil(self.sunrise)

    @property
    def local_year_sunrise(self) -> datetime:
        """The sunrise opening the Abda epoch's Vedic day, civil clock."""
        return self._civil(self.year_sunrise)

    @property
    def local_month_sunrise(self) -> datetime:
        """The sunrise opening the Masa epoch's Vedic day, civil clock."""
        return self._civil(self.month_sunrise)


def _events(
    # Any: Skyfield's discrete-event arrays (`Time`, bool ndarray) are untyped at
    # the library boundary, exactly as `calculations.py` treats Skyfield `t`.
    astro: SkyfieldAstronomy,
    lat: float,
    lon: float,
    start: datetime,
    end: datetime,
) -> tuple[Any, Any]:
    """Sunrise/sunset event times + rise/set flags in [start, end]."""
    place = wgs84.latlon(lat, lon)
    t0, t1 = astro.ts.from_datetime(start), astro.ts.from_datetime(end)
    f = almanac.sunrise_sunset(astro.eph, place)
    times, is_rise = almanac.find_discrete(t0, t1, f)
    return times, is_rise


def _rise_times(times: Any, is_rise: Any, *, want_rise: bool) -> list[datetime]:
    """UTC datetimes of the sunrise (or sunset) events, in order."""
    return [
        t.utc_datetime() for t, rise in zip(times, is_rise, strict=True) if bool(rise) is want_rise
    ]


def _last_rise_before(times: Any, is_rise: Any, instant: datetime) -> datetime:
    """The most recent sunrise at or before the instant (its day's sunrise)."""
    rises = _rise_times(times, is_rise, want_rise=True)
    prior = [t for t in rises if t <= instant]
    return prior[-1] if prior else rises[0]


def _first_set_after(times: Any, is_rise: Any, sunrise: datetime) -> datetime:
    """The first sunset strictly after the day's sunrise."""
    after = [s for s in _rise_times(times, is_rise, want_rise=False) if s > sunrise]
    return after[0] if after else sunrise + timedelta(hours=12)


def _day_opening_sunrise(
    astro: SkyfieldAstronomy, instant: datetime, lat: float, lon: float
) -> datetime:
    """The sunrise that opened the Vedic day containing ``instant`` (UTC)."""
    span = timedelta(hours=_LOOKBACK_HOURS)
    times, is_rise = _events(astro, lat, lon, instant - span, instant + span)
    return _last_rise_before(times, is_rise, instant)


def sun_window(
    astro: SkyfieldAstronomy,
    birth_utc: datetime,
    lat: float,
    lon: float,
    *,
    civil_offset: timedelta,
) -> SunWindow:
    """Sunrise opening the birth day, its sunset, and the Abda/Masa epoch sunrises."""
    span = timedelta(hours=_LOOKBACK_HOURS)
    times, is_rise = _events(astro, lat, lon, birth_utc - span, birth_utc + span)
    sunrise = _last_rise_before(times, is_rise, birth_utc)
    year_epoch = sunrise - timedelta(days=_AVG_YEAR_DAYS)
    month_epoch = sunrise - timedelta(days=_AVG_MONTH_DAYS)
    return SunWindow(
        sunrise=sunrise,
        sunset=_first_set_after(times, is_rise, sunrise),
        civil_offset=civil_offset,
        year_sunrise=_day_opening_sunrise(astro, year_epoch, lat, lon),
        month_sunrise=_day_opening_sunrise(astro, month_epoch, lat, lon),
    )
