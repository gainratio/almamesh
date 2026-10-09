"""Pydantic contract for the Phase-1 predictive transit (gochara) engine.

These models are the typed, prose-free output of `calculate_transit_context`.
The LLM/i18n layer narrates the stable `descriptor` keys later; the engine never
emits sentences. All enums are closed sets serialized as their `.value` for the
browser. See `backend/docs/predictive-engine-plan.md` section 2 for the contract.
"""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum

from pydantic import BaseModel, Field

from almamesh.constants.astrology import PlanetName, ZodiacSign

# --- enums (closed sets; serialize as their .value) ---


class SadeSatiPhase(StrEnum):
    """Which sign Saturn occupies relative to the natal Moon during Sade Sati."""

    RISING = "rising"  # Saturn in the 12th from natal Moon sign
    PEAK = "peak"  # Saturn in the 1st (over the natal Moon sign itself)
    SETTING = "setting"  # Saturn in the 2nd from natal Moon sign
    NONE = "none"  # not currently in Sade Sati


class TransitReference(StrEnum):
    """The natal point a gochara reading is counted from."""

    MOON = "moon"  # Chandra Lagna (Janma Rasi) — the classical primary
    LAGNA = "lagna"  # natal Ascendant — secondary


class TransitEventKind(StrEnum):
    """The kind of a dated forward event in the timeline."""

    SIGN_INGRESS = "sign_ingress"  # a slow graha enters a new rasi
    SADE_SATI_PHASE = "sade_sati_phase"  # entry into rising/peak/setting/none
    RETURN = "return"  # Saturn (~29.5y) or Jupiter (~12y) return
    DASHA_CHANGE = "dasha_change"  # maha/antar lord handover
    STATION = "station"  # retrograde/direct station (slow grahas)


class TransitSeverity(StrEnum):
    """Coarse, deterministic, classical-leaning valence (the LLM refines later)."""

    SUPPORTIVE = "supportive"
    NEUTRAL = "neutral"
    CHALLENGING = "challenging"


class StationDirection(StrEnum):
    """Which way a graha turns at a station."""

    RETROGRADE = "retrograde"  # starts moving backward
    DIRECT = "direct"  # resumes forward motion


# --- atomic placements ---


class TransitPlacement(BaseModel):
    """One transiting graha placed against the natal chart at the instant."""

    graha: PlanetName
    longitude: float  # sidereal, 0..360
    sign: ZodiacSign
    sign_degrees: float  # 0..30 within sign
    nakshatra: str
    nakshatra_pada: int
    is_retrograde: bool
    house_from_lagna: int  # 1..12, whole-sign from natal Lagna
    house_from_moon: int  # 1..12, whole-sign from natal Moon (Chandra Lagna)
    natal_sign_occupied: ZodiacSign  # the sign this transit sits in
    model_config = {"use_enum_values": True}


class GocharaContext(BaseModel):
    """All transiting grahas placed against the natal chart at `instant`."""

    instant: datetime  # UTC, the transit instant ("now" or injected)
    transit_ayanamsa: float  # Lahiri at the transit instant (audit)
    placements: dict[PlanetName, TransitPlacement]


# --- Sade Sati ---


class SadeSatiSegment(BaseModel):
    """One phase span of the current/queried Sade Sati cycle."""

    phase: SadeSatiPhase
    saturn_sign: ZodiacSign  # the rasi Saturn occupies in this phase
    start: datetime  # phase entry (ingress) instant, UTC
    end: datetime  # phase exit (next ingress) instant, UTC
    model_config = {"use_enum_values": True}


class SadeSatiContext(BaseModel):
    """Saturn over the 12th/1st/2nd from the natal Moon — the headline transit."""

    is_active: bool
    current_phase: SadeSatiPhase
    natal_moon_sign: ZodiacSign
    cycle: list[SadeSatiSegment]  # the 3 phase spans of the active/next cycle
    cycle_start: datetime | None = None  # Saturn entering the 12th
    cycle_end: datetime | None = None  # Saturn leaving the 2nd
    model_config = {"use_enum_values": True}


# --- major slow-transit hits & returns ---


class SlowTransitHit(BaseModel):
    """A Jupiter/Saturn transit over a natal point (Moon, Lagna), or a return."""

    graha: PlanetName  # JUPITER or SATURN
    kind: TransitEventKind  # SIGN_INGRESS / RETURN
    natal_point: str  # "moon" | "lagna" | "natal_<graha>"
    exact: datetime  # instant of exact conjunction / return, UTC
    severity: TransitSeverity
    model_config = {"use_enum_values": True}


# --- dasha × transit fusion ---


class DashaTransitFusion(BaseModel):
    """The active dasha lord weighted by concurrent transits over it / from it."""

    instant: datetime
    maha_lord: PlanetName
    antar_lord: PlanetName | None = None
    maha_lord_transit_house_from_moon: int  # 1..12
    maha_lord_transit_house_from_lagna: int  # 1..12
    reinforcing: list[PlanetName] = Field(default_factory=list)  # benefics
    afflicting: list[PlanetName] = Field(default_factory=list)  # malefics
    net_weight: float  # -1.0..+1.0 deterministic score
    severity: TransitSeverity
    model_config = {"use_enum_values": True}


# --- 12-month forward timeline ---


class TimelineEvent(BaseModel):
    """One dated, structured, prose-free forward event. The LLM narrates later."""

    date: datetime  # UTC instant of the event
    kind: TransitEventKind
    graha: PlanetName | None = None  # the moving graha (None for dasha changes)
    from_sign: ZodiacSign | None = None  # ingress: vacated sign
    to_sign: ZodiacSign | None = None  # ingress: entered sign
    from_lord: PlanetName | None = None  # dasha change: outgoing lord
    to_lord: PlanetName | None = None  # dasha change: incoming lord
    sade_sati_phase: SadeSatiPhase | None = None
    station_direction: StationDirection | None = None  # station: which way it turns
    station_sign: ZodiacSign | None = None  # station: the sign it stations in
    severity: TransitSeverity
    descriptor: str  # STABLE machine key, e.g. "saturn.ingress.aries"
    model_config = {"use_enum_values": True}


class TransitTimeline(BaseModel):
    """Forward-looking dated events over the window (default 12 months)."""

    window_start: datetime
    window_end: datetime
    events: list[TimelineEvent]  # chronologically sorted


# --- top-level ---


class TransitContext(BaseModel):
    """Everything the Phase-1 transit layer emits for one chart + instant."""

    instant: datetime  # the transit "now" (UTC, injectable)
    gochara: GocharaContext
    sade_sati: SadeSatiContext
    slow_hits: list[SlowTransitHit]
    fusion: DashaTransitFusion
    timeline: TransitTimeline
