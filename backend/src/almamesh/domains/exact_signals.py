"""Exact-transit signals per life area and month (technique #1), behind a flag.

A month scores for a domain when a slow mover (Saturn, Jupiter, Rahu, Ketu; Mars too
for a recipe with ``mars_windows``) is within orb of a natal point that signifies the
domain: 0.5 for the contact, plus 0.5 when the touched graha is the running
Vimshottari maha or antar lord. Relevance reuses the recipes' significator rule
(house lords, occupants, counted karakas) and the lagna when the 1st is a domain house.

``ExactTransitSettings.enabled`` defaults off: the shipped reading does not use this
family until it passes the promotion rule on HELD-OUT data (learning-loop spec §2).
The retrodiction harness scores the same rule as the ``exact_transits`` family.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Final, TypeAlias

from almamesh.constants.astrology import PlanetName
from almamesh.dasha.depth import level_spans
from almamesh.domains.recipes import DOMAIN_RECIPES
from almamesh.domains.significators import domain_house_numbers, significator_grahas
from almamesh.transits.exact import (
    EXACT_ORB_DEG,
    LAGNA_POINT,
    Contact,
    ContactBook,
    astro_movers,
    natal_points,
)

if TYPE_CHECKING:
    from collections.abc import Sequence

    from almamesh.calculations import SkyfieldAstronomy
    from almamesh.domains.recipes import DomainRecipe
    from almamesh.schemas.astrology import SiderealContext
    from almamesh.schemas.domains import LifeDomain

YearMonth: TypeAlias = tuple[int, int]

SLOW_MOVERS: Final[frozenset[PlanetName]] = frozenset(
    {PlanetName.SATURN, PlanetName.JUPITER, PlanetName.RAHU, PlanetName.KETU}
)
_HALF: Final[float] = 0.5


@dataclass(frozen=True)
class ExactTransitSettings:
    """Off by default; the orb is the pre-registered constant."""

    enabled: bool = False
    orb_deg: float = EXACT_ORB_DEG


def contact_score(
    contacts: frozenset[Contact],
    movers: frozenset[PlanetName],
    relevant: frozenset[str],
    dasha_points: frozenset[str],
) -> float:
    """0.5 for a mover on a relevant point, plus 0.5 if that point is a running dasha lord."""
    touched = {point for graha, point in contacts if graha in movers} & relevant
    return _HALF * bool(touched) + _HALF * bool(touched & dasha_points)


def domain_movers(recipe: DomainRecipe) -> frozenset[PlanetName]:
    """The slow movers, plus Mars for a recipe that dates Mars windows (obstacles)."""
    return SLOW_MOVERS | ({PlanetName.MARS} if recipe.mars_windows else frozenset())


def domain_points(natal: SiderealContext, recipe: DomainRecipe) -> frozenset[str]:
    """The domain's significator grahas, plus the lagna when the 1st is a domain house."""
    grahas = frozenset(g.value for g in significator_grahas(natal, recipe))
    lagna = frozenset({LAGNA_POINT}) if 1 in domain_house_numbers(recipe) else frozenset()
    return grahas | lagna


def _bounds(ym: YearMonth) -> tuple[datetime, datetime]:
    year, month = ym
    end = datetime(year + month // 12, month % 12 + 1, 1, tzinfo=UTC)
    return datetime(year, month, 1, tzinfo=UTC), end


def running_lords(natal: SiderealContext, start: datetime, end: datetime) -> frozenset[str]:
    """Maha and antar lords running at any time in [start, end)."""
    spans = list(level_spans(natal.dashas.maha_dasha_sequence, start, end).values())
    return frozenset(p.lord.value for level in spans[:2] for p in level)


def _month_scores(
    natal: SiderealContext, book: ContactBook, ym: YearMonth
) -> dict[LifeDomain, float]:
    start, end = _bounds(ym)
    contacts, lords = book.month(start, end), running_lords(natal, start, end)
    return {
        domain: contact_score(contacts, domain_movers(r), domain_points(natal, r), lords)
        for domain, r in DOMAIN_RECIPES.items()
    }


def monthly_exact_signals(
    natal: SiderealContext,
    astro: SkyfieldAstronomy,
    months: Sequence[YearMonth],
    settings: ExactTransitSettings,
) -> dict[LifeDomain, tuple[float, ...]]:
    """Each domain's exact-transit score per month; empty when the flag is off."""
    if not settings.enabled:
        return {}
    book = ContactBook(astro_movers(astro), natal_points(natal), settings.orb_deg)
    rows = [_month_scores(natal, book, ym) for ym in months]
    return {domain: tuple(row[domain] for row in rows) for domain in DOMAIN_RECIPES}


__all__ = [
    "SLOW_MOVERS",
    "ExactTransitSettings",
    "contact_score",
    "domain_movers",
    "domain_points",
    "monthly_exact_signals",
    "running_lords",
]
