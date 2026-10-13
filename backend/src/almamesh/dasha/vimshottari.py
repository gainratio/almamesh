"""
Vimshottari Dasha System.

Implements the traditional 120-year Vimshottari dasha system based on
Moon's nakshatra position. Calculates Mahadasha (MD) and Antardasha (AD)
periods for a given time window.

The sequence of 9 planets repeats through the 120-year cycle:
Ketu (7) -> Venus (20) -> Sun (6) -> Moon (10) -> Mars (7) ->
Rahu (18) -> Jupiter (16) -> Saturn (19) -> Mercury (17)
"""

from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING

from almamesh.constants.astrology import (
    DASHA_SEQUENCE,
    DASHA_YEARS,
    DashaSystem,
    Dignity,
    EventType,
    PlanetName,
)
from almamesh.dasha.models import (
    DashaEngineConfig,
    Signal,
    TimeSegment,
    VimPeriod,
    VimshottariState,
)
from almamesh.schemas.astrology import PlanetPosition, SiderealContext

if TYPE_CHECKING:
    from almamesh.dasha.models import JaiminiKarakas


# =============================================================================
# VIMSHOTTARI PERIOD COMPUTATION
# =============================================================================


def compute_vimshottari_periods(
    context: SiderealContext,
    start_date: datetime,
    end_date: datetime,
) -> list[VimPeriod]:
    """
    Extract Vimshottari MD/AD periods for the given time window.

    Uses the existing dasha data from SiderealContext and expands
    to include antardasha (AD) subdivisions.

    Args:
        context: The sidereal context with dasha data.
        start_date: Start of analysis window.
        end_date: End of analysis window.

    Returns:
        List of VimPeriod objects covering the time window.
    """
    periods: list[VimPeriod] = []
    maha_sequence = context.dashas.maha_dasha_sequence

    for maha in maha_sequence:
        # Skip if outside window
        if maha.end_date < start_date or maha.start_date > end_date:
            continue

        # Calculate antardasha periods within this mahadasha
        md_lord = maha.lord
        md_start = maha.start_date
        # Each antardasha is a fraction of the mahadasha's actual span, so the
        # nine ADs tile the MD exactly under whatever year convention built it
        # — no separate year-length constant, no convention mismatch.
        md_span = maha.end_date - maha.start_date

        # AD sequence starts from MD lord
        lord_idx = DASHA_SEQUENCE.index(md_lord)
        ad_start = md_start

        for i in range(9):
            ad_lord = DASHA_SEQUENCE[(lord_idx + i) % 9]
            ad_fraction = DASHA_YEARS[ad_lord] / 120
            ad_end = ad_start + md_span * ad_fraction

            # Only include if overlaps with window
            if ad_end >= start_date and ad_start <= end_date:
                periods.append(
                    VimPeriod(
                        md_lord=md_lord,
                        ad_lord=ad_lord,
                        start_date=max(ad_start, start_date),
                        end_date=min(ad_end, end_date),
                        antar_start=ad_start,
                        antar_end=ad_end,
                    )
                )

            ad_start = ad_end
            if ad_start > end_date:
                break

    return periods


def _active_pratyantardasha(
    ad_lord: PlanetName, ad_start: datetime, ad_end: datetime, dt: datetime
) -> PlanetName:
    """Pratyantardasha lord active at dt within an antardasha.

    Each PD is DASHA_YEARS/120 of the AD span, the sequence starting from the
    AD lord, so the nine PDs tile the AD exactly.
    """
    ad_span = ad_end - ad_start
    lord_idx = DASHA_SEQUENCE.index(ad_lord)
    pd_start = ad_start
    pd_lord = ad_lord
    for i in range(9):
        pd_lord = DASHA_SEQUENCE[(lord_idx + i) % 9]
        pd_end = pd_start + ad_span * (DASHA_YEARS[pd_lord] / 120)
        if pd_start <= dt < pd_end:
            return pd_lord
        pd_start = pd_end
    return pd_lord  # dt at/after the AD end: the final PD lord


def find_active_vimshottari(periods: list[VimPeriod], dt: datetime) -> VimshottariState:
    """
    Find the active Vimshottari state at a given datetime.

    Args:
        periods: List of VimPeriod objects.
        dt: The datetime to check.

    Returns:
        VimshottariState with active MD, AD, and PD lords.
    """
    for p in periods:
        if p.start_date <= dt < p.end_date:
            ad_lord = p.ad_lord or p.md_lord
            return VimshottariState(
                md_lord=p.md_lord,
                ad_lord=ad_lord,
                pd_lord=_active_pratyantardasha(ad_lord, p.antar_start, p.antar_end, dt),
            )
    # Fallback to first period if not found
    if periods:
        p = periods[0]
        return VimshottariState(md_lord=p.md_lord, ad_lord=p.ad_lord or p.md_lord)
    return VimshottariState(md_lord=PlanetName.SUN, ad_lord=PlanetName.SUN)


# =============================================================================
# VIMSHOTTARI SIGNAL EXTRACTION
# =============================================================================


