"""Life Atlas domain windows: Jupiter/Saturn ingresses in both directions, dasha
changes and Sade Sati phases; no Mars/node ingresses and no stations (amendment A1)."""

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
        ("jupiter", "station", False),
        ("mars", "sign_ingress", False),
        ("rahu", "sign_ingress", False),
        ("ketu", "sign_ingress", False),
        ("saturn", "station", False),
        ("mars", "station", False),
        (None, "dasha_change", True),
        (None, "sade_sati_phase", True),
    ],
)
def test_domain_windows_take_only_their_event_set(
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


def test_should_feed_domain_windows_when_jupiter_ingress_is_backward() -> None:
    # Given Jupiter moving back from Leo into Cancer (a retrograde cusp crossing)
    event = TimelineEvent.model_validate(
        {
            "date": datetime(2027, 1, 24, tzinfo=UTC),
            "kind": "sign_ingress",
            "graha": "jupiter",
            "from_sign": "Leo",
            "to_sign": "Cancer",
            "severity": "neutral",
            "descriptor": "jupiter.ingress.cancer",
        }
    )
    # When the Life Atlas filter sees it
    feeds = feeds_domain_windows(event)
    # Then it feeds the windows like a forward ingress does
    assert feeds is True
