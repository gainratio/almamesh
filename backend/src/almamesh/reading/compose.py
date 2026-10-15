"""Compose the period reading from contexts one predictive run already computed.

Pure and READ-ONLY: natal, transits (timeline, gochara, Sade Sati), vargas,
strength (ashtakavarga) and domains in, one ``PeriodReading`` out. No ephemeris
call happens here; dasha depth and Yogini are arithmetic over the natal Moon.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from almamesh.dasha.depth import active_chain, level_spans
from almamesh.reading.bounds import bounded_transits
from almamesh.reading.classical import ChartLords
from almamesh.reading.common import ReadingFrame, utc_date
from almamesh.reading.dashas import dasha_spans, sandhi, sookshma, yogini_spans
from almamesh.reading.lords import natal_lords
from almamesh.reading.panchang import panchang_from
from almamesh.reading.rules import READING_RULES
from almamesh.reading.segments import reading_segments
from almamesh.reading.sky import double_transit, sky_spans, transit_lords
from almamesh.reading.themes import ThemeInputs, reading_themes
from almamesh.schemas.reading import DashaLevel, PeriodReading, ReadingWindow
from almamesh.transits.natal import natal_lagna_index, natal_moon_index

if TYPE_CHECKING:
    from datetime import date, datetime

    from almamesh.constants.astrology import PlanetName
    from almamesh.schemas.astrology import DashaPeriod, SiderealContext
    from almamesh.schemas.domains import LifeDomainsContext
    from almamesh.schemas.reading import SkySpan, YoginiSpan
    from almamesh.schemas.strength import StrengthContext
    from almamesh.schemas.transits import TransitContext
    from almamesh.schemas.vargas import VargaContext

_RUNNING_LEVELS = (DashaLevel.MAHA, DashaLevel.ANTAR, DashaLevel.PRATYANTAR)


def _running(spans: dict[DashaLevel, list[DashaPeriod]]) -> list[tuple[DashaLevel, PlanetName]]:
    """Each lord running in the window, labelled with the outermost level it runs at."""
    first: dict[PlanetName, DashaLevel] = {}
    for level in _RUNNING_LEVELS:
        for period in spans[level]:
            first.setdefault(period.lord, level)
    return [(level, lord) for lord, level in first.items()]


@dataclass(frozen=True)
class _Run:
    """The pieces of one run the reading is assembled from."""

    natal: SiderealContext
    transits: TransitContext
    vargas: VargaContext
    spans: dict[DashaLevel, list[DashaPeriod]]
    chain: list[DashaPeriod]
    frame: ReadingFrame
    lords: ChartLords
    yogini: tuple[YoginiSpan | None, YoginiSpan | None]
    sky: list[SkySpan]
    themes: ThemeInputs

    @property
    def start(self) -> datetime:
        return self.transits.timeline.window_start

    @property
    def end(self) -> datetime:
        return self.transits.timeline.window_end


def _prepare(
    natal: SiderealContext,
    transits: TransitContext,
    vargas: VargaContext,
    strength: StrengthContext,
    domains: LifeDomainsContext,
) -> _Run:
    """Dasha depth, the natal frame, the Yogini maha and antar and the sky for the window."""
    start, end = transits.timeline.window_start, transits.timeline.window_end
    spans = level_spans(natal.dashas.maha_dasha_sequence, start, end)
    frame = ReadingFrame(natal_moon_index(natal), natal_lagna_index(natal), strength.ashtakavarga)
    chain = active_chain(natal.dashas.maha_dasha_sequence, transits.instant)
    lords = ChartLords(natal, strength.shadbala)
    yogini = yogini_spans(natal, transits.instant)
    sky = sky_spans(transits, frame)
    themes = ThemeInputs(natal, domains, _running(spans), yogini[0], sky, start, end, lords)
    return _Run(natal, transits, vargas, spans, chain, frame, lords, yogini, sky, themes)


def _assemble(run: _Run) -> PeriodReading:
    """The wire reading from the prepared pieces."""
    mahas, gochara = run.natal.dashas.maha_dasha_sequence, run.transits.gochara
    return PeriodReading(
        window=ReadingWindow(start=utc_date(run.start), end=utc_date(run.end)),
        natal_lords=natal_lords(run.lords, run.vargas),
        dasha_spans=dasha_spans(run.spans, (run.start, run.end), run.lords),
        sookshma=sookshma(run.chain, run.lords),
        sandhi=sandhi(run.spans, run.start, run.end),
        yogini=run.yogini[0],
        yogini_antar=run.yogini[1],
        segments=reading_segments(mahas, run.spans, run.transits.timeline),
        sky=run.sky,
        transit_lords=transit_lords(gochara, run.chain, run.frame),
        double_transit=double_transit(gochara, run.frame.lagna_idx),
        themes=reading_themes(run.themes),
        panchang=panchang_from(gochara),
        rules=list(READING_RULES),
    )


def compute_period_reading(
    natal: SiderealContext,
    transits: TransitContext,
    vargas: VargaContext,
    strength: StrengthContext,
    domains: LifeDomainsContext,
    *,
    reading_end: date | None = None,
) -> PeriodReading:
    """The period reading for [reference day, reading_end] inside the transit window.

    ``reading_end`` is the reading's INCLUSIVE last UTC day; absent means the
    reference day only. Segments, spans, sandhi and themes read only the bounded
    timeline; sookshma, panchang and the gochara rows stay at the reference instant.
    """
    bounded = bounded_transits(transits, reading_end)
    return _assemble(_prepare(natal, bounded, vargas, strength, domains))


__all__ = ["compute_period_reading"]
