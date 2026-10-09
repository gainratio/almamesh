"""Golden parity + determinism regression for the life-domain synthesis (DE421).

Mirrors test_varga_golden.py / test_transit_golden.py: the in-browser Pyodide
engine must produce LifeDomainsContext output byte-identical to CPython. Natal /
transit / varga / strength goldens are untouched — LifeDomainsContext is a
SEPARATE additive object. Floats are canonicalized to 6 decimals (here only the
Shadbala Rupas) so trivial last-bit noise never trips the guard.

Regenerate (only on an intentional engine change):
    uv run python -m tests.fixtures.regen_domains_golden
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

from almamesh.calculations import calculate_sidereal_context
from almamesh.domains import compute_life_domains
from almamesh.schemas.domains import LifeDomainsContext
from almamesh.strength import compute_strength_context
from almamesh.transits import calculate_transit_context
from almamesh.vargas import compute_varga_context

# Pinned instants: reproducible natal dashas + a fixed transit "now".
FIXED_REFERENCE_DATE = datetime(2025, 1, 1, tzinfo=UTC)
FIXED_TRANSIT_INSTANT = datetime(2025, 1, 1, tzinfo=UTC)

# (iso birth, lat, lon, civil UTC offset minutes) — synthetic reference native
# (one generic case) + Delhi + NYC. The offset is the birthplace's civil offset.
FIXTURES: list[tuple[str, float, float, int]] = [
    ("1988-08-08T06:44:00+05:30", 12.9716, 77.5946, 330),  # Bengaluru (reference native)
    ("1990-01-15T12:00:00+00:00", 28.6139, 77.2090, 330),  # Delhi
    ("2000-12-31T23:59:00+00:00", 40.7128, -74.0060, -300),  # NYC
]

GOLDEN_PATH = Path(__file__).parent / "fixtures" / "domains_golden_de421.json"


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


def _compute(iso_dt: str, lat: float, lon: float, offset_minutes: int) -> LifeDomainsContext:
    """The full predictive pipeline for one fixture, pinned to the fixed instants."""
    birth = datetime.fromisoformat(iso_dt)
    natal = calculate_sidereal_context(birth, lat, lon, reference_date=FIXED_REFERENCE_DATE)
    transits = calculate_transit_context(natal, birth, transit_instant=FIXED_TRANSIT_INSTANT)
    vargas = compute_varga_context(natal)
    civil = timedelta(minutes=offset_minutes)
    strength = compute_strength_context(natal, birth, lat, lon, civil_offset=civil)
    return compute_life_domains(natal, transits, vargas, strength)


def _canonical_domains(iso_dt: str, lat: float, lon: float, offset_minutes: int) -> object:
    """Canonicalized JSON dump of one fixture's LifeDomainsContext."""
    return _canonicalize(_compute(iso_dt, lat, lon, offset_minutes).model_dump(mode="json"))


def _load_golden() -> dict[str, object]:
    loaded = json.loads(GOLDEN_PATH.read_text())
    assert isinstance(loaded, dict)
    return loaded


def test_all_domain_fixtures_match_golden() -> None:
    """Every fixture's canonicalized LifeDomainsContext equals the committed golden."""
    golden = _load_golden()
    for iso_dt, lat, lon, offset in FIXTURES:
        assert _canonical_domains(iso_dt, lat, lon, offset) == golden[iso_dt]


def test_domains_json_round_trip_is_byte_identical() -> None:
    """model_dump_json -> model_validate_json -> model_dump_json is byte-stable."""
    iso_dt, lat, lon, offset = FIXTURES[0]
    dumped = _compute(iso_dt, lat, lon, offset).model_dump_json()
    assert LifeDomainsContext.model_validate_json(dumped).model_dump_json() == dumped
