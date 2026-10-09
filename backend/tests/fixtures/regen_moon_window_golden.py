"""Regenerate moon_window_golden_de421.json.

Run: uv run python -m tests.fixtures.regen_moon_window_golden
"""

import json

from almamesh.edge.chart_runtime import compute_moon_window_payload
from tests.test_moon_window_golden import GOLDEN_PATH, golden_cases


def main() -> None:
    golden = {key: compute_moon_window_payload(case) for key, case in golden_cases().items()}
    GOLDEN_PATH.write_text(json.dumps(golden, indent=2, sort_keys=True) + "\n")


if __name__ == "__main__":
    main()
