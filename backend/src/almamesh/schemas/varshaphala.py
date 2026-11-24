"""Pydantic schemas for Tajaka Varshaphala (Annual Solar Return)."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from almamesh.constants.astrology import PlanetName, ZodiacSign
from almamesh.schemas.astrology import SiderealContext


class MunthaInfo(BaseModel):
    """Annual progressed ascendant (Muntha) for a solar return year."""

    model_config = ConfigDict(frozen=True)

    sign: ZodiacSign
    sign_lord: PlanetName
    house_from_varsha_lagna: int = Field(ge=1, le=12)
    natal_lagna_sign: ZodiacSign
    completed_years: int = Field(ge=0)


class PanchavargiyaBala(BaseModel):
    """Five-fold Tajaka planetary strength (0-20 Virupas scale)."""

    model_config = ConfigDict(frozen=True)

    kshetra: float
    uchcha: float
    hadda: float
    drekkana: float
    navamsa: float
    total: float
    dignity_band: Literal["strong", "moderate", "weak"]


class VarsheshaCandidate(BaseModel):
    """One of the five Panchadhikari office-holders evaluated for Year Lord."""

    model_config = ConfigDict(frozen=True)

    graha: PlanetName
    roles: list[str]
    panchavargiya_total: float
    aspects_varsha_lagna: bool


class MuddaDashaPeriod(BaseModel):
    """One annual Mudda Dasha period compressed across the solar year."""

    model_config = ConfigDict(frozen=True)

    lord: PlanetName
    start_utc: datetime
    end_utc: datetime
    duration_days: float
    is_current: bool


class TajakaYoga(BaseModel):
    """Classical Tajaka applying (Ithasala) or separating (Easarpha) yoga."""

    model_config = ConfigDict(frozen=True)

    name: Literal["Ithasala", "Easarpha"]
    kind: Literal["applying", "separating"]
    faster_planet: PlanetName
    slower_planet: PlanetName
    aspect_type: Literal["conjunction", "sextile", "square", "trine", "opposition"]
    orb_degrees: float
    deep_orb: bool


class VarshaphalaContext(BaseModel):
    """Complete deterministic Tajaka Varshaphala (Annual Solar Return) payload."""

    model_config = ConfigDict(frozen=True)

    target_year: int
    completed_years: int = Field(ge=0)
    solar_return_utc: datetime
    next_solar_return_utc: datetime
    ayanamsa_type: str
    ayanamsa_value: float
    natal_sun_longitude: float
    return_sun_longitude: float
    is_day_chart: bool
    varsha_chart: SiderealContext
    muntha: MunthaInfo
    varshesha: PlanetName
    varshesha_candidates: list[VarsheshaCandidate]
    panchavargiya_bala: dict[PlanetName, PanchavargiyaBala]
    mudda_dasha: list[MuddaDashaPeriod]
    tajaka_yogas: list[TajakaYoga]
