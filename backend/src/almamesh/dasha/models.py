"""
Dasha Engine Domain Models.

Contains all Pydantic models used across the dasha engine:
- Signal: Atomic astrologically meaningful condition
- TimeSegment: Unified time segment with states from all dasha systems
- EventWindow: Predicted event with probability and evidence
- CompositeTimeline: Complete output of composite dasha analysis
- DashaEngineConfig: Engine configuration
- State models: VimshottariState, CharaState, YoginiState
- Period models: VimPeriod, CharaPeriod, YoginiPeriod
- Karaka models: JaiminiKarakas, KarakaInfo
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field

from almamesh.constants.astrology import (
    CONFLUENCE_MULTIPLIERS,
    DASHA_THRESHOLDS,
    DEFAULT_MERGE_GAP_DAYS,
    SIGNAL_WEIGHTS,
    DashaSystem,
    EventType,
    PlanetName,
    ZodiacSign,
)

# =============================================================================
# CONFIGURATION MODELS
# =============================================================================


class ConfluenceMultipliers(BaseModel):
    """Multipliers when multiple dasha systems agree on an event."""

    vim_x_chara: float = CONFLUENCE_MULTIPLIERS["vim_x_chara"]
    vim_x_yogini: float = CONFLUENCE_MULTIPLIERS["vim_x_yogini"]
    chara_x_yogini: float = CONFLUENCE_MULTIPLIERS["chara_x_yogini"]
    triple_stack: float = CONFLUENCE_MULTIPLIERS["triple_stack"]


class SignalWeights(BaseModel):
    """Base weights for different signal types."""

    # Vimshottari weights
    vim_10th_activation: float = SIGNAL_WEIGHTS["vim_10th_activation"]
    vim_7th_activation: float = SIGNAL_WEIGHTS["vim_7th_activation"]
    vim_health_house: float = SIGNAL_WEIGHTS["vim_health_house"]
    vim_relocation: float = SIGNAL_WEIGHTS["vim_relocation"]
    vim_wealth_house: float = SIGNAL_WEIGHTS["vim_wealth_house"]

    # Chara weights
    chara_amk_activation: float = SIGNAL_WEIGHTS["chara_amk_activation"]
    chara_dk_activation: float = SIGNAL_WEIGHTS["chara_dk_activation"]
    chara_house_activation: float = SIGNAL_WEIGHTS["chara_house_activation"]

    # Yogini weights (modulation, not primary)
    yogini_boost: float = SIGNAL_WEIGHTS["yogini_boost"]


class DashaEngineConfig(BaseModel):
    """Configuration for the composite dasha engine."""

    weights: SignalWeights = Field(default_factory=SignalWeights)
    multipliers: ConfluenceMultipliers = Field(default_factory=ConfluenceMultipliers)
    thresholds: dict[EventType, float] = Field(default_factory=lambda: DASHA_THRESHOLDS)
    merge_gap_days: int = DEFAULT_MERGE_GAP_DAYS


# =============================================================================
# SIGNAL AND CORE DOMAIN MODELS
# =============================================================================


class Signal(BaseModel):
    """Single astrologically meaningful condition (atomic evidence)."""

    id: str
    system: DashaSystem
    event_tags: list[EventType]
    weight: float  # 0.0-1.0, intrinsic strength
    polarity: int  # +1 benefic, -1 malefic, 0 mixed
    rationale: str  # Human explanation
    features: dict[str, Any] = Field(default_factory=dict)  # Structured details


# =============================================================================
# DASHA STATE MODELS
# =============================================================================


class VimshottariState(BaseModel):
    """Active Vimshottari dasha lords at a point in time."""

    md_lord: PlanetName  # Mahadasha lord
    ad_lord: PlanetName  # Antardasha lord
    pd_lord: PlanetName | None = None  # Pratyantardasha lord (optional)


class CharaState(BaseModel):
    """Active Chara (Jaimini) dasha state."""

    sign_md: ZodiacSign  # Mahadasha sign
    sign_ad: ZodiacSign  # Antardasha sign
    active_karakas: list[str] = Field(default_factory=list)  # AmK, DK, etc. in active signs


class YoginiState(BaseModel):
    """Active Yogini dasha state."""

    yogini_name: str  # Mangala, Pingala, etc.
    lord: PlanetName


# =============================================================================
# TIME SEGMENT AND EVENT MODELS
# =============================================================================


class TimeSegment(BaseModel):
    """A unified time segment with states from all three dasha systems."""

    start_date: datetime
    end_date: datetime
    vimshottari: VimshottariState
    chara: CharaState
    yogini: YoginiState
    signals: list[Signal] = Field(default_factory=list)
    event_scores: dict[EventType, float] = Field(default_factory=dict)


class EventWindow(BaseModel):
    """A predicted event with probability and evidence."""

    event_type: EventType
    window_start: datetime
    window_end: datetime
    probability: float  # 0.0-1.0
    confluence_systems: list[DashaSystem]
    top_signals: list[Signal]
    explanations: list[str]


# =============================================================================
# JAIMINI KARAKAS
# =============================================================================


class KarakaInfo(BaseModel):
    """Information about a Jaimini Karaka."""

    planet: PlanetName
    sign: ZodiacSign
    house: int
    degrees: float  # Degrees within sign (0-30)


class JaiminiKarakas(BaseModel):
    """Chara Karakas based on planetary degrees (Jaimini system)."""

    atk: KarakaInfo  # Atmakaraka (soul) - highest degree
    amk: KarakaInfo  # Amatyakaraka (career) - 2nd highest
    bk: KarakaInfo  # Bhratrukaraka (siblings) - 3rd
    mk: KarakaInfo  # Matrukaraka (mother) - 4th
    pk: KarakaInfo  # Pitrukaraka (father) - 5th
    gk: KarakaInfo  # Gnatikaraka (relatives) - 6th
    dk: KarakaInfo  # Darakaraka (spouse) - lowest degree


# =============================================================================
# COMPOSITE TIMELINE
# =============================================================================


class CompositeTimeline(BaseModel):
    """Complete output of the composite dasha analysis."""

    segments: list[TimeSegment]
    events: list[EventWindow]
    karakas: JaiminiKarakas | None = None


# =============================================================================
# DASHA PERIOD MODELS
# =============================================================================


class VimPeriod(BaseModel):
    """A Vimshottari dasha period (MD or MD/AD).

    ``start_date``/``end_date`` may be clipped to an analysis window;
    ``antar_start``/``antar_end`` are always the antar's TRUE bounds, which the
    pratyantar arithmetic must start from.
    """

    md_lord: PlanetName
    ad_lord: PlanetName | None = None
    start_date: datetime
    end_date: datetime
    antar_start: datetime
    antar_end: datetime


class CharaPeriod(BaseModel):
    """A Chara (Jaimini) dasha period."""

    sign: ZodiacSign
    start_date: datetime
    end_date: datetime
    duration_years: float


class YoginiPeriod(BaseModel):
    """A Yogini dasha period."""

    yogini_name: str
    lord: PlanetName
    start_date: datetime
    end_date: datetime
    duration_years: float
