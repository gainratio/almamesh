"""Difficult houses (6/8/12) in the period reading, on a SYNTHETIC chart.

SYNTHETIC_AQUARIUS is not a real person: a birth instant and place searched for
by script so the chart has an Aquarius lagna near 28°53' and the Moon in
Capricorn (Shravana pada 3, about 16.9°). Natal Mars and Rahu sit in Capricorn,
the 12th from the lagna. Sep 2019 runs Saturn maha / Saturn antar with the Rahu
then Jupiter pratyantar; Saturn rules the 1st and 12th for Aquarius.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta

import pytest

from almamesh.calculations import calculate_sidereal_context
from almamesh.constants.astrology import PlanetName
from almamesh.predictive import PredictiveContexts, compute_predictive_contexts
from almamesh.reading.themes import ThemeInputs, reading_themes
from almamesh.schemas.domains import LifeDomain
from almamesh.schemas.reading import DashaLevel, ReadingTheme

SYNTHETIC_AQUARIUS = datetime(1971, 9, 30, 11, 40, tzinfo=UTC)
_LAT, _LON = 13.08, 80.27
_IST = timedelta(minutes=330)


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
