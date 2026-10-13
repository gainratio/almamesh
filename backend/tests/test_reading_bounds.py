"""reading_end: the period reading covers [reference day, reading_end] inside the window.

The run's transit window is 12 or 24 months, but a reading is one period's own.
Absent ``reading_end`` means the reference day only; anything outside the window
is refused loudly, never clipped silently.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta

import pytest

from almamesh.calculations import calculate_sidereal_context
from almamesh.edge.chart_runtime import compute_predictive
from almamesh.predictive import PredictiveContexts, compute_predictive_contexts
from almamesh.reading import compute_period_reading
from almamesh.reading.bounds import bounded_transits, reading_close, reading_end_from_wire
from almamesh.schemas.reading import PeriodReading

BIRTH = datetime(1990, 1, 15, 12, tzinfo=UTC)
LAT, LON = 28.6139, 77.2090
REFERENCE = datetime(2019, 5, 1, tzinfo=UTC)  # 12 months end 2020-04-30T06:00Z


@pytest.fixture(scope="module")
def run() -> PredictiveContexts:
    return compute_predictive_contexts(
        BIRTH, LAT, LON, REFERENCE, civil_offset=timedelta(minutes=330), window_months=12
    )


def _reading(run: PredictiveContexts, reading_end: date | None) -> PeriodReading:
    """Rebuild the reading from the run's own contexts with other bounds (no ephemeris)."""
    return compute_period_reading(
        calculate_sidereal_context(BIRTH, LAT, LON, reference_date=REFERENCE),
        run.transit_context,
        run.varga_context_full,
        run.strength_context,
        run.domains_context,
        reading_end=reading_end,
    )


def test_absent_reading_end_is_the_reference_day_only(run: PredictiveContexts) -> None:
    reading = run.period_reading
    assert (reading.window.start, reading.window.end) == (date(2019, 5, 1), date(2019, 5, 2))
    assert [(s.start, s.end) for s in reading.segments] == [(date(2019, 5, 1), date(2019, 5, 2))]


def test_the_transit_context_keeps_the_whole_window(run: PredictiveContexts) -> None:
    timeline = run.transit_context.timeline
    assert timeline.window_end == datetime(2020, 4, 30, 6, tzinfo=UTC)
    assert any(e.date > datetime(2019, 6, 1, tzinfo=UTC) for e in timeline.events)


def test_a_month_reading_ends_after_its_last_day(run: PredictiveContexts) -> None:
    reading = _reading(run, date(2019, 5, 31))
    assert (reading.window.start, reading.window.end) == (date(2019, 5, 1), date(2019, 6, 1))
    assert reading.segments[-1].end == date(2019, 6, 1)
    assert all(s.end <= date(2019, 6, 1) for s in reading.sky)
    assert all(w.date < date(2019, 6, 1) for t in reading.themes for w in t.windows)


def test_the_last_day_starting_inside_the_window_is_allowed(run: PredictiveContexts) -> None:
    """2020-04-30 starts before the 06:00Z window end: the reading closes at the window end."""
    close = reading_close(run.transit_context.timeline, date(2020, 4, 30))
    assert close == datetime(2020, 4, 30, 6, tzinfo=UTC)


def test_bounded_events_stop_at_the_close(run: PredictiveContexts) -> None:
    bounded = bounded_transits(run.transit_context, date(2019, 5, 31))
    close = datetime(2019, 6, 1, tzinfo=UTC)
    assert bounded.timeline.window_end == close
    assert all(e.date < close for e in bounded.timeline.events)
    assert bounded.gochara == run.transit_context.gochara


def test_a_reading_end_before_the_reference_day_is_refused(run: PredictiveContexts) -> None:
    with pytest.raises(ValueError, match="invalid reading_end: before the reference day"):
        _reading(run, date(2019, 4, 30))


def test_a_reading_end_past_the_window_is_refused(run: PredictiveContexts) -> None:
    """2020-05-01 starts after the window's 2020-04-30T06:00Z end."""
    with pytest.raises(ValueError, match="invalid reading_end: past the window end"):
        _reading(run, date(2020, 5, 1))


@pytest.mark.parametrize("bad", ["2019-5-31", "20190531", "2019-02-30", 20190531, True, ""])
def test_wire_refuses_anything_but_an_iso_date(bad: object) -> None:
    with pytest.raises(ValueError, match="invalid reading_end: must be an ISO date"):
        reading_end_from_wire(bad)


def test_wire_reads_an_iso_date_and_absent_is_none() -> None:
    assert reading_end_from_wire("2019-05-31") == date(2019, 5, 31)
    assert reading_end_from_wire(None) is None


def test_edge_payload_passes_reading_end_to_the_reading() -> None:
    payload: dict[str, object] = {
        "datetime_utc": BIRTH.isoformat(),
        "latitude": LAT,
        "longitude": LON,
        "reference_instant": REFERENCE.isoformat(),
        "utc_offset_minutes": 330,
        "reading_end": "2019-05-31",
    }
    reading = compute_predictive(payload)["period_reading"]
    assert isinstance(reading, dict)
    assert reading["window"] == {"start": "2019-05-01", "end": "2019-06-01"}


def test_edge_payload_refuses_a_reading_end_past_the_window() -> None:
    payload: dict[str, object] = {
        "datetime_utc": BIRTH.isoformat(),
        "latitude": LAT,
        "longitude": LON,
        "reference_instant": REFERENCE.isoformat(),
        "utc_offset_minutes": 330,
        "reading_end": "2020-05-01",
    }
    with pytest.raises(ValueError, match="past the window end"):
        compute_predictive(payload)


def test_a_theme_window_on_the_closing_midnight_is_outside(run: PredictiveContexts) -> None:
    """The reading is half-open: a window at 2019-06-01T00:00Z belongs to June, not May."""
    domains = run.domains_context
    close = datetime(2019, 6, 1, tzinfo=UTC)
    forecasts = {
        key: forecast.model_copy(
            update={
                "upcoming_windows": [
                    w.model_copy(update={"date": close, "severity": "challenging"})
                    for w in forecast.upcoming_windows[:1]
                ]
            }
        )
        for key, forecast in domains.forecasts.items()
    }
    moved = domains.model_copy(update={"forecasts": forecasts})
    reading = compute_period_reading(
        calculate_sidereal_context(BIRTH, LAT, LON, reference_date=REFERENCE),
        run.transit_context,
        run.varga_context_full,
        run.strength_context,
        moved,
        reading_end=date(2019, 5, 31),
    )
    assert any(f.upcoming_windows for f in forecasts.values())
    assert [w for t in reading.themes for w in t.windows] == []
