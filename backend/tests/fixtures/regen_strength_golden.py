"""Regenerate tests/fixtures/strength_golden_de421.json deterministically.

Run: ``uv run python tests/fixtures/regen_strength_golden.py``. Recomputes the
pinned StrengthContext for each case and rewrites the golden. Birth instants and
places are fixed; the engine is deterministic, so the output is reproducible.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta
from pathlib import Path

from almamesh.calculations import calculate_sidereal_context
from almamesh.strength import compute_strength_context

_OUT = Path(__file__).parent / "strength_golden_de421.json"

# (name, ISO birth instant with offset, latitude, longitude)
_CASES: tuple[tuple[str, str, float, float], ...] = (
    ("reference_native_1988", "1988-08-08T06:44:00+05:30", 12.9716, 77.5946),
    ("tokyo_1985", "1985-07-15T09:30:00+09:00", 35.6762, 139.6503),
    ("newyork_1990", "1990-01-15T12:00:00-05:00", 40.7128, -74.0060),
)


def _civil(birth: datetime) -> timedelta:
    """The fixture's civil offset: every strength case is written in local time."""
    offset = birth.utcoffset()
    assert offset is not None, "strength fixtures carry their local offset"
    return offset


def _round(obj: object) -> object:
    """Round floats to 6 dp (matches the golden-test tolerance)."""
    if isinstance(obj, float):
        return round(obj, 6)
    if isinstance(obj, dict):
        return {k: _round(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_round(v) for v in obj]
    return obj


def _case(name: str, birth_iso: str, lat: float, lon: float) -> dict[str, object]:
    """Compute one fixture case dict."""
    birth = datetime.fromisoformat(birth_iso)
    natal = calculate_sidereal_context(birth, lat, lon)
    ctx = compute_strength_context(natal, birth, lat, lon, civil_offset=_civil(birth))
    return {
        "name": name,
        "birth_iso": birth_iso,
        "lat": lat,
        "lon": lon,
        "expected": _round(ctx.model_dump(mode="json")),
    }


def main() -> None:
    """Write the golden fixture for every case."""
    cases = [_case(*c) for c in _CASES]
    _OUT.write_text(json.dumps({"cases": cases}, indent=2, sort_keys=True) + "\n")
    print(f"wrote {len(cases)} cases to {_OUT}")  # noqa: T201 - dev script


if __name__ == "__main__":
    main()
