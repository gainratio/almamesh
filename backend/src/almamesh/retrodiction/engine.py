"""The one seam to the chart engine: a natal frame and per-month skies for one native.

Reads only public engine calculations (natal context, Vimshottari depth, Yogini
periods, transit longitudes). Month skies are cached, so overlapping event windows
of the same native cost one ephemeris read per month.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import TYPE_CHECKING, Final

from almamesh.calculations import calculate_sidereal_context
from almamesh.constants.astrology import PlanetName
from almamesh.dasha.depth import level_spans
from almamesh.dasha.yogini import compute_yogini_periods
from almamesh.retrodiction.indicators import SKY_GRAHAS, MonthSky, NatalFrame
from almamesh.transits.natal import natal_lagna_index, natal_moon_index, sign_index
from almamesh.transits.positions import EPHEMERIS_LAST_INSTANT, transit_longitude

if TYPE_CHECKING:
    from almamesh.calculations import SkyfieldAstronomy
    from almamesh.dasha.models import YoginiPeriod
    from almamesh.retrodiction.events import Birth
    from almamesh.schemas.astrology import SiderealContext

YearMonth = tuple[int, int]

# The Lahiri table (resources/lahiri_ayanamsa.txt) starts here; the engine fails closed
# before it, so a native born earlier cannot be charted at all.
ENGINE_FIRST_INSTANT: Final[datetime] = datetime(1900, 1, 1, tzinfo=UTC)
OUT_OF_RANGE_BIRTH: Final[str] = "birth before 1900, outside the engine's ayanamsa table"


def birth_in_range(birth: Birth) -> bool:
    """The engine can chart this birth (it is not before the ayanamsa table)."""
    return birth.datetime.astimezone(UTC) >= ENGINE_FIRST_INSTANT


def month_start(ym: YearMonth) -> datetime:
    """00:00 UTC on the 1st."""
    return datetime(ym[0], ym[1], 1, tzinfo=UTC)


def add_months(ym: YearMonth, delta: int) -> YearMonth:
    """``ym`` shifted by ``delta`` months."""
    index = ym[0] * 12 + ym[1] - 1 + delta
    return index // 12, index % 12 + 1


def _natal_frame(natal: SiderealContext) -> NatalFrame:
    """Lagna and Moon signs, lordships and occupancy from the natal context."""
    return NatalFrame(
        lagna_idx=natal_lagna_index(natal),
        moon_idx=natal_moon_index(natal),
        rulers={g: frozenset(p.houses_ruled) for g, p in natal.planets.items()},
        occupied={g: p.house for g, p in natal.planets.items()},
    )


class SubjectEngine:
    """Natal frame plus cached month skies for one native."""

    def __init__(self, birth: Birth, astronomy: SkyfieldAstronomy) -> None:
        self._birth_utc = birth.datetime.astimezone(UTC)
        self._astronomy = astronomy
        self._natal = calculate_sidereal_context(
            self._birth_utc,
            birth.latitude,
            birth.longitude,
            reference_date=self._birth_utc,
            astronomy=astronomy,
        )
        mahas = self._natal.dashas.maha_dasha_sequence
        self._dasha_end = mahas[-1].end_date
        self._yogini = compute_yogini_periods(self._natal, mahas[0].start_date, self._dasha_end)
        self.frame = _natal_frame(self._natal)
        self._skies: dict[YearMonth, MonthSky] = {}

    def covers(self, ym: YearMonth) -> bool:
        """The whole month lies after birth, inside the dashas and the ephemeris."""
        end = month_start(add_months(ym, 1))
        return month_start(ym) >= self._birth_utc and end <= min(
            EPHEMERIS_LAST_INSTANT, self._dasha_end
        )

    def month(self, ym: YearMonth) -> MonthSky:
        """The month's sky (cached)."""
        if ym not in self._skies:
            self._skies[ym] = self._compute(ym)
        return self._skies[ym]

    def _compute(self, ym: YearMonth) -> MonthSky:
        start, end = month_start(ym), month_start(add_months(ym, 1))
        mid = datetime(ym[0], ym[1], 15, 12, tzinfo=UTC)
        spans = level_spans(self._natal.dashas.maha_dasha_sequence, start, end)
        running = tuple(frozenset(p.lord for p in periods) for periods in spans.values())
        return MonthSky(
            running=running, yogini_lord=_yogini_lord(self._yogini, mid), signs=self._signs(mid)
        )

    def _signs(self, mid: datetime) -> dict[PlanetName, int]:
        signs = {g: sign_index(transit_longitude(self._astronomy, g, mid)) for g in SKY_GRAHAS}
        signs[PlanetName.KETU] = (signs[PlanetName.RAHU] + 6) % 12
        return signs


def _yogini_lord(periods: list[YoginiPeriod], instant: datetime) -> PlanetName | None:
    """The Yogini maha lord running at ``instant``."""
    return next((p.lord for p in periods if p.start_date <= instant < p.end_date), None)


__all__ = [
    "ENGINE_FIRST_INSTANT",
    "OUT_OF_RANGE_BIRTH",
    "SubjectEngine",
    "YearMonth",
    "add_months",
    "birth_in_range",
    "month_start",
]
