"""Sade Sati phase-boundary events for the timeline.

Each phase segment whose `start` falls in the window becomes a dated event with a
`sade_sati.<phase>.start` descriptor."""

from __future__ import annotations

from typing import TYPE_CHECKING

from almamesh.calculations import AyanamsaType, NodeType
from almamesh.schemas.transits import (
    SadeSatiPhase,
    TimelineEvent,
    TransitEventKind,
    TransitSeverity,
)
from almamesh.transits.sade_sati import build_sade_sati_context

if TYPE_CHECKING:
    from datetime import datetime

    from almamesh.calculations import SkyfieldAstronomy


def _phase_event(phase: str, when: datetime) -> TimelineEvent:
    """One Sade Sati phase-start timeline event."""
    return TimelineEvent(
        date=when,
        kind=TransitEventKind.SADE_SATI_PHASE,
        sade_sati_phase=SadeSatiPhase(phase),
        severity=TransitSeverity.CHALLENGING,
        descriptor=f"sade_sati.{phase}.start",
    )


def sade_sati_phase_events(
    astro: SkyfieldAstronomy,
    moon_idx: int,
    start: datetime,
    end: datetime,
    ayanamsa_type: AyanamsaType = AyanamsaType.LAHIRI,
    node_type: NodeType = NodeType.MEAN,
) -> list[TimelineEvent]:
    """Sade Sati phase boundaries (segment starts) inside [start, end]."""
    ctx = build_sade_sati_context(astro, moon_idx, start, ayanamsa_type, node_type)
    return [_phase_event(seg.phase, seg.start) for seg in ctx.cycle if start <= seg.start <= end]
