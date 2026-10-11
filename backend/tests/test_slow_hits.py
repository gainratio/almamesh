"""Jupiter/Saturn slow-transit hits over natal points + Saturn/Jupiter returns.

Reference (Delhi 1990-01-15 chart; natal Saturn 263.60 deg Sagittarius, natal
Moon 143.78 deg Leo):
  - First Saturn return ~2019 (age ~29; sidereal Saturn back over natal Saturn).
  - Jupiter conjunct natal Moon ~2027-10 (next exact within the search window).
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from almamesh.calculations import (
    AyanamsaType,
    NodeType,
    SkyfieldAstronomy,
    calculate_sidereal_context,
)
from almamesh.constants.astrology import PlanetName
from almamesh.schemas.transits import TransitEventKind, TransitSeverity
from almamesh.transits import slow_hits
from almamesh.transits.positions import transit_longitude
from almamesh.transits.slow_hits import (
    next_conjunction,
    next_saturn_return,
)

_BIRTH = datetime(1990, 1, 15, 12, 0, 0, tzinfo=UTC)
_DELHI = (28.6139, 77.2090)


def _natal():
    return calculate_sidereal_context(
        _BIRTH, *_DELHI, reference_date=datetime(2025, 1, 1, tzinfo=UTC)
    )


def test_should_find_saturn_return_near_age_thirty() -> None:
    # Given the natal Saturn longitude and a search start before the return
    natal = _natal()
    natal_sat = natal.planets[PlanetName.SATURN].longitude
    with SkyfieldAstronomy() as astro:
        # When the next Saturn return after 2018 is found
        hit = next_saturn_return(astro, natal_sat, datetime(2018, 1, 1, tzinfo=UTC))
        # Then the FIRST exact contact lands in early 2019 (~29-yr from a Jan-1990
        # birth; the retrograde loop also re-contacts mid- and late-2019).
        assert hit is not None
        assert datetime(2019, 1, 1, tzinfo=UTC) <= hit.exact <= datetime(2019, 6, 1, tzinfo=UTC)
        assert hit.kind == TransitEventKind.RETURN.value
        assert hit.severity == TransitSeverity.NEUTRAL.value
        # And at the exact instant, transit Saturn equals natal Saturn (sub-degree)
        lon = transit_longitude(
            astro, PlanetName.SATURN, hit.exact, AyanamsaType.LAHIRI, NodeType.MEAN
        )
        assert abs((lon - natal_sat + 180) % 360 - 180) < 0.05


def test_should_find_jupiter_conjunct_natal_moon() -> None:
    # Given the natal Moon longitude and a 2025 search start
    natal = _natal()
    natal_moon = natal.planets[PlanetName.MOON].longitude
    with SkyfieldAstronomy() as astro:
        # When the next Jupiter-over-natal-Moon conjunction is found
        hit = next_conjunction(
            astro, PlanetName.JUPITER, natal_moon, "moon", datetime(2025, 1, 1, tzinfo=UTC)
        )
        # Then it lands ~2027-10 and is flagged SUPPORTIVE (Jupiter on the Moon)
        assert hit is not None
        assert datetime(2027, 9, 1, tzinfo=UTC) <= hit.exact <= datetime(2027, 12, 1, tzinfo=UTC)
        assert hit.severity == TransitSeverity.SUPPORTIVE.value
        lon = transit_longitude(
            astro, PlanetName.JUPITER, hit.exact, AyanamsaType.LAHIRI, NodeType.MEAN
        )
        assert abs((lon - natal_moon + 180) % 360 - 180) == pytest.approx(0.0, abs=0.05)


def test_should_stop_ephemeris_scan_after_first_conjunction(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Given a synthetic transit that reaches its target five days into a multi-year search
    start = datetime(2026, 1, 1, tzinfo=UTC)
    sampled: list[datetime] = []

    def longitude(_astro: object, _graha: object, when: datetime, *_args: object) -> float:
        sampled.append(when)
        return min(10.0, (when - start).total_seconds() / 86400.0 - 5.0)

    monkeypatch.setattr(slow_hits, "transit_longitude", longitude)

    # When the caller asks only for the next conjunction
    hit = next_conjunction(object(), PlanetName.JUPITER, 0.0, "moon", start)  # type: ignore[arg-type]

    # Then the exact first hit is returned without scanning the unused search horizon
    assert hit is not None
    assert abs(hit.exact - (start + timedelta(days=5))) < timedelta(seconds=1)
    assert len(sampled) < 100


@pytest.mark.parametrize("retrograde", [False, True])
@pytest.mark.parametrize("is_return", [False, True])
def test_should_skip_opposition_and_find_later_true_contact(
    monkeypatch: pytest.MonkeyPatch, retrograde: bool, is_return: bool
) -> None:
    start = datetime(2026, 1, 1, tzinfo=UTC)

    def longitude(_astro: object, _graha: object, when: datetime, *_args: object) -> float:
        days = (when - start).total_seconds() / 86400.0
        return (240.0 - days if retrograde else 120.0 + days) % 360.0

    monkeypatch.setattr(slow_hits, "transit_longitude", longitude)
    hit = (
        next_saturn_return(object(), 0.0, start)  # type: ignore[arg-type]
        if is_return
        else next_conjunction(object(), PlanetName.JUPITER, 0.0, "moon", start)  # type: ignore[arg-type]
    )
    assert hit is not None
    # The angular wrapper jumps at opposition on day 60; conjunction is day 240.
    assert abs(hit.exact - (start + timedelta(days=240))) < timedelta(seconds=1)


def test_should_return_no_contact_when_only_opposition_is_in_the_horizon(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    start = datetime(2026, 1, 1, tzinfo=UTC)

    def longitude(_astro: object, _graha: object, when: datetime, *_args: object) -> float:
        return min(220.0, 120.0 + (when - start).total_seconds() / 86400.0)

    monkeypatch.setattr(slow_hits, "transit_longitude", longitude)
    assert next_conjunction(object(), PlanetName.SATURN, 0.0, "lagna", start) is None  # type: ignore[arg-type]


@pytest.mark.parametrize("direction", [1, -1])
def test_should_find_conjunction_across_the_zero_degree_seam(
    monkeypatch: pytest.MonkeyPatch, direction: int
) -> None:
    start = datetime(2026, 1, 1, tzinfo=UTC)

    def longitude(_astro: object, _graha: object, when: datetime, *_args: object) -> float:
        return (direction * ((when - start).total_seconds() / 86400.0 - 2.5)) % 360.0

    monkeypatch.setattr(slow_hits, "transit_longitude", longitude)
    hit = next_conjunction(object(), PlanetName.JUPITER, 0.0, "moon", start)  # type: ignore[arg-type]
    assert hit is not None
    assert abs(hit.exact - (start + timedelta(days=2.5))) < timedelta(seconds=1)


@pytest.mark.parametrize("direction", [1, -1])
def test_should_include_a_contact_at_the_search_horizon(
    monkeypatch: pytest.MonkeyPatch, direction: int
) -> None:
    start = datetime(2026, 1, 1, tzinfo=UTC)
    end = start + timedelta(days=5)

    def longitude(_astro: object, _graha: object, when: datetime, *_args: object) -> float:
        return (direction * ((when - end).total_seconds() / 86400.0)) % 360.0

    monkeypatch.setattr(slow_hits, "transit_longitude", longitude)
    hit = slow_hits._first_crossing(object(), PlanetName.JUPITER, 0.0, start, end)  # type: ignore[arg-type]
    assert hit is not None
    assert abs(hit - end) < timedelta(seconds=1)


def test_should_not_publish_real_saturn_opposition_as_an_aquarius_conjunction() -> None:
    # A generic late-Aquarius target: the 2038 Leo transit is opposite it, not conjunct.
    start = datetime(2026, 10, 11, tzinfo=UTC)
    with SkyfieldAstronomy() as astro:
        assert next_conjunction(astro, PlanetName.SATURN, 329.0, "lagna", start) is None


def test_should_find_next_real_saturn_return_after_opposition() -> None:
    target = _natal().planets[PlanetName.SATURN].longitude
    start = datetime(2026, 10, 11, tzinfo=UTC)
    with SkyfieldAstronomy() as astro:
        hit = next_saturn_return(astro, target, start)
        assert hit is not None
        assert datetime(2048, 1, 1, tzinfo=UTC) < hit.exact < datetime(2051, 1, 1, tzinfo=UTC)
        actual = transit_longitude(
            astro, PlanetName.SATURN, hit.exact, AyanamsaType.LAHIRI, NodeType.MEAN
        )
        assert abs((actual - target + 180.0) % 360.0 - 180.0) < 0.000001
