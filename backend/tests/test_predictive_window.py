"""window_months: one compute covers up to two years; the wire refuses anything else."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

import pytest

from almamesh.edge.chart_runtime import compute_predictive
from almamesh.predictive import compute_predictive_contexts, window_months_from_wire

BIRTH = datetime(1990, 1, 15, 12, tzinfo=UTC)
LAT, LON = 28.6139, 77.2090
REFERENCE = datetime(2026, 6, 9, 12, tzinfo=UTC)


def _payload(**extra: object) -> dict[str, object]:
    return {
        "datetime_utc": BIRTH.isoformat(),
        "latitude": LAT,
        "longitude": LON,
        "reference_instant": REFERENCE.isoformat(),
        "utc_offset_minutes": 330,
        **extra,
    }


def _window_days(result: dict[str, object]) -> float:
    timeline = json.loads(json.dumps(result))["transit_context"]["timeline"]
    start = datetime.fromisoformat(timeline["window_start"])
    return (datetime.fromisoformat(timeline["window_end"]) - start) / timedelta(days=1)


def test_default_window_is_twelve_engine_months() -> None:
    assert _window_days(compute_predictive(_payload())) == 365.25


def test_window_months_24_is_one_compute_over_two_years() -> None:
    assert _window_days(compute_predictive(_payload(window_months=24))) == 730.5


@pytest.mark.parametrize("bad", [0, 25, -1, 12.0, True, "24"])
def test_wire_refuses_anything_but_whole_months_1_to_24(bad: object) -> None:
    with pytest.raises(ValueError, match="window_months"):
        window_months_from_wire(bad)


def test_absent_wire_value_is_the_default() -> None:
    assert window_months_from_wire(None) == 12


def test_engine_refuses_a_window_past_two_years() -> None:
    with pytest.raises(ValueError, match="window_months"):
        compute_predictive_contexts(
            BIRTH, LAT, LON, REFERENCE, civil_offset=timedelta(minutes=330), window_months=25
        )


def test_payload_bytes_stay_within_the_low_end_budget() -> None:
    # Measured on main before Inc B: 59,102 bytes for this chart at 12 months.
    twelve = len(json.dumps(compute_predictive(_payload())))
    twenty_four = len(json.dumps(compute_predictive(_payload(window_months=24))))
    print(f"predictive payload bytes: 12m={twelve} 24m={twenty_four}")  # noqa: T201 - recorded in the PR
    assert twelve <= 72 * 1024
    assert twenty_four <= 88 * 1024
