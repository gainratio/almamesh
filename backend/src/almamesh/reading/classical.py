"""Classical dasha rules (spec ``docs/superpowers/specs/2026-10-15-classical-dasha-rules.md``).

R1 relevance (a lord's lordship, occupancy or karakatva for an area), R2 a sub-lord
counted from its parent lord, R3 sign dignity and strength, R7 the graded score
(level- and time-weighted, 0-100) and the tone. Pure and read-only over the natal
chart and its Shadbala: no ephemeris call. The weights are fixed constants, stated
in the spec before any eval run; nothing here was fitted to data.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Final, Protocol

from almamesh.calculations import get_dignity
from almamesh.constants.astrology import SIGN_LORDS, Dignity, PlanetName, ZodiacSign
from almamesh.dasha.depth import level_spans
from almamesh.dasha.yogini import compute_yogini_periods, yogini_antars
from almamesh.reading.common import sign_index_of
from almamesh.reading.functional import functional_nature
from almamesh.schemas.reading import (
    DashaLevel,
    FunctionalNature,
    LordStrength,
    Relation,
    SignDignity,
    Tone,
)
from almamesh.strength.friendship import Relationship, natural_relationship

if TYPE_CHECKING:
    from collections.abc import Sequence
    from datetime import datetime

    from almamesh.dasha.models import YoginiPeriod
    from almamesh.domains.recipes import DomainRecipe
    from almamesh.schemas.astrology import DashaPeriod, SiderealContext
    from almamesh.schemas.strength import ShadbalaContext

AGREEMENT_THRESHOLD: Final[int] = 50
_SUPPORT_HOUSES: Final[frozenset[int]] = frozenset({1, 4, 5, 7, 9, 10, 11})
_FRICTION_HOUSES: Final[frozenset[int]] = frozenset({6, 8, 12})
_KARAKA_WEIGHT: Final[float] = 0.5
_MULTIPLIER: Final[dict[LordStrength, float]] = {
    LordStrength.STRONG: 1.0,
    LordStrength.ORDINARY: 0.75,
    LordStrength.WEAK: 0.5,
}
_VIMSHOTTARI_WEIGHTS: Final[tuple[tuple[DashaLevel, int], ...]] = (
    (DashaLevel.MAHA, 3),
    (DashaLevel.ANTAR, 2),
    (DashaLevel.PRATYANTAR, 1),
)
_YOGINI_MAHA_WEIGHT: Final[int] = 2
_YOGINI_ANTAR_WEIGHT: Final[int] = 1
_NODES: Final[frozenset[PlanetName]] = frozenset({PlanetName.RAHU, PlanetName.KETU})
_BY_RELATIONSHIP: Final[dict[Relationship, SignDignity]] = {
    Relationship.FRIEND: SignDignity.FRIEND,
    Relationship.NEUTRAL: SignDignity.NEUTRAL,
    Relationship.ENEMY: SignDignity.ENEMY,
}
_NATURE_VALENCE: Final[dict[FunctionalNature, int]] = {
    FunctionalNature.YOGAKARAKA: 1,
    FunctionalNature.BENEFIC: 1,
    FunctionalNature.MALEFIC: -1,
    FunctionalNature.MARAKA: -1,
    FunctionalNature.NEUTRAL: 0,
}
_STRENGTH_VALENCE: Final[dict[LordStrength, int]] = {
    LordStrength.STRONG: 1,
    LordStrength.ORDINARY: 0,
    LordStrength.WEAK: -1,
}
_RELATION_VALENCE: Final[dict[Relation, int]] = {
    Relation.SUPPORT: 1,
    Relation.NEUTRAL: 0,
    Relation.FRICTION: -1,
}


class _Span(Protocol):
    """Any dasha period: a lord running over [start_date, end_date)."""

    @property
    def lord(self) -> PlanetName: ...
    @property
    def start_date(self) -> datetime: ...
    @property
    def end_date(self) -> datetime: ...


@dataclass(frozen=True)
class Area:
    """A life area's whole-sign houses and its counted karakas."""

    houses: frozenset[int]
    karakas: frozenset[PlanetName]


def area_of(recipe: DomainRecipe) -> Area:
    """The area of a domain recipe; an activation-only domain counts no karakas."""
    karakas = () if recipe.activation_only else tuple(rule.graha for rule in recipe.karakas)
    return Area(frozenset(rule.house for rule in recipe.houses), frozenset(karakas))


