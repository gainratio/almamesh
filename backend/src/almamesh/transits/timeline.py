"""Forward timeline of dated, structured, prose-free transit events.

Every Jupiter, Saturn, Mars and Rahu/Ketu sign change, in its real direction;
Jupiter/Saturn/Mars retrograde and direct stations; Vimshottari maha/antar
handovers; Sade Sati phase boundaries. The Sun, Moon, Mercury and Venus move
too fast to be signal over a period. Each event carries a STABLE dotted
`descriptor` key the i18n/LLM layer narrates later.

The timeline is Lahiri ayanamsa + mean node by construction, so it takes no
ayanamsa or node arguments."""

from __future__ import annotations

from datetime import timedelta
from typing import TYPE_CHECKING

from almamesh.constants.astrology import PlanetName
from almamesh.schemas.transits import TimelineEvent, TransitTimeline
from almamesh.transits.natal import natal_moon_index
from almamesh.transits.timeline_dasha import dasha_change_events
from almamesh.transits.timeline_sade_sati import sade_sati_phase_events
from almamesh.transits.timeline_sign_changes import node_sign_change_events, sign_change_events
from almamesh.transits.timeline_stations import station_events

if TYPE_CHECKING:
    from datetime import datetime

    from almamesh.calculations import SkyfieldAstronomy
    from almamesh.schemas.astrology import SiderealContext

_DAYS_PER_MONTH = 30.4375
_INGRESS_GRAHAS = (PlanetName.JUPITER, PlanetName.SATURN, PlanetName.MARS)
_STATION_GRAHAS = (PlanetName.JUPITER, PlanetName.SATURN, PlanetName.MARS)


def _collect(
    astro: SkyfieldAstronomy,
    natal: SiderealContext,
    birth_dt: datetime,
    start: datetime,
    end: datetime,
) -> list[TimelineEvent]:
    """Gather every event kind in the window before sorting."""
    events: list[TimelineEvent] = []
    for graha in _INGRESS_GRAHAS:
        events += sign_change_events(astro, graha, start, end)
    events += node_sign_change_events(astro, start, end)
    for graha in _STATION_GRAHAS:
        events += station_events(astro, graha, start, end)
    events += dasha_change_events(natal, birth_dt, start, end)
    events += sade_sati_phase_events(astro, natal_moon_index(natal), start, end)
    return events


def build_timeline(
    astro: SkyfieldAstronomy,
    natal: SiderealContext,
    birth_dt: datetime,
    start: datetime,
    window_months: int = 12,
) -> TransitTimeline:
    """Build the chronologically-sorted forward timeline over the window."""
    end = start + timedelta(days=_DAYS_PER_MONTH * window_months)
    events = _collect(astro, natal, birth_dt, start, end)
    events.sort(key=lambda e: e.date)
    return TransitTimeline(window_start=start, window_end=end, events=events)
