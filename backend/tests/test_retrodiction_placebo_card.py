"""The amendment (f) DEV scorecard end to end on synthetic natives (no licensed data)."""

from __future__ import annotations

import json
from typing import TYPE_CHECKING

import pytest
from typer.testing import CliRunner

from almamesh.retrodiction import engine as engine_module
from almamesh.retrodiction.cli import app
from almamesh.retrodiction.events import load_events
from almamesh.retrodiction.placebo_card import BASELINE, PlaceboCard, RunPlan, build_placebo_card

if TYPE_CHECKING:
    from collections.abc import Callable
    from pathlib import Path

    from almamesh.retrodiction.engine import YearMonth
    from almamesh.retrodiction.events import Birth

_THREE_NATIVES = """
kind: synthetic
label: placebo test
subjects:
  - id: n1
    birth: {datetime: "1980-03-04T05:06:00+05:30", latitude: 13.08, longitude: 80.27}
    events: [{category: job_start, date: "2000-05", precision: month}]
  - id: n2
    birth: {datetime: "1980-07-14T11:00:00+00:00", latitude: 51.5, longitude: -0.12}
    events: [{category: marriage, date: "2008-06", precision: month}]
  - id: n3
    birth: {datetime: "1980-11-02T22:30:00-05:00", latitude: 40.7, longitude: -74.0}
    events: [{category: legal, date: "2012-11", precision: month}]
"""


@pytest.fixture
def events_path(tmp_path: Path) -> Path:
    path = tmp_path / "events.yaml"
    path.write_text(_THREE_NATIVES, encoding="utf-8")
    return path


def test_should_write_an_aggregate_only_placebo_scorecard_from_the_cli(
    events_path: Path, tmp_path: Path
) -> None:
    out = tmp_path / "card"
    result = CliRunner().invoke(
        app, ["placebo-scorecard", "--events", str(events_path), "--out", str(out)]
    )
    assert result.exit_code == 0, result.output
    card = json.loads((out / "placebo-scorecard.json").read_text())
    markdown = (out / "placebo-scorecard.md").read_text()
    assert card["added_family"] == "exact_transits"
    assert card["events_scored"] == 3
    assert {r["family_set"] for r in card["rows"]} == {BASELINE, "+exact_transits"}
    assert "only:yogini" in card["controls"]
    assert card["planted"]["3"]["lift"] == pytest.approx(73 / 3)
    assert "placebo-calibrated" in markdown
    assert "SYNTHETIC" in markdown
    for native in ("n1", "n2", "n3"):
        assert f'"{native}' not in (out / "placebo-scorecard.json").read_text()
        assert native not in markdown


def test_should_refuse_an_unknown_added_family(events_path: Path, tmp_path: Path) -> None:
    result = CliRunner().invoke(
        app,
        [
            "placebo-scorecard",
            "--events",
            str(events_path),
            "--added",
            "nope",
            "--out",
            str(tmp_path),
        ],
    )
    assert result.exit_code == 2
    assert "exact_transits or engine_obstacles" in result.output


def _fake_activation(asked: list[YearMonth]) -> Callable[[Birth, YearMonth], float]:
    def activation(birth: Birth, ym: YearMonth) -> float:
        asked.append(ym)
        return (ym[1] % 4) / 4

    return activation


def test_should_score_only_disputes_events_and_resolve_obstacles_lazily(
    events_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Given a cheap stand-in for the engine's obstacles reading
    asked: list[YearMonth] = []
    monkeypatch.setattr(engine_module, "obstacles_activation", _fake_activation(asked))
    loaded = load_events(events_path)
    # When
    card = build_placebo_card(loaded, RunPlan(added="engine_obstacles"), workers=1)
    exact = build_placebo_card(loaded, RunPlan(added="exact_transits"), workers=1)
    # Then only the legal event is scored, and far fewer months than every window holds
    assert card.events_scored == 1
    assert 0 < len(set(asked)) < 5 * 73

    # and BASELINE on the disputes area is the same number in both runs
    assert _disputes_baseline(card) == _disputes_baseline(exact)
    assert len(_disputes_baseline(card)) == 2


def _disputes_baseline(card: PlaceboCard) -> list[float]:
    return [
        r.summary.hits
        for r in card.rows
        if r.family_set == BASELINE and r.area.startswith("disputes")
    ]
