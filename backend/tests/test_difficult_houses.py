"""Difficult houses (6/8/12) in the period reading, on a SYNTHETIC chart.

SYNTHETIC_AQUARIUS is not a real person: a birth instant and place searched for
by script so the chart has an Aquarius lagna near 28°53' and the Moon in
Capricorn (Shravana pada 3, about 16.9°). Natal Mars and Rahu sit in Capricorn,
the 12th from the lagna. Sep 2019 runs Saturn maha / Saturn antar with the Rahu
then Jupiter pratyantar; Saturn rules the 1st and 12th for Aquarius.

SYNTHETIC_SCORPIO (1985-03-10 06:00 UTC, New York coordinates) is also
synthetic: a Scorpio lagna whose Saturn neither rules nor occupies 6/8/12, so
it shows that a karaka alone never activates ``obstacles``.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta

import pytest

from almamesh.calculations import calculate_sidereal_context
from almamesh.constants.astrology import PlanetName
from almamesh.domains.recipes import DOMAIN_RECIPES
from almamesh.domains.significators import significator_grahas
from almamesh.predictive import PredictiveContexts, compute_predictive_contexts
from almamesh.reading.themes import ThemeInputs, reading_themes
from almamesh.schemas.domains import LifeDomain, StrengthBand
from almamesh.schemas.reading import DashaLevel, ReadingTheme
from almamesh.schemas.vargas import DivisionalChart

SYNTHETIC_AQUARIUS = datetime(1971, 9, 30, 11, 40, tzinfo=UTC)
_LAT, _LON = 13.08, 80.27
_IST = timedelta(minutes=330)
SYNTHETIC_SCORPIO = datetime(1985, 3, 10, 6, tzinfo=UTC)
_NY_LAT, _NY_LON = 40.7128, -74.006
_NY_EST = timedelta(minutes=-300)


def synthetic_reading(reference: datetime, reading_end: date) -> PredictiveContexts:
    """The production 12-month run for the synthetic chart, bounded to one period."""
    return compute_predictive_contexts(
        SYNTHETIC_AQUARIUS,
        _LAT,
        _LON,
        reference,
        civil_offset=_IST,
        window_months=12,
        reading_end=reading_end,
    )


def scorpio_reading(reference: datetime, reading_end: date) -> PredictiveContexts:
    """The production 12-month run for the synthetic Scorpio chart."""
    return compute_predictive_contexts(
        SYNTHETIC_SCORPIO,
        _NY_LAT,
        _NY_LON,
        reference,
        civil_offset=_NY_EST,
        window_months=12,
        reading_end=reading_end,
    )


_SEP_2019 = datetime(2019, 9, 1, tzinfo=UTC)


@pytest.fixture(scope="module")
def sep_2019() -> PredictiveContexts:
    return synthetic_reading(_SEP_2019, date(2019, 9, 30))


def theme_of(contexts: PredictiveContexts, domain: LifeDomain) -> ReadingTheme:
    """The reading's theme for one domain."""
    return next(t for t in contexts.period_reading.themes if t.domain == domain)


def themes_with_running(
    contexts: PredictiveContexts, running: list[tuple[DashaLevel, PlanetName]]
) -> dict[LifeDomain, ReadingTheme]:
    """The themes recomputed for a chosen set of running lords (no yogini, no sky)."""
    natal = calculate_sidereal_context(SYNTHETIC_AQUARIUS, _LAT, _LON, reference_date=_SEP_2019)
    window = contexts.transit_context.timeline
    inputs = ThemeInputs(
        natal, contexts.domains_context, running, None, [], window.window_start, window.window_end
    )
    return {t.domain: t for t in reading_themes(inputs)}


def test_should_keep_every_domain_theme_when_at_most_eight_domains_exist(
    sep_2019: PredictiveContexts,
) -> None:
    # Given a reading over every life domain (no more than the 8-theme bound)
    assert len(LifeDomain) <= 8
    # When the themes are listed
    themes = sep_2019.period_reading.themes
    # Then no domain is silently dropped
    assert {t.domain for t in themes} == set(LifeDomain)


def test_should_agree_when_a_running_lord_only_occupies_a_domain_house(
    sep_2019: PredictiveContexts,
) -> None:
    # Given Rahu running alone: it rules nothing and is not a karaka of spiritual,
    # but it sits in the 12th (a spiritual house) of the synthetic chart
    running = [(DashaLevel.PRATYANTAR, PlanetName.RAHU)]
    # When the themes are read
    spiritual = themes_with_running(sep_2019, running)[LifeDomain.SPIRITUAL]
    # Then the occupant counts as Vimshottari agreement and is cited as such
    assert spiritual.agreement.vimshottari is True
    assert "Rahu (pratyantar) occupies the 12th" in spiritual.factors


