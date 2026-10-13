"""Small shared helpers: sign keys, UTC dates, whole-sign houses, day-level cuts."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime
from typing import TYPE_CHECKING, Final, TypeVar, cast

from almamesh.constants.astrology import ZODIAC_SIGNS, PlanetName, ZodiacSign
from almamesh.transits.natal import whole_sign_house

if TYPE_CHECKING:
    from collections.abc import Iterable

    from almamesh.schemas.reading import SignKey
    from almamesh.schemas.strength import AshtakavargaContext

_T = TypeVar("_T")
_SUFFIXES: Final[dict[int, str]] = {1: "st", 2: "nd", 3: "rd"}


def sign_index_of(sign: ZodiacSign | str) -> int:
    """The 0..11 index of a sign value."""
    return ZODIAC_SIGNS.index(str(sign))


def sign_key(sign_idx: int) -> SignKey:
    """The lowercase wire key of the sign at ``sign_idx``."""
    return cast("SignKey", ZODIAC_SIGNS[sign_idx].lower())


def utc_date(when: datetime) -> date:
    """The UTC calendar date of an instant."""
    return when.astimezone(UTC).date()


def ordinal(house: int) -> str:
    """``1`` -> ``1st`` ... ``12`` -> ``12th`` (houses only)."""
    return f"{house}{_SUFFIXES.get(house, 'th')}"


def title(graha: PlanetName) -> str:
    """A graha's display name, e.g. ``Saturn``."""
    return graha.value.capitalize()


def one_per_day(cuts: Iterable[tuple[datetime, _T]], end: datetime) -> list[tuple[date, _T]]:
    """Chronological cuts collapsed to one per UTC day (the latest that day wins).

    No cut survives on the end day, so every resulting span is at least a day.
    """
    days: dict[date, _T] = {}
    for when, item in sorted(cuts, key=lambda cut: cut[0]):
        days[utc_date(when)] = item
    days.pop(utc_date(end), None)
    return sorted(days.items(), key=lambda day: day[0])


def span_bounds(days: list[date], end: datetime) -> list[tuple[date, date]]:
    """Consecutive [start, end) day pairs, the last one closing at ``end``."""
    return list(zip(days, [*days[1:], utc_date(end)], strict=True))


@dataclass(frozen=True)
class ReadingFrame:
    """The natal reference points every transit fact is counted from."""

    moon_idx: int
    lagna_idx: int
    ashtakavarga: AshtakavargaContext

    def from_moon(self, sign_idx: int) -> int:
        """Whole-sign house of ``sign_idx`` counted from the natal Moon."""
        return whole_sign_house(sign_idx, self.moon_idx)

    def from_lagna(self, sign_idx: int) -> int:
        """Whole-sign house of ``sign_idx`` counted from the natal lagna."""
        return whole_sign_house(sign_idx, self.lagna_idx)

    def sav(self, sign_idx: int) -> int:
        """Sarvashtakavarga bindus of a sign."""
        return self.ashtakavarga.sarva.bindus[ZodiacSign(ZODIAC_SIGNS[sign_idx])]

    def bav(self, graha: PlanetName, sign_idx: int) -> int | None:
        """The graha's own Bhinnashtakavarga bindus in a sign (None for the nodes)."""
        chart = self.ashtakavarga.bhinna.get(graha)
        return None if chart is None else chart.bindus[ZodiacSign(ZODIAC_SIGNS[sign_idx])]
