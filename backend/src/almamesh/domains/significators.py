"""Resolve a domain recipe against the natal chart: houses, lords, karakas.

Whole-sign bhavas (see ``almamesh.calculations.HOUSE_SYSTEM``): each domain
house IS one sign, its lord is that sign's ruler, and "occupants" are the grahas
whose natal whole-sign house number matches. Everything here is a pure, read-only
lookup over the natal ``SiderealContext`` — no astrology is re-derived.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from almamesh.schemas.domains import HouseSignificator, KarakaSignificator

if TYPE_CHECKING:
    from almamesh.constants.astrology import PlanetName, ZodiacSign
    from almamesh.domains.recipes import DomainRecipe, HouseRule, KarakaRule
    from almamesh.schemas.astrology import SiderealContext


def _house_significator(natal: SiderealContext, rule: HouseRule) -> HouseSignificator:
    """One domain bhava + where its lord sits in the natal chart."""
    cusp = natal.houses[rule.house]
    lord = natal.planets[cusp.sign_lord]
    return HouseSignificator(
        house=rule.house,
        sign=cusp.sign,
        lord=cusp.sign_lord,
        lord_house=lord.house,
        lord_sign=lord.sign,
        lord_dignity=lord.dignity,
        rule=rule.rule,
    )


def house_significators(natal: SiderealContext, recipe: DomainRecipe) -> list[HouseSignificator]:
    """Every domain bhava resolved to its sign + lord placement."""
    return [_house_significator(natal, rule) for rule in recipe.houses]


def _karaka_significator(natal: SiderealContext, rule: KarakaRule) -> KarakaSignificator:
    """One natural karaka resolved to its natal placement."""
    pos = natal.planets[rule.graha]
    return KarakaSignificator(
        graha=rule.graha,
        house=pos.house,
        sign=pos.sign,
        dignity=pos.dignity,
        is_retrograde=pos.is_retrograde,
        rule=rule.rule,
    )


def karaka_significators(natal: SiderealContext, recipe: DomainRecipe) -> list[KarakaSignificator]:
    """Every natural karaka resolved to its natal placement."""
    return [_karaka_significator(natal, rule) for rule in recipe.karakas]


def domain_house_numbers(recipe: DomainRecipe) -> frozenset[int]:
    """The whole-sign house numbers the recipe declares for the domain."""
    return frozenset(rule.house for rule in recipe.houses)


def domain_house_signs(natal: SiderealContext, recipe: DomainRecipe) -> frozenset[ZodiacSign]:
    """The signs occupied by the domain's whole-sign houses in this chart."""
    return frozenset(natal.houses[rule.house].sign for rule in recipe.houses)


def _counted_karakas(recipe: DomainRecipe) -> frozenset[PlanetName]:
    """The karakas that signify; an activation-only domain's karakas are context only."""
    if recipe.activation_only:
        return frozenset()
    return frozenset(rule.graha for rule in recipe.karakas)


def significator_grahas(natal: SiderealContext, recipe: DomainRecipe) -> frozenset[PlanetName]:
    """House lords + occupants of the domain houses + counted karakas."""
    houses = domain_house_numbers(recipe)
    lords = {natal.houses[h].sign_lord for h in houses}
    occupants = {pos.name for pos in natal.planets.values() if pos.house in houses}
    return frozenset(lords | occupants) | _counted_karakas(recipe)
