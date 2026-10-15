"""The amendment (f) DEV scorecard end to end on synthetic natives (no licensed data)."""

from __future__ import annotations

import json
from typing import TYPE_CHECKING

import pytest
from typer.testing import CliRunner

from almamesh.retrodiction import engine as engine_module
from almamesh.retrodiction.cli import app
from almamesh.retrodiction.engine import OUT_OF_RANGE_BIRTH
from almamesh.retrodiction.events import RetrodictionInputError, load_events
from almamesh.retrodiction.placebo_card import BASELINE, PlaceboCard, RunPlan, build_placebo_card
from almamesh.retrodiction.placebo_run import UNREADABLE, score_hits

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


def _raising_activation(bad: Callable[[YearMonth], bool]) -> Callable[[Birth, YearMonth], float]:
    def activation(birth: Birth, ym: YearMonth) -> float:
        if bad(ym):
            raise engine_module.EngineReadingRangeError(f"{ym}: outside the ephemeris")
        return 0.5

    return activation


def test_should_exclude_a_disputes_event_whose_own_window_cannot_be_read(
    events_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Given an engine reading that fails for every month (amendment c)
    monkeypatch.setattr(engine_module, "obstacles_activation", _raising_activation(lambda _: True))
    plan = RunPlan(added="engine_obstacles")
    # When / Then the only disputes event is excluded, so nothing can be ranked
    with pytest.raises(RetrodictionInputError, match="placebo window"):
        build_placebo_card(load_events(events_path), plan, workers=1)
    hits, excluded = score_hits(load_events(events_path), plan)
    assert hits == []
    assert [x.reason for x in excluded] == [UNREADABLE]


def test_should_drop_only_the_placebo_windows_the_engine_cannot_read(
    events_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Given readings that fail only before 2005 (the legal event is 2012-11)
    monkeypatch.setattr(
        engine_module, "obstacles_activation", _raising_activation(lambda ym: ym[0] < 2005)
    )
    hits, _ = score_hits(load_events(events_path), RunPlan(added="engine_obstacles"))
    # Then the event stays, with only its later placebo windows
    assert len(hits) == 1
    assert 0 < len(hits[0].placebos) < 4


_EDGE_NATIVES = """
kind: synthetic
label: placebo edge cases
subjects:
  - id: e1
    birth: {datetime: "1980-03-04T05:06:00+05:30", latitude: 13.08, longitude: 80.27}
    events:
      - {category: job_start, date: "2000-05", precision: month}
      - {category: marriage, date: "2004", precision: year}
  - id: e2
    birth: {datetime: "1895-07-14T11:00:00+00:00", latitude: 51.5, longitude: -0.12}
    events: [{category: marriage, date: "1920-06", precision: month}]
"""


def test_should_score_the_same_hits_in_parallel_and_list_why_events_drop(tmp_path: Path) -> None:
    # Given a ranked event, a year-only event and a pre-1900 native
    path = tmp_path / "edge.yaml"
    path.write_text(_EDGE_NATIVES, encoding="utf-8")
    plan = RunPlan(placebos=1)
    # When scored serially and in two processes
    serial = score_hits(load_events(path), plan, workers=1)
    parallel = score_hits(load_events(path), plan, workers=2)
    # Then the results are identical and each drop names its reason
    assert parallel == serial
    assert len(serial[0]) == 1
    assert sorted(x.reason for x in serial[1]) == sorted(
        [OUT_OF_RANGE_BIRTH, "precision coarser than a month"]
    )
