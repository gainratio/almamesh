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
_DEGREES_PER_HOUR: Final[float] = 15.0  # Earth turns 15 deg of longitude per hour


@dataclass(frozen=True)
class SunWindow:
    """The civil sunrise that opened the birth day and the following sunset (UTC).

    ``longitude`` is kept so the Vedic weekday can be read off the LOCAL date of
    the sunrise: east of ~90 deg E a local morning sunrise is still the previous
    day in UTC, so ``sunrise.weekday()`` alone names the wrong day.
    """

    sunrise: datetime
    sunset: datetime
    longitude: float

    @property
    def local_sunrise(self) -> datetime:
        """The sunrise in local mean solar time at the birthplace (aware).

        The Vedic day is astronomical (sunrise to sunrise at the place), so its
        weekday is the date of the sunrise in local solar time. Local mean time
        is exact here: civil sunrise lies hours from local midnight at every
        latitude with a sunrise, so no civil-zone rule can move it across a date
        line. It also needs no timezone database inside the engine.
        """
        offset = timedelta(hours=self.longitude / _DEGREES_PER_HOUR)
        return self.sunrise.astimezone(timezone(offset))


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


def sun_window(astro: SkyfieldAstronomy, birth_utc: datetime, lat: float, lon: float) -> SunWindow:
    """Civil sunrise opening the birth day and the following sunset (UTC, rigorous)."""
    start = birth_utc - timedelta(hours=_LOOKBACK_HOURS)
    end = birth_utc + timedelta(hours=_LOOKBACK_HOURS)
    times, is_rise = _events(astro, lat, lon, start, end)
    sunrise = _last_rise_before(times, is_rise, birth_utc)
    sunset = _first_set_after(times, is_rise, sunrise)
    return SunWindow(sunrise=sunrise, sunset=sunset, longitude=lon)
