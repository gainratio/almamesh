"""Dasha x transit fusion: the active dasha lord weighted by concurrent transits.

The dasha names *what* period is active; the transit weighs *how* it currently
reads. We locate the active maha/antar lord at the instant, find where that lord
is transiting (house from Moon/Lagna), collect which benefics reinforce and
malefics afflict its transit sign (conjunction or graha-specific Vedic aspect),
and reduce all of it to a deterministic net_weight in [-1, 1] with documented,
named weights — no magic numbers, no LLM."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Final

from almamesh.calculations import (
    AyanamsaType,
    NodeType,
    calculate_vimshottari_dashas,
)
from almamesh.constants.astrology import PlanetName
from almamesh.schemas.transits import DashaTransitFusion, TransitSeverity
from almamesh.transits.aspects import afflicting_malefics, reinforcing_benefics
from almamesh.transits.natal import (
    natal_lagna_index,
    natal_moon_index,
    sign_index,
    whole_sign_house,
)
from almamesh.transits.positions import transit_positions

if TYPE_CHECKING:
    from datetime import datetime

    from almamesh.calculations import SkyfieldAstronomy
    from almamesh.schemas.astrology import SiderealContext, VimshottariDashaData

# --- documented weight table (deterministic; Phase-2/3 can extend additively) ---
_KENDRA_TRIKONA_HOUSES: Final[frozenset[int]] = frozenset({1, 4, 5, 7, 9, 10})
_DUSTHANA_HOUSES: Final[frozenset[int]] = frozenset({6, 8, 12})
_HOUSE_BONUS: Final[float] = 0.3  # lord in a kendra/trikona from the Moon
_HOUSE_PENALTY: Final[float] = -0.3  # lord in a dusthana from the Moon
_PER_BENEFIC: Final[float] = 0.25  # each benefic reinforcing the lord's sign
_PER_MALEFIC: Final[float] = -0.25  # each malefic afflicting the lord's sign
_SUPPORTIVE_THRESHOLD: Final[float] = 0.15
_CHALLENGING_THRESHOLD: Final[float] = -0.15


def _house_term(house_from_moon: int) -> float:
    """Placement bonus/penalty for the lord's transit house from the Moon."""
    if house_from_moon in _KENDRA_TRIKONA_HOUSES:
        return _HOUSE_BONUS
    if house_from_moon in _DUSTHANA_HOUSES:
        return _HOUSE_PENALTY
    return 0.0


def _severity_for(weight: float) -> TransitSeverity:
    """Map a net weight onto the coarse three-way severity."""
    if weight >= _SUPPORTIVE_THRESHOLD:
        return TransitSeverity.SUPPORTIVE
    if weight <= _CHALLENGING_THRESHOLD:
        return TransitSeverity.CHALLENGING
    return TransitSeverity.NEUTRAL


def score_fusion(
    house_from_moon: int,
    reinforcing: list[PlanetName],
    afflicting: list[PlanetName],
) -> tuple[float, TransitSeverity]:
    """Reduce placement + benefic/malefic counts to a clamped weight + severity."""
    raw = (
        _house_term(house_from_moon)
        + _PER_BENEFIC * len(reinforcing)
        + _PER_MALEFIC * len(afflicting)
    )
    weight = max(-1.0, min(1.0, raw))
    return weight, _severity_for(weight)


def _fallback_maha_lord(dashas: VimshottariDashaData, instant: datetime) -> PlanetName:
    """Nearest boundary maha lord from this chart's sequence when outside the 120y span."""
    seq = dashas.maha_dasha_sequence
    if not seq:
        raise ValueError("Vimshottari maha_dasha_sequence cannot be empty")
    return seq[0].lord if instant < seq[0].start_date else seq[-1].lord


def _active_lords(
    natal: SiderealContext, birth_dt: datetime, instant: datetime
) -> tuple[PlanetName, PlanetName | None, PlanetName | None]:
    """Active maha, antar, and pratyantar lords computed atomically at the instant."""
    moon_long = natal.planets[PlanetName.MOON].longitude
    dashas = calculate_vimshottari_dashas(
        moon_long, birth_dt, convention=natal.dashas.convention, reference_date=instant
    )
    maha = dashas.current_maha.lord if dashas.current_maha else _fallback_maha_lord(dashas, instant)
    antar = dashas.current_antar.lord if dashas.current_antar else None
    pratyantar = dashas.current_pratyantar.lord if dashas.current_pratyantar else None
    return maha, antar, pratyantar


def _lord_house_from_moon(
    raw: dict[PlanetName, dict[str, Any]], lord: PlanetName | None, moon_idx: int
) -> int | None:
    """Whole-sign house from the natal Moon for an optional dasha sub-lord."""
    if lord is None:
        return None
    return whole_sign_house(sign_index(float(raw[lord]["longitude"])), moon_idx)


def build_fusion(
    astro: SkyfieldAstronomy,
    natal: SiderealContext,
    birth_dt: datetime,
    instant: datetime,
    ayanamsa_type: AyanamsaType = AyanamsaType.LAHIRI,
    node_type: NodeType = NodeType.MEAN,
) -> DashaTransitFusion:
    """Fuse the active dasha lord with its concurrent transit reinforcement."""
    maha, antar, pratyantar = _active_lords(natal, birth_dt, instant)
    raw = transit_positions(astro, instant, ayanamsa_type, node_type)
    moon_idx = natal_moon_index(natal)
    lord_idx = sign_index(float(raw[maha]["longitude"]))
    house_moon = whole_sign_house(lord_idx, moon_idx)
    reinforcing = reinforcing_benefics(raw, maha, lord_idx)
    afflicting = afflicting_malefics(raw, maha, lord_idx)
    weight, severity = score_fusion(house_moon, reinforcing, afflicting)
    return DashaTransitFusion(
        instant=instant,
        maha_lord=maha,
        antar_lord=antar,
        pratyantar_lord=pratyantar,
        maha_lord_transit_house_from_moon=house_moon,
        maha_lord_transit_house_from_lagna=whole_sign_house(lord_idx, natal_lagna_index(natal)),
        antar_lord_transit_house_from_moon=_lord_house_from_moon(raw, antar, moon_idx),
        pratyantar_lord_transit_house_from_moon=_lord_house_from_moon(raw, pratyantar, moon_idx),
        reinforcing=reinforcing,
        afflicting=afflicting,
        net_weight=weight,
        severity=severity,
    )
