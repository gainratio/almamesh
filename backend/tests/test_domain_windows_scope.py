"""Life Atlas domain windows keep the pre-Inc-B event set (Ruling 6)."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from almamesh.domains.windows import feeds_domain_windows
from almamesh.schemas.transits import TimelineEvent


@pytest.mark.parametrize(
    ("graha", "kind", "expected"),
    [
        ("jupiter", "sign_ingress", True),
        ("saturn", "sign_ingress", True),
        ("mars", "sign_ingress", False),
        ("rahu", "sign_ingress", False),
        ("ketu", "sign_ingress", False),
        ("saturn", "station", False),
        ("mars", "station", False),
        (None, "dasha_change", True),
        (None, "sade_sati_phase", True),
    ],
)
def test_domain_windows_keep_the_pre_inc_b_event_set(
    graha: str | None, kind: str, expected: bool
) -> None:
    event = TimelineEvent.model_validate(
        {
            "date": datetime(2027, 1, 1, tzinfo=UTC),
            "kind": kind,
            "graha": graha,
            "severity": "neutral",
            "descriptor": "test.event",
        }
    )
    assert feeds_domain_windows(event) is expected
