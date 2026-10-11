"""A reference instant anywhere in 1900..2052 computes: no forward scan may run past the ephemeris.

Regression: Saturn's sign-ingress look-ahead (3 years, chained for Sade Sati) read DE421 past
its 2053-10-09 end, so a Time travel year of 2051 or 2052 (and 2047 for some Moon signs) raised
EphemerisRangeError and the UI showed a bare "failed".
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from almamesh.edge.chart_runtime import compute_predictive

LAT, LON = 28.6139, 77.2090
# The Moon signs that fail earliest: 1985-05-10 fails from 2047-01-01, 1985-06-10 from 2050-01-01.
_BIRTHS = (datetime(1985, 5, 10, 12, tzinfo=UTC), datetime(1985, 6, 10, 12, tzinfo=UTC))
_REFERENCES = (
    (datetime(2047, 1, 1, tzinfo=UTC), None),
    (datetime(2051, 1, 1, tzinfo=UTC), None),
    (datetime(2052, 1, 1, tzinfo=UTC), 24),  # a leap year: the web asks for a 24-month window
    (datetime(2052, 12, 31, tzinfo=UTC), None),
)


@pytest.mark.parametrize("birth", _BIRTHS, ids=lambda b: b.date().isoformat())
@pytest.mark.parametrize("reference,window", _REFERENCES, ids=lambda v: str(v)[:10])
def test_reference_inside_the_ephemeris_computes(
    birth: datetime, reference: datetime, window: int | None
) -> None:
    payload: dict[str, object] = {
        "datetime_utc": birth.isoformat(),
        "latitude": LAT,
        "longitude": LON,
        "reference_instant": reference.isoformat(),
        "utc_offset_minutes": 330,
    }
    if window is not None:
        payload["window_months"] = window
    result = compute_predictive(payload)
    assert result["transit_context"]["timeline"]["window_start"].startswith(str(reference.year))


def test_ephemeris_end_is_pinned_to_the_literal_the_web_app_mirrors() -> None:
    # frontend/packages/llm/src/period.ts EPHEMERIS_LAST_YEAR (2052) is this instant's year - 1.
    from almamesh.transits.positions import EPHEMERIS_LAST_INSTANT

    assert EPHEMERIS_LAST_INSTANT == datetime(2053, 1, 1, tzinfo=UTC)
