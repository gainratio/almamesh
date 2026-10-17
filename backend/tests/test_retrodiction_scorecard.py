"""The DEV scorecard: per-area baseline vs +family, ratio CI, corrections, controls."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from typer.testing import CliRunner

from almamesh.retrodiction.cli import app
from almamesh.retrodiction.events import EventCategory
from almamesh.retrodiction.harness import EventScores
from almamesh.retrodiction.placebo_run import V1
from almamesh.retrodiction.scorecard import (
    ControlVerdicts,
    Scorecard,
    area_rows,
    control_verdicts,
    corrected,
    hit_ratio,
)
from almamesh.retrodiction.scorecard_markdown import render_scorecard
from tests.retrodiction_leaks import leaks

N = 73
BASE = frozenset({"b"})
WITH = frozenset({"b", "x"})


def _event(subject: str, area: str, *, x_peak: bool) -> EventScores:
    ramp = tuple(i / 1000 for i in range(N))
    x = tuple(5.0 if (x_peak and i == 36) else 0.0 for i in range(N))
    category = EventCategory.MARRIAGE if area == "relationships" else EventCategory.JOB_START
    return EventScores(subject, category, (2000, 1), area, {"b": ramp, "x": x}, 36)


def _events() -> list[EventScores]:
    rel = [_event(f"r{i}", "relationships", x_peak=True) for i in range(20)]
    car = [_event(f"c{i}", "career", x_peak=False) for i in range(20)]
    return rel + car


def test_should_show_the_added_family_lifting_only_its_area() -> None:
    # When
    rows = {(r.area, r.k): r for r in area_rows(_events(), BASE, WITH, (3,), seed=1)}
    # Then relationships go from the ramp's middle (a miss) to every event a hit
    rel, car = rows["relationships", 3], rows["career", 3]
    assert rel.baseline.hits == 0.0
    assert rel.added.hits == 20.0
    assert car.added.hits == car.baseline.hits
    assert rel.n == car.n == 20


def test_should_give_ratio_one_with_a_zero_width_interval_when_nothing_changes() -> None:
    events = [_event(f"r{i}", "relationships", x_peak=True) for i in range(10)]
    ratio = hit_ratio(events, WITH, WITH, 3, seed=1)
    assert (ratio.value, ratio.low, ratio.high) == (1.0, 1.0, 1.0)


def test_should_leave_the_ratio_undefined_when_the_baseline_never_hits() -> None:
    events = [_event(f"r{i}", "relationships", x_peak=True) for i in range(10)]
    assert hit_ratio(events, BASE, WITH, 3, seed=1).value is None


def test_should_correct_across_every_area_and_k() -> None:
    survivors = corrected({("a", 3): 0.001, ("b", 3): 0.04, ("c", 6): 0.5})
    assert survivors.holm == [("a", 3)]
    assert survivors.bh == [("a", 3)]
    assert survivors.tests == 3


def test_should_void_the_run_when_a_control_misbehaves() -> None:
    ok = control_verdicts(planted_lift=73 / 3, planted_p=1e-30, shuffled_ci=(0.8, 1.2), n=73, k=3)
    assert ok == ControlVerdicts(planted_ok=True, shuffled_ok=True)
    bad = control_verdicts(planted_lift=10.0, planted_p=1e-30, shuffled_ci=(1.1, 1.5), n=73, k=3)
    assert bad == ControlVerdicts(planted_ok=False, shuffled_ok=False)


_THREE_NATIVES = """
kind: synthetic
label: scorecard test
subjects:
  - id: n1
    birth: {datetime: "1980-03-04T05:06:00+05:30", latitude: 13.08, longitude: 80.27}
    events: [{category: job_start, date: "2019-05", precision: month}]
  - id: n2
    birth: {datetime: "1980-07-14T11:00:00+00:00", latitude: 51.5, longitude: -0.12}
    events: [{category: marriage, date: "2008-06", precision: month}]
  - id: n3
    birth: {datetime: "1980-11-02T22:30:00-05:00", latitude: 40.7, longitude: -74.0}
    events: [{category: legal, date: "2012-11", precision: month}]
