"""compute_moon_window: the Moon at a place's local start and end, and at one event."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from almamesh.edge.chart_runtime import compute_moon_window_payload
from almamesh.transits.moon_window import (
    EventPoint,
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


def test_paksha_follows_tithi() -> None:
    mark = compute_moon_window(*BOGOTA_DAY).at_place.at_start
    assert mark.paksha == ("shukla" if mark.tithi <= 15 else "krishna")


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


def test_wire_and_direct_call_agree_and_the_edge_entry_dumps_json() -> None:
    payload = {
        "place_start_utc": "2026-06-15T05:00:00+00:00",
        "place_end_utc": "2026-06-16T05:00:00+00:00",
        "event": {
            "datetime_utc": "2026-06-15T20:00:00+00:00",
            "latitude": BOGOTA[0],
            "longitude": BOGOTA[1],
        },
    }
    direct = compute_moon_window(
        *BOGOTA_DAY,
        event=EventPoint(
            when=datetime(2026, 6, 15, 20, tzinfo=UTC), latitude=BOGOTA[0], longitude=BOGOTA[1]
        ),
    )
    assert moon_window_from_wire(payload) == direct
    assert compute_moon_window_payload(payload) == direct.model_dump(mode="json")


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
