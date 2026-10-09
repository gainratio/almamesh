"""Golden parity + determinism regression for the LAZY predictive payload (DE421).

Mirrors test_transit_golden.py / test_domains_golden.py: the in-browser Pyodide
engine must produce the composed ``PredictiveContexts`` payload byte-identical
to CPython. The natal / transit / varga / strength / domains goldens are
untouched — this golden covers the COMPOSED entrypoint the chart Worker calls
(``almamesh.predictive.compute_predictive_contexts``) at one pinned instant.
Floats are canonicalized to 6 decimals so trivial last-bit noise never trips
the guard. The fixture set is the parity-clean subset (Delhi/NYC) used by
frontend/packages/browser/integration/parity.mjs — keep them in lockstep.

Regenerate (only on an intentional engine change):
    uv run python -m tests.fixtures.regen_predictive_golden
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

from almamesh.predictive import PredictiveContexts, compute_predictive_contexts

# The single pinned instant: natal reference_date AND transit "now".
# MUST match parity.mjs:PREDICTIVE_REFERENCE_INSTANT.
FIXED_REFERENCE_INSTANT = datetime(2026, 6, 9, 12, 0, 0, tzinfo=UTC)

# NOTE: this golden pins the ENGINE's four contexts only. Domain-strength
# receipts are minted by the browser Worker's TypeScript (@gainratio/avow), not
# here, so they are not part of the CPython<->Pyodide byte-parity surface. Their
# cross-language byte-compatibility is proven separately by the shared golden
# vectors in testdata/vectors/ (backend/tests/test_strength_receipt_vectors.py
# and the @almamesh/browser strengthReceipt suite).

# (iso birth, lat, lon, civil UTC offset minutes) — parity-clean subset; MUST
# match parity.mjs:PREDICTIVE_FIXTURES. The offset is the birthplace's civil
# offset at birth (IST +5:30, EST -5:00); Kalabala reads weekdays off it.
FIXTURES: list[tuple[str, float, float, int]] = [
    ("1990-01-15T12:00:00+00:00", 28.6139, 77.2090, 330),  # Delhi
    ("2000-12-31T23:59:00+00:00", 40.7128, -74.0060, -300),  # NYC
]

GOLDEN_PATH = Path(__file__).parent / "fixtures" / "predictive_golden_de421.json"


def _canonicalize(value: object) -> object:
    """Recursively round floats to 6 decimals; preserve bool; sort dict keys."""
    if isinstance(value, bool):
        return value
    if isinstance(value, float):
        return round(value, 6)
    if isinstance(value, dict):
        return {k: _canonicalize(value[k]) for k in sorted(value)}
    if isinstance(value, list):
        return [_canonicalize(item) for item in value]
    return value


def _compute(iso_dt: str, lat: float, lon: float, offset_minutes: int) -> PredictiveContexts:
    """The composed predictive payload for one fixture at the pinned instant."""
    birth = datetime.fromisoformat(iso_dt)
    civil = timedelta(minutes=offset_minutes)
    return compute_predictive_contexts(birth, lat, lon, FIXED_REFERENCE_INSTANT, civil_offset=civil)


def _canonical_predictive(iso_dt: str, lat: float, lon: float, offset_minutes: int) -> object:
    """Canonicalized JSON dump of one fixture's PredictiveContexts."""
    return _canonicalize(_compute(iso_dt, lat, lon, offset_minutes).model_dump(mode="json"))


def _load_golden() -> dict[str, object]:
    loaded = json.loads(GOLDEN_PATH.read_text())
    assert isinstance(loaded, dict)
    return loaded


def test_all_predictive_fixtures_match_golden() -> None:
    """Every fixture's canonicalized PredictiveContexts equals the committed golden."""
    golden = _load_golden()
    for iso_dt, lat, lon, offset in FIXTURES:
        assert _canonical_predictive(iso_dt, lat, lon, offset) == golden[iso_dt]


def test_predictive_json_round_trip_is_byte_identical() -> None:
    """model_dump_json -> model_validate_json -> model_dump_json is byte-stable."""
    iso_dt, lat, lon, offset = FIXTURES[0]
    dumped = _compute(iso_dt, lat, lon, offset).model_dump_json()
    assert PredictiveContexts.model_validate_json(dumped).model_dump_json() == dumped
