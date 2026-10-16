"""Per-month, per-life-area signals from exact transits (engine side, behind a flag)."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime

import pytest

from almamesh.calculations import SkyfieldAstronomy, calculate_sidereal_context
from almamesh.constants.astrology import PlanetName as P
from almamesh.domains.exact_signals import (
    SLOW_MOVERS,
    ExactTransitSettings,
    contact_score,
    domain_movers,
    domain_points,
    monthly_exact_signals,
)
from almamesh.domains.recipes import DOMAIN_RECIPES
from almamesh.domains.significators import significator_grahas
from almamesh.schemas.astrology import SiderealContext
from almamesh.schemas.domains import LifeDomain
from almamesh.transits.exact import astro_movers, exact_hits

BORN = datetime(1980, 3, 4, 0, 36, tzinfo=UTC)
SLOW = frozenset({P.SATURN, P.JUPITER, P.RAHU, P.KETU})


@pytest.fixture(scope="module")
def astro() -> Iterator[SkyfieldAstronomy]:
    with SkyfieldAstronomy() as handle:
        yield handle


@pytest.fixture(scope="module")
def natal(astro: SkyfieldAstronomy) -> SiderealContext:
    return calculate_sidereal_context(BORN, 13.08, 80.27, reference_date=BORN, astronomy=astro)


def test_should_score_zero_when_nothing_touches_a_relevant_point() -> None:
    contacts = frozenset({(P.SATURN, "moon")})
    assert contact_score(contacts, SLOW, frozenset({"sun"}), frozenset({"sun"})) == 0.0


def test_should_score_half_when_a_mover_touches_a_relevant_point() -> None:
    contacts = frozenset({(P.SATURN, "sun")})
    assert contact_score(contacts, SLOW, frozenset({"sun"}), frozenset({"venus"})) == 0.5


def test_should_score_one_when_the_touched_point_is_a_running_dasha_lord() -> None:
    contacts = frozenset({(P.JUPITER, "sun"), (P.RAHU, "moon")})
    assert contact_score(contacts, SLOW, frozenset({"sun"}), frozenset({"sun"})) == 1.0


def test_should_ignore_a_dasha_lord_that_is_not_relevant() -> None:
    contacts = frozenset({(P.JUPITER, "moon")})
    assert contact_score(contacts, SLOW, frozenset({"sun"}), frozenset({"moon"})) == 0.0


def test_should_ignore_a_contact_by_a_graha_that_is_not_a_mover() -> None:
    contacts = frozenset({(P.MARS, "sun")})
    assert contact_score(contacts, SLOW, frozenset({"sun"}), frozenset()) == 0.0


def test_should_add_mars_only_for_the_obstacles_area() -> None:
    assert SLOW_MOVERS == SLOW
    assert domain_movers(DOMAIN_RECIPES[LifeDomain.OBSTACLES]) == SLOW | {P.MARS}
    assert domain_movers(DOMAIN_RECIPES[LifeDomain.CAREER]) == SLOW


def test_should_use_the_significator_rule_for_relevant_points(natal: SiderealContext) -> None:
    career = DOMAIN_RECIPES[LifeDomain.CAREER]
    expected = frozenset(g.value for g in significator_grahas(natal, career))
    assert domain_points(natal, career) == expected


def test_should_add_the_lagna_when_the_first_house_is_a_target(natal: SiderealContext) -> None:
    assert "lagna" in domain_points(natal, DOMAIN_RECIPES[LifeDomain.HEALTH])
    assert "lagna" not in domain_points(natal, DOMAIN_RECIPES[LifeDomain.CAREER])


def test_should_return_nothing_when_the_flag_is_off(
    natal: SiderealContext, astro: SkyfieldAstronomy
) -> None:
    assert ExactTransitSettings().enabled is False
    assert monthly_exact_signals(natal, astro, [(2010, 1)], ExactTransitSettings()) == {}


def test_should_flag_career_in_the_month_saturn_crosses_the_natal_sun(
    natal: SiderealContext, astro: SkyfieldAstronomy
) -> None:
    # Given the first month after 2000 in which transit Saturn is exactly on the natal Sun
    sun = natal.planets[P.SUN].longitude
    saturn = astro_movers(astro)[P.SATURN]
    hit = exact_hits(
        saturn, sun, datetime(2000, 1, 1, tzinfo=UTC), datetime(2030, 1, 1, tzinfo=UTC), 5.0
    )[0]
    quiet = (hit.year - 6, hit.month)
    # When
    signals = monthly_exact_signals(
        natal, astro, [(hit.year, hit.month), quiet], ExactTransitSettings(enabled=True)
    )
    # Then career (Sun is its karaka) scores in the hit month; every area is in {0, 0.5, 1}
    assert set(signals) == set(DOMAIN_RECIPES)
    assert signals[LifeDomain.CAREER][0] >= 0.5
    assert all(v in {0.0, 0.5, 1.0} for series in signals.values() for v in series)
