"""Stations: the instant the engine's own retrograde flag flips, with the sign it happens in."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from almamesh.calculations import SkyfieldAstronomy
from almamesh.constants.astrology import PlanetName
from almamesh.schemas.transits import StationDirection, TimelineEvent, TransitEventKind
from almamesh.transits.positions import transit_positions
from almamesh.transits.timeline_stations import station_events

_START = datetime(2026, 6, 9, 12, tzinfo=UTC)
_END = _START + timedelta(days=730.5)  # the 24-month engine window


@pytest.fixture(scope="module")
def astro() -> SkyfieldAstronomy:
    return SkyfieldAstronomy()


def _summary(events: list[TimelineEvent]) -> list[tuple[str, str | None, str | None]]:
    return [(e.date.date().isoformat(), e.station_direction, e.station_sign) for e in events]


def test_saturn_stations_over_two_years(astro: SkyfieldAstronomy) -> None:
    assert _summary(station_events(astro, PlanetName.SATURN, _START, _END)) == [
        ("2026-07-26", "retrograde", "Pisces"),
        ("2026-12-10", "direct", "Pisces"),
        ("2027-08-09", "retrograde", "Aries"),
        ("2027-12-23", "direct", "Pisces"),
    ]


def test_jupiter_stations_over_two_years(astro: SkyfieldAstronomy) -> None:
    assert _summary(station_events(astro, PlanetName.JUPITER, _START, _END)) == [
        ("2026-12-12", "retrograde", "Leo"),
        ("2027-04-12", "direct", "Cancer"),
        ("2028-01-11", "retrograde", "Virgo"),
        ("2028-05-13", "direct", "Leo"),
    ]


def test_mars_turns_retrograde_in_leo_and_direct_in_cancer(astro: SkyfieldAstronomy) -> None:
    assert _summary(station_events(astro, PlanetName.MARS, _START, _END)) == [
        ("2027-01-10", "retrograde", "Leo"),
        ("2027-04-01", "direct", "Cancer"),
    ]


@pytest.mark.parametrize("graha", [PlanetName.JUPITER, PlanetName.SATURN, PlanetName.MARS])
def test_a_station_is_where_the_engine_retrograde_flag_flips(
    astro: SkyfieldAstronomy, graha: PlanetName
) -> None:
    hour = timedelta(hours=1)
    for event in station_events(astro, graha, _START, _END):
        before = bool(transit_positions(astro, event.date - hour)[graha]["is_retrograde"])
        after = bool(transit_positions(astro, event.date + hour)[graha]["is_retrograde"])
        assert after is (event.station_direction == StationDirection.RETROGRADE.value)
        assert before is not after


def test_station_event_shape(astro: SkyfieldAstronomy) -> None:
    first = station_events(astro, PlanetName.SATURN, _START, _END)[0]
    assert first.kind == TransitEventKind.STATION.value
    assert first.graha == "saturn"
    assert first.descriptor == "saturn.station.retrograde"
    assert (first.from_sign, first.to_sign, first.severity) == (None, None, "neutral")
