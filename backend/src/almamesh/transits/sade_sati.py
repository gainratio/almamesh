"""Sade Sati — Saturn's ~7.5-year passage over the 12th, 1st and 2nd signs from
the natal Moon (Janma Rasi). Three phases: rising (12th), peak (over the Moon),
setting (2nd). Phase boundaries are Saturn sign-cusp ingresses found with the
retrograde-aware last-crossing rule (spec section 3.2)."""

from __future__ import annotations

from typing import TYPE_CHECKING

from almamesh.calculations import AyanamsaType, NodeType
from almamesh.constants.astrology import ZODIAC_SIGNS, PlanetName, ZodiacSign
from almamesh.schemas.transits import SadeSatiContext, SadeSatiPhase, SadeSatiSegment
from almamesh.transits.natal import sign_index
from almamesh.transits.positions import transit_longitude
from almamesh.transits.saturn_cusp import ingress_after, ingress_before

if TYPE_CHECKING:
    from datetime import datetime

    from almamesh.calculations import SkyfieldAstronomy

# Saturn-occupied sign offsets from the natal Moon for each phase, in order.
_PHASE_OFFSETS: tuple[tuple[SadeSatiPhase, int], ...] = (
    (SadeSatiPhase.RISING, -1),  # Saturn in the 12th from the Moon
    (SadeSatiPhase.PEAK, 0),  # Saturn over the Moon sign itself
    (SadeSatiPhase.SETTING, 1),  # Saturn in the 2nd from the Moon
)


def sade_sati_phase(saturn_idx: int, moon_idx: int) -> SadeSatiPhase:
    """Which Sade Sati phase (or NONE) Saturn's current sign corresponds to."""
    for phase, offset in _PHASE_OFFSETS:
        if saturn_idx == (moon_idx + offset) % 12:
            return phase
    return SadeSatiPhase.NONE


def _peak_entry(astro: SkyfieldAstronomy, moon_idx: int, instant: datetime) -> datetime | None:
    """Saturn's sticking entry into the Moon sign — anchor of the whole cycle.

    Prefer the sticking entry at/before `instant` (active/just-finished peak);
    otherwise the next sticking entry forward — which, during a retrograde
    excursion, is the LAST crossing of the cusp (the one that sticks).
    """
    return ingress_before(astro, moon_idx, instant) or ingress_after(astro, moon_idx, instant)


def _boundaries(
    astro: SkyfieldAstronomy, moon_idx: int, peak_start: datetime
) -> list[datetime] | None:
    """The four chained ingress instants: into (M-1), M, (M+1), (M+2)."""
    rising = ingress_before(astro, (moon_idx - 1) % 12, peak_start)
    setting = ingress_after(astro, (moon_idx + 1) % 12, peak_start)
    if rising is None or setting is None:
        return None
    cycle_end = ingress_after(astro, (moon_idx + 2) % 12, setting)
    return None if cycle_end is None else [rising, peak_start, setting, cycle_end]


def _segments(moon_idx: int, bounds: list[datetime]) -> list[SadeSatiSegment]:
    """Three dated phase spans tiled by the four chained boundary instants."""
    out: list[SadeSatiSegment] = []
    for i, (phase, offset) in enumerate(_PHASE_OFFSETS):
        sign = ZodiacSign(ZODIAC_SIGNS[(moon_idx + offset) % 12])
        out.append(
            SadeSatiSegment(phase=phase, saturn_sign=sign, start=bounds[i], end=bounds[i + 1])
        )
    return out


def _build_cycle(
    astro: SkyfieldAstronomy, moon_idx: int, instant: datetime
) -> list[SadeSatiSegment]:
    """The three phase segments (rising, peak, setting) in chronological order."""
    peak_start = _peak_entry(astro, moon_idx, instant)
    if peak_start is None:
        return []
    bounds = _boundaries(astro, moon_idx, peak_start)
    return _segments(moon_idx, bounds) if bounds else []


def _saturn_sign_index(astro: SkyfieldAstronomy, instant: datetime) -> int:
    """The sign index Saturn currently occupies, floored like the natal code."""
    lon = transit_longitude(astro, PlanetName.SATURN, instant, AyanamsaType.LAHIRI, NodeType.MEAN)
    return sign_index(lon)


def build_sade_sati_context(
    astro: SkyfieldAstronomy, moon_idx: int, instant: datetime
) -> SadeSatiContext:
    """Detect the phase, active flag, and dated 3-phase cycle for a Moon sign."""
    saturn_idx = _saturn_sign_index(astro, instant)
    phase = sade_sati_phase(saturn_idx, moon_idx)
    cycle = _build_cycle(astro, moon_idx, instant)
    active = phase is not SadeSatiPhase.NONE
    return SadeSatiContext(
        is_active=active,
        current_phase=phase,
        natal_moon_sign=ZodiacSign(ZODIAC_SIGNS[moon_idx % 12]),
        cycle=cycle,
        cycle_start=cycle[0].start if active and cycle else None,
        cycle_end=cycle[-1].end if active and cycle else None,
    )