def relation_from(parent_sign: int, child_sign: int) -> tuple[int, Relation]:
    """R2: the child's whole-sign house from the parent, and its relation."""
    house = (child_sign - parent_sign) % 12 + 1
    if house in _FRICTION_HOUSES:
        return house, Relation.FRICTION
    return house, Relation.SUPPORT if house in _SUPPORT_HOUSES else Relation.NEUTRAL


def sign_dignity(graha: PlanetName, sign: ZodiacSign) -> SignDignity:
    """R3: exalted / debilitated / own, else natural friendship to the sign lord."""
    if graha in _NODES:
        return SignDignity.NEUTRAL
    lord = SIGN_LORDS[sign]
    base = get_dignity(graha, sign, lord)
    if base is not Dignity.NEUTRAL:
        return SignDignity(base.value)
    return _BY_RELATIONSHIP[natural_relationship(graha, lord)]


def strength_band(
    dignity: SignDignity, *, combust: bool, retro: bool, meets_minimum: bool | None
) -> LordStrength:
    """R3: the first matching rule decides; else ordinary."""
    rules = (
        (combust, LordStrength.WEAK),
        (retro, LordStrength.STRONG),
        (dignity in {SignDignity.EXALTED, SignDignity.OWN}, LordStrength.STRONG),
        (dignity is SignDignity.DEBILITATED, LordStrength.WEAK),
        (dignity is SignDignity.FRIEND and meets_minimum is True, LordStrength.STRONG),
        (dignity is SignDignity.ENEMY and meets_minimum is False, LordStrength.WEAK),
    )
    return next((band for hit, band in rules if hit), LordStrength.ORDINARY)


@dataclass(frozen=True)
class ChartLords:
    """The natal facts the classical rules read for each graha."""

    natal: SiderealContext
    shadbala: ShadbalaContext

    def dignity(self, graha: PlanetName) -> SignDignity:
        """The graha's natal sign dignity."""
        return sign_dignity(graha, self.natal.planets[graha].sign)

    def strength(self, graha: PlanetName) -> LordStrength:
        """R3 for the natal graha (nodes: no Shadbala, retrograde not counted)."""
        placement, bala = self.natal.planets[graha], self.shadbala.planets.get(graha)
        return strength_band(
            self.dignity(graha),
            combust=placement.is_combust,
            retro=placement.is_retrograde and bala is not None,
            meets_minimum=None if bala is None else bala.meets_minimum,
        )

    def relevance(self, graha: PlanetName, area: Area) -> float:
        """R1: 1 if it sits in or rules an area house, 0.5 if only a karaka, else 0."""
        placement = self.natal.planets[graha]
        if placement.house in area.houses or area.houses.intersection(placement.houses_ruled):
            return 1.0
        return _KARAKA_WEIGHT if graha in area.karakas else 0.0

    def weight(self, graha: PlanetName, area: Area) -> float:
        """Relevance scaled by strength."""
        return self.relevance(graha, area) * _MULTIPLIER[self.strength(graha)]

    def relation(self, parent: PlanetName, child: PlanetName) -> tuple[int, Relation]:
        """R2 between two natal grahas."""
        signs = self.natal.planets
        return relation_from(sign_index_of(signs[parent].sign), sign_index_of(signs[child].sign))

    def valence(self, graha: PlanetName, relation: Relation | None) -> int:
        """R7 tone vote: functional nature + strength + placement from the parent."""
        placement = self.natal.planets[graha]
        nature = functional_nature(placement.houses_ruled, is_yogakaraka=placement.is_yogakaraka)
        placed = 0 if relation is None else _RELATION_VALENCE[relation]
        return _NATURE_VALENCE[nature] + _STRENGTH_VALENCE[self.strength(graha)] + placed


def _share(span: _Span, start: datetime, end: datetime) -> float:
    """The fraction of [start, end) the span covers."""
    overlap = min(span.end_date, end) - max(span.start_date, start)
    return max(overlap / (end - start), 0.0)