def test_should_cite_the_lord_and_the_occupant_when_both_run(
    sep_2019: PredictiveContexts,
) -> None:
    # Given Sep 2019: Saturn (maha) rules the 12th, Rahu (pratyantar) occupies it
    # When the spiritual theme (houses 9/12/5) is read
    spiritual = theme_of(sep_2019, LifeDomain.SPIRITUAL)
    # Then both running lords are cited
    assert "Saturn (maha) rules the 12th" in spiritual.factors
    assert "Rahu (pratyantar) occupies the 12th" in spiritual.factors


# --- the obstacles domain (6th / 8th / 12th) ---

_OBSTACLES = LifeDomain.OBSTACLES


def test_should_read_obstacles_from_the_sixth_eighth_and_twelfth_in_the_d30() -> None:
    # Given the obstacles recipe
    recipe = DOMAIN_RECIPES[_OBSTACLES]
    # When its houses, varga and karakas are read
    houses = [rule.house for rule in recipe.houses]
    karakas = {rule.graha for rule in recipe.karakas}
    # Then it is the three dusthanas, the D30 and the classical malefic karakas
    assert houses == [6, 8, 12]
    assert recipe.varga.chart is DivisionalChart.D30
    assert karakas == {PlanetName.SATURN, PlanetName.MARS, PlanetName.RAHU}
    assert all(rule.meaning for rule in recipe.houses)


@pytest.mark.parametrize("house", [6, 8, 12])
def test_should_fit_the_longest_factor_with_a_house_meaning(house: int) -> None:
    # Given the longest label a factor can carry (a Yogini, Jupiter, an occupancy)
    meaning = next(r.meaning for r in DOMAIN_RECIPES[_OBSTACLES].houses if r.house == house)
    # When the factor is written
    factor = f"Yogini Bhramari (Jupiter) occupies the {house}th: {meaning}"
    # Then it fits the 80-character factor bound
    assert len(factor) <= 80


def test_should_not_let_a_karaka_alone_signify_obstacles() -> None:
    # Given a chart whose Saturn neither rules nor occupies the 6th, 8th or 12th
    natal = calculate_sidereal_context(
        SYNTHETIC_SCORPIO, _NY_LAT, _NY_LON, reference_date=_SEP_2019
    )
    # When the obstacles significators are resolved
    sigs = significator_grahas(natal, DOMAIN_RECIPES[_OBSTACLES])
    # Then Saturn is not one: the base-rate guard counts only lords and occupants
    assert PlanetName.SATURN not in sigs


def test_should_not_agree_on_obstacles_when_only_a_karaka_runs() -> None:
    # Given the Scorpio chart with only Saturn (a karaka, not a lord or occupant) running
    contexts = scorpio_reading(_SEP_2019, date(2019, 9, 30))
    natal = calculate_sidereal_context(
        SYNTHETIC_SCORPIO, _NY_LAT, _NY_LON, reference_date=_SEP_2019
    )
    window = contexts.transit_context.timeline
    running = [(DashaLevel.MAHA, PlanetName.SATURN)]
    inputs = ThemeInputs(
        natal, contexts.domains_context, running, None, [], window.window_start, window.window_end
    )
    # When the themes are read
    obstacles = next(t for t in reading_themes(inputs) if t.domain == _OBSTACLES)
    # Then Vimshottari does not agree
    assert obstacles.agreement.vimshottari is False


def test_should_cite_the_sixth_when_its_lord_runs(sep_2019: PredictiveContexts) -> None:
    # Given the Moon running alone: it rules the 6th (Cancer) of the Aquarius chart
    running = [(DashaLevel.PRATYANTAR, PlanetName.MOON)]
    # When the themes are read
    obstacles = themes_with_running(sep_2019, running)[_OBSTACLES]
    # Then the 6th is cited with its classical meaning
    assert obstacles.factors[0] == (
        "Moon (pratyantar) rules the 6th: legal or administrative matters"
    )


def test_sep_2019_reading_names_the_twelfth_house_lords(sep_2019: PredictiveContexts) -> None:
    # Given the synthetic chart in Sep 2019
    # When the obstacles theme is read
    obstacles = theme_of(sep_2019, _OBSTACLES)
    # Then the Saturn maha (12th lord) and Rahu pratyantar (12th occupant) are cited
    assert obstacles.houses == [6, 8, 12]
    assert "Saturn (maha) rules the 12th: losses and expenses" in obstacles.factors
    assert "Rahu (pratyantar) occupies the 12th: losses and expenses" in obstacles.factors
    assert obstacles.agreement.vimshottari is True


def test_should_never_cite_a_karakas_natal_strength_for_obstacles(
    sep_2019: PredictiveContexts,
) -> None:
    # Given the Sep 2019 obstacles theme
    obstacles = theme_of(sep_2019, _OBSTACLES)
    # When its factors are read
    # Then none is a natal strength percentage (that would be the same every month)
    assert not any("strength is" in factor for factor in obstacles.factors)
