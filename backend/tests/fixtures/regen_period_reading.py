"""Regenerate testdata/period-reading/*.json (the frontend's copy of the reading).

Run: ``uv run python -m tests.fixtures.regen_period_reading``. Each file is the
wire ``period_reading`` object only, for DELHI_BIRTH at one pinned reference
instant. Regenerate only on an intentional engine change.
"""

from __future__ import annotations

import json

from tests.test_period_reading import _FIXTURE_DIR, READING_CASES, compute_delhi, wire_reading


def main() -> None:
    """Write every golden reading and print its compact wire size."""
    _FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
    for name, (reference, window) in READING_CASES.items():
        reading = wire_reading(compute_delhi(reference, window))
        (_FIXTURE_DIR / name).write_text(json.dumps(reading, indent=2) + "\n")
        compact = len(json.dumps(reading, separators=(",", ":")).encode())
        print(f"{name}: {compact} bytes compact")  # noqa: T201 - dev script


if __name__ == "__main__":
    main()
