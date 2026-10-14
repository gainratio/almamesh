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

from almamesh.predictive import PredictiveContexts, compute_predictive_contexts
from almamesh.schemas.domains import LifeDomain

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


@pytest.fixture(scope="module")
def sep_2019() -> PredictiveContexts:
    return synthetic_reading(datetime(2019, 9, 1, tzinfo=UTC), date(2019, 9, 30))


def test_should_keep_every_domain_theme_when_at_most_eight_domains_exist(
    sep_2019: PredictiveContexts,
) -> None:
    # Given a reading over every life domain (no more than the 8-theme bound)
    assert len(LifeDomain) <= 8
    # When the themes are listed
    themes = sep_2019.period_reading.themes
    # Then no domain is silently dropped
    assert {t.domain for t in themes} == set(LifeDomain)
