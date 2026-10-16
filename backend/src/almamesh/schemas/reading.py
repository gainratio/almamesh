"""Pydantic wire contract for the period reading (``PredictiveContexts.period_reading``).

One compact, citable digest of a predictive run: the running dashas down to the
sookshma, the natal lords with their lordships and functional nature, the slow
sky per span with Moon-based tags, and per-domain themes with plain agreement
booleans. Every value is read off contexts the same run already computed; the
reading makes no ephemeris call. Dates are UTC calendar dates (ISO
``YYYY-MM-DD``); signs are lowercase sign names, matching the grahas.
"""

from __future__ import annotations

import datetime as _dt
from datetime import date, datetime
from enum import StrEnum
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

from almamesh.constants.astrology import PlanetName
from almamesh.schemas.domains import LifeDomain, StrengthBand
from almamesh.schemas.transits import TransitSeverity

SignKey = Literal[
    "aries",
    "taurus",
    "gemini",
    "cancer",
    "leo",
    "virgo",
    "libra",
    "scorpio",
    "sagittarius",
    "capricorn",
    "aquarius",
    "pisces",
]
House = Annotated[int, Field(ge=1, le=12)]
Factor = Annotated[str, Field(min_length=1, max_length=80)]

_FROZEN = ConfigDict(frozen=True)


class DashaLevel(StrEnum):
    """The four Vimshottari depths, outermost first."""

    MAHA = "maha"
    ANTAR = "antar"
    PRATYANTAR = "pratyantar"
    SOOKSHMA = "sookshma"


class FunctionalNature(StrEnum):
    """A graha's functional nature by lagna lordship (BPHS)."""

    YOGAKARAKA = "yogakaraka"
    BENEFIC = "benefic"
    MALEFIC = "malefic"
    MARAKA = "maraka"
    NEUTRAL = "neutral"


class SignDignity(StrEnum):
    """A graha's sign dignity: exaltation tables, own sign, else natural friendship (BPHS)."""

    EXALTED = "exalted"
    OWN = "own"
    FRIEND = "friend"
    NEUTRAL = "neutral"
    ENEMY = "enemy"
    DEBILITATED = "debilitated"


class LordStrength(StrEnum):
    """A dasha lord's strength band (spec 2026-10-15, R3)."""

    STRONG = "strong"
    ORDINARY = "ordinary"
    WEAK = "weak"


class Relation(StrEnum):
    """A sub-lord's placement counted from its parent lord (spec 2026-10-15, R2)."""

    SUPPORT = "support"
    FRICTION = "friction"
    NEUTRAL = "neutral"


Tone = Literal["supportive", "mixed", "challenging"]


class ReadingWindow(BaseModel):
    """The covered half-open window [start, end)."""

    model_config = _FROZEN
    start: date
    end: date


class NatalLord(BaseModel):
    """One graha's natal facts: lordships, placement, dignity, varga signs, yogas."""

    model_config = _FROZEN
    rules: list[House]
    house: House
    sign: SignKey
    dignity: str  # the chart's own four-value dignity (exalted/own/neutral/debilitated)
    strength: LordStrength
    combust: bool
    retro: bool
    functional: FunctionalNature
    d9_sign: SignKey
    d10_sign: SignKey
    vargottama: bool
    yogas: list[str]


class DashaSpan(BaseModel):
    """One maha/antar/pratyantar span, clipped to the window.

    ``from_parent`` is the lord's whole-sign house counted from its parent lord
    (antar from maha, pratyantar from antar); None for a maha.
    """

    model_config = _FROZEN
    level: DashaLevel
    lord: PlanetName
    start: date
    end: date
    from_parent: House | None = None
    relation: Relation | None = None


class Sookshma(BaseModel):
    """The sookshma (level 4) running at the reference instant, unclipped."""

    model_config = _FROZEN
    lord: PlanetName
    start: date
    end: date
    from_parent: House | None = None  # counted from the pratyantar lord
    relation: Relation | None = None


class Sandhi(BaseModel):
    """The first maha or antar change inside the window."""

    model_config = _FROZEN
    level: DashaLevel
    date: _dt.date