"""


def test_should_write_an_aggregate_only_scorecard_when_run_from_the_cli(tmp_path: Path) -> None:
    # Given three synthetic natives born in the same year
    events = tmp_path / "events.yaml"
    events.write_text(_THREE_NATIVES, encoding="utf-8")
    # When
    result = CliRunner().invoke(
        app, ["scorecard", "--events", str(events), "--out", str(tmp_path / "card")]
    )
    # Then the JSON and markdown carry per-area rows, controls and no native id
    assert result.exit_code == 0, result.output
    card = json.loads((tmp_path / "card" / "scorecard.json").read_text())
    markdown = (tmp_path / "card" / "scorecard.md").read_text()
    assert card["added_family"] == "exact_transits"
    assert card["families"] == sorted(V1 | {"exact_transits"})
    assert card["events_scored"] == 3
    assert card["swap_natives_dropped"] == 0
    assert {row["area"] for row in card["rows"]} >= {"all areas", "career", "relationships"}
    # the planted family reaches its ceiling, but 3 events cannot reach p < 1e-20: VOID
    assert card["planted"]["3"]["lift"] == pytest.approx(73 / 3)
    assert card["verdicts"]["planted_ok"] is False
    assert "VOID" in markdown
    assert "| career |" in markdown
    assert "Holm" in markdown
    assert "SYNTHETIC" in markdown
    for native in ("n1", "n2", "n3"):
        assert native not in markdown
        assert f'"{native}' not in (tmp_path / "card" / "scorecard.json").read_text()
    # and no value-level leak: id-shaped key or value, timed date, coordinates, name
    assert leaks(card) == []
    assert leaks(markdown) == []


def test_should_refuse_a_scorecard_with_no_input(tmp_path: Path) -> None:
    result = CliRunner().invoke(app, ["scorecard", "--out", str(tmp_path / "card")])
    assert result.exit_code == 2
    assert "exactly one of --events or --adb" in result.output


def test_should_refuse_a_scorecard_when_no_event_can_be_ranked(tmp_path: Path) -> None:
    events = tmp_path / "events.yaml"
    events.write_text(
        _THREE_NATIVES.replace('"2019-05", precision: month', '"2019", precision: year')
        .replace('"2008-06", precision: month', '"2008", precision: year')
        .replace('"2012-11", precision: month', '"2012", precision: year'),
        "utf-8",
    )
    result = CliRunner().invoke(
        app, ["scorecard", "--events", str(events), "--out", str(tmp_path / "c")]
    )
    assert result.exit_code == 2
    assert "no event could be ranked" in result.output


def test_should_render_ratios_and_drop_the_synthetic_banner_for_evidence() -> None:
    # Given a scorecard whose relationships baseline sometimes hits
    events = _events() + [_event("rx", "relationships", x_peak=False)]
    rows = area_rows(events, WITH, WITH, (3,), seed=1, swap=events)
    card = Scorecard(
        label="unit",
        added_family="x",
        families=["b", "x"],
        preregistration_digest="0" * 64,
        window=36,
        ks=[3],
        events_scored=len(events),
        exclusions={},
        swap_natives_dropped=0,
        swap_exclusions={},
        rows=rows,
        corrections=corrected({}),
        shuffled={"3": rows[0].added},
        planted={"3": rows[0].added},
        verdicts=ControlVerdicts(planted_ok=True, shuffled_ok=True),
    )
    # When
    markdown = render_scorecard(card, evidence=True)
    # Then
    assert "| relationships | 21 |" in markdown
    assert "1.00 [1.00, 1.00]" in markdown
    assert "SYNTHETIC" not in markdown
    assert "Controls (ok)" in markdown


def test_should_report_added_over_baseline_hits_when_the_family_doubles_them() -> None:
    # Given 20 natives: the baseline family peaks for half of them, the added one for all
    def event(i: int) -> EventScores:
        peak = tuple(5.0 if j == 36 else 0.0 for j in range(N))
        flat = tuple(j / 1000 for j in range(N))
        families = {"b": peak if i < 10 else flat, "x": peak}
        return EventScores(
            f"n{i}", EventCategory.MARRIAGE, (2000, 1), "relationships", families, 36
        )

    # When
    ratio = hit_ratio([event(i) for i in range(20)], BASE, WITH, 3, seed=1)
    # Then
    assert ratio.value == pytest.approx(2.0)
    assert ratio.low is not None and ratio.high is not None
    assert 1.0 < ratio.low <= 2.0 <= ratio.high


def test_should_accept_a_planted_p_at_the_fft_floor_when_the_set_is_large() -> None:
    # Regression (DEV run 2026-10-14): thousands of events take the FFT path, whose p is
    # floored at 1e-12, so "p < 1e-20" voided a planted control that was exactly N/k.
    floor = control_verdicts(
        planted_lift=73 / 3, planted_p=1e-12, shuffled_ci=(0.9, 1.1), n=73, k=3
    )
    weak = control_verdicts(planted_lift=73 / 3, planted_p=1e-11, shuffled_ci=(0.9, 1.1), n=73, k=3)
    assert floor.planted_ok is True
    assert weak.planted_ok is False
