"""Regenerate tests/fixtures/predictive_golden_de421.json deterministically.

Run: ``uv run python -m tests.fixtures.regen_predictive_golden``. Recomputes the
pinned composed PredictiveContexts for each case and rewrites the golden. Birth
instants, places and the single reference instant are all fixed (they must
match ``tests/test_predictive_golden.py`` AND
``frontend/packages/browser/integration/parity.mjs``); the engine is
deterministic, so the output is reproducible. Regenerate only on an intentional
engine change.
"""

from __future__ import annotations

import json
from pathlib import Path

# Single source of truth: reuse the golden test's pins, cases and pipeline.
from tests.test_predictive_golden import FIXTURES, GOLDEN_PATH, _canonical_predictive


def main() -> None:
    """Write the golden fixture for every case."""
    golden = {
        iso: _canonical_predictive(iso, lat, lon, offset) for iso, lat, lon, offset in FIXTURES
    }
    out = Path(GOLDEN_PATH)
    out.write_text(json.dumps(golden, indent=2, sort_keys=True) + "\n")
    print(f"wrote {len(golden)} cases to {out} ({out.stat().st_size} bytes)")  # noqa: T201 - dev script


if __name__ == "__main__":
    main()