class YoginiSpan(BaseModel):
    """A Yogini maha or antar running at the reference instant, unclipped."""

    model_config = _FROZEN
    name: str
    lord: PlanetName
    start: date
    end: date


class ReadingSegment(BaseModel):
    """A stretch of the window with one maha/antar/pratyantar and one slow sky."""

    model_config = _FROZEN
    start: date
    end: date
    maha: PlanetName
    antar: PlanetName
    pratyantar: PlanetName
    events: list[str]  # "YYYY-MM-DD descriptor" for each timeline event inside the segment


class SkySpan(BaseModel):
    """One slow graha in one sign (and one motion) over part of the window."""

    model_config = _FROZEN
    graha: PlanetName
    start: date
    end: date
    sign: SignKey
    retro: bool
    from_moon: House
    from_lagna: House
    sav: int
    bav: int | None  # None for the nodes (no Bhinnashtakavarga)
    tags: list[str]


class TransitLord(BaseModel):
    """A running lord's gochara at the reference instant."""

    model_config = _FROZEN
    sign: SignKey
    from_moon: House
    from_lagna: House
    sav: int
    bav: int | None
    retro: bool


class ThemeAgreement(BaseModel):
    """Plain per-technique agreement flags, never a fused score."""

    model_config = _FROZEN
    vimshottari: bool
    yogini: bool
    transit: bool


class ThemeDasha(BaseModel):
    """The graded dasha scores for one domain (spec 2026-10-15, R7)."""

    model_config = _FROZEN
    vimshottari: Annotated[int, Field(ge=0, le=100)]
    yogini: Annotated[int, Field(ge=0, le=100)]
    tone: Tone | None  # None when no running Vimshottari lord is tied to the domain


class ThemeWindow(BaseModel):
    """A dated domain window inside the reading window."""

    model_config = _FROZEN
    date: _dt.date
    descriptor: str
    severity: TransitSeverity


class ReadingTheme(BaseModel):
    """One life domain's reading for the window."""

    model_config = _FROZEN
    domain: LifeDomain
    houses: list[House]
    direction: Literal["supportive", "mixed", "challenging"]
    strength: StrengthBand
    strength_pct: int
    confidence: Literal["high", "medium", "low"]
    agreement: ThemeAgreement
    dasha: ThemeDasha
    factors: Annotated[list[Factor], Field(max_length=3)]
    windows: Annotated[list[ThemeWindow], Field(max_length=3)]


class Panchang(BaseModel):
    """The five limbs (plus paksha) at the reference instant."""

    model_config = _FROZEN
    instant: datetime
    tithi: Annotated[int, Field(ge=1, le=30)]
    tithi_name: str
    paksha: Literal["shukla", "krishna"]
    nakshatra: str
    karana: str
    yoga: str
    vara: str


class PeriodReading(BaseModel):
    """The whole period reading for one predictive run."""

    model_config = _FROZEN
    window: ReadingWindow
    natal_lords: dict[PlanetName, NatalLord]
    dasha_spans: list[DashaSpan]
    sookshma: Sookshma | None
    sandhi: Sandhi | None
    yogini: YoginiSpan | None
    yogini_antar: YoginiSpan | None
    segments: list[ReadingSegment]
    sky: list[SkySpan]
    transit_lords: dict[PlanetName, TransitLord]
    double_transit: list[House]
    themes: Annotated[list[ReadingTheme], Field(max_length=8)]
    panchang: Panchang
    rules: list[str]


__all__ = [
    "DashaLevel",
    "DashaSpan",
    "FunctionalNature",
    "LordStrength",
    "NatalLord",
    "Panchang",
    "PeriodReading",
    "ReadingSegment",
    "ReadingTheme",
    "ReadingWindow",
    "Relation",
    "Sandhi",
    "SignDignity",
    "SignKey",
    "SkySpan",
    "Sookshma",
    "ThemeAgreement",
    "ThemeDasha",
    "ThemeWindow",
    "Tone",
    "TransitLord",
    "YoginiSpan",
]