def graded_score(
    lords: ChartLords,
    area: Area,
    levels: Sequence[tuple[int, Sequence[_Span]]],
    window: tuple[datetime, datetime],
) -> int:
    """R7: 100 x the level-, time- and strength-weighted mean relevance, rounded."""
    total = sum(weight for weight, _ in levels)
    hits = sum(
        weight * _share(span, *window) * lords.weight(span.lord, area)
        for weight, spans in levels
        for span in spans
    )
    return round(100 * hits / total)


def vimshottari_score(lords: ChartLords, area: Area, start: datetime, end: datetime) -> int:
    """The area's graded Vimshottari score over [start, end) (maha 3, antar 2, pratyantar 1)."""
    spans = level_spans(lords.natal.dashas.maha_dasha_sequence, start, end)
    levels = [(weight, spans[level]) for level, weight in _VIMSHOTTARI_WEIGHTS]
    return graded_score(lords, area, levels, (start, end))


def running_yogini(
    natal: SiderealContext, start: datetime, end: datetime
) -> tuple[list[YoginiPeriod], list[YoginiPeriod]]:
    """The Yogini mahas and antars that share time with [start, end)."""
    mahas = natal.dashas.maha_dasha_sequence
    yoginis = compute_yogini_periods(natal, mahas[0].start_date, mahas[-1].end_date)
    running = [p for p in yoginis if p.start_date < end and p.end_date > start]
    antars = [a for maha in running for a in yogini_antars(maha) if a.end_date > start]
    return running, [a for a in antars if a.start_date < end]


def yogini_score(lords: ChartLords, area: Area, start: datetime, end: datetime) -> int:
    """The area's graded Yogini score over [start, end) (maha 2, antar 1)."""
    running, antars = running_yogini(lords.natal, start, end)
    levels: list[tuple[int, Sequence[_Span]]] = [
        (_YOGINI_MAHA_WEIGHT, running),
        (_YOGINI_ANTAR_WEIGHT, antars),
    ]
    return graded_score(lords, area, levels, (start, end))


def _containing(periods: Sequence[DashaPeriod], instant: datetime) -> DashaPeriod | None:
    return next((p for p in periods if p.start_date <= instant < p.end_date), None)


def with_parents(
    spans: dict[DashaLevel, list[DashaPeriod]],
) -> list[tuple[DashaLevel, DashaPeriod, DashaPeriod | None]]:
    """Every maha/antar/pratyantar span with the parent span it runs inside (None for a maha)."""
    rows: list[tuple[DashaLevel, DashaPeriod, DashaPeriod | None]] = [
        (DashaLevel.MAHA, maha, None) for maha in spans[DashaLevel.MAHA]
    ]
    for parent, level in (
        (DashaLevel.MAHA, DashaLevel.ANTAR),
        (DashaLevel.ANTAR, DashaLevel.PRATYANTAR),
    ):
        rows += [(level, p, _containing(spans[parent], p.start_date)) for p in spans[level]]
    return rows


def span_relation(
    lords: ChartLords, span: _Span, parent: _Span | None
) -> tuple[int, Relation] | None:
    """R2 for a span inside its parent; None for a maha."""
    return None if parent is None else lords.relation(parent.lord, span.lord)


def _span_valence(lords: ChartLords, span: _Span, parent: _Span | None) -> int:
    relation = span_relation(lords, span, parent)
    return lords.valence(span.lord, None if relation is None else relation[1])


def _tone(valences: list[int]) -> Tone:
    signs = {v > 0 for v in valences if v != 0}
    if signs == {True}:
        return "supportive"
    return "challenging" if signs == {False} else "mixed"


def dasha_tone(lords: ChartLords, area: Area, start: datetime, end: datetime) -> Tone | None:
    """R7 tone over the Vimshottari spans tied to the area; None when none is."""
    spans = level_spans(lords.natal.dashas.maha_dasha_sequence, start, end)
    valences = [
        _span_valence(lords, span, parent)
        for _, span, parent in with_parents(spans)
        if lords.relevance(span.lord, area) > 0
    ]
    return _tone(valences) if valences else None


__all__ = [
    "AGREEMENT_THRESHOLD",
    "Area",
    "ChartLords",
    "area_of",
    "dasha_tone",
    "graded_score",
    "relation_from",
    "running_yogini",
    "sign_dignity",
    "span_relation",
    "strength_band",
    "vimshottari_score",
    "with_parents",
    "yogini_score",
]
