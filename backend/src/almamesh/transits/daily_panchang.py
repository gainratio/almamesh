"""Daily Panchang, Tarabala, and Chandrabala marks across a multi-day Moon window."""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from datetime import date, datetime
from typing import Final, Literal

from pydantic import BaseModel, ConfigDict

from almamesh.calculations import SkyfieldAstronomy, get_nakshatra_info
from almamesh.constants.astrology import NAKSHATRA_NAMES, PlanetName, ZodiacSign
from almamesh.reading.panchang import panchang_at
from almamesh.schemas.reading import Panchang
from almamesh.transits.positions import transit_longitude

_SIGNS: Final[tuple[ZodiacSign, ...]] = tuple(ZodiacSign)
_NAKSHATRA_INDEX: Final[dict[str, int]] = {name: idx for idx, name in enumerate(NAKSHATRA_NAMES)}
_VALID_VARAS: Final[frozenset[str]] = frozenset(
    ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")
)  # fmt: skip
_TARA_NAMES: Final[tuple[str, ...]] = (
    "Janma", "Sampat", "Vipat", "Kshema", "Pratyak",
    "Sadhana", "Naidhana", "Mitra", "Parama Mitra",
)  # fmt: skip
_SUPPORTIVE_CHANDRA_HOUSES: Final[frozenset[int]] = frozenset((1, 3, 6, 7, 10, 11))
_CHANDRASHTAMA_HOUSE: Final[int] = 8
_SUPPORTIVE_TARAS: Final[frozenset[int]] = frozenset((2, 4, 6, 8, 9))
_CHALLENGING_TARAS: Final[frozenset[int]] = frozenset((3, 5, 7))
_MAX_DAYS: Final[int] = 15

DayQuality = Literal["supportive", "mixed", "caution"]
InstantParser = Callable[[object, str], datetime]
_OverlayTuple = tuple[int | None, int | None, str | None, DayQuality | None]

_QUALITY_BY_FLAGS: Final[dict[tuple[bool, bool, bool], DayQuality]] = {
    (True, True, False): "supportive",
    (False, False, True): "caution",
}


class DayInstantInput(BaseModel):
    model_config = ConfigDict(frozen=True)
    date: str
    when: datetime
    vara: str | None = None


class NatalMoonRef(BaseModel):
    model_config = ConfigDict(frozen=True)
    sign: ZodiacSign
    nakshatra: str


class DayPanchangMark(BaseModel):
    model_config = ConfigDict(frozen=True)
    date: str
    vara: str
    sign: ZodiacSign
    nakshatra: str
    pada: int
    nakshatra_lord: PlanetName
    tithi: int
    tithi_name: str
    paksha: Literal["shukla", "krishna"]
    yoga: str
    karana: str
    house_from_moon: int | None = None
    tara_number: int | None = None
    tara_name: str | None = None
    day_quality: DayQuality | None = None


def _day_quality(house_from_moon: int, tara_number: int) -> DayQuality:
    if house_from_moon == _CHANDRASHTAMA_HOUSE:
        return "caution"
    flags = (
        house_from_moon in _SUPPORTIVE_CHANDRA_HOUSES,
        tara_number in _SUPPORTIVE_TARAS,
        tara_number in _CHALLENGING_TARAS,
    )
    return _QUALITY_BY_FLAGS.get(flags, "mixed")


def _natal_overlay(
    moon_sign: ZodiacSign, moon_nakshatra: str, natal_moon: NatalMoonRef | None
) -> _OverlayTuple:
    if natal_moon is None:
        return None, None, None, None
    house = ((_SIGNS.index(moon_sign) - _SIGNS.index(natal_moon.sign)) % 12) + 1
    delta = (_NAKSHATRA_INDEX[moon_nakshatra] - _NAKSHATRA_INDEX[natal_moon.nakshatra]) % 27
    tara_num = (delta % 9) + 1
    return house, tara_num, _TARA_NAMES[tara_num - 1], _day_quality(house, tara_num)


