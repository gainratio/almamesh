"""Regenerate tests/fixtures/domains_golden_de421.json deterministically.

Run: ``uv run python -m tests.fixtures.regen_domains_golden``. Recomputes the
pinned LifeDomainsContext for each case and rewrites the golden. Birth instants,
places, the natal ``reference_date`` and the transit instant are all fixed (they
must match ``tests/test_domains_golden.py``); the engine is deterministic, so
the output is reproducible. Regenerate only on an intentional engine change.
"""

from __future__ import annotations

import json
from pathlib import Path

# Single source of truth: reuse the golden test's pins, cases and pipeline.
from tests.test_domains_golden import FIXTURES, GOLDEN_PATH, _canonical_domains


def main() -> None:
    """Write the golden fixture for every case."""
    golden = {iso: _canonical_domains(iso, lat, lon, offset) for iso, lat, lon, offset in FIXTURES}
    out = Path(GOLDEN_PATH)
    out.write_text(json.dumps(golden, indent=2, sort_keys=True) + "\n")
    print(f"wrote {len(golden)} cases to {out} ({out.stat().st_size} bytes)")  # noqa: T201 - dev script


if __name__ == "__main__":
    main()