def _extract_vim_career_signals(
    lord: PlanetName,
    planet: PlanetPosition,
    context: SiderealContext,
    config: DashaEngineConfig,
    signals: list[Signal],
) -> None:
    """Extract career-related Vimshottari signals."""
    house_10_lord = context.houses[10].sign_lord
    if planet.house == 10 or lord == house_10_lord:
        signals.append(
            Signal(
                id=f"vim_{lord.value}_10th",
                system=DashaSystem.VIMSHOTTARI,
                event_tags=[EventType.CAREER_CHANGE, EventType.PROMOTION],
                weight=config.weights.vim_10th_activation,
                polarity=1 if planet.dignity in [Dignity.EXALTED, Dignity.OWN] else 0,
                rationale=f"{lord.value.title()} activates 10th house during dasha period",
                features={"planet": lord.value, "house": 10, "dignity": planet.dignity.value},
            )
        )


def _extract_vim_relationship_signals(
    lord: PlanetName,
    planet: PlanetPosition,
    context: SiderealContext,
    config: DashaEngineConfig,
    signals: list[Signal],
) -> None:
    """Extract relationship-related Vimshottari signals."""
    house_7_lord = context.houses[7].sign_lord
    if planet.house == 7 or lord == house_7_lord:
        signals.append(
            Signal(
                id=f"vim_{lord.value}_7th",
                system=DashaSystem.VIMSHOTTARI,
                event_tags=[EventType.MARRIAGE, EventType.ENGAGEMENT],
                weight=config.weights.vim_7th_activation,
                polarity=1 if planet.dignity != Dignity.DEBILITATED else -1,
                rationale=f"{lord.value.title()} activates 7th house (relationships)",
                features={"planet": lord.value, "house": 7},
            )
        )


def _extract_vim_health_signals(
    lord: PlanetName,
    planet: PlanetPosition,
    context: SiderealContext,
    config: DashaEngineConfig,
    signals: list[Signal],
) -> None:
    """Extract health-related Vimshottari signals."""
    house_6_lord = context.houses[6].sign_lord
    house_8_lord = context.houses[8].sign_lord
    if lord == house_6_lord or lord == house_8_lord:
        signals.append(
            Signal(
                id=f"vim_{lord.value}_health",
                system=DashaSystem.VIMSHOTTARI,
                event_tags=[EventType.HEALTH_ISSUE],
                weight=config.weights.vim_health_house,
                polarity=-1,
                rationale=f"{lord.value.title()} is lord of 6th/8th house (health)",
                features={"planet": lord.value},
            )
        )


def _extract_vim_relocation_signals(
    lord: PlanetName,
    planet: PlanetPosition,
    context: SiderealContext,
    config: DashaEngineConfig,
    signals: list[Signal],
) -> None:
    """Extract relocation-related Vimshottari signals."""
    house_4_lord = context.houses[4].sign_lord
    house_12_lord = context.houses[12].sign_lord
    if planet.house in [4, 12] or lord in [house_4_lord, house_12_lord]:
        signals.append(
            Signal(
                id=f"vim_{lord.value}_relocation",
                system=DashaSystem.VIMSHOTTARI,
                event_tags=[EventType.RELOCATION],
                weight=config.weights.vim_relocation,
                polarity=0,
                rationale=f"{lord.value.title()} activates 4th/12th (home/foreign lands)",
                features={"planet": lord.value},
            )
        )


def _extract_vim_wealth_signals(
    lord: PlanetName,
    planet: PlanetPosition,
    context: SiderealContext,
    config: DashaEngineConfig,
    signals: list[Signal],
) -> None:
    """Extract wealth-related Vimshottari signals."""
    house_2_lord = context.houses[2].sign_lord
    house_11_lord = context.houses[11].sign_lord
    if planet.house in [2, 11] or lord in [house_2_lord, house_11_lord]:
        signals.append(
            Signal(
                id=f"vim_{lord.value}_wealth",
                system=DashaSystem.VIMSHOTTARI,
                event_tags=[EventType.WINDFALL],
                weight=config.weights.vim_wealth_house,
                polarity=1 if planet.dignity in [Dignity.EXALTED, Dignity.OWN] else 0,
                rationale=f"{lord.value.title()} activates 2nd/11th (wealth houses)",
                features={"planet": lord.value},
            )
        )


def extract_vimshottari_signals(
    seg: TimeSegment,
    context: SiderealContext,
    karakas: JaiminiKarakas | None,  # Unused, kept for backward compatibility
    config: DashaEngineConfig,
) -> list[Signal]:
    """
    Extract signals from Vimshottari dasha state.

    Analyzes the active dasha lords and their placements to generate
    signals for various life events (career, relationships, health, etc.).

    Args:
        seg: The time segment with Vimshottari state.
        context: The sidereal context with planetary positions.
        karakas: Jaimini karakas (unused, kept for backward compatibility).
        config: Engine configuration with weights.

    Returns:
        List of Signal objects extracted from Vimshottari state.
    """
    del karakas  # Unused, suppress linter warning
    signals: list[Signal] = []
    lords = [seg.vimshottari.md_lord, seg.vimshottari.ad_lord]
    if seg.vimshottari.pd_lord:
        lords.append(seg.vimshottari.pd_lord)

    for lord in lords:
        planet = context.planets.get(lord)
        if not planet:
            continue

        _extract_vim_career_signals(lord, planet, context, config, signals)
        _extract_vim_relationship_signals(lord, planet, context, config, signals)
        _extract_vim_health_signals(lord, planet, context, config, signals)
        _extract_vim_relocation_signals(lord, planet, context, config, signals)
        _extract_vim_wealth_signals(lord, planet, context, config, signals)

    return signals