def _sky_limbs(
    astro: SkyfieldAstronomy, when: datetime
) -> tuple[ZodiacSign, tuple[str, int, PlanetName], Panchang]:
    sun_lon = transit_longitude(astro, PlanetName.SUN, when)
    moon_lon = transit_longitude(astro, PlanetName.MOON, when)
    nak = get_nakshatra_info(moon_lon)
    snap = panchang_at(when, sun_longitude=sun_lon, moon_longitude=moon_lon, moon_nakshatra=nak[0])
    return _SIGNS[int((moon_lon % 360.0) // 30.0)], nak, snap


def compute_day_mark(
    astro: SkyfieldAstronomy,
    start: datetime,
    end: datetime,
    day: DayInstantInput,
    natal_moon: NatalMoonRef | None = None,
) -> DayPanchangMark:
    if not start <= day.when <= end:
        raise ValueError(f"invalid day {day.date}: instant is outside the place bounds")
    sign, (nak_name, pada, lord), snap = _sky_limbs(astro, day.when)
    limbs = snap.model_dump(include={"tithi", "tithi_name", "paksha", "yoga", "karana"})
    house, tara_num, tara_name, quality = _natal_overlay(sign, nak_name, natal_moon)
    return DayPanchangMark(
        date=day.date, vara=day.vara or snap.vara, sign=sign, nakshatra=nak_name, pada=pada,
        nakshatra_lord=lord, house_from_moon=house, tara_number=tara_num, tara_name=tara_name,
        day_quality=quality, **limbs,
    )  # fmt: skip


def _wire_vara(raw: object) -> str | None:
    if raw is None:
        return None
    if not isinstance(raw, str) or raw not in _VALID_VARAS:
        raise ValueError("invalid day vara: must be an English weekday name")
    return raw


def _wire_date_str(raw: object) -> str:
    if not isinstance(raw, str) or len(raw) != 10:
        raise ValueError("invalid day date: must be YYYY-MM-DD")
    try:
        date.fromisoformat(raw)
    except ValueError as error:
        raise ValueError("invalid day date: must be YYYY-MM-DD") from error
    return raw


def _parse_day_entry(idx: int, entry: object, parse_instant: InstantParser) -> DayInstantInput:
    if not isinstance(entry, Mapping):
        raise ValueError(f"invalid days[{idx}]: must be an object")
    return DayInstantInput(
        date=_wire_date_str(entry.get("date")),
        when=parse_instant(entry.get("datetime_utc"), f"days[{idx}] datetime_utc"),
        vara=_wire_vara(entry.get("vara")),
    )


def _check_days_seq(raw_days: object) -> Sequence[object]:
    if not isinstance(raw_days, Sequence) or isinstance(raw_days, str):
        raise ValueError("invalid days: must be a list of day instants")
    if not 1 <= len(raw_days) <= _MAX_DAYS:
        raise ValueError(f"invalid days: must contain 1..{_MAX_DAYS} entries")
    return raw_days


def parse_wire_days(raw_days: object, parse_instant: InstantParser) -> list[DayInstantInput] | None:
    if raw_days is None:
        return None
    return [_parse_day_entry(i, d, parse_instant) for i, d in enumerate(_check_days_seq(raw_days))]


def _parse_moon_sign(raw_sign: object) -> ZodiacSign:
    if not isinstance(raw_sign, str):
        raise ValueError("invalid natal_moon: sign must be a string")
    try:
        return ZodiacSign(raw_sign.strip().capitalize())
    except ValueError as error:
        raise ValueError(f"invalid natal_moon sign: {raw_sign}") from error


def _parse_moon_nakshatra(raw_nak: object) -> str:
    if not isinstance(raw_nak, str) or raw_nak not in _NAKSHATRA_INDEX:
        raise ValueError(f"invalid natal_moon nakshatra: {raw_nak}")
    return raw_nak


def parse_wire_natal_moon(raw: object) -> NatalMoonRef | None:
    if raw is None:
        return None
    if not isinstance(raw, Mapping):
        raise ValueError("invalid natal_moon: must be an object")
    return NatalMoonRef(
        sign=_parse_moon_sign(raw.get("sign")),
        nakshatra=_parse_moon_nakshatra(raw.get("nakshatra")),
    )
