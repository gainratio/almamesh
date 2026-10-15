"""
Yogini Dasha System.

Implements the 36-year Yogini dasha cycle based on Moon's nakshatra.
This is a shorter timing system often used for more precise timing
and as a confirming factor alongside Vimshottari.

The 8 Yoginis and their durations:
Mangala (Moon, 1) -> Pingala (Sun, 2) -> Dhanya (Jupiter, 3) ->
Bhramari (Mars, 4) -> Bhadrika (Mercury, 5) -> Ulka (Saturn, 6) ->
Siddha (Venus, 7) -> Sankata (Rahu, 8)
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import TYPE_CHECKING

from almamesh.constants.astrology import (
    NAKSHATRA_NAMES,
    YOGINI_SEQUENCE,
    DashaSystem,
    EventType,
    PlanetName,
)
from almamesh.dasha.convention import (
    DEFAULT_DASHA_YEAR_CONVENTION,
    DashaYearConvention,
)
from almamesh.dasha.models import (
    DashaEngineConfig,
    Signal,
    TimeSegment,
    YoginiPeriod,
    YoginiState,
)
from almamesh.schemas.astrology import PlanetPosition, SiderealContext

if TYPE_CHECKING:
    from almamesh.dasha.models import JaiminiKarakas


# =============================================================================
# YOGINI PERIOD COMPUTATION
# =============================================================================


def _get_yogini_start_info(moon: PlanetPosition) -> tuple[int, float]:
    """
    Calculate starting yogini index and balance consumed.

    Args:
        moon: Moon's position with nakshatra information.

    Returns:
        Tuple of (starting yogini index, portion consumed).
    """
    nak_idx = NAKSHATRA_NAMES.index(moon.nakshatra)
    start_yogini_idx = (nak_idx + 3) % 8

    # Balance calculation
    nak_span = 360 / 27
    nak_start = nak_idx * nak_span
    portion_consumed = (moon.longitude - nak_start) / nak_span

    return start_yogini_idx, portion_consumed


def _add_yogini_period(
    periods: list[YoginiPeriod],
    name: str,
    lord: PlanetName,
    years: float,
    start: datetime,
    end: datetime,
    window_start: datetime,
    window_end: datetime,
) -> None:
    """Add a yogini period if it overlaps with the requested window."""
    if end >= window_start and start <= window_end:
        periods.append(
            YoginiPeriod(
                yogini_name=name,
                lord=lord,
                start_date=max(start, window_start),
                end_date=min(end, window_end),
                duration_years=years,
            )
        )


def compute_yogini_periods(
    context: SiderealContext,
    start_date: datetime,
    end_date: datetime,
    convention: DashaYearConvention = DEFAULT_DASHA_YEAR_CONVENTION,
) -> list[YoginiPeriod]:
    """
    Calculate Yogini Dasha periods based on Moon's nakshatra.

    The starting Yogini is determined by Moon's birth nakshatra,
    with balance calculated from Moon's position within the nakshatra.

    Args:
        context: The sidereal context with Moon's position.
        start_date: Start of analysis window.
        end_date: End of analysis window.

    Returns:
        List of YoginiPeriod objects covering the time window.
    """
    if not context.dashas.maha_dasha_sequence:
        return []

    start_idx, portion = _get_yogini_start_info(context.planets[PlanetName.MOON])
    current_date = context.dashas.maha_dasha_sequence[0].start_date
    periods: list[YoginiPeriod] = []

    # First period (with balance)
    name, lord, years = YOGINI_SEQUENCE[start_idx]
    rem_years = years * (1 - portion)
    period_end = current_date + timedelta(days=rem_years * convention.days_per_year)

    _add_yogini_period(
        periods, name, lord, rem_years, current_date, period_end, start_date, end_date
    )
    current_date = period_end

    # Subsequent periods (cycle through 36-year sequence)
    max_cycles = 10
    for _ in range(max_cycles):
        for i in range(8):
            if current_date > end_date:
                return periods
            idx = (start_idx + 1 + i) % 8
            name, lord, years = YOGINI_SEQUENCE[idx]
            period_end = current_date + timedelta(days=years * convention.days_per_year)
            _add_yogini_period(
                periods, name, lord, years, current_date, period_end, start_date, end_date
            )
            current_date = period_end

    return periods


_CYCLE_YEARS = 36
_YOGINI_INDEX = {name: idx for idx, (name, _lord, _years) in enumerate(YOGINI_SEQUENCE)}


def _virtual_start(maha: YoginiPeriod, convention: DashaYearConvention) -> datetime:
    """The start of the FULL maha: before birth for the birth maha's balance."""
    full = YOGINI_SEQUENCE[_YOGINI_INDEX[maha.yogini_name]][2]
    return maha.start_date - timedelta(days=(full - maha.duration_years) * convention.days_per_year)


def _antar_rows(
    maha: YoginiPeriod, convention: DashaYearConvention
) -> list[tuple[str, PlanetName, float, datetime, datetime]]:
    """The eight full antars (name, lord, years, start, end) from the virtual start."""
    first = _YOGINI_INDEX[maha.yogini_name]
    full = YOGINI_SEQUENCE[first][2]
    cursor, rows = _virtual_start(maha, convention), []
    for step in range(len(YOGINI_SEQUENCE)):
        name, lord, years = YOGINI_SEQUENCE[(first + step) % len(YOGINI_SEQUENCE)]
        length = full * years / _CYCLE_YEARS
        end = cursor + timedelta(days=length * convention.days_per_year)
        rows.append((name, lord, length, cursor, end))
        cursor = end
    return rows


