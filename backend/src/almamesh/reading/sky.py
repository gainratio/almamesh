"""The slow sky: Jupiter/Saturn/Rahu/Ketu sign spans, Moon-based tags, transit lords.

Spans start from the gochara at the reference instant and change only at the
timeline's own ingress and station events: no position is recomputed here.
Houses are whole-sign from the natal Moon and lagna.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Final, NamedTuple

from almamesh.constants.astrology import PlanetName
from almamesh.reading.common import one_per_day, sign_index_of, sign_key, span_bounds
from almamesh.schemas.reading import SkySpan, TransitLord
from almamesh.schemas.transits import SadeSatiPhase, StationDirection, TransitEventKind
from almamesh.transits.aspects import drishti_offsets
from almamesh.transits.natal import whole_sign_house
from almamesh.transits.sade_sati import sade_sati_phase

if TYPE_CHECKING:
    from datetime import date, datetime

    from almamesh.reading.common import ReadingFrame
    from almamesh.schemas.astrology import DashaPeriod
    from almamesh.schemas.transits import GocharaContext, TimelineEvent, TransitContext

SKY_GRAHAS: Final[tuple[PlanetName, ...]] = (
    PlanetName.JUPITER,
    PlanetName.SATURN,
    PlanetName.RAHU,
    PlanetName.KETU,
)
_SKY_KINDS: Final[frozenset[str]] = frozenset(
    {TransitEventKind.SIGN_INGRESS.value, TransitEventKind.STATION.value}
)
_SADE_SATI_TAGS: Final[dict[SadeSatiPhase, str]] = {
    SadeSatiPhase.RISING: "sade_sati_phase_1",
    SadeSatiPhase.PEAK: "sade_sati_phase_2",
    SadeSatiPhase.SETTING: "sade_sati_phase_3",
}
_SATURN_HOUSE_TAGS: Final[tuple[tuple[frozenset[int], str], ...]] = (
    (frozenset({1, 4, 7, 10}), "kantaka_shani"),
    (frozenset({8}), "ashtama_shani"),
)


class _Cut(NamedTuple):
    """A graha's sign and motion from one instant on."""

    when: datetime
    sign_idx: int
    retro: bool


def _saturn_tags(sign_idx: int, moon_idx: int) -> list[str]:
    """Sade Sati phase (via the transit engine's own rule), then Kantaka/Ashtama."""
    phase = sade_sati_phase(sign_idx, moon_idx)
    tags = [_SADE_SATI_TAGS[phase]] if phase in _SADE_SATI_TAGS else []
    from_moon = whole_sign_house(sign_idx, moon_idx)
    return tags + [tag for houses, tag in _SATURN_HOUSE_TAGS if from_moon in houses]


def sky_tags(graha: PlanetName, sign_idx: int, moon_idx: int) -> list[str]:
    """The Moon-based tags of a slow graha in a sign (nodes carry none)."""
    if graha is PlanetName.JUPITER:
        return [f"jupiter_from_moon_{whole_sign_house(sign_idx, moon_idx)}"]
    if graha is PlanetName.SATURN:
        return _saturn_tags(sign_idx, moon_idx)
    return []


def _advance(cut: _Cut, event: TimelineEvent) -> _Cut:
    """The state after one ingress (new sign) or station (new motion)."""
    if event.kind == TransitEventKind.SIGN_INGRESS:
        return _Cut(event.date, sign_index_of(str(event.to_sign)), cut.retro)
    return _Cut(event.date, cut.sign_idx, event.station_direction == StationDirection.RETROGRADE)


def _graha_cuts(transits: TransitContext, graha: PlanetName) -> list[_Cut]:
    """The graha's state at the instant, then after each of its timeline changes."""
    placement = transits.gochara.placements[graha]
    cut = _Cut(transits.instant, sign_index_of(placement.sign), placement.is_retrograde)
    cuts = [cut]
    for event in transits.timeline.events:
        if event.graha == graha and event.kind in _SKY_KINDS:
            cut = _advance(cut, event)
            cuts.append(cut)
    return cuts


def _span(graha: PlanetName, bounds: tuple[date, date], cut: _Cut, frame: ReadingFrame) -> SkySpan:
    """One wire sky span."""
    return SkySpan(
        graha=graha,
        start=bounds[0],
        end=bounds[1],
        sign=sign_key(cut.sign_idx),
        retro=cut.retro,
        from_moon=frame.from_moon(cut.sign_idx),
        from_lagna=frame.from_lagna(cut.sign_idx),
        sav=frame.sav(cut.sign_idx),
        bav=frame.bav(graha, cut.sign_idx),
        tags=sky_tags(graha, cut.sign_idx, frame.moon_idx),
    )


def _graha_spans(transits: TransitContext, graha: PlanetName, frame: ReadingFrame) -> list[SkySpan]:
    """One graha's spans tiling the window, one change per day at most."""
    end = transits.timeline.window_end
    days = one_per_day(((c.when, c) for c in _graha_cuts(transits, graha)), end)
    bounds = span_bounds([day for day, _ in days], end)
    return [_span(graha, pair, cut, frame) for pair, (_, cut) in zip(bounds, days, strict=True)]


def sky_spans(transits: TransitContext, frame: ReadingFrame) -> list[SkySpan]:
    """Jupiter, Saturn, Rahu and Ketu spans over the window, graha by graha."""
    return [span for graha in SKY_GRAHAS for span in _graha_spans(transits, graha, frame)]


def _transit_lord(gochara: GocharaContext, graha: PlanetName, frame: ReadingFrame) -> TransitLord:
    """One running lord's gochara row at the instant."""
    placement = gochara.placements[graha]
    idx = sign_index_of(placement.sign)
    return TransitLord(
        sign=sign_key(idx),
        from_moon=frame.from_moon(idx),
        from_lagna=frame.from_lagna(idx),
        sav=frame.sav(idx),
        bav=frame.bav(graha, idx),
        retro=placement.is_retrograde,
    )


def transit_lords(
    gochara: GocharaContext, chain: list[DashaPeriod], frame: ReadingFrame
) -> dict[PlanetName, TransitLord]:
    """Each running lord (maha down to sookshma, deduplicated) at the instant."""
    lords = dict.fromkeys(p.lord for p in chain)
    return {lord: _transit_lord(gochara, lord, frame) for lord in lords}


def _touched(graha: PlanetName, sign_idx: int, lagna_idx: int) -> set[int]:
    """Houses from the lagna the graha occupies or aspects (graha drishti)."""
    offsets = drishti_offsets(graha) | {1}
    return {whole_sign_house((sign_idx + off - 1) % 12, lagna_idx) for off in offsets}


def double_transit(gochara: GocharaContext, lagna_idx: int) -> list[int]:
    """Houses from the lagna both Jupiter and Saturn occupy or aspect at the instant."""
    touched = [
        _touched(g, sign_index_of(gochara.placements[g].sign), lagna_idx)
        for g in (PlanetName.JUPITER, PlanetName.SATURN)
    ]
    return sorted(touched[0] & touched[1])


__all__ = ["SKY_GRAHAS", "double_transit", "sky_spans", "sky_tags", "transit_lords"]
