"""Golden-fixture determinism gate for the Phase-3 strength engine.

Pins the full ``StrengthContext`` (Ashtakavarga + Shadbala) for a small set of
charts incl. the founder. A drift here means either a real engine change (update
the fixture deliberately) or a regression. Regenerate with
``tests/fixtures/regen_strength_golden.py``.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta
from pathlib import Path

import pytest

from almamesh.calculations import calculate_sidereal_context
from almamesh.strength import compute_strength_context

_FIXTURE = Path(__file__).parent / "fixtures" / "strength_golden_de421.json"


def _civil(birth: datetime) -> timedelta:
    """The fixture's civil offset: every strength case is written in local time."""
    offset = birth.utcoffset()
    assert offset is not None, "strength fixtures carry their local offset"
    return offset


def _round(obj: object) -> object:
    """Round floats to 6 dp so sub-microdegree astronomy jitter never flaps."""
    if isinstance(obj, float):
        return round(obj, 6)
    if isinstance(obj, dict):
        return {k: _round(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_round(v) for v in obj]
    return obj


def _compute(case: dict[str, object]) -> object:
    """Compute the rounded StrengthContext dump for one fixture case."""
    birth = datetime.fromisoformat(str(case["birth_iso"]))
    lat, lon = float(case["lat"]), float(case["lon"])  # type: ignore[arg-type]
    natal = calculate_sidereal_context(birth, lat, lon)
    ctx = compute_strength_context(natal, birth, lat, lon, civil_offset=_civil(birth))
    return _round(ctx.model_dump(mode="json"))


@pytest.fixture(scope="module")
def golden() -> dict[str, object]:
    return json.loads(_FIXTURE.read_text())


def test_should_match_golden_strength_for_every_case(golden: dict[str, object]) -> None:
    # Given each pinned chart in the golden fixture
    for case in golden["cases"]:  # type: ignore[index]
        # When the strength context is recomputed
        actual = _compute(case)  # type: ignore[arg-type]
        # Then it is byte-identical to the stored expected dump
        assert actual == case["expected"], f"strength drift for {case['name']}"  # type: ignore[index]


def test_should_have_at_least_three_golden_cases(golden: dict[str, object]) -> None:
    # Then the fixture covers the founder + two more charts
    assert len(golden["cases"]) >= 3  # type: ignore[arg-type]


def test_should_keep_sav_337_across_all_golden_cases(golden: dict[str, object]) -> None:
    # Then every golden chart preserves the canonical SAV invariant
    for case in golden["cases"]:  # type: ignore[index]
        assert case["expected"]["ashtakavarga"]["sarva"]["total"] == 337  # type: ignore[index]
