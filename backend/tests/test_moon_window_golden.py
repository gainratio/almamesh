"""Golden for compute_moon_window; the browser parity gate (CHECK 8) compares Pyodide to it."""

from __future__ import annotations

import json
from pathlib import Path

from almamesh.edge.chart_runtime import compute_moon_window_payload

GOLDEN_PATH = Path(__file__).parent / "fixtures" / "moon_window_golden_de421.json"


def golden_cases() -> dict[str, dict[str, object]]:
    """Keys MUST equal MOON_WINDOW_FIXTURES in apps/web/scripts/verify-browser-parity.mjs."""
    return {
        "bogota-2026-06-15": {
            "place_start_utc": "2026-06-15T05:00:00+00:00",
            "place_end_utc": "2026-06-16T05:00:00+00:00",
        },
        "la-2026-06-01..03": {
            "place_start_utc": "2026-06-01T07:00:00+00:00",
            "place_end_utc": "2026-06-04T07:00:00+00:00",
        },
        "bogota-2026-06-15@15:00": {
            "place_start_utc": "2026-06-15T05:00:00+00:00",
            "place_end_utc": "2026-06-16T05:00:00+00:00",
            "event": {
                "datetime_utc": "2026-06-15T20:00:00+00:00",
                "latitude": 4.711,
                "longitude": -74.0721,
            },
        },
    }


def test_moon_window_matches_golden() -> None:
    golden = json.loads(GOLDEN_PATH.read_text())
    actual = {key: compute_moon_window_payload(case) for key, case in golden_cases().items()}
    assert actual == golden