def yogini_antars(
    maha: YoginiPeriod, convention: DashaYearConvention = DEFAULT_DASHA_YEAR_CONVENTION
) -> list[YoginiPeriod]:
    """The Yogini antardashas of one (unclipped-start) maha, clipped to it.

    Proportional (standard): an antar lasts maha years x its Yogini's years / 36,
    in Yogini order from the maha's own Yogini. The birth maha is the tail of a full
    maha, so its antars are dated from the virtual start before birth (like the
    Vimshottari birth balance); antars wholly before birth are dropped. The last
    antar closes exactly at the maha's end.
    """
    rows = _antar_rows(maha, convention)
    return [
        YoginiPeriod(
            yogini_name=name,
            lord=lord,
            start_date=max(start, maha.start_date),
            end_date=maha.end_date if name == rows[-1][0] else min(end, maha.end_date),
            duration_years=years,
        )
        for name, lord, years, start, end in rows
        if end > maha.start_date
    ]


def find_active_yogini(periods: list[YoginiPeriod], dt: datetime) -> YoginiState:
    """
    Find the active Yogini state at a given datetime.

    Args:
        periods: List of YoginiPeriod objects.
        dt: The datetime to check.

    Returns:
        YoginiState with active yogini name and lord.
    """
    for p in periods:
        if p.start_date <= dt < p.end_date:
            return YoginiState(yogini_name=p.yogini_name, lord=p.lord)
    # Fallback
    if periods:
        return YoginiState(yogini_name=periods[0].yogini_name, lord=periods[0].lord)
    return YoginiState(yogini_name="Mangala", lord=PlanetName.MOON)


# =============================================================================
# YOGINI SIGNAL EXTRACTION
# =============================================================================


def _extract_yogini_career_signals(
    planet: PlanetPosition,
    state: YoginiState,
    yogini_lord: PlanetName,
    config: DashaEngineConfig,
    signals: list[Signal],
) -> None:
    """Extract career-related Yogini signals."""
    if planet.house == 10:
        signals.append(
            Signal(
                id=f"yogini_{yogini_lord.value}_10th",
                system=DashaSystem.YOGINI,
                event_tags=[EventType.CAREER_CHANGE, EventType.PROMOTION],
                weight=config.weights.yogini_boost,
                polarity=1,
                rationale=f"Yogini {state.yogini_name} lord in 10th (career trigger)",
                features={"yogini": state.yogini_name, "planet": yogini_lord.value},
            )
        )


def _extract_yogini_relationship_signals(
    planet: PlanetPosition,
    state: YoginiState,
    yogini_lord: PlanetName,
    config: DashaEngineConfig,
    signals: list[Signal],
) -> None:
    """Extract relationship-related Yogini signals."""
    if planet.house == 7:
        signals.append(
            Signal(
                id=f"yogini_{yogini_lord.value}_7th",
                system=DashaSystem.YOGINI,
                event_tags=[EventType.MARRIAGE, EventType.ENGAGEMENT],
                weight=config.weights.yogini_boost,
                polarity=1,
                rationale="Yogini period triggers 7th house (relationship timing)",
                features={"yogini": state.yogini_name, "planet": yogini_lord.value},
            )
        )


def _extract_yogini_relocation_signals(
    planet: PlanetPosition,
    state: YoginiState,
    yogini_lord: PlanetName,
    config: DashaEngineConfig,
    signals: list[Signal],
) -> None:
    """Extract relocation-related Yogini signals."""
    if planet.house in [4, 12]:
        signals.append(
            Signal(
                id=f"yogini_{yogini_lord.value}_relocation",
                system=DashaSystem.YOGINI,
                event_tags=[EventType.RELOCATION],
                weight=config.weights.yogini_boost,
                polarity=0,
                rationale="Yogini period activates 4th/12th (relocation timing)",
                features={"yogini": state.yogini_name, "planet": yogini_lord.value},
            )
        )


def _extract_yogini_health_signals(
    planet: PlanetPosition,
    state: YoginiState,
    yogini_lord: PlanetName,
    config: DashaEngineConfig,
    signals: list[Signal],
) -> None:
    """Extract health-related Yogini signals."""
    if planet.house in [6, 8]:
        signals.append(
            Signal(
                id=f"yogini_{yogini_lord.value}_health",
                system=DashaSystem.YOGINI,
                event_tags=[EventType.HEALTH_ISSUE],
                weight=config.weights.yogini_boost,
                polarity=-1,
                rationale="Yogini period lord in 6th/8th (health attention needed)",
                features={"yogini": state.yogini_name, "planet": yogini_lord.value},
            )
        )


def extract_yogini_signals(
    seg: TimeSegment,
    context: SiderealContext,
    karakas: JaiminiKarakas | None,  # Unused, kept for backward compatibility
    config: DashaEngineConfig,
) -> list[Signal]:
    """
    Extract signals from Yogini dasha state (short-term triggers).

    Yogini signals act as timing refinements and confirmations for
    longer-term Vimshottari predictions.

    Args:
        seg: The time segment with Yogini state.
        context: The sidereal context with planetary positions.
        karakas: Jaimini karakas (unused, kept for backward compatibility).
        config: Engine configuration with weights.

    Returns:
        List of Signal objects extracted from Yogini state.
    """
    del karakas  # Unused, suppress linter warning
    signals: list[Signal] = []
    yogini_lord = seg.yogini.lord
    planet = context.planets.get(yogini_lord)

    if not planet:
        return signals

    _extract_yogini_career_signals(planet, seg.yogini, yogini_lord, config, signals)
    _extract_yogini_relationship_signals(planet, seg.yogini, yogini_lord, config, signals)
    _extract_yogini_relocation_signals(planet, seg.yogini, yogini_lord, config, signals)
    _extract_yogini_health_signals(planet, seg.yogini, yogini_lord, config, signals)

    return signals
