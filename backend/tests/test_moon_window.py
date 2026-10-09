"""compute_moon_window: the Moon at a place's local start and end, and at one event."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from almamesh.calculations import calculate_sidereal_context
from almamesh.constants.astrology import PlanetName
from almamesh.edge.chart_runtime import compute_moon_window_payload
from almamesh.transits.moon_window import (
    EventPoint,
    EventSky,
    MoonWindow,
    compute_moon_window,
    moon_window_from_wire,
    tithi_number,
)

BOGOTA = (4.711, -74.0721)
BOGOTA_DAY = (datetime(2026, 6, 15, 5, tzinfo=UTC), datetime(2026, 6, 16, 5, tzinfo=UTC))


@pytest.mark.parametrize(
    ("moon", "sun", "expected"),
    [
        (0.0, 0.0, 1),
        (11.999, 0.0, 1),
        (12.0, 0.0, 2),
        (180.0, 0.0, 16),
        (359.9, 0.0, 30),
        (5.0, 350.0, 2),
    ],
)
def test_tithi_number_counts_twelve_degree_steps_of_moon_minus_sun(
    moon: float, sun: float, expected: int
) -> None:
    assert tithi_number(moon, sun) == expected


def test_a_place_day_reports_the_moon_at_both_ends() -> None:
    window = compute_moon_window(*BOGOTA_DAY)
    start, end = window.at_place.at_start, window.at_place.at_end
    # The Moon moves 11.8-15.4 deg a day: one nakshatra (13.33 deg) or more, so the ends differ.
    assert (start.nakshatra, start.tithi) != (end.nakshatra, end.tithi)
    assert window.event is None


def test_a_few_days_span_is_accepted() -> None:
    start = datetime(2026, 6, 1, 7, tzinfo=UTC)  # Los Angeles 00:00 (PDT)
    window = compute_moon_window(start, start + timedelta(days=3))
    assert window.at_place.at_start != window.at_place.at_end


@pytest.mark.parametrize(
    "span",
    [timedelta(hours=21), timedelta(days=6, hours=3), timedelta(hours=-24)],
)
def test_spans_that_are_not_one_to_six_local_days_are_refused(span: timedelta) -> None:
    start = datetime(2026, 6, 15, 5, tzinfo=UTC)
    with pytest.raises(ValueError, match="place bounds"):
        compute_moon_window(start, start + span)


def test_event_reports_lagna_sign_and_moon_without_degrees() -> None:
    when = datetime(2026, 6, 15, 20, tzinfo=UTC)  # 15:00 in Bogotá
    window = compute_moon_window(
        *BOGOTA_DAY, event=EventPoint(when=when, latitude=BOGOTA[0], longitude=BOGOTA[1])
    )
    assert window.event is not None
    dumped = window.model_dump(mode="json")
    assert set(dumped["event"]) == {"lagna_sign", "moon"}
    assert not any(isinstance(v, float) for v in dumped["event"]["moon"].values())


def test_event_outside_the_bounds_is_refused() -> None:
    when = datetime(2026, 6, 20, tzinfo=UTC)
    with pytest.raises(ValueError, match="event"):
        compute_moon_window(
            *BOGOTA_DAY, event=EventPoint(when=when, latitude=BOGOTA[0], longitude=BOGOTA[1])
        )


def test_event_with_impossible_coordinates_is_refused() -> None:
    when = datetime(2026, 6, 15, 20, tzinfo=UTC)
    with pytest.raises(ValueError, match="event"):
        compute_moon_window(*BOGOTA_DAY, event=EventPoint(when=when, latitude=95.0, longitude=0.0))


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"place_start_utc": "2026-06-15T05:00:00+00:00"},
        {"place_start_utc": "2026-06-15T05:00:00", "place_end_utc": "2026-06-16T05:00:00+00:00"},
        {
            "place_start_utc": "1899-12-31T05:00:00+00:00",
            "place_end_utc": "1900-01-01T05:00:00+00:00",
        },
        {
            "place_start_utc": "2053-01-01T05:00:00+00:00",
            "place_end_utc": "2053-01-02T05:00:00+00:00",
        },
        {"place_start_utc": 20260615, "place_end_utc": "2026-06-16T05:00:00+00:00"},
    ],
)
def test_wire_refuses_missing_naive_out_of_range_or_malformed_bounds(
    payload: dict[str, object],
) -> None:
    with pytest.raises(ValueError, match="place_"):
        moon_window_from_wire(payload)


BOGOTA_3PM_WIRE = {
    "place_start_utc": "2026-06-15T05:00:00+00:00",
    "place_end_utc": "2026-06-16T05:00:00+00:00",
    "event": {
        "datetime_utc": "2026-06-15T20:00:00+00:00",
        "latitude": BOGOTA[0],
        "longitude": BOGOTA[1],
    },
}


def test_wire_and_direct_call_agree_and_the_edge_entry_dumps_json() -> None:
    at_3pm = datetime(2026, 6, 15, 20, tzinfo=UTC)
    event = EventPoint(when=at_3pm, latitude=BOGOTA[0], longitude=BOGOTA[1])
    direct = compute_moon_window(*BOGOTA_DAY, event=event)
    assert moon_window_from_wire(BOGOTA_3PM_WIRE) == direct
    assert compute_moon_window_payload(BOGOTA_3PM_WIRE) == direct.model_dump(mode="json")


@pytest.mark.parametrize(
    ("event", "message"),
    [
        ("Bogota", "event"),
        (
            {"datetime_utc": "2026-06-15T20:00:00+00:00", "latitude": "4.7", "longitude": 0.0},
            "latitude",
        ),
        (
            {"datetime_utc": "2026-06-15T20:00:00+00:00", "latitude": 4.7, "longitude": True},
            "longitude",
        ),
    ],
)
def test_wire_refuses_a_malformed_event(event: object, message: str) -> None:
    payload = {
        "place_start_utc": "2026-06-15T05:00:00+00:00",
        "place_end_utc": "2026-06-16T05:00:00+00:00",
        "event": event,
    }
    with pytest.raises(ValueError, match=message):
        moon_window_from_wire(payload)


def test_wire_without_an_event_reports_only_the_place() -> None:
    payload = {
        "place_start_utc": "2026-06-15T05:00:00+00:00",
        "place_end_utc": "2026-06-16T05:00:00+00:00",
    }
    assert moon_window_from_wire(payload).event is None


NEW_MOON = datetime(2026, 6, 15, 2, 54, tzinfo=UTC)  # astronomical new moon
FULL_MOON = datetime(2026, 6, 29, 23, 57, tzinfo=UTC)  # astronomical full moon
PLACES = [BOGOTA, (34.0522, -118.2437), (-33.8688, 151.2093)]


def _window_at(when: datetime, place: tuple[float, float]) -> tuple[MoonWindow, EventSky]:
    point = EventPoint(when=when, latitude=place[0], longitude=place[1])
    window = compute_moon_window(
        when - timedelta(hours=12), when + timedelta(hours=12), event=point
    )
    assert window.event is not None
    return window, window.event


@pytest.mark.parametrize("place", PLACES)
@pytest.mark.parametrize(
    "when", [datetime(2026, 6, 15, 20, tzinfo=UTC), datetime(2031, 1, 3, 9, tzinfo=UTC)]
)
def test_event_sky_matches_the_natal_chart_pipeline(
    when: datetime, place: tuple[float, float]
) -> None:
    chart = calculate_sidereal_context(when, place[0], place[1], reference_date=when)
    _, event = _window_at(when, place)
    assert event.lagna_sign == chart.lagna.sign
    assert event.moon.sign == chart.planets[PlanetName.MOON].sign
    assert event.moon.nakshatra == chart.planets[PlanetName.MOON].nakshatra


def test_place_ends_match_the_natal_chart_pipeline() -> None:
    start, end = BOGOTA_DAY
    window = compute_moon_window(start, end)
    for mark, when in ((window.at_place.at_start, start), (window.at_place.at_end, end)):
        moon = calculate_sidereal_context(when, 0.0, 0.0, reference_date=when).planets[
            PlanetName.MOON
        ]
        assert (mark.sign, mark.nakshatra) == (moon.sign, moon.nakshatra)


@pytest.mark.parametrize(
    ("when", "tithi", "paksha"),
    [
        (NEW_MOON - timedelta(hours=1), 30, "krishna"),
        (NEW_MOON + timedelta(hours=1), 1, "shukla"),
        (FULL_MOON - timedelta(hours=1), 15, "shukla"),
        (FULL_MOON + timedelta(hours=1), 16, "krishna"),
    ],
)
def test_tithi_and_paksha_flip_at_the_documented_new_and_full_moons(
    when: datetime, tithi: int, paksha: str
) -> None:
    window = compute_moon_window(when, when + timedelta(days=1))
    assert (window.at_place.at_start.tithi, window.at_place.at_start.paksha) == (tithi, paksha)


@pytest.mark.parametrize("span", [timedelta(hours=22), timedelta(days=6, hours=2)])
def test_the_exact_span_limits_are_accepted(span: timedelta) -> None:
    start = datetime(2026, 6, 15, 5, tzinfo=UTC)
    assert compute_moon_window(start, start + span).event is None


@pytest.mark.parametrize("field", ["place_start_utc", "place_end_utc"])
def test_wire_names_the_field_when_the_instant_is_not_iso(field: str) -> None:
    payload = {
        "place_start_utc": "2026-06-15T05:00:00+00:00",
        "place_end_utc": "2026-06-16T05:00:00+00:00",
    }
    payload[field] = "nope"
    with pytest.raises(ValueError, match=f"invalid {field}"):
        moon_window_from_wire(payload)


@pytest.mark.parametrize("step", range(14))
def test_event_sky_matches_the_natal_chart_across_a_lunar_month(step: int) -> None:
    """Every Moon sign is visited, so a wrong 30-degree sign table cannot hide."""
    when = datetime(2026, 6, 1, 3, tzinfo=UTC) + timedelta(hours=50 * step)
    place = PLACES[step % len(PLACES)]
    chart = calculate_sidereal_context(when, place[0], place[1], reference_date=when)
    _, event = _window_at(when, place)
    assert (event.lagna_sign, event.moon.sign) == (
        chart.lagna.sign,
        chart.planets[PlanetName.MOON].sign,
    )
