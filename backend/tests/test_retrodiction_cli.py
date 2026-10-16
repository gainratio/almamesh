"""The ``almamesh-eval retrodiction`` command end to end on tiny synthetic files."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from typer.testing import CliRunner

from almamesh.retrodiction import cli
from almamesh.retrodiction.adb import import_adb
from almamesh.retrodiction.cli import app
from almamesh.retrodiction.mapping import preregistration_digest
from almamesh.retrodiction.split import split_natives
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


def test_an_adb_run_writes_its_report_next_to_the_export(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    export = _four_native_zip(tmp_path)
    _pin_the_fake_split(monkeypatch, export)
    code, output = _run("--adb", str(export), "--split", "dev")
    assert code == 0, output
    report = json.loads((tmp_path / "retrodiction-report" / "report.json").read_text())
    assert report["run"]["kind"] == "public"
    assert "astro-databank" in report["run"]["label"]


def test_an_adb_report_may_not_be_written_into_a_git_tree(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repo = tmp_path / "repo"
    (repo / ".git").mkdir(parents=True)
    export = _four_native_zip(tmp_path)
    _pin_the_fake_split(monkeypatch, export)
    code, output = _run("--adb", str(export), "--split", "dev", "--out", str(repo / "out"))
    assert code == 2
    assert "git working tree" in output
    assert not (repo / "out").exists()


@pytest.mark.parametrize("both", [True, False])
def test_exactly_one_input_is_required(tmp_path: Path, both: bool) -> None:
    args = ["--events", str(_file(tmp_path)), "--adb", str(_adb_zip(tmp_path))] if both else []
    code, output = _run(*args)
    assert code == 2
    assert "exactly one of --events or --adb" in output


def _four_native_zip(directory: Path) -> Path:
    entries = tuple(FakeEntry(adb_id=900200 + i) for i in range(4))
    return plain_zip(directory / "adb_export_four.zip", {"x.xml": export_xml(entries)})


def _pin_the_fake_split(monkeypatch: pytest.MonkeyPatch, export: Path) -> str:
    digest = split_natives(import_adb(export).events).digest
    monkeypatch.setattr(cli, "ADB_SPLIT_DIGEST", digest)
    return digest


def test_should_score_only_dev_natives_when_split_is_dev(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Given a four-native export whose split digest is the pinned one
    export = _four_native_zip(tmp_path)
    digest = _pin_the_fake_split(monkeypatch, export)
    # When
    code, output = _run("--adb", str(export), "--split", "dev")
    # Then two natives are scored and the label names the half and the split
    assert code == 0, output
    report = json.loads((tmp_path / "retrodiction-report" / "report.json").read_text())
    assert len({row["subject"] for row in report["events"]}) == 2
    assert f"[dev, split {digest[:12]}]" in report["run"]["label"]


def test_should_refuse_a_split_whose_digest_is_not_pinned(tmp_path: Path) -> None:
    code, output = _run("--adb", str(_four_native_zip(tmp_path)), "--split", "dev")
    assert code == 2
    assert "split digest" in output


def test_should_refuse_held_out_without_a_release_look(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    export = _four_native_zip(tmp_path)
    _pin_the_fake_split(monkeypatch, export)
    code, output = _run("--adb", str(export), "--split", "held-out")
    assert code == 2
    assert "release candidate" in output


def test_should_score_held_out_when_a_release_look_is_declared(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    export = _four_native_zip(tmp_path)
    _pin_the_fake_split(monkeypatch, export)
    code, output = _run("--adb", str(export), "--split", "held-out", "--release-look")
    assert code == 0, output


def test_should_refuse_a_split_of_an_event_file(tmp_path: Path) -> None:
    code, output = _run("--events", str(_file(tmp_path)), "--split", "dev")
    assert code == 2
    assert "--split applies to an ADB export" in output


def test_should_write_the_id_lists_beside_the_export_when_adb_split_runs(tmp_path: Path) -> None:
    # Given
    export = _four_native_zip(tmp_path)
    # When
    result = RUNNER.invoke(app, ["adb-split", "--adb", str(export)])
    # Then the digest is printed, ids stay in the file only
    assert result.exit_code == 0, result.output
    digest = split_natives(import_adb(export).events).digest
    assert digest in result.output
    assert "900200" not in result.output
    written = json.loads((tmp_path / f"split-{digest[:12]}.json").read_text())
    assert len(written["dev"]) == len(written["held_out"]) == 2
    assert written["digest"] == digest


def test_should_refuse_an_unknown_split_half(tmp_path: Path) -> None:
    code, output = _run("--adb", str(_four_native_zip(tmp_path)), "--split", "all")
    assert code == 2
    assert "--split must be dev or held-out" in output


def test_should_refuse_split_ids_inside_a_git_tree(tmp_path: Path) -> None:
    (tmp_path / ".git").mkdir()
    result = RUNNER.invoke(app, ["adb-split", "--adb", str(_four_native_zip(tmp_path))])
    assert result.exit_code == 2
    assert "git working tree" in result.output


def _placebo(*args: str) -> tuple[int, str]:
    result = RUNNER.invoke(app, ["placebo-scorecard", "--added", "classical_dasha", *args])
    return result.exit_code, result.output


@pytest.mark.parametrize(
    "split", [["--split", "held-out", "--release-look"], ["--split", "held-out"], []]
)
def test_should_refuse_to_score_classical_dasha_outside_dev(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, split: list[str]
) -> None:
    # Given the pinned split of an ADB export (amendment h3: HELD-OUT is not read)
    export = _four_native_zip(tmp_path)
    _pin_the_fake_split(monkeypatch, export)
    # When classical_dasha is asked for anything but the DEV half, even with a release look
    code, output = _placebo("--adb", str(export), *split, "--out", str(tmp_path / "card"))
    # Then the run is refused before any native is scored
    assert code == 2
    assert "DEV half only" in output
    assert not (tmp_path / "card").exists()


def test_should_score_classical_dasha_on_the_dev_half(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    export = _four_native_zip(tmp_path)
    _pin_the_fake_split(monkeypatch, export)
    code, output = _placebo("--adb", str(export), "--split", "dev", "--out", str(tmp_path / "c"))
    assert code == 0, output
    card = json.loads((tmp_path / "c" / "placebo-scorecard.json").read_text())
    assert "[dev, split" in card["setup"]["label"]


@pytest.mark.parametrize("command", [["retrodiction"], ["scorecard"], ["placebo-scorecard"]])
@pytest.mark.parametrize("extra", [[], ["--sample-natives", "2", "--seed", "1"]])
def test_should_refuse_an_adb_run_with_no_split_so_held_out_is_never_read_by_omission(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, command: list[str], extra: list[str]
) -> None:
    # Given the pinned split of an ADB export
    export = _four_native_zip(tmp_path)
    _pin_the_fake_split(monkeypatch, export)
    # When a scoring command names the export but no half
    result = RUNNER.invoke(
        app, [*command, "--adb", str(export), *extra, "--out", str(tmp_path / "o")]
    )
    # Then it is refused and nothing is written
    assert result.exit_code == 2, result.output
    assert "--split dev" in result.output
    assert not (tmp_path / "o").exists()
