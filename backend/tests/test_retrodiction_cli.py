"""The ``almamesh-eval retrodiction`` command end to end on tiny synthetic files."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from typer.testing import CliRunner

from almamesh.retrodiction.cli import app
from almamesh.retrodiction.mapping import preregistration_digest

RUNNER = CliRunner()
_EVENTS = """
kind: {kind}
label: cli test
source: unit test (fake native)
subjects:
  - id: fake
    birth: {{datetime: "1980-03-04T05:06:00+05:30", latitude: 13.08, longitude: 80.27}}
    events:
      - {{category: job_start, date: "2019-05", precision: month, place: Nowhere}}
      - {{category: legal, date: "2012-11-03", precision: day}}
      - {{category: education, date: "1999", precision: year}}
"""


def _file(directory: Path, kind: str = "synthetic", body: str = _EVENTS) -> Path:
    path = directory / "events.yaml"
    path.write_text(body.format(kind=kind), encoding="utf-8")
    return path


def _run(*args: str) -> tuple[int, str]:
    result = RUNNER.invoke(app, ["retrodiction", *args])
    return result.exit_code, result.output


def test_a_synthetic_run_writes_json_and_markdown(tmp_path: Path) -> None:
    code, output = _run("--events", str(_file(tmp_path)), "--out", str(tmp_path / "out"))
    assert code == 0, output
    report = json.loads((tmp_path / "out" / "report.json").read_text())
    markdown = (tmp_path / "out" / "report.md").read_text()
    assert report["run"]["kind"] == "synthetic"
    assert report["run"]["evidence"] is False
    assert report["run"]["preregistered"] is True
    assert report["run"]["preregistration_digest"] == preregistration_digest()
    assert report["run"]["months_per_window"] == 73
    assert set(report["overall"]) == {"3", "6"}
    assert len(report["events"]) == 2
    assert report["exclusions"][0]["reason"] == "precision coarser than a month"
    assert {row["variant"] for row in report["ablation"]} >= {"all", "shipped_only"}
    assert "SYNTHETIC" in markdown
    assert "| job_start |" in markdown


def test_a_changed_window_is_flagged_as_not_preregistered(tmp_path: Path) -> None:
    code, output = _run(
        "--events",
        str(_file(tmp_path)),
        "--window",
        "24",
        "--k",
        "3",
        "--out",
        str(tmp_path / "out"),
    )
    assert code == 0, output
    report = json.loads((tmp_path / "out" / "report.json").read_text())
    assert report["run"]["preregistered"] is False
    assert report["run"]["months_per_window"] == 49
    assert "NOT the pre-registered" in (tmp_path / "out" / "report.md").read_text()


def test_a_personal_report_lands_next_to_the_events_file(tmp_path: Path) -> None:
    code, output = _run("--events", str(_file(tmp_path, kind="personal")))
    assert code == 0, output
    assert (tmp_path / "retrodiction-report" / "report.md").exists()
    assert "evidence" in output


def test_a_personal_report_may_not_be_written_into_a_git_tree(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    (repo / ".git").mkdir(parents=True)
    code, output = _run(
        "--events", str(_file(tmp_path, kind="personal")), "--out", str(repo / "out")
    )
    assert code == 2
    assert "git working tree" in output
    assert not (repo / "out").exists()


def test_a_personal_events_file_inside_a_git_tree_is_refused(tmp_path: Path) -> None:
    (tmp_path / ".git").mkdir()
    code, output = _run("--events", str(_file(tmp_path, kind="personal")))
    assert code == 2
    assert "inside a git working tree" in output


def test_a_malformed_file_is_refused(tmp_path: Path) -> None:
    code, output = _run("--events", str(_file(tmp_path, body="kind: {kind}\nsubjects: 3\n")))
    assert code == 2
    assert "subjects" in output


@pytest.mark.parametrize("ks", ["0", "x", "73", ""])
def test_bad_k_values_are_refused(tmp_path: Path, ks: str) -> None:
    code, output = _run("--events", str(_file(tmp_path)), "--k", ks)
    assert code == 2
    assert "k" in output


def test_a_file_with_no_rankable_event_is_refused(tmp_path: Path) -> None:
    body = _EVENTS.split("      - {{category: job_start")[0]
    body += '      - {{category: education, date: "1999", precision: year}}\n'
    code, output = _run("--events", str(_file(tmp_path, body=body)))
    assert code == 2
    assert "no event could be ranked" in output
