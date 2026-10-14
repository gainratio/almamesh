"""The ``almamesh-eval retrodiction`` command end to end on tiny synthetic files."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from typer.testing import CliRunner

from almamesh.retrodiction.cli import app
from almamesh.retrodiction.mapping import preregistration_digest
from tests.adb_xml import FakeEntry, export_xml, plain_zip

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


def test_workers_write_the_same_report_as_one_process(tmp_path: Path) -> None:
    events = str(_file(tmp_path))
    assert _run("--events", events, "--out", str(tmp_path / "one"))[0] == 0
    assert _run("--events", events, "--out", str(tmp_path / "two"), "--workers", "2")[0] == 0
    one = (tmp_path / "one" / "report.json").read_bytes()
    assert (tmp_path / "two" / "report.json").read_bytes() == one


def test_a_native_sample_is_recorded_in_the_report(tmp_path: Path) -> None:
    out = tmp_path / "out"
    args = ("--events", str(_file(tmp_path)), "--out", str(out))
    assert _run(*args, "--sample-natives", "1", "--seed", "7")[0] == 0
    report = json.loads((out / "report.json").read_text())
    assert report["run"]["sample_natives"] == 1
    assert report["run"]["sample_seed"] == 7
    assert "random sample of 1 natives (seed 7)" in (out / "report.md").read_text()


def test_a_sample_needs_its_seed(tmp_path: Path) -> None:
    code, output = _run("--events", str(_file(tmp_path)), "--sample-natives", "1")
    assert code == 2
    assert "--seed" in output


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


def _adb_zip(directory: Path) -> Path:
    entries = (FakeEntry(adb_id=900101), FakeEntry(adb_id=900102, rrc="3", rating="B"))
    return plain_zip(directory / "adb_export_fake.zip", {"x.xml": export_xml(entries)})


def test_adb_summary_prints_counts_and_no_native(tmp_path: Path) -> None:
    result = RUNNER.invoke(app, ["adb-summary", "--adb", str(_adb_zip(tmp_path))])
    assert result.exit_code == 0, result.output
    summary = json.loads(result.output)
    assert summary["ratings"] == {"AA": 1, "B": 1}
    assert summary["events_mapped"] == {"job_start": 1}
    assert "900101" not in result.output
    assert sorted(p.name for p in tmp_path.iterdir()) == ["adb_export_fake.zip"]


def test_adb_summary_refuses_an_export_inside_a_git_tree(tmp_path: Path) -> None:
    (tmp_path / ".git").mkdir()
    result = RUNNER.invoke(app, ["adb-summary", "--adb", str(_adb_zip(tmp_path))])
    assert result.exit_code == 2
    assert "git working tree" in result.output


def test_an_adb_run_writes_its_report_next_to_the_export(tmp_path: Path) -> None:
    code, output = _run("--adb", str(_adb_zip(tmp_path)))
    assert code == 0, output
    report = json.loads((tmp_path / "retrodiction-report" / "report.json").read_text())
    assert report["run"]["kind"] == "public"
    assert "astro-databank" in report["run"]["label"]


def test_an_adb_report_may_not_be_written_into_a_git_tree(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    (repo / ".git").mkdir(parents=True)
    code, output = _run("--adb", str(_adb_zip(tmp_path)), "--out", str(repo / "out"))
    assert code == 2
    assert "git working tree" in output
    assert not (repo / "out").exists()


@pytest.mark.parametrize("both", [True, False])
def test_exactly_one_input_is_required(tmp_path: Path, both: bool) -> None:
    args = ["--events", str(_file(tmp_path)), "--adb", str(_adb_zip(tmp_path))] if both else []
    code, output = _run(*args)
    assert code == 2
    assert "exactly one of --events or --adb" in output
